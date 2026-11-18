import {
  derive,
  cleanDrawing,
  cleanRecordings,
  cleanImages,
  imageBytes,
  VAULT_IMAGE_BYTES,
  decrypt,
  merge,
  emptyVault,
  safeUrl,
  seal,
  newDataKey,
  exportKey,
  importKey,
  setPassword,
  setRecovery,
  openWithPassword,
  openWithRecovery,
  newRecoveryCode,
  parseRecoveryCode,
  verifySlots,
  validateEnvelope,
  type Memo,
  MEMO_MAX,
  type Envelope,
  type SealedEnvelope,
  type KeySlots,
  type Vault,
  type Entry,
  type Folder,
  type FolderKind,
  cleanFolderName,
  folderId,
} from "./crypto";
import { deleteMemo, upsertMemo } from "./memo-ops";
import { folderTree, joinPath, parentOf, within } from "./folders";
import {
  clearClientId,
  clearTokens,
  listSnapshots,
  oauthSource,
  readRemote,
  removeSnapshots,
  setClientId,
  upload,
  userClientId,
} from "./drive";
import { mergeSnapshots, VaultMismatch } from "./sync-core";
import { deleteEntry, upsertEntry } from "./entry-ops";
const TIMEOUT = 15 * 60 * 1000;
type Session = {
  key: string; // data key (DEK), raw base64
  id: string;
  // Password key and salt, kept only to read legacy v1 snapshots in Drive.
  legacy?: { salt: string; kek: string };
  expires: number;
  nonce: string;
  windowIds: number[];
};
let queue = Promise.resolve();
let lockGeneration = 0;
async function lock() {
  lockGeneration++;
  await chrome.storage.session.remove(["session", "capture", "passwordProof"]);
  await chrome.alarms.clear("veilmark-lock");
}
async function session(): Promise<Session> {
  const { session: s } = await chrome.storage.session.get<{
    session?: Session;
  }>("session");
  if (!s) throw Error(LOCKED);
  if (s.expires <= Date.now()) {
    await lock();
    throw Error(LOCKED);
  }
  const windows = await chrome.windows.getAll({
    windowTypes: ["normal", "popup"],
  });
  if (!s.windowIds?.some((id) => windows.some((w) => w.id === id))) {
    await lock();
    throw Error("瀏覽器工作階段已結束，請重新解鎖");
  }
  return s;
}
async function keyOf(s: Session) {
  return importKey(s.key);
}
async function touch(s: Session, initial = false, generation = lockGeneration) {
  if (!initial && (await session()).nonce !== s.nonce)
    throw Error("已上鎖，請重新解鎖");
  if (generation !== lockGeneration) throw Error("已上鎖，請重新解鎖");
  s.windowIds = (
    await chrome.windows.getAll({ windowTypes: ["normal", "popup"] })
  )
    .filter((w) => w.id !== undefined)
    .map((w) => w.id!);
  if (!s.windowIds.length)
    throw Error("請開啟 Chrome 視窗後使用 Veil Bookmark");
  s.expires = Date.now() + TIMEOUT;
  await chrome.storage.session.set({ session: s });
  await chrome.alarms.create("veilmark-lock", { when: s.expires });
}
type Opened = {
  v: Vault;
  dek: CryptoKey;
  sealed: SealedEnvelope;
  legacy?: { salt: string; kek: CryptoKey };
};
/** Opens a v1 or v3 envelope with the master password. A v1 envelope is
 *  migrated to v3 with a fresh data key (same password and salt). */
async function openPassword(input: unknown, password: string): Promise<Opened> {
  const e = validateEnvelope(input);
  if (e.version === 1) {
    const kek = await derive(password, e.salt);
    const v = await decrypt(e, kek);
    const dek = await newDataKey();
    const keys = await setPassword(dek, e.id, password, undefined, e.salt);
    return {
      v,
      dek,
      sealed: await seal(v, dek, keys),
      legacy: { salt: e.salt, kek },
    };
  }
  const { dek, kek } = await openWithPassword(e, password);
  const v = await decrypt(e, dek);
  return { v, dek, sealed: e, legacy: { salt: e.keys.salt, kek } };
}
async function startSession(o: Opened, generation = lockGeneration) {
  await touch(
    {
      key: await exportKey(o.dek),
      id: o.sealed.id,
      ...(o.legacy && {
        legacy: { salt: o.legacy.salt, kek: await exportKey(o.legacy.kek) },
      }),
      expires: 0,
      nonce: crypto.randomUUID(),
      windowIds: [],
    },
    true,
    generation,
  );
}
async function local() {
  return (await chrome.storage.local.get("vault")).vault as
    Envelope | undefined;
}

