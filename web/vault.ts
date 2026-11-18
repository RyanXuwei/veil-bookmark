// The mobile web app's vault: opened with the master password from the
// encrypted snapshots in Google Drive (or this phone's encrypted copy when
// offline). The data key lives only in memory; edits are re-encrypted, kept
// on the phone and uploaded to Drive like the extension does.
import {
  decrypt,
  merge,
  openWithPassword,
  seal,
  validateEnvelope,
  type Envelope,
  type KeySlots,
  type SealedEnvelope,
  type Vault,
  verifySlots,
} from "../src/crypto";
import { readRemoteWith, removeSnapshots, upload } from "../src/drive";
import { deleteEntry, upsertEntry } from "../src/entry-ops";
import { deleteMemo, upsertMemo } from "../src/memo-ops";
import { mergeSnapshots, VaultMismatch } from "../src/sync-core";
import {
  accountLock,
  account,
  removeAccount,
  activeAccount,
  identify,
  kv,
  workspaceKey,
} from "./accounts";
import { token, forgetToken } from "./google";
import * as bio from "./biometric";

// ---- Encrypted copy on this phone (IndexedDB) -------------------------------
const DB = "veil-bookmark-web";
const cacheGet = () => kv<unknown>(DB, workspaceKey("vault"), "readonly");
// Bookmarks (with folders) and notes are encrypted separately, so saving a
// bookmark does not re-encrypt notes with pictures. Both parts are written in
// one IndexedDB put (atomic). Older copies hold one envelope with everything.
type Part = "entries" | "memos" | "all";
type Layout2 = { layout: 2; a: SealedEnvelope; b: SealedEnvelope };
let lastParts: { a: SealedEnvelope; b: SealedEnvelope; keys: string } | null =
  null;
const entriesPart = (v: Vault): Vault => ({ ...v, memos: [] });
const memosPart = (v: Vault): Vault => ({ ...v, entries: [], folders: [] });
async function cacheWrite(
  v: Vault,
  dek: CryptoKey,
  keys: KeySlots,
  part: Part = "all",
) {
  const storageKey = workspaceKey("vault");
  const k = JSON.stringify(keys);
  const prev =
    lastParts && lastParts.keys === k && lastParts.a.id === v.id
      ? lastParts
      : null;
  const a =
    part === "memos" && prev ? prev.a : await seal(entriesPart(v), dek, keys);
  const b =
    part === "entries" && prev ? prev.b : await seal(memosPart(v), dek, keys);
  const record: Layout2 = { layout: 2, a, b };
  await kv(DB, storageKey, "readwrite", record);
  lastParts = { a, b, keys: k };
}
/** This phone's copy: the envelope that holds the key slots, and a reader. */
function cachedCopy(c: unknown) {
  if (c && (c as Layout2).layout === 2) {
    const a = validateEnvelope((c as Layout2).a);
    const b = validateEnvelope((c as Layout2).b);
    if (a.version !== 3 || b.version !== 3 || a.id !== b.id) return null;
    return {
      env: a,
      read: async (dek: CryptoKey) =>
        merge(await decrypt(a, dek), await decrypt(b, dek)),
    };
  }
  const e = validateEnvelope(c);
  return e.version === 3
    ? { env: e, read: (dek: CryptoKey) => decrypt(e, dek) }
    : null;
}
export const hasCache = async () => {
  try {
    return !!(await cacheGet());
  } catch {
    return false;
  }
};
/** Removes this phone's encrypted copy (Drive is not touched). */
export const clearCache = () => {
  lastParts = null;
  return kv(DB, workspaceKey("vault"), "readwrite", undefined, true);
};

// ---- State ---------------------------------------------------------------
export type SyncState = {
  syncing: boolean;
  lastSync: number;
  error: string;
  // Edits on this phone not yet uploaded (e.g. the Google sign-in expired).
  pending: boolean;
};
let open: { v: Vault; dek: CryptoKey; keys: KeySlots } | null = null;
let sync: SyncState = {
  syncing: false,
  lastSync: 0,
  error: "",
  pending: false,
};
const listeners = new Set<() => void>();
export function subscribe(f: () => void) {
  listeners.add(f);
  return () => void listeners.delete(f);
}
const emit = () => listeners.forEach((f) => f());
export const vault = () => open?.v ?? null;
export const syncState = () => sync;
function setSync(next: Partial<SyncState>) {
  sync = { ...sync, ...next };
  emit();
}

