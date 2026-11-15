import {
  b64,
  unb64,
  random,
  derive,
  encrypt,
  decrypt,
  merge,
  safeUrl,
  type Envelope,
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
  key: string;
  id: string;
  salt: string;
  expires: number;
  nonce: string;
  windowIds: number[];
};
let queue = Promise.resolve();
let lockGeneration = 0;
async function lock() {
  lockGeneration++;
  await chrome.storage.session.remove(["session", "capture"]);
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
  return crypto.subtle.importKey(
    "raw",
    unb64(s.key),
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"],
  );
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
async function unlock(e: Envelope, password: string) {
  const generation = lockGeneration;
  const key = await derive(password, e.salt);
  const v = await decrypt(e, key);
  await touch(
    {
      key: b64(new Uint8Array(await crypto.subtle.exportKey("raw", key))),
      id: e.id,
      salt: e.salt,
      expires: 0,
      nonce: crypto.randomUUID(),
      windowIds: [],
    },
    true,
    generation,
  );
  return v;
}
async function local() {
  return (await chrome.storage.local.get("vault")).vault as
    Envelope | undefined;
}
async function save(v: Vault, s: Session) {
  await session();
  await chrome.storage.local.set({
    vault: await encrypt(v, await keyOf(s), s.salt),
  });
}
async function sync(interactive = false) {
  const s = await session();
  const key = await keyOf(s);
  const e = await local();
  if (!e) throw Error("請先建立或還原保險庫");
  let v = await decrypt(e, key);
  const { t, envelopes, ids } = await readRemote(interactive);
  for (const remote of envelopes) {
    if (remote.id !== s.id || remote.salt !== s.salt)
      throw Error(
        "Drive 含有另一個保險庫。請保留本機備份，於新安裝中從 Drive 還原，避免覆蓋。",
      );
    v = merge(v, await decrypt(remote, key));
  }
  await session();
  const snapshot = await encrypt(v, key, s.salt);
  await chrome.storage.local.set({ vault: snapshot });
  const canonical = JSON.stringify(merge(v, v));
  let remoteUnion: Vault = { version: 1, id: v.id, entries: [] };
  for (const remote of envelopes)
    remoteUnion = merge(remoteUnion, await decrypt(remote, key));
  // Upload when Drive is missing changes, or consolidate several snapshots
  // into one so Drive keeps a single current copy.
  if (
    !envelopes.length ||
    envelopes.length > 1 ||
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
    const salt = b64(random(16));
    const key = await derive(m.password, salt);
    const v: Vault = { version: 1, id: crypto.randomUUID(), entries: [] };
    const e = await encrypt(v, key, salt);
    await chrome.storage.local.set({ vault: e });
    await unlock(e, m.password);
    return v;
  }
  if (m.type === "UNLOCK") {
    const { attempts = 0, nextAttempt = 0 } = await chrome.storage.session.get<{
      attempts?: number;
      nextAttempt?: number;
    }>(["attempts", "nextAttempt"]);
    if (Date.now() < nextAttempt) throw Error("嘗試次數過多，請稍後再試");
    const e = await local();
    if (!e) throw Error("尚無保險庫");
    try {
      const v = await unlock(e, m.password);
      await chrome.storage.session.remove(["attempts", "nextAttempt"]);
      return v;
    } catch (err) {
      await chrome.storage.session.set({
        attempts: attempts + 1,
        nextAttempt:
          Date.now() + Math.min(60000, 1000 * 2 ** Math.min(attempts, 6)),
      });
      throw err;
    }
  }
  if (m.type === "RESTORE") {
    if (await local()) throw Error("只可在空白安裝還原，請先保留現有備份");
    const key = await derive(m.password, m.envelope.salt);
    await decrypt(m.envelope, key);
    await chrome.storage.local.set({ vault: m.envelope });
    return unlock(m.envelope, m.password);
  }
  if (m.type === "RESTORE_DRIVE") {
    if (await local()) throw Error("只可在空白安裝從 Drive 還原");
    const { envelopes } = await readRemote(true);
    if (!envelopes.length) throw Error("Drive 尚無 Veil Bookmark 備份");
    const first = envelopes[0];
    const key = await derive(m.password, first.salt);
    let v = await decrypt(first, key);
    for (const e of envelopes) {
      if (e.salt !== first.salt)
        throw Error("Drive 含有不同保險庫，請改用加密檔案還原");
      v = merge(v, await decrypt(e, key));
    }
    const e = await encrypt(v, key, first.salt);
    await chrome.storage.local.set({ vault: e, driveEnabled: true });
    return unlock(e, m.password);
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