// ---- Local storage layout --------------------------------------------------
// Layout 2 keeps bookmarks (with all folder records) and notes in two
// encrypted envelopes that share the vault ID and key slots:
//   vault       bookmarks + folders (memos: [])
//   vaultMemos  notes (entries: [], folders: [])
//   vaultLayout 2
// A bookmark change re-encrypts only the small bookmark part, so notes with
// pictures or audio no longer slow it down. All three keys are always
// written in one chrome.storage.local.set, which Chrome applies atomically.
// Without vaultLayout, "vault" is the older single envelope with everything;
// it is read as before and converted on the next save. Google Drive and
// backup files keep the single-envelope format.
type Part = "entries" | "memos" | "all";
const NOTES_MISSING =
  "記事資料不完整，無法開啟。請從 Google Drive 或加密備份還原。";
// Decrypted parts by ciphertext, so each request does not decrypt the notes
// again. Callers get a copy: requests modify the vault in place.
const partCache = new Map<string, Vault>();
async function decryptPart(e: Envelope, dek: CryptoKey) {
  const key = e.version === 3 ? `${e.id}|${e.iv}` : "";
  let v = key ? partCache.get(key) : undefined;
  if (!v) {
    v = await decrypt(e, dek);
    if (key) {
      if (partCache.size > 4) partCache.clear();
      partCache.set(key, v);
    }
  }
  return structuredClone(v);
}
/** The whole vault (bookmarks, notes, folders) from this computer. */
async function readVault(dek: CryptoKey): Promise<Vault> {
  const st = await chrome.storage.local.get([
    "vault",
    "vaultMemos",
    "vaultLayout",
  ]);
  if (!st.vault) throw Error("尚無保險庫");
  const a = await decryptPart(validateEnvelope(st.vault), dek);
  if (st.vaultLayout !== 2) return a; // older single envelope
  if (!st.vaultMemos) throw Error(NOTES_MISSING);
  const b = await decryptPart(validateEnvelope(st.vaultMemos), dek);
  if (b.id !== a.id) throw Error(NOTES_MISSING);
  // A union, so nothing is lost even if an older release wrote "vault".
  return merge(a, b);
}
const entriesPart = (v: Vault): Vault => ({ ...v, memos: [] });
const memosPart = (v: Vault): Vault => ({ ...v, entries: [], folders: [] });
/** Saves the vault on this computer; `part` says what changed. Other values
 *  in `extra` are written in the same atomic call. */
async function writeVault(
  v: Vault,
  dek: CryptoKey,
  keys: KeySlots,
  part: Part = "all",
  extra: Record<string, unknown> = {},
) {
  const st = await chrome.storage.local.get([
    "vault",
    "vaultMemos",
    "vaultLayout",
  ]);
  const old = st.vault as Envelope | undefined;
  // Both parts unless the stored layout already matches and keys are equal.
  if (
    st.vaultLayout !== 2 ||
    !st.vaultMemos ||
    !old ||
    old.version !== 3 ||
    old.id !== v.id ||
    JSON.stringify(old.keys) !== JSON.stringify(keys)
  )
    part = "all";
  const set: Record<string, unknown> = { ...extra, vaultLayout: 2 };
  if (part !== "memos") set.vault = await seal(entriesPart(v), dek, keys);
  if (part !== "entries") set.vaultMemos = await seal(memosPart(v), dek, keys);
  await chrome.storage.local.set(set);
}
/** One envelope with everything, for Google Drive and backup files. */
async function combined(dek: CryptoKey) {
  const e = await local();
  if (!e || e.version !== 3) throw Error("請先建立或還原保險庫");
  return seal(await readVault(dek), dek, e.keys);
}
async function localKeys(): Promise<KeySlots> {
  const e = await local();
  if (!e || e.version !== 3) throw Error("請先建立或還原保險庫");
  return e.keys;
}
async function save(v: Vault, s: Session, keys?: KeySlots, part: Part = "all") {
  await session();
  const k = keys || (await localKeys());
  await writeVault(v, await keyOf(s), k, keys ? "all" : part);
}
async function rateLimited<T>(fn: () => Promise<T>) {
  const { attempts = 0, nextAttempt = 0 } = await chrome.storage.session.get<{
    attempts?: number;
    nextAttempt?: number;
  }>(["attempts", "nextAttempt"]);
  if (Date.now() < nextAttempt) throw Error("嘗試次數過多，請稍後再試");
  try {
    const r = await fn();
    await chrome.storage.session.remove(["attempts", "nextAttempt"]);
    return r;
  } catch (err) {
    await chrome.storage.session.set({
      attempts: attempts + 1,
      nextAttempt:
        Date.now() + Math.min(60000, 1000 * 2 ** Math.min(attempts, 6)),
    });
    throw err;
  }
}
const OTHER_VAULT =
  "Drive 含有另一個保險庫。請保留本機備份，於新安裝中從 Drive 還原，避免覆蓋。";