let attempts = 0,
  nextAttempt = 0;
const NOT_FOUND =
  "Google Drive 上還沒有 Veil Bookmark 保險庫。請先在電腦的擴充功能「同步與備份」連接 Google Drive。";

/** Opens the vault with the master password. */
export async function unlock(password: string) {
  if (Date.now() < nextAttempt) throw Error("嘗試次數過多，請稍後再試");
  await serialized(() =>
    openVault(async (first) => {
      try {
        const { dek } = await openWithPassword(first, password);
        attempts = 0;
        return dek;
      } catch (e) {
        nextAttempt =
          Date.now() + Math.min(60000, 1000 * 2 ** Math.min(attempts++, 6));
        throw e;
      }
    }),
  );
  await bio.passwordUsed(open!.v.id);
}

/** Opens the vault with Face ID / fingerprint (see biometric.ts). The
 *  biometric prompt comes first: Safari only allows it right after a tap. */
export async function unlockBiometric() {
  const k = await bio.unlockKey();
  await serialized(() =>
    openVault(async (first) => {
      try {
        if (first.id !== k.vault) throw Error();
        await verifySlots(k.dek, first.id, first.keys);
        return k.dek;
      } catch {
        await bio.disable();
        throw Error("生物辨識資料已失效，請輸入主密碼後重新啟用");
      }
    }),
  );
}

/** Turns on biometric unlock for the open vault. */
export async function enableBiometric() {
  if (!open) throw Error("已上鎖，請重新解鎖");
  await bio.enable(open.dek, open.v.id);
}

async function openVault(key: (first: SealedEnvelope) => Promise<CryptoKey>) {
  if (activeAccount() !== "legacy" && !account())
    throw Error("請先連接 Google Drive");
  const t = token();
  let remote: Envelope[] = [];
  let ids: string[] = [];
  if (t) {
    if ((await identify(t)).id !== activeAccount())
      throw Error("Google 帳戶與工作區不符，已停止同步");
    ({ envelopes: remote, ids } = await readRemoteWith(t));
  }
  let cached: ReturnType<typeof cachedCopy> = null;
  try {
    const c = await cacheGet();
    if (c) cached = cachedCopy(c);
  } catch {}
  const sealed = remote
    .filter((x): x is SealedEnvelope => x.version === 3)
    .sort((a, b) => b.keys.updated - a.keys.updated);
  const first = sealed[0] || (t && remote.length ? null : cached?.env);
  if (!first)
    throw Error(
      remote.length
        ? "請先在電腦上用最新版的擴充功能同步一次，再用手機開啟。"
        : t
          ? NOT_FOUND
          : "請先連接 Google Drive",
    );
  const dek = await key(first);
  let v =
    cached && first === cached.env
      ? await cached.read(dek)
      : await decrypt(first, dek);
  let keys = first.keys;
  // Edits made on this phone that were not uploaded yet.
  if (cached && first !== cached.env && cached.env.id === v.id)
    try {
      v = merge(v, await cached.read(dek));
    } catch {}
  lastParts = null;
  open = { v, dek, keys };
  await cacheWrite(v, dek, keys);
  setSync({ pending: true });
  if (t) void syncNow(remote, ids);
  emit();
}

export function lock() {
  open = null;
  lastParts = null;
  clearTimeout(timer);
  emit();
}

// ---- Sync ----------------------------------------------------------------
let queue: Promise<unknown> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
function serialized<T>(fn: () => Promise<T>) {
  const run = () => accountLock(fn);
  const r = queue.then(run, run);
  queue = r.catch(() => {});
  return r;
}

