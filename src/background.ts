import {
  derive,
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
} from "./crypto";
import {
  clearClientId,
  clearTokens,
  oauthSource,
  readRemote,
  removeSnapshots,
  setClientId,
  upload,
  userClientId,
} from "./drive";
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
  if (!s) throw Error("已上鎖，請重新解鎖");
  if (s.expires <= Date.now()) {
    await lock();
    throw Error("已上鎖，請重新解鎖");
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
async function localKeys(): Promise<KeySlots> {
  const e = await local();
  if (!e || e.version !== 3) throw Error("請先建立或還原保險庫");
  return e.keys;
}
async function save(v: Vault, s: Session, keys?: KeySlots) {
  await session();
  const k = keys || (await localKeys());
  await chrome.storage.local.set({
    vault: await seal(v, await keyOf(s), k),
  });
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
async function sync(interactive = false) {
  const s = await session();
  const dek = await keyOf(s);
  const e = await local();
  if (!e) throw Error("請先建立或還原保險庫");
  let keys = await localKeys();
  let v = await decrypt(e, dek);
  const { t, envelopes, ids } = await readRemote(interactive);
  const remoteVaults: Vault[] = [];
  let stale = false;
  for (const remote of envelopes) {
    if (remote.id !== s.id) throw Error(OTHER_VAULT);
    let rv: Vault;
    if (remote.version === 1) {
      // Legacy snapshot from before key slots: readable with the old password key.
      if (!s.legacy || remote.salt !== s.legacy.salt) throw Error(OTHER_VAULT);
      rv = await decrypt(remote, await importKey(s.legacy.kek));
      stale = true;
    } else {
      try {
        await verifySlots(dek, s.id, remote.keys);
        rv = await decrypt(remote, dek);
      } catch {
        throw Error(OTHER_VAULT);
      }
      // The newest key slots win, e.g. after a password reset on another device.
      if (remote.keys.updated > keys.updated) keys = remote.keys;
      if (remote.keys.updated !== keys.updated) stale = true;
    }
    remoteVaults.push(rv);
    v = merge(v, rv);
  }
  if (envelopes.some((r) => r.version === 3 && r.keys.updated < keys.updated))
    stale = true;
  await session();
  const snapshot = await seal(v, dek, keys);
  await chrome.storage.local.set({ vault: snapshot });
  const canonical = JSON.stringify(merge(v, v));
  let remoteUnion: Vault = emptyVault(v.id);
  for (const rv of remoteVaults) remoteUnion = merge(remoteUnion, rv);
  // Upload when Drive is missing changes or newer keys, or consolidate several
  // snapshots into one so Drive keeps a single current copy.
  if (
    !envelopes.length ||
    envelopes.length > 1 ||
    stale ||
    JSON.stringify(remoteUnion) !== canonical
  ) {
    await upload(t, snapshot);
    await removeSnapshots(t, ids);
  }
  await chrome.storage.local.set({ lastSync: Date.now(), syncError: "" });
  return v;
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
    const sealed = await seal(v, dek, keys);
    await chrome.storage.local.set({ vault: sealed });
    await startSession({ v, dek, sealed }, generation);
    return { recoveryKey: code.code };
  }
  if (m.type === "UNLOCK") {
    const generation = lockGeneration;
    const e = await local();
    if (!e) throw Error("尚無保險庫");
    const o = await rateLimited(() => openPassword(e, m.password));
    if (o.sealed !== e) await chrome.storage.local.set({ vault: o.sealed });
    await startSession(o, generation);
    return o.v;
  }
  if (m.type === "RESTORE") {
    if (await local()) throw Error("只可在空白安裝還原，請先保留現有備份");
    const generation = lockGeneration;
    const o = await rateLimited(() => openPassword(m.envelope, m.password));
    await chrome.storage.local.set({ vault: o.sealed });
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
    const v = await decrypt(e, dek);
    const code = newRecoveryCode();
    let keys = await setPassword(dek, e.id, m.newPassword, e.keys);
    keys = await setRecovery(dek, e.id, code.bytes, keys);
    const sealed = await seal(v, dek, keys);
    await chrome.storage.local.set({ vault: sealed });
    await startSession({ v, dek, sealed }, generation);
    return { recoveryKey: code.code };
  }
  if (m.type === "RESTORE_DRIVE") {
    if (await local()) throw Error("只可在空白安裝從 Drive 還原");
    const generation = lockGeneration;
    const { envelopes } = await readRemote(true);
    if (!envelopes.length) throw Error("Drive 尚無 Veil Bookmark 備份");
    // Open with the newest key slots so a password reset elsewhere is honoured.
    const sealedOnes = envelopes
      .filter((x): x is SealedEnvelope => x.version === 3)
      .sort((a, b) => b.keys.updated - a.keys.updated);
    const first = sealedOnes[0] || envelopes[0];
    const o = await rateLimited(() => openPassword(first, m.password));
    let v = o.v;
    for (const e of envelopes) {
      if (e.id !== o.sealed.id)
        throw Error("Drive 含有不同保險庫，請改用加密檔案還原");
      try {
        v = merge(
          v,
          e.version === 1
            ? await decrypt(e, await derive(m.password, e.salt))
            : await decrypt(e, o.dek),
        );
      } catch {
        throw Error("Drive 含有不同保險庫，請改用加密檔案還原");
      }
    }
    const sealed = await seal(v, o.dek, o.sealed.keys);
    await chrome.storage.local.set({ vault: sealed, driveEnabled: true });
    await startSession({ ...o, v, sealed }, generation);
    return v;
  }
  if (m.type === "DISCONNECT") {
    await chrome.storage.local.set({ driveEnabled: false });
    await clearTokens();
    return;
  }
  if (m.type === "SET_CLIENT_ID") {
    await setClientId(m.clientId);
    return;
  }
  if (m.type === "CLEAR_CLIENT_ID") {
    await chrome.storage.local.set({ driveEnabled: false });
    await clearClientId();
    return;
  }
  if (m.type === "EXPORT") {
    await session();
    return local();
  }
  if (m.type === "SYNC") {
    const v = await sync(true);
    await chrome.storage.local.set({ driveEnabled: true });
    return v;
  }
  const s = await session();
  const key = await keyOf(s);
  const e = await local();
  if (!e) throw Error("尚無保險庫");
  let v = await decrypt(e, key);
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
    const { driveEnabled } = await chrome.storage.local.get("driveEnabled");
    if (driveEnabled)
      await chrome.alarms.create("veilmark-sync-soon", { delayInMinutes: 0.5 });
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
    const { driveEnabled } = await chrome.storage.local.get("driveEnabled");
    if (driveEnabled)
      await chrome.alarms.create("veilmark-sync-soon", { delayInMinutes: 0.5 });
    return { recoveryKey: code.code };
  }
  if (m.type === "TOUCH") {
    await touch(s);
    return;
  }
  if (m.type === "UPSERT") {
    const old = v.entries.find((x) => x.id === m.entry.id);
    const x = m.entry;
    const entry: Entry = {
      id: old?.id || crypto.randomUUID(),
      title: String(x.title || "")
        .trim()
        .slice(0, 300),
      url: safeUrl(String(x.url)),
      folder: String(x.folder || "")
        .trim()
        .slice(0, 100),
      tags: String(x.tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 30),
      notes: String(x.notes || "").slice(0, 5000),
      updated: Math.max(Date.now(), (old?.updated || 0) + 1),
      revision: crypto.randomUUID(),
      deleted: false,
    };
    if (!entry.title) throw Error("請填寫書籤名稱");
    v.entries = v.entries.filter((x) => x.id !== entry.id).concat(entry);
    await save(v, s);
    await touch(s);
  } else if (m.type === "DELETE") {
    const x = v.entries.find((x) => x.id === m.id);
    if (x) {
      x.deleted = true;
      x.updated = Math.max(Date.now(), x.updated + 1);
      x.revision = crypto.randomUUID();
      await save(v, s);
    }
    await touch(s);
  } else if (m.type === "MEMO_UPSERT") {
    const x = m.memo || {};
    const old = v.memos.find((y) => y.id === x.id);
    const body = String(x.body || "");
    if (body.length > MEMO_MAX) throw Error("記事內容過長");
    const memo: Memo = {
      id: old?.id || crypto.randomUUID(),
      title: String(x.title || "")
        .trim()
        .slice(0, 300),
      body,
      format: x.format === "html" ? "html" : "text",
      updated: Math.max(Date.now(), (old?.updated || 0) + 1),
      revision: crypto.randomUUID(),
      deleted: false,
    };
    const visible =
      memo.format === "html"
        ? memo.body.replace(/<[^>]*>|&nbsp;/g, "").trim()
        : memo.body.trim();
    if (!memo.title && !visible) throw Error("請輸入記事標題或內容");
    if (!old && v.memos.filter((y) => !y.deleted).length >= 5000)
      throw Error("記事數量已達上限");
    v.memos = v.memos.filter((y) => y.id !== memo.id).concat(memo);
    await save(v, s);
    await touch(s);
    const { driveEnabled } = await chrome.storage.local.get("driveEnabled");
    if (driveEnabled)
      await chrome.alarms.create("veilmark-sync-soon", { delayInMinutes: 0.5 });
    return memo;
  } else if (m.type === "MEMO_DELETE") {
    const x = v.memos.find((y) => y.id === m.id);
    if (x) {
      x.deleted = true;
      x.body = "";
      x.title = "";
      x.updated = Math.max(Date.now(), x.updated + 1);
      x.revision = crypto.randomUUID();
      await save(v, s);
    }
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
  const { driveEnabled } = await chrome.storage.local.get("driveEnabled");
  if (driveEnabled)
    await chrome.alarms.create("veilmark-sync-soon", { delayInMinutes: 0.5 });
  return v;
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
        if (data && "entries" in data) await session();
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
    void serialized(async () => {
      if (a.name === "veilmark-lock") {
        try {
          await session();
        } catch {}
      } else if (a.name.startsWith("veilmark-sync")) {
        const { driveEnabled } = await chrome.storage.local.get("driveEnabled");
        if (driveEnabled)
          try {
            await sync();
          } catch (e) {
            await chrome.storage.local.set({ syncError: (e as Error).message });
          }
      }
    });
  });
}
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void chrome.alarms.get("veilmark-sync").then((alarm) => {
  if (!alarm)
    return chrome.alarms.create("veilmark-sync", { periodInMinutes: 5 });
});