// Drive holds a vault with a different key: sync stops and the user chooses
// which copy to keep in Sync & backup (DRIVE_USE_REMOTE / DRIVE_REPLACE).
const DRIVE_CONFLICT =
  "Google Drive 已有另一個保險庫，請在「同步與備份」選擇要保留哪一份。";
async function conflict() {
  await chrome.storage.local.set({ driveConflict: true });
  return Error(DRIVE_CONFLICT);
}
/** Opens and merges the Drive snapshots with the Drive vault's password. */
async function openDrive(envelopes: Envelope[], password: string) {
  if (!envelopes.length) throw Error("Drive 尚無 Veil Bookmark 備份");
  // Open with the newest key slots so a password reset elsewhere is honoured.
  const sealedOnes = envelopes
    .filter((x): x is SealedEnvelope => x.version === 3)
    .sort((a, b) => b.keys.updated - a.keys.updated);
  const first = sealedOnes[0] || envelopes[0];
  const o = await rateLimited(() => openPassword(first, password));
  let v = o.v;
  for (const e of envelopes) {
    if (e.id !== o.sealed.id)
      throw Error("Drive 含有不同保險庫，請改用加密檔案還原");
    try {
      v = merge(
        v,
        e.version === 1
          ? await decrypt(e, await derive(password, e.salt))
          : await decrypt(e, o.dek),
      );
    } catch {
      throw Error("Drive 含有不同保險庫，請改用加密檔案還原");
    }
  }
  return { ...o, v, sealed: await seal(v, o.dek, o.sealed.keys) };
}
// One sync at a time. Reading and writing Google Drive (the slow part) runs
// outside the request queue so the popup and the notebook stay responsive;
// only merging into this computer's vault waits in the queue, and it reads
// the local vault there, so edits made meanwhile are never overwritten.
let syncChain: Promise<unknown> = Promise.resolve();
async function sync(interactive = false, inQueue = false): Promise<Vault> {
  const run = async () => {
    await session();
    const { t, envelopes, ids } = await readRemote(interactive);
    const step = async () => {
      const s = await session();
      const dek = await keyOf(s);
      const e = await local();
      if (!e) throw Error("請先建立或還原保險庫");
      let keys = await localKeys();
      const before = await readVault(dek);
      let merged;
      try {
        merged = await mergeSnapshots({
          v: before,
          dek,
          keys,
          envelopes,
          ...(s.legacy && {
            legacy: {
              salt: s.legacy.salt,
              kek: await importKey(s.legacy.kek),
            },
          }),
        });
      } catch (err) {
        if (err instanceof VaultMismatch) throw await conflict();
        throw err;
      }
      const v = merged.v;
      const keysChanged = JSON.stringify(keys) !== JSON.stringify(merged.keys);
      keys = merged.keys;
      await session();
      // Only the parts Drive changed are written here.
      const same = (a: Vault, b: Vault) =>
        JSON.stringify(merge(a, a)) === JSON.stringify(merge(b, b));
      const entriesChanged = !same(entriesPart(v), entriesPart(before));
      const memosChanged = !same(memosPart(v), memosPart(before));
      if (keysChanged || entriesChanged || memosChanged)
        await writeVault(
          v,
          dek,
          keys,
          keysChanged || (entriesChanged && memosChanged)
            ? "all"
            : entriesChanged
              ? "entries"
              : "memos",
        );
      return { v, dek, keys, upload: merged.upload, damaged: merged.damaged };
    };
    const r = inQueue ? await step() : await serialized(step);
    if (r.upload) {
      await upload(t, await seal(r.v, r.dek, r.keys));
      // Snapshots that could not be read are kept, never deleted.
      await removeSnapshots(
        t,
        ids.filter((_, i) => !r.damaged.includes(i)),
      );
    }
    await chrome.storage.local.set({
      lastSync: Date.now(),
      syncError: "",
      driveConflict: false,
    });
    return r.v;
  };
  // A sync requested from a page already holds the request queue.
  if (inQueue) return run();
  const task = syncChain.then(run, run);
  syncChain = task.catch(() => {});
  return task;
}
const LOCKED = "已上鎖，請重新解鎖";
// The popup is often open for only a few seconds, so background sync must not
// wait for the 5-minute tick: pull right after unlocking and push about a
// second after each change. The alarm is a fallback in case Chrome stops the
// service worker before the timer fires. Changes made while sync could not run
// (locked, offline) stay in the local vault and are merged on the next sync.
const QUICK_SYNC_MS = 1000;
let quickTimer: ReturnType<typeof setTimeout> | undefined;
async function requestSync(delay = QUICK_SYNC_MS) {
  const { driveEnabled } = await chrome.storage.local.get("driveEnabled");
  if (!driveEnabled) return;
  await chrome.alarms.create("veilmark-sync-soon", { delayInMinutes: 0.5 });
  clearTimeout(quickTimer);
  // Returns the sync (Chrome ignores it; tests can wait for it).
  quickTimer = setTimeout(() => backgroundSync(), delay);
}
async function backgroundSync() {
  const { driveEnabled } = await chrome.storage.local.get("driveEnabled");
  if (!driveEnabled) return;
  try {
    await session();
  } catch {
    return; // Locked: nothing to sync until the next unlock; not an error.
  }
  try {
    await sync();
    await chrome.alarms.clear("veilmark-sync-soon");
  } catch (e) {
    try {
      await session();
    } catch {
      return; // Locked while syncing.
    }
    await chrome.storage.local.set({ syncError: (e as Error).message });
  }
}
function folderKind(k: unknown): FolderKind {
  if (k !== "entry" && k !== "memo") throw Error("未知操作");
  return k;
}
/** Folder paths in use (records, items and their ancestors). */
function liveFolders(v: Vault, kind: FolderKind) {
  const items: { folder?: string; deleted: boolean }[] =
    kind === "entry" ? v.entries : v.memos;
  return folderTree(
    kind,
    v.folders,
    items.filter((x) => !x.deleted),
  );
}
/** A folder record for the path and each missing ancestor. */
function ensureFolder(v: Vault, kind: FolderKind, path: string) {
  const chain: string[] = [];
  for (let p = path; p; p = parentOf(p)) chain.unshift(p);
  for (const p of chain) {
    const rec = (v.folders || []).find(
      (f) => f.id === folderId(kind, p) && !f.deleted,
    );
    if (!rec) upsertFolder(v, kind, p);
  }
}
/** Renames (or moves) a folder with everything below it. */
function renameTree(v: Vault, kind: FolderKind, from: string, to: string) {
  if (!from || !to || from === to) return;
  if (within(to, from)) throw Error("不能把資料夾移到它自己的子資料夾");
  const live = liveFolders(v, kind);
  const moving = live.filter((p) => within(p, from));
  for (const p of moving) {
    const next = to + p.slice(from.length);
    if (live.includes(next) && !within(next, from))
      throw Error("已有同名資料夾");
  }
  ensureFolder(v, kind, parentOf(to));
  for (const p of moving) {
    const next = to + p.slice(from.length);
    const old = (v.folders || []).find(
      (f) => f.id === folderId(kind, p) && !f.deleted,
    );
    upsertFolder(v, kind, next, old?.order);
    removeFolder(v, kind, p);
    moveItems(v, kind, p, next);
  }
}
function upsertFolder(
  v: Vault,
  kind: FolderKind,
  name: string,
  order?: number,
) {
  const folders = (v.folders ||= []);
  const id = folderId(kind, name);
  const old = folders.find((f) => f.id === id);
  const next =
    order ??
    (old && !old.deleted ? old.order : undefined) ??
    Math.max(
      -1,
      ...folders
        .filter((f) => f.kind === kind && !f.deleted)
        .map((f) => f.order),
    ) + 1;
  if (old && !old.deleted && old.order === next) return;
  const f: Folder = {
    id,
    kind,
    name,
    order: next,
    updated: Math.max(Date.now(), (old?.updated || 0) + 1),
    revision: crypto.randomUUID(),
    deleted: false,
  };
  v.folders = folders.filter((x) => x.id !== id).concat(f);
}
function removeFolder(v: Vault, kind: FolderKind, name: string) {
  const f = (v.folders || []).find((x) => x.id === folderId(kind, name));
  if (!f || f.deleted) return;
  f.deleted = true;
  f.updated = Math.max(Date.now(), f.updated + 1);
  f.revision = crypto.randomUUID();
}
function moveItems(v: Vault, kind: FolderKind, from: string, to: string) {
  const items: {
    folder?: string;
    order?: number;
    updated: number;
    revision: string;
    deleted: boolean;
  }[] = kind === "entry" ? v.entries : v.memos;
  for (const x of items)
    if (!x.deleted && (x.folder || "") === from && from) {
      x.folder = to;
      if (!to) delete x.order;
      x.updated = Math.max(Date.now(), x.updated + 1);
      x.revision = crypto.randomUUID();
    }
}
async function handle(m: any, sender: chrome.runtime.MessageSender) {
  if (m.type === "OPEN_PRIVATE") {
    await chrome.windows.create({ incognito: true });
    return;
  }
  if (m.type === "OPEN_SETTINGS") {
    await chrome.tabs.create({
      url: `chrome://extensions/?id=${chrome.runtime.id}`,
    });
    return;
  }
  const sourceId = m.sourceWindowId ?? sender.tab?.windowId;
  const sourceWindow = Number.isInteger(sourceId)
    ? await chrome.windows.get(sourceId)
    : await chrome.windows.getCurrent();
  if (m.type === "STATUS") {
    let unlocked = false;
    try {
      await session();
      unlocked = true;
    } catch {}
    const e = await local();
    const settings = await chrome.storage.local.get([
      "driveEnabled",
      "driveConflict",
      "lastSync",
      "syncError",
    ]);
    return {
      incognito: !!sourceWindow.incognito,
      allowed: await chrome.extension.isAllowedIncognitoAccess(),
      exists: !!e,
      hasRecovery: e?.version === 3 && !!e.keys.recovery,
      unlocked,
      configured: !!(await oauthSource()),
      oauthSource: await oauthSource(),
      oauthClientId: (await userClientId()) || "",
      redirectUrl: chrome.identity?.getRedirectURL?.() || "",
      ...settings,
      // Older versions recorded "locked" as a sync error on every tick.
      syncError: settings.syncError === LOCKED ? "" : settings.syncError || "",
    };
  }
  if (m.type === "LOCK") {
    await lock();
    return;
  }
  if (m.type === "CREATE") {
    if (await local()) throw Error("已有保險庫");
    if (typeof m.password !== "string" || m.password.length < 4)
      throw Error("主密碼至少 4 個字元");
    const generation = lockGeneration;
    const id = crypto.randomUUID();
    const v: Vault = emptyVault(id);
    const dek = await newDataKey();
    const code = newRecoveryCode();
    let keys = await setPassword(dek, id, m.password);
    keys = await setRecovery(dek, id, code.bytes, keys);
    await writeVault(v, dek, keys);
    const sealed = (await local()) as SealedEnvelope;
    await startSession({ v, dek, sealed }, generation);
    return { recoveryKey: code.code };
  }
  if (m.type === "UNLOCK") {
    const generation = lockGeneration;
    const e = await local();
    if (!e) throw Error("尚無保險庫");
    const o = await rateLimited(() => openPassword(e, m.password));
    // "vault" may hold only the bookmarks: read both parts.
    const v = o.sealed === e ? await readVault(o.dek) : o.v;
    if (o.sealed !== e) await writeVault(v, o.dek, o.sealed.keys); // v1 → v3
    await startSession({ ...o, v }, generation);
    await requestSync(0);
    return v;
  }
  if (m.type === "RESTORE") {
    if (await local()) throw Error("只可在空白安裝還原，請先保留現有備份");
    const generation = lockGeneration;
    const o = await rateLimited(() => openPassword(m.envelope, m.password));
    await writeVault(o.v, o.dek, o.sealed.keys);
    await startSession(o, generation);
    return o.v;
  }
  if (m.type === "RECOVER") {
    // Forgot the master password: unlock with the recovery key, set a new
    // password and issue a new recovery key (the old one is now exposed).
    const generation = lockGeneration;
    if (typeof m.newPassword !== "string" || m.newPassword.length < 4)
      throw Error("主密碼至少 4 個字元");
    const existing = await local();
    if (existing && m.envelope)
      throw Error("只可在空白安裝還原，請先保留現有備份");
    const e = validateEnvelope(existing || m.envelope);
    if (e.version !== 3) throw Error("這個保險庫尚未建立救援金鑰");
    const bytes = parseRecoveryCode(m.recoveryKey);
    const dek = await rateLimited(() => openWithRecovery(e, bytes));
    const v = existing ? await readVault(dek) : await decrypt(e, dek);
    const code = newRecoveryCode();
    let keys = await setPassword(dek, e.id, m.newPassword, e.keys);
    keys = await setRecovery(dek, e.id, code.bytes, keys);
    await writeVault(v, dek, keys);
    const sealed = (await local()) as SealedEnvelope;
    await startSession({ v, dek, sealed }, generation);
    await requestSync(0);
    return { recoveryKey: code.code };
  }
  if (m.type === "DRIVE_PROBE") {
    // New installation: is there a vault in Drive to restore? Only lists the
    // app-data folder (nothing is downloaded). Without `interactive` it never
    // shows a Google prompt, so it only answers when this Google account has
    // already authorised Veil Bookmark.
    if (await local()) return { state: "exists" };
    if (!(await oauthSource())) return { state: "unavailable" };
    try {
      const { ids } = await listSnapshots(m.interactive === true);
      return { state: ids.length ? "found" : "empty" };
    } catch (e) {
      if (m.interactive === true) throw e;
      return { state: "unknown" };
    }
  }
  if (m.type === "RESTORE_DRIVE") {
    if (await local()) throw Error("只可在空白安裝從 Drive 還原");
    const generation = lockGeneration;
    const { envelopes } = await readRemote(true);
    const o = await openDrive(envelopes, m.password);
    await writeVault(o.v, o.dek, o.sealed.keys, "all", {
      driveEnabled: true,
      driveConflict: false,
      syncError: "",
    });
    await startSession(o, generation);
    await requestSync(0);
    return o.v;
  }
  if (m.type === "DISCONNECT") {
    await chrome.storage.local.set({
      driveEnabled: false,
      driveConflict: false,
      syncError: "",
    });
    await clearTokens();
    return;
  }
  if (m.type === "SET_CLIENT_ID") {
    await setClientId(m.clientId);
    return;
  }
  if (m.type === "CLEAR_CLIENT_ID") {
    await chrome.storage.local.set({
      driveEnabled: false,
      driveConflict: false,
      syncError: "",
    });
    await clearClientId();
    return;
  }
  if (m.type === "EXPORT") {
    // Backups always hold everything in one envelope.
    return combined(await keyOf(await session()));
  }
  if (m.type === "SYNC") {
    const v = await sync(true, true);
    await chrome.storage.local.set({ driveEnabled: true });
    return v;
  }
  const s = await session();
  const key = await keyOf(s);
  const e = await local();
  if (!e) throw Error("尚無保險庫");
  let v = await readVault(key);
  if (m.type === "LIST") return v;
  if (m.type === "VERIFY_PASSWORD") {
    if (e.version !== 3) throw Error("請先建立或還原保險庫");
    const opened = await rateLimited(() => openWithPassword(e, m.password));
    if ((await exportKey(opened.dek)) !== s.key) throw Error(OTHER_VAULT);
    if ((await session()).nonce !== s.nonce) throw Error("已上鎖，請重新解鎖");
    const proof = {
      verificationToken: crypto.randomUUID(),
      expires: Date.now() + 5 * 60 * 1000,
      nonce: s.nonce,
      id: e.id,
      keysAuth: e.keys.auth,
    };
    await chrome.storage.session.set({ passwordProof: proof });
    return {
      verificationToken: proof.verificationToken,
      expires: proof.expires,
    };
  }
  if (m.type === "CHANGE_PASSWORD") {
    if (typeof m.newPassword !== "string" || m.newPassword.length < 4)
      throw Error("主密碼至少 4 個字元");
    if (m.newPassword !== m.confirmPassword) throw Error("兩次密碼不一致");
    const { passwordProof: p } = await chrome.storage.session.get<{
      passwordProof?: {
        verificationToken: string;
        expires: number;
        nonce: string;
        id: string;
        keysAuth: string;
      };
    }>("passwordProof");
    if (
      e.version !== 3 ||
      !p ||
      p.verificationToken !== m.verificationToken ||
      p.expires <= Date.now() ||
      p.nonce !== s.nonce ||
      p.id !== e.id ||
      p.keysAuth !== e.keys.auth
    )
      throw Error("原密碼驗證已失效，請重新驗證");
    await chrome.storage.session.remove("passwordProof");
    const generation = lockGeneration;
    const keys = await setPassword(key, e.id, m.newPassword, e.keys);
    if (generation !== lockGeneration || (await session()).nonce !== s.nonce)
      throw Error("已上鎖，請重新解鎖");
    await save(v, s, keys);
    await touch(s);
    await requestSync();
    return;
  }
  if (m.type === "RECOVERY_CREATE") {
    // Re-confirm the password: a recovery key is as powerful as the password.
    if (e.version !== 3) throw Error("請先建立或還原保險庫");
    const opened = await rateLimited(() => openWithPassword(e, m.password));
    if ((await exportKey(opened.dek)) !== s.key) throw Error(OTHER_VAULT);
    const code = newRecoveryCode();
    const keys = await setRecovery(key, e.id, code.bytes, e.keys);
    await save(v, s, keys);
    await touch(s);
    await requestSync();
    return { recoveryKey: code.code };
  }
  if (m.type === "DRIVE_USE_REMOTE") {
    // Conflict choice 1: replace this computer's vault with the one in Drive.
    // The page downloads a backup of this vault first.
    const generation = lockGeneration;
    const { envelopes } = await readRemote(true);
    if (envelopes.length && envelopes.every((x) => x.id === e.id))
      return sync(true, true); // Already the same vault (resolved elsewhere).
    const o = await openDrive(envelopes, m.password);
    if (generation !== lockGeneration || (await session()).nonce !== s.nonce)
      throw Error("已上鎖，請重新解鎖");
    await writeVault(o.v, o.dek, o.sealed.keys, "all", {
      driveEnabled: true,
      driveConflict: false,
      syncError: "",
      lastSync: Date.now(),
    });
    await startSession(o, generation);
    return o.v;
  }
  if (m.type === "DRIVE_REPLACE") {
    // Conflict choice 2: keep this computer's vault and delete the Drive one.
    // Re-confirm this vault's password: Drive's copy cannot be recovered.
    if (e.version !== 3) throw Error("請先建立或還原保險庫");
    if (m.confirm !== true) throw Error("請先確認 Drive 上的舊資料將被刪除");
    const opened = await rateLimited(() => openWithPassword(e, m.password));
    if ((await exportKey(opened.dek)) !== s.key) throw Error(OTHER_VAULT);
    const { t, ids } = await listSnapshots(true);
    await session();
    // Upload first: if a delete fails, Drive still has this vault and the
    // choice can be repeated.
    await upload(t, await seal(v, key, e.keys)); // everything, not one part
    await removeSnapshots(t, ids);
    await chrome.storage.local.set({
      driveEnabled: true,
      driveConflict: false,
      syncError: "",
      lastSync: Date.now(),
    });
    return v;
  }
  if (m.type === "TOUCH") {
    await touch(s);
    return;
  }
  if (m.type === "UPSERT") {
    upsertEntry(v, m.entry || {});
    await save(v, s, undefined, "entries");
    await touch(s);
  } else if (m.type === "DELETE") {
    if (deleteEntry(v, m.id)) await save(v, s, undefined, "entries");
    await touch(s);
  } else if (m.type === "MEMO_UPSERT") {
    const memo = upsertMemo(v, m.memo || {});
    await save(v, s, undefined, "memos");
    await touch(s);
    await requestSync();
    return memo;
  } else if (m.type === "MEMO_DELETE") {
    if (deleteMemo(v, m.id)) await save(v, s, undefined, "memos");
    await touch(s);
  } else if (m.type === "MEMO_META") {
    // Title / folder only, from the popup's quick menu (body untouched).
    const x = v.memos.find((y) => y.id === m.id && !y.deleted);
    if (!x) throw Error("記事不存在");
    if (m.title !== undefined)
      x.title = String(m.title || "")
        .trim()
        .slice(0, 300);
    if (m.folder !== undefined) {
      const folder = cleanFolderName(m.folder);
      if (folder !== (x.folder || "")) delete x.order;
      x.folder = folder;
    }
    x.updated = Math.max(Date.now(), x.updated + 1);
    x.revision = crypto.randomUUID();
    await save(v, s, undefined, "memos");
    await touch(s);
  } else if (m.type === "REORDER") {
    // Drag and drop: the full new order of one folder, which may now also
    // contain an item dragged in from another folder.
    const kind = folderKind(m.kind);
    const folder = cleanFolderName(m.folder);
    const ids: string[] = Array.isArray(m.ids) ? m.ids.slice(0, 20000) : [];
    const list: {
      id: string;
      folder?: string;
      order?: number;
      updated: number;
      revision: string;
      deleted: boolean;
    }[] = kind === "entry" ? v.entries : v.memos;
    const byId = new Map(list.filter((x) => !x.deleted).map((x) => [x.id, x]));
    ids.forEach((id, i) => {
      const x = byId.get(String(id));
      if (!x || (x.order === i && (x.folder || "") === folder)) return;
      x.order = i;
      x.folder = folder;
      x.updated = Math.max(Date.now(), x.updated + 1);
      x.revision = crypto.randomUUID();
    });
    if (folder) ensureFolder(v, kind, folder);
    await save(v, s);
    await touch(s);
  } else if (m.type === "FOLDER_ORDER") {
    const kind = folderKind(m.kind);
    const names: string[] = (Array.isArray(m.names) ? m.names : [])
      .slice(0, 5000)
      .map(cleanFolderName)
      .filter(Boolean);
    names.forEach((name, i) => upsertFolder(v, kind, name, i));
    await save(v, s);
    await touch(s);
  } else if (m.type === "FOLDER_CREATE") {
    const kind = folderKind(m.kind);
    const name = cleanFolderName(m.name);
    if (!name) throw Error("請輸入資料夾名稱");
    if (liveFolders(v, kind).includes(name)) throw Error("已有同名資料夾");
    ensureFolder(v, kind, name);
    await save(v, s);
    await touch(s);
  } else if (m.type === "FOLDER_RENAME") {
    const kind = folderKind(m.kind);
    const from = cleanFolderName(m.from);
    const to = cleanFolderName(m.to);
    if (!to) throw Error("請輸入資料夾名稱");
    // Renaming, or moving to another parent ("to" is the new full path).
    renameTree(v, kind, from, to);
    // Optional new order of the siblings at the destination.
    if (Array.isArray(m.order))
      m.order
        .slice(0, 5000)
        .map(cleanFolderName)
        .filter(Boolean)
        .forEach((name: string, i: number) => upsertFolder(v, kind, name, i));
    await save(v, s);
    await touch(s);
  } else if (m.type === "FOLDER_DELETE") {
    // The folder goes away; its bookmarks or notes and its subfolders move
    // up one level (to "Unfiled" for a top-level folder).
    const kind = folderKind(m.kind);
    const name = cleanFolderName(m.name);
    const up = parentOf(name);
    const live = liveFolders(v, kind);
    for (const p of live.filter((p) => within(p, name) && p !== name)) {
      const next = joinPath(up, p.slice(name.length + 1));
      const old = (v.folders || []).find(
        (f) => f.id === folderId(kind, p) && !f.deleted,
      );
      if (!live.includes(next)) upsertFolder(v, kind, next, old?.order);
      removeFolder(v, kind, p);
      moveItems(v, kind, p, next);
    }
    removeFolder(v, kind, name);
    moveItems(v, kind, name, up);
    await save(v, s);
    await touch(s);
  } else if (m.type === "OPEN") {
    const x = v.entries.find((x) => x.id === m.id && !x.deleted);
    if (!x) throw Error("書籤不存在");
    const url = safeUrl(x.url);
    if (m.incognito) await chrome.windows.create({ url, incognito: true });
    else if (Number.isInteger(m.targetTabId)) {
      const tab = await chrome.tabs.get(m.targetTabId);
      if (tab.windowId !== sourceWindow.id)
        throw Error("目標分頁不在目前視窗，請重新開啟浮框再試");
      await chrome.tabs.update(m.targetTabId, { url });
    } else {
      if (sourceWindow.id === undefined)
        throw Error("目前視窗已關閉，請重新開啟浮框");
      await chrome.tabs.create({ url, windowId: sourceWindow.id });
    }
    await touch(s);
    return;
  } else throw Error("未知操作");
  await requestSync();
  return v;
}
function lite(v: Vault): Vault {
  return {
    ...v,
    memos: v.memos.map(
      ({ images: _i, recordings: _r, drawing: _d, ...rest }) => rest,
    ),
  };
}
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const task = queue.then(fn, fn);
  queue = task.then(
    () => {},
    () => {},
  );
  return task;
}
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL("index.html"))
  )
    return;
  (m.type === "LOCK"
    ? lock()
    : serialized(async () => {
        const data = await handle(m, sender);
        if (data && "entries" in data) {
          await session();
          // The popup lists notes but never shows their pictures, audio or
          // drawings: leave those out so large vaults stay quick.
          if (m.lite) return lite(data as Vault);
        }
        return data;
      })
  ).then(
    (data) => respond({ ok: true, data }),
    (e) => respond({ ok: false, error: e.message }),
  );
  return true;
});
{
  chrome.idle.setDetectionInterval(900);
  chrome.idle.onStateChanged.addListener((state) => {
    if (state !== "active") void lock();
  });
  chrome.windows.onCreated.addListener(() => {
    void serialized(async () => {
      try {
        const s = await session();
        s.windowIds = (await chrome.windows.getAll())
          .filter((w) => w.id !== undefined)
          .map((w) => w.id!);
        await chrome.storage.session.set({ session: s });
      } catch {}
    });
  });
  chrome.windows.onRemoved.addListener(() => {
    void (async () => {
      if (
        !(await chrome.windows.getAll({ windowTypes: ["normal", "popup"] }))
          .length
      )
        await lock();
    })();
  });
  chrome.runtime.onStartup.addListener(() => {
    void lock();
  });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === "veilmark-lock") {
      void session().catch(() => {});
      return;
    }
    if (a.name.startsWith("veilmark-sync")) {
      void backgroundSync(); // queues only its merge step
      return;
    }
    void serialized(async () => {
      if (a.name === "veilmark-lock") {
        try {
          await session();
        } catch {}
      }
    });
  });
}
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void chrome.alarms.get("veilmark-sync").then((alarm) => {
  if (!alarm)
    return chrome.alarms.create("veilmark-sync", { periodInMinutes: 5 });
});