/** Merges Drive's snapshots and uploads this phone's changes. */
export function syncNow(pre?: Envelope[], preIds?: string[]) {
  return serialized(async () => {
    const o = open;
    if (!o) return;
    const t = token();
    if (!t) {
      setSync({ error: "", pending: true });
      return;
    }
    setSync({ syncing: true });
    try {
      if ((await identify(t)).id !== activeAccount())
        throw Error("Google 帳戶與工作區不符，已停止同步");
      await refreshLocal(o);
      const base = o.v;
      const r = pre
        ? { envelopes: pre, ids: preIds! }
        : await readRemoteWith(t);
      const m = await mergeSnapshots({
        v: o.v,
        dek: o.dek,
        keys: o.keys,
        envelopes: r.envelopes,
      });
      if (open !== o) return; // Locked meanwhile.
      // Keep edits made on this phone while Drive was being read.
      const edited = o.v !== base;
      const next = edited ? merge(m.v, o.v) : m.v;
      o.v = { ...next };
      o.keys = m.keys;
      if (edited) soon();
      await cacheWrite(next, o.dek, m.keys);
      if (m.upload) {
        // Drive keeps one envelope with everything.
        await upload(t, await seal(next, o.dek, m.keys));
        // Snapshots that could not be read are kept, never deleted.
        await removeSnapshots(
          t,
          r.ids.filter((_, i) => !m.damaged.includes(i)),
        );
      }
      setSync({
        syncing: false,
        lastSync: Date.now(),
        error: "",
        pending: edited,
      });
    } catch (e) {
      setSync({
        syncing: false,
        pending: true,
        error:
          e instanceof VaultMismatch
            ? "Google Drive 上的保險庫已被更換。請上鎖後用新的主密碼重新開啟。"
            : (e as Error).message,
      });
    }
  });
}
function soon() {
  clearTimeout(timer);
  setSync({ pending: true });
  timer = setTimeout(() => void syncNow(), 800);
}

// ---- Edits ---------------------------------------------------------------
async function save(part: Part) {
  const o = open!;
  await cacheWrite(o.v, o.dek, o.keys, part);
  emit();
  soon();
}
async function refreshLocal(o: NonNullable<typeof open>) {
  const c = await cacheGet();
  if (!c) return;
  const parts = c as Layout2;
  if (
    parts.layout === 2 &&
    lastParts &&
    parts.a.ciphertext === lastParts.a.ciphertext &&
    parts.a.iv === lastParts.a.iv &&
    parts.b.ciphertext === lastParts.b.ciphertext &&
    parts.b.iv === lastParts.b.iv
  )
    return;
  const saved = cachedCopy(c);
  if (!saved || saved.env.id !== o.v.id)
    throw Error("Google 帳戶與工作區不符，已停止同步");
  await verifySlots(o.dek, o.v.id, saved.env.keys);
  o.v = merge(o.v, await saved.read(o.dek));
  if (saved.env.keys.updated > o.keys.updated) o.keys = saved.env.keys;
  lastParts = null;
}
function edit<T>(fn: (v: Vault) => T, part: Part): Promise<T> {
  return serialized(async () => {
    if (activeAccount() !== "legacy" && !account())
      throw Error("請先連接 Google Drive");
    const o = open;
    if (!o) throw Error("已上鎖，請重新解鎖");
    await refreshLocal(o);
    if (open !== o) throw Error("已上鎖，請重新解鎖");
    const result = fn(o.v);
    o.v = { ...o.v };
    await save(part);
    return result;
  });
}
export const saveEntry = (x: Parameters<typeof upsertEntry>[1]) =>
  edit((v) => upsertEntry(v, x), "entries");
export const removeEntry = (id: string) =>
  edit((v) => deleteEntry(v, id), "entries");
export const saveMemo = (x: Record<string, unknown>) =>
  edit((v) => upsertMemo(v, x), "memos");
export const removeMemo = (id: string) =>
  edit((v) => deleteMemo(v, id), "memos");
/** Drain storage and synchronization before changing the selection. */
export async function prepareAccountSwitch() {
  await serialized(async () => {
    lock();
  });
  sync = { syncing: false, lastSync: 0, error: "", pending: false };
  emit();
}

export async function removeWorkspace() {
  await serialized(async () => {
    lock();
    await clearCache();
    await bio.disable();
    forgetToken();
    removeAccount();
  });
}
