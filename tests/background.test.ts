import { test } from "node:test";
import assert from "node:assert/strict";
const local: Record<string, any> = {},
  session: Record<string, any> = {};
const listeners: Record<string, Function> = {};
const alarms: Record<string, any> = {};
let fakeWindows: any[] = [{ id: 1, incognito: true }];
let fakeNow = Date.now();
const realNow = Date.now;
Date.now = () => fakeNow;
const event = (name: string) => ({
  addListener: (f: Function) => {
    listeners[name] = f;
  },
});

// chrome.storage stores values like base::Value dictionaries: object keys come
// back sorted, not in insertion order. Mimic that so order bugs surface here.
const sortKeys = (x: any): any =>
  Array.isArray(x)
    ? x.map(sortKeys)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, sortKeys(x[k])]),
        )
      : x;
const store = (data: Record<string, any>) => ({
  get: async (keys: any) => {
    if (keys === null) return { ...data };
    const result: Record<string, any> = {};
    for (const k of typeof keys === "string" ? [keys] : keys)
      if (k in data) result[k] = data[k];
    return structuredClone(result);
  },
  set: async (x: any) => {
    Object.assign(data, sortKeys(structuredClone(x)));
  },
  remove: async (keys: any) => {
    for (const k of typeof keys === "string" ? [keys] : keys) delete data[k];
  },
  setAccessLevel: async () => {},
});
(globalThis as any).chrome = {
  runtime: {
    id: "test",
    getURL: (s: string) => `chrome-extension://test/${s}`,
    getManifest: () => ({}),
    getContexts: async ({ documentIds }: any) =>
      documentIds.map((documentId: string) => ({
        documentId,
        incognito: documentId === "private-doc",
      })),
    onMessage: event("message"),
    onStartup: event("startup"),
    onInstalled: event("installed"),
  },
  contextMenus: {
    removeAll: async () => {},
    create: () => {},
    onClicked: event("menu"),
  },
  i18n: { getMessage: () => "" },
  extension: {
    inIncognitoContext: true,
    isAllowedIncognitoAccess: async () => true,
  },
  storage: {
    local: store(local),
    session: store(session),
    onChanged: event("storage"),
  },
  alarms: {
    get: async (n: string) => alarms[n],
    create: async (n: string, v: any) => {
      alarms[n] = v;
    },
    clear: async (n: string) => {
      delete alarms[n];
    },
    onAlarm: event("alarm"),
  },
  action: {
    onClicked: event("action"),
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {},
    openPopup: async () => {},
  },
  idle: { setDetectionInterval: () => {}, onStateChanged: event("idle") },
  windows: {
    onCreated: event("created"),
    onRemoved: event("removed"),
    get: async (id: number) => fakeWindows.find((w) => w.id === id),
    getCurrent: async () => fakeWindows[0] || {},
    getAll: async () => fakeWindows,
  },
  tabs: {
    create: async () => {},
    onCreated: event("tab-created"),
    onUpdated: event("tab-updated"),
  },
};
// Background quick-sync timers are captured instead of run, so tests decide
// when they fire and no stray sync runs between tests.
const quickTimers = new Map<number, { fn: Function; ms: number }>();
let timerId = 0;
const realSetTimeout = globalThis.setTimeout,
  realClearTimeout = globalThis.clearTimeout;
(globalThis as any).setTimeout = (fn: Function, ms = 0, ...a: any[]) => {
  if (/src[\\/]background\.ts/.test(new Error().stack || "")) {
    quickTimers.set(++timerId, { fn, ms });
    return timerId;
  }
  return realSetTimeout(fn as any, ms, ...a);
};
(globalThis as any).clearTimeout = (id: any) => {
  if (quickTimers.delete(id)) return;
  realClearTimeout(id);
};
await import("../src/background");
const rpc = (type: string, data: any = {}, incognito = true) =>
  new Promise<any>((resolve, reject) =>
    listeners.message(
      { type, ...data },
      {
        id: "test",
        url: "chrome-extension://test/index.html",
        documentId: incognito ? "private-doc" : "normal-doc",
        tab: incognito ? undefined : { incognito: false },
      },
      (r: any) => (r.ok ? resolve(r.data) : reject(Error(r.error))),
    ),
  );
test("background encryption, CRUD, export, lock, expiry and restart/session recovery", async () => {
  try {
    assert.equal((await rpc("STATUS")).exists, false);
    await assert.rejects(rpc("CREATE", { password: "123" }));
    await rpc("CREATE", { password: "1234" });
    assert(session.session);
    assert.equal((await rpc("STATUS")).unlocked, true);
    assert.equal(local.vault.entries, undefined);
    const v = await rpc("UPSERT", {
      entry: {
        title: "secret title",
        url: "https://example.com",
        folder: "秘密",
        tags: "a,b",
        notes: "private",
      },
    });
    assert.equal(v.entries.length, 1);
    assert(!JSON.stringify(local).includes("secret title"));
    assert.equal((await rpc("LIST")).entries[0].notes, "private");
    await rpc("LOCK");
    assert(!session.session);
    await assert.rejects(rpc("LIST"));
    await assert.rejects(rpc("UNLOCK", { password: "wrong" }));
    fakeNow += 2000;
    await rpc("UNLOCK", { password: "1234" });
    await rpc("DELETE", { id: v.entries[0].id });
    assert.equal((await rpc("LIST")).entries[0].deleted, true);
    const backup = await rpc("EXPORT");
    await rpc("LOCK");
    delete local.vault;
    await rpc("RESTORE", { password: "1234", envelope: backup });
    assert.equal((await rpc("LIST")).entries[0].deleted, true);
    fakeNow += 15 * 60 * 1000 + 1;
    await assert.rejects(rpc("LIST"));
    assert(!session.session);
    await rpc("UNLOCK", { password: "1234" });
    listeners.idle("locked");
    await rpc("STATUS");
    assert(!session.session);
    await rpc("UNLOCK", { password: "1234" });
    fakeWindows = [];
    listeners.removed();
    await rpc("STATUS");
    assert(!session.session);
    fakeWindows = [{ id: 2, incognito: true }];
    await rpc("UNLOCK", { password: "1234" });
    listeners.startup();
    await rpc("STATUS");
    assert(!session.session);
    await assert.rejects(rpc("SYNC"), /上鎖/);
  } finally {
    Date.now = realNow;
  }
});
test("Drive encrypted snapshot merge, no-op sync, tombstones, consolidation cleanup, vanished snapshots, different vault rejection and HTTP failure", async () => {
  const { decrypt, importKey, seal } = await import("../src/crypto");
  const originalFetch = globalThis.fetch;
  const remote = new Map<string, any>();
  let nextId = 0;
  const deleted: string[] = [];
  let ghost = false;
  let posts = 0;
  let fail = false;
  (chrome.runtime.getManifest as any) = () => ({
    oauth2: { client_id: "test.apps.googleusercontent.com" },
  });
  (chrome as any).identity = {
    getAuthToken: async () => ({ token: "synthetic-token" }),
    removeCachedAuthToken: async () => {},
    clearAllCachedAuthTokens: async () => {},
  };
  globalThis.fetch = async (input: any, init: any = {}) => {
    const u = String(input);
    assert.equal(init.headers.Authorization, "Bearer synthetic-token");
    if (fail) return new Response("", { status: 503 });
    if (init.method === "POST") {
      const body = String(init.body);
      const json = body
        .split("Content-Type: application/json\r\n\r\n")[1]
        .split("\r\n--")[0];
      const id = String(nextId++);
      remote.set(id, JSON.parse(json));
      posts++;
      return Response.json({ id });
    }
    const id = decodeURIComponent(u.split("/files/")[1]?.split("?")[0] || "");
    if (init.method === "DELETE") {
      deleted.push(id);
      return new Response(null, { status: remote.delete(id) ? 204 : 404 });
    }
    if (u.includes("alt=media"))
      return remote.has(id)
        ? Response.json(remote.get(id))
        : new Response("", { status: 404 });
    const ids = [...remote.keys(), ...(ghost ? ["vanished"] : [])];
    return Response.json({ files: ids.map((id) => ({ id })) });
  };
  try {
    await rpc("UNLOCK", { password: "1234" });
    await rpc("SYNC");
    assert.equal(posts, 1);
    await rpc("SYNC");
    assert.equal(posts, 1);
    const key = await importKey(session.session.key);
    const cloud = await decrypt(local.vault, key);
    cloud.entries.push({
      id: "remote-new",
      title: "remote secret",
      url: "https://example.org",
      folder: "cloud",
      tags: [],
      notes: "remote note",
      updated: Date.now(),
      revision: "remote-revision",
      deleted: false,
    });
    remote.set("other-device", await seal(cloud, key, local.vault.keys));
    const merged = await rpc("SYNC");
    assert(merged.entries.some((x: any) => x.id === "remote-new"));
    assert(merged.entries.some((x: any) => x.deleted));
    // Two snapshots are consolidated into one; both read snapshots are removed.
    assert.equal(posts, 2);
    assert.deepEqual(deleted.sort(), ["0", "other-device"]);
    assert.equal(remote.size, 1);
    const [only] = remote.values();
    assert(
      (await decrypt(only, key)).entries.some(
        (x: any) => x.id === "remote-new",
      ),
    );
    // A snapshot that disappears between listing and download is skipped.
    ghost = true;
    await rpc("SYNC");
    ghost = false;
    assert.equal(posts, 2);
    await rpc("UPSERT", {
      entry: { title: "local change", url: "https://example.net" },
    });
    await rpc("SYNC");
    assert.equal(posts, 3);
    assert.equal(remote.size, 1, "Drive keeps one current snapshot");
    const cloudText = JSON.stringify([...remote.values()]);
    assert(!cloudText.includes("local change"));
    assert(!cloudText.includes("remote secret"));
    const before = structuredClone(local.vault);
    fail = true;
    await assert.rejects(rpc("SYNC"), /503/);
    assert.deepEqual(local.vault, before);
    fail = false;
    remote.set("foreign", {
      ...[...remote.values()][0],
      id: "different-vault",
    });
    const sizeBefore = remote.size;
    await assert.rejects(rpc("SYNC"), /另一個保險庫/);
    assert.deepEqual(local.vault, before);
    assert.equal(remote.size, sizeBefore, "nothing is deleted on rejection");
    remote.delete("foreign");
    const normalFetch = globalThis.fetch;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const waiting = new Promise<void>((r) => (started = r));
    globalThis.fetch = async (...args) => {
      started();
      await gate;
      return normalFetch(...args);
    };
    const inFlight = rpc("SYNC");
    const rejected = assert.rejects(inFlight, /上鎖/);
    await waiting;
    await rpc("LOCK");
    assert(!session.session, "locking must not wait behind a network request");
    release();
    await rejected;
    assert(!session.session, "in-flight sync must not restore the removed key");
  } finally {
    globalThis.fetch = originalFetch;
    await rpc("LOCK");
  }
});

test("normal and private contexts share the encrypted vault and session", async () => {
  await rpc("UNLOCK", { password: "1234" }, false);
  const normal = await rpc("LIST", {}, false);
  const privateView = await rpc("LIST");
  assert.deepEqual(normal, privateView);
  await rpc(
    "UPSERT",
    { entry: { title: "normal mode", url: "https://example.com/normal" } },
    false,
  );
  assert(
    (await rpc("LIST")).entries.some((x: any) => x.title === "normal mode"),
  );
  await rpc("LOCK", {}, false);
  await assert.rejects(rpc("LIST"), /上鎖/);
});

test("runtime client ID: validation, web auth flow, token cache, state check, 401 reset and removal", async () => {
  const originalFetch = globalThis.fetch;
  (chrome.runtime.getManifest as any) = () => ({});
  let flows = 0;
  let mode: "ok" | "badState" | "noScope" | "cancel" = "ok";
  const seen: string[] = [];
  (chrome as any).identity = {
    getRedirectURL: () => "https://test.chromiumapp.org/",
    launchWebAuthFlow: async ({ url, interactive }: any) => {
      flows++;
      const u = new URL(url);
      seen.push(
        `${u.searchParams.get("client_id")}|${interactive}|${u.searchParams.get("prompt")}`,
      );
      assert.equal(
        u.searchParams.get("redirect_uri"),
        "https://test.chromiumapp.org/",
      );
      assert.equal(u.searchParams.get("response_type"), "token");
      if (mode === "cancel") throw Error("The user did not approve access.");
      const state =
        mode === "badState" ? "forged" : u.searchParams.get("state");
      const scope = mode === "noScope" ? "openid" : u.searchParams.get("scope");
      return `https://test.chromiumapp.org/#access_token=web-token-${flows}&expires_in=3600&token_type=Bearer&scope=${encodeURIComponent(scope!)}&state=${state}`;
    },
    clearAllCachedAuthTokens: async () => {},
    removeCachedAuthToken: async () => {},
  };
  let unauthorized = false;
  const auth: string[] = [];
  globalThis.fetch = async (input: any, init: any = {}) => {
    auth.push(init.headers.Authorization);
    if (unauthorized) return new Response("", { status: 401 });
    if (init.method === "POST") return Response.json({ id: "x" });
    return Response.json({ files: [] });
  };
  try {
    delete local.oauthClientId;
    let st = await rpc("STATUS");
    assert.equal(st.configured, false);
    assert.equal(st.redirectUrl, "https://test.chromiumapp.org/");
    await assert.rejects(
      rpc("SET_CLIENT_ID", { clientId: "not-a-client" }),
      /用戶端 ID/,
    );
    await assert.rejects(
      rpc("SET_CLIENT_ID", { clientId: "x.apps.googleusercontent.com/evil" }),
      /用戶端 ID/,
    );
    await rpc("SET_CLIENT_ID", {
      clientId: "  123-abc.apps.googleusercontent.com ",
    });
    st = await rpc("STATUS");
    assert.equal(st.configured, true);
    assert.equal(st.oauthSource, "user");
    assert.equal(st.oauthClientId, "123-abc.apps.googleusercontent.com");

    await rpc("UNLOCK", { password: "1234" });
    await rpc("SYNC");
    assert.equal(flows, 1);
    assert.equal(seen[0], "123-abc.apps.googleusercontent.com|true|null");
    assert(auth.every((h) => h === "Bearer web-token-1"));
    await rpc("SYNC");
    assert.equal(flows, 1, "cached token is reused");

    unauthorized = true;
    await assert.rejects(rpc("SYNC"), /授權已失效/);
    assert(!session.driveToken, "401 clears the cached token");
    unauthorized = false;

    mode = "badState";
    await assert.rejects(rpc("SYNC"), /回應無效/);
    mode = "noScope";
    await assert.rejects(rpc("SYNC"), /允許存取應用程式資料/);
    mode = "cancel";
    await assert.rejects(rpc("SYNC"), /未完成或已取消/);
    assert(
      !JSON.stringify(local).includes("web-token"),
      "tokens never reach persistent storage",
    );

    mode = "ok";
    await rpc("SYNC");
    await rpc("CLEAR_CLIENT_ID");
    assert(!local.oauthClientId && !session.driveToken);
    assert.equal(local.driveEnabled, false);
    assert.equal((await rpc("STATUS")).configured, false);
    await assert.rejects(rpc("SYNC"), /尚未設定/);
  } finally {
    globalThis.fetch = originalFetch;
    await rpc("LOCK");
  }
});

test("memo create, edit, delete tombstone, limits, and lock protection", async () => {
  await rpc("UNLOCK", { password: "1234" });
  local.driveEnabled = true;
  delete alarms["veilmark-sync-soon"];
  await assert.rejects(
    rpc("MEMO_UPSERT", { memo: { title: " ", body: " " } }),
    /記事標題或內容/,
  );
  await assert.rejects(
    rpc("MEMO_UPSERT", { memo: { title: "big", body: "x".repeat(500_001) } }),
    /過長/,
  );
  const created = await rpc("MEMO_UPSERT", {
    memo: { title: "銀行提示", body: "secret memo text" },
  });
  assert(created.id);
  assert.equal(
    alarms["veilmark-sync-soon"]?.delayInMinutes,
    0.5,
    "new notebook edits must schedule sync just like bookmarks",
  );
  delete alarms["veilmark-sync-soon"];
  const edited = await rpc("MEMO_UPSERT", {
    memo: { id: created.id, title: "銀行提示", body: "updated text" },
  });
  assert.equal(edited.id, created.id);
  assert(edited.updated > created.updated);
  assert.equal(alarms["veilmark-sync-soon"]?.delayInMinutes, 0.5);
  local.driveEnabled = false;
  let v = await rpc("LIST");
  assert.equal(v.memos.filter((x: any) => !x.deleted).length, 1);
  assert(
    !JSON.stringify(local.vault).includes("updated text"),
    "memo stays encrypted at rest",
  );
  await rpc("MEMO_DELETE", { id: created.id });
  v = await rpc("LIST");
  const tomb = v.memos.find((x: any) => x.id === created.id);
  assert.equal(tomb.deleted, true);
  assert.equal(tomb.body, "", "deleted memo content is wiped");
  await rpc("LOCK");
  await assert.rejects(
    rpc("MEMO_UPSERT", { memo: { title: "x", body: "y" } }),
    /上鎖/,
  );
});

test("recovery key: create, forgot-password reset, rotation, fresh-install recovery, legacy migration and synced key slots", async () => {
  const c = await import("../src/crypto");
  const clearAttempts = () => {
    delete session.attempts;
    delete session.nextAttempt;
  };
  await rpc("LOCK");
  delete local.vault;
  delete local.driveEnabled;
  const { recoveryKey } = await rpc("CREATE", { password: "1234" });
  assert.match(recoveryKey, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  assert.equal(local.vault.version, 3);
  assert(!JSON.stringify(local).includes(recoveryKey), "key is never stored");
  assert.equal((await rpc("STATUS")).hasRecovery, true);
  await rpc("UPSERT", {
    entry: { title: "kept", url: "https://example.com/kept" },
  });
  await rpc("LOCK");

  // Forgot password: wrong key rejected, right key (sloppy input) resets it.
  await assert.rejects(
    rpc("RECOVER", {
      recoveryKey: c.newRecoveryCode().code,
      newPassword: "5678",
    }),
    /救援金鑰不正確/,
  );
  clearAttempts();
  await assert.rejects(
    rpc("RECOVER", { recoveryKey: "nope", newPassword: "5678" }),
    /格式不正確/,
  );
  await assert.rejects(
    rpc("RECOVER", { recoveryKey, newPassword: "12" }),
    /至少 4/,
  );
  const reset = await rpc("RECOVER", {
    recoveryKey: recoveryKey.toLowerCase().replace(/-/g, " "),
    newPassword: "5678",
  });
  assert.notEqual(reset.recoveryKey, recoveryKey, "a used key is replaced");
  assert((await rpc("LIST")).entries.some((x: any) => x.title === "kept"));
  await rpc("LOCK");
  await assert.rejects(rpc("UNLOCK", { password: "1234" }), /密碼不正確/);
  clearAttempts();
  await rpc("UNLOCK", { password: "5678" });
  await rpc("LOCK");
  await assert.rejects(
    rpc("RECOVER", { recoveryKey, newPassword: "9999" }),
    /救援金鑰不正確/,
  );
  clearAttempts();

  // Rotation requires the current password; the previous key stops working.
  await rpc("UNLOCK", { password: "5678" });
  await assert.rejects(
    rpc("RECOVERY_CREATE", { password: "1234" }),
    /密碼不正確/,
  );
  clearAttempts();
  const rotated = await rpc("RECOVERY_CREATE", { password: "5678" });
  const backup = await rpc("EXPORT");
  await rpc("LOCK");
  await assert.rejects(
    rpc("RECOVER", { recoveryKey: reset.recoveryKey, newPassword: "0000" }),
    /救援金鑰不正確/,
  );
  clearAttempts();

  // New computer: backup file + recovery key.
  delete local.vault;
  await assert.rejects(
    rpc("RECOVER", { recoveryKey: rotated.recoveryKey, newPassword: "abcd" }),
  );
  const fresh = await rpc("RECOVER", {
    envelope: backup,
    recoveryKey: rotated.recoveryKey,
    newPassword: "abcd",
  });
  assert(fresh.recoveryKey);
  assert((await rpc("LIST")).entries.some((x: any) => x.title === "kept"));
  await rpc("LOCK");

  // A legacy v1 vault opens with its password, is migrated, has no key yet.
  const salt = c.b64(c.random(16));
  local.vault = await c.encrypt(
    { version: 2, id: "legacy-vault", entries: [], memos: [] },
    await c.derive("1234", salt),
    salt,
  );
  await rpc("UNLOCK", { password: "1234" });
  assert.equal(local.vault.version, 3);
  assert.equal(local.vault.keys.salt, salt);
  assert.equal((await rpc("STATUS")).hasRecovery, false);
  await rpc("RECOVERY_CREATE", { password: "1234" });
  assert.equal((await rpc("STATUS")).hasRecovery, true);

  // Sync: newer key slots from another device are adopted; forged ones rejected.
  const originalFetch = globalThis.fetch;
  (chrome.runtime.getManifest as any) = () => ({
    oauth2: { client_id: "test.apps.googleusercontent.com" },
  });
  (chrome as any).identity = {
    getAuthToken: async () => ({ token: "t" }),
    removeCachedAuthToken: async () => {},
    clearAllCachedAuthTokens: async () => {},
  };
  const remote = new Map<string, any>();
  let n = 0;
  globalThis.fetch = async (input: any, init: any = {}) => {
    const u = String(input);
    if (init.method === "POST") {
      const json = String(init.body)
        .split("Content-Type: application/json\r\n\r\n")[1]
        .split("\r\n--")[0];
      remote.set(String(n++), JSON.parse(json));
      return Response.json({});
    }
    const id = decodeURIComponent(u.split("/files/")[1]?.split("?")[0] || "");
    if (init.method === "DELETE")
      return new Response(null, { status: remote.delete(id) ? 204 : 404 });
    if (u.includes("alt=media")) return Response.json(remote.get(id));
    return Response.json({ files: [...remote.keys()].map((id) => ({ id })) });
  };
  try {
    const dek = await c.importKey(session.session.key);
    const v = await c.decrypt(local.vault, dek);
    const otherKeys = await c.setPassword(
      dek,
      v.id,
      "newpass",
      local.vault.keys,
    );
    remote.set("other", await c.seal(v, dek, otherKeys));
    await rpc("SYNC");
    assert.equal(local.vault.keys.updated, otherKeys.updated);
    await rpc("LOCK");
    await assert.rejects(rpc("UNLOCK", { password: "1234" }), /密碼不正確/);
    clearAttempts();
    await rpc("UNLOCK", { password: "newpass" });
    const forged = await c.seal(v, dek, otherKeys);
    forged.keys = { ...forged.keys, updated: forged.keys.updated + 1000 };
    remote.clear();
    remote.set("forged", forged);
    await assert.rejects(rpc("SYNC"), /另一個保險庫/);
    assert.equal(local.vault.keys.updated, otherKeys.updated);
  } finally {
    globalThis.fetch = originalFetch;
    await rpc("LOCK");
  }
});

test("password change requires fresh proof, preserves data and recovery, rejects old password", async () => {
  const c = await import("../src/crypto");
  delete local.vault;
  delete session.session;
  delete session.attempts;
  delete session.nextAttempt;
  const created = await rpc("CREATE", { password: "1234" });
  await rpc("UPSERT", {
    entry: { title: "retained bookmark", url: "https://example.com/keep" },
  });
  await rpc("MEMO_UPSERT", {
    memo: { title: "retained note", body: "keep note" },
  });
  const before = await rpc("LIST");
  const recoverySlot = structuredClone(local.vault.keys.recovery);
  await assert.rejects(
    rpc("CHANGE_PASSWORD", { newPassword: "5678", confirmPassword: "5678" }),
    /重新驗證/,
  );
  await assert.rejects(
    rpc("VERIFY_PASSWORD", { password: "wrong" }),
    /密碼不正確/,
  );
  delete session.attempts;
  delete session.nextAttempt;
  const proof = await rpc("VERIFY_PASSWORD", { password: "1234" });
  await assert.rejects(
    rpc("CHANGE_PASSWORD", {
      ...proof,
      newPassword: "123",
      confirmPassword: "123",
    }),
    /至少 4/,
  );
  await assert.rejects(
    rpc("CHANGE_PASSWORD", {
      ...proof,
      newPassword: "5678",
      confirmPassword: "9999",
    }),
    /不一致/,
  );
  await rpc("CHANGE_PASSWORD", {
    ...proof,
    newPassword: "5678",
    confirmPassword: "5678",
  });
  assert(!session.passwordProof);
  assert.deepEqual(await rpc("LIST"), before);
  assert.deepEqual(local.vault.keys.recovery, recoverySlot);
  const recovered = await c.openWithRecovery(
    local.vault,
    c.parseRecoveryCode(created.recoveryKey),
  );
  // The backup (one envelope with everything) opens with the recovery key.
  assert.deepEqual(await c.decrypt(await rpc("EXPORT"), recovered), before);
  await assert.rejects(
    rpc("CHANGE_PASSWORD", {
      ...proof,
      newPassword: "abcd",
      confirmPassword: "abcd",
    }),
    /重新驗證/,
  );
  await rpc("LOCK");
  await assert.rejects(rpc("UNLOCK", { password: "1234" }), /密碼不正確/);
  delete session.attempts;
  delete session.nextAttempt;
  await rpc("UNLOCK", { password: "5678" });
  const pending = await rpc("VERIFY_PASSWORD", { password: "5678" });
  await rpc("LOCK");
  assert(!session.passwordProof);
  await rpc("UNLOCK", { password: "5678" });
  await assert.rejects(
    rpc("CHANGE_PASSWORD", {
      ...pending,
      newPassword: "abcd",
      confirmPassword: "abcd",
    }),
    /重新驗證/,
  );
  await rpc("LOCK");
  delete local.vault;
  delete session.attempts;
  delete session.nextAttempt;
});

test("quick sync: pulls right after unlock, pushes about a second after edits, silent while locked", async () => {
  const { decrypt, importKey, seal } = await import("../src/crypto");
  const originalFetch = globalThis.fetch;
  const remote = new Map<string, any>();
  let nextId = 0,
    calls = 0,
    fail = false;
  (chrome.runtime.getManifest as any) = () => ({
    oauth2: { client_id: "test.apps.googleusercontent.com" },
  });
  (chrome as any).identity = {
    getAuthToken: async () => ({ token: "synthetic-token" }),
    removeCachedAuthToken: async () => {},
    clearAllCachedAuthTokens: async () => {},
  };
  globalThis.fetch = async (input: any, init: any = {}) => {
    calls++;
    if (fail) return new Response("", { status: 503 });
    const u = String(input);
    if (init.method === "POST") {
      const json = String(init.body)
        .split("Content-Type: application/json\r\n\r\n")[1]
        .split("\r\n--")[0];
      const id = "q" + nextId++;
      remote.set(id, JSON.parse(json));
      return Response.json({ id });
    }
    const id = decodeURIComponent(u.split("/files/")[1]?.split("?")[0] || "");
    if (init.method === "DELETE")
      return new Response(null, { status: remote.delete(id) ? 204 : 404 });
    if (u.includes("alt=media"))
      return remote.has(id)
        ? Response.json(remote.get(id))
        : new Response("", { status: 404 });
    return Response.json({ files: [...remote.keys()].map((id) => ({ id })) });
  };
  const fire = async () => {
    const due = [...quickTimers.values()];
    quickTimers.clear();
    // Drive is read and written outside the request queue: wait for the sync.
    await Promise.all(due.map((t) => t.fn()));
  };
  try {
    await rpc("LOCK");
    delete local.vault;
    delete local.lastSync;
    local.syncError = "";
    delete session.attempts;
    delete session.nextAttempt;
    quickTimers.clear();
    await rpc("CREATE", { password: "abcd" });
    assert.equal(quickTimers.size, 0, "no Drive: no sync is scheduled");
    local.driveEnabled = true;

    // Another device added a bookmark; this device sees it right after unlock.
    const key = await importKey(session.session.key);
    const other = await decrypt(local.vault, key);
    other.entries.push({
      id: "from-other-device",
      title: "other device",
      url: "https://example.org",
      folder: "",
      tags: [],
      notes: "",
      updated: Date.now(),
      revision: "r1",
      deleted: false,
    });
    remote.set("seed", await seal(other, key, local.vault.keys));
    await rpc("LOCK");
    await rpc("UNLOCK", { password: "abcd" });
    assert.deepEqual(
      [...quickTimers.values()].map((t) => t.ms),
      [0],
      "unlock syncs immediately",
    );
    await fire();
    assert(local.lastSync, "sync ran right after unlock");
    assert(
      (await rpc("LIST")).entries.some((e: any) => e.id === "from-other-device"),
    );

    // An edit is pushed within about a second, not at the next 5-minute tick.
    await rpc("UPSERT", { entry: { title: "quick", url: "https://a.example" } });
    assert.deepEqual(
      [...quickTimers.values()].map((t) => t.ms),
      [1000],
    );
    assert.equal(alarms["veilmark-sync-soon"]?.delayInMinutes, 0.5);
    // Rapid edits restart the short timer instead of piling up syncs.
    await rpc("UPSERT", { entry: { title: "quick 2", url: "https://b.example" } });
    assert.equal(quickTimers.size, 1);
    await fire();
    assert.equal(alarms["veilmark-sync-soon"], undefined, "fallback cleared");
    const [onlyId] = [...remote.keys()];
    assert.equal(remote.size, 1, "Drive keeps one consolidated snapshot");
    const pushed = await decrypt(remote.get(onlyId), key);
    assert(pushed.entries.some((e: any) => e.title === "quick 2"));

    // Locked: periodic ticks do nothing and record no error.
    await rpc("LOCK");
    const before = calls;
    listeners.alarm({ name: "veilmark-sync" });
    listeners.alarm({ name: "veilmark-sync-soon" });
    await rpc("STATUS");
    assert.equal(calls, before, "no Drive traffic while locked");
    assert.equal(local.syncError, "");
    // A stale "locked" error saved by an older version is not shown.
    local.syncError = "已上鎖，請重新解鎖";
    assert.equal((await rpc("STATUS")).syncError, "");

    // Real failures while unlocked are still reported.
    await rpc("UNLOCK", { password: "abcd" });
    fail = true;
    await fire();
    assert.match(local.syncError, /503/);
    fail = false;
    await rpc("UPSERT", { entry: { title: "after", url: "https://c.example" } });
    await fire();
    assert.equal(local.syncError, "", "a later success clears the error");
  } finally {
    globalThis.fetch = originalFetch;
    quickTimers.clear();
    await rpc("LOCK");
    delete local.vault;
    delete local.driveEnabled;
    delete session.driveToken;
  }
});

test("notebook images: validated, kept when omitted, limited, wiped on delete", async () => {
  const c = await import("../src/crypto");
  await rpc("LOCK");
  delete local.vault;
  delete local.driveEnabled;
  quickTimers.clear();
  await rpc("CREATE", { password: "abcd" });
  const img = (id: string, chars = 400) => ({
    id,
    data: "A".repeat(chars),
    mime: "image/webp",
    w: 900,
    h: 500,
  });
  assert.equal(c.cleanImages([img("a"), { ...img("b"), mime: "text/html" }, { ...img("c"), data: "%%%%" }, img("a")]).length, 1);
  assert.equal(c.cleanImages([{ ...img("x"), w: 0 }, { ...img("y"), id: "../x" }]).length, 0);
  const m = await rpc("MEMO_UPSERT", {
    memo: { title: "", body: '<img data-veil-img="a" alt="">', format: "html", images: [img("a")] },
  });
  assert.equal(m.images.length, 1, "a picture alone is content");
  const kept = await rpc("MEMO_UPSERT", {
    memo: { id: m.id, title: "t", body: '<p>x</p><img data-veil-img="a" alt="">', format: "html" },
  });
  assert.equal(kept.images.length, 1, "images omitted = unchanged");
  await assert.rejects(
    rpc("MEMO_UPSERT", { memo: { id: m.id, title: "t", body: "x", format: "html", images: [img("a"), { ...img("b"), mime: "image/svg+xml" }] } }),
    /圖片數量或大小/,
  );
  await assert.rejects(
    rpc("MEMO_UPSERT", { memo: { id: m.id, title: "t", body: "x", format: "html", images: [img("big", c.IMAGE_MAX + 4)] } }),
    /圖片數量或大小/,
  );
  // Vault-wide cap across notes.
  const per = 1_400_000;
  for (let n = 0; n < 2; n++)
    await rpc("MEMO_UPSERT", {
      memo: { title: "n" + n, body: "x", format: "html", images: Array.from({ length: 7 }, (_, i) => img(`v${n}-${i}`, per)) },
    });
  await assert.rejects(
    rpc("MEMO_UPSERT", {
      memo: { title: "n3", body: "x", format: "html", images: Array.from({ length: 7 }, (_, i) => img(`w${i}`, per)) },
    }),
    /圖片儲存空間已滿/,
  );
  assert(!JSON.stringify(local.vault).includes("A".repeat(64)), "images encrypted at rest");
  await rpc("MEMO_DELETE", { id: m.id });
  const gone = (await rpc("LIST")).memos.find((x: any) => x.id === m.id);
  assert.deepEqual(gone.images, []);
  await rpc("LOCK");
  delete local.vault;
});

test("Drive upload: multipart for small vaults, resumable session for large ones", async () => {
  const { upload } = await import("../src/drive");
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method: string; size: number; type: string }[] = [];
  globalThis.fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method, size: String(init.body || "").length, type: init.headers["Content-Type"] });
    if (url.includes("uploadType=resumable"))
      return new Response(null, {
        status: 200,
        headers: { Location: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=xyz" },
      });
    return Response.json({ id: "f" });
  };
  try {
    const small = { version: 3, id: "v", iv: "i", ciphertext: "x".repeat(1000) } as any;
    await upload("tok", small);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /uploadType=multipart/);
    calls.length = 0;
    await upload("tok", { ...small, ciphertext: "x".repeat(5_000_000) });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /uploadType=resumable$/);
    assert.equal(calls[0].method, "POST");
    assert(calls[0].size < 1000, "metadata only in the first request");
    assert.match(calls[1].url, /upload_id=xyz/);
    assert.equal(calls[1].method, "PUT");
    assert(calls[1].size > 5_000_000);
    // A session URL pointing elsewhere is refused.
    globalThis.fetch = async () =>
      new Response(null, { status: 200, headers: { Location: "https://evil.example/upload" } });
    await assert.rejects(upload("tok", { ...small, ciphertext: "x".repeat(5_000_000) }), /回應無效/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ordering and folders: reorder, move between folders, folder order/create/rename/delete, note quick edit, sync merge", async () => {
  const c = await import("../src/crypto");
  await rpc("LOCK");
  delete local.vault;
  delete local.driveEnabled;
  quickTimers.clear();
  await rpc("CREATE", { password: "abcd" });
  const add = async (title: string, folder = "") =>
    (await rpc("UPSERT", { entry: { title, url: `https://${title}.example`, folder } })).entries.find(
      (x: any) => x.title === title,
    ).id;
  const a = await add("a", "Work"),
    b = await add("b", "Work"),
    cc = await add("c", "Work"),
    d = await add("d");
  let v = await rpc("REORDER", { kind: "entry", folder: "Work", ids: [cc, a, b] });
  const order = (f: string) =>
    v.entries.filter((x: any) => x.folder === f && !x.deleted).sort((x: any, y: any) => x.order - y.order).map((x: any) => x.title);
  assert.deepEqual(order("Work"), ["c", "a", "b"]);
  // Drag "d" from Unfiled into Work between c and a.
  v = await rpc("REORDER", { kind: "entry", folder: "Work", ids: [cc, d, a, b] });
  assert.deepEqual(order("Work"), ["c", "d", "a", "b"]);
  // Editing keeps the position; changing folder drops it.
  v = await rpc("UPSERT", { entry: { id: a, title: "a2", url: "https://a.example", folder: "Work" } });
  assert.equal(v.entries.find((x: any) => x.id === a).order, 2);
  v = await rpc("UPSERT", { entry: { id: b, title: "b", url: "https://b.example", folder: "Home" } });
  assert.equal(v.entries.find((x: any) => x.id === b).order, undefined);
  // Folders: create empty, order, rename (items follow), delete (items to Unfiled).
  await rpc("FOLDER_CREATE", { kind: "entry", name: "Empty" });
  await assert.rejects(rpc("FOLDER_CREATE", { kind: "entry", name: "Work" }), /同名/);
  await assert.rejects(rpc("FOLDER_CREATE", { kind: "entry", name: "  " }), /資料夾名稱/);
  v = await rpc("FOLDER_ORDER", { kind: "entry", names: ["Home", "Empty", "Work"] });
  const { folderNames } = await import("../src/sortable");
  assert.deepEqual(folderNames("entry", v.folders, v.entries.filter((x: any) => !x.deleted)), ["Home", "Empty", "Work"]);
  v = await rpc("FOLDER_RENAME", { kind: "entry", from: "Work", to: "Job" });
  assert.deepEqual(folderNames("entry", v.folders, v.entries.filter((x: any) => !x.deleted)), ["Home", "Empty", "Job"]);
  assert.equal(v.entries.filter((x: any) => x.folder === "Job").length, 3);
  await assert.rejects(rpc("FOLDER_RENAME", { kind: "entry", from: "Job", to: "Home" }), /同名/);
  v = await rpc("FOLDER_DELETE", { kind: "entry", name: "Job" });
  assert.equal(v.entries.filter((x: any) => !x.deleted && x.folder === "").length, 3);
  assert.deepEqual(folderNames("entry", v.folders, v.entries.filter((x: any) => !x.deleted)), ["Home", "Empty"]);
  await assert.rejects(rpc("REORDER", { kind: "other", folder: "", ids: [] }), /未知操作/);

  // Notes: folders, quick rename and move keep the body.
  const n1 = await rpc("MEMO_UPSERT", { memo: { title: "n1", body: "<p>secret body</p>", format: "html" } });
  const n2 = await rpc("MEMO_UPSERT", { memo: { title: "n2", body: "x", format: "html" } });
  await rpc("FOLDER_CREATE", { kind: "memo", name: "日記" });
  v = await rpc("MEMO_META", { id: n1.id, title: "改名", folder: "日記" });
  let m1 = v.memos.find((x: any) => x.id === n1.id);
  assert.equal(m1.title, "改名");
  assert.equal(m1.folder, "日記");
  assert.equal(m1.body, "<p>secret body</p>");
  v = await rpc("REORDER", { kind: "memo", folder: "日記", ids: [n2.id, n1.id] });
  assert.deepEqual(v.memos.filter((x: any) => x.folder === "日記").sort((x: any, y: any) => x.order - y.order).map((x: any) => x.title), ["n2", "改名"]);
  // Saving from the notebook keeps folder and position.
  v = { memos: [await rpc("MEMO_UPSERT", { memo: { id: n1.id, title: "改名", body: "<p>edited</p>", format: "html" } })] };
  assert.equal(v.memos[0].folder, "日記");
  assert.equal(v.memos[0].order, 1);
  await assert.rejects(rpc("MEMO_META", { id: "missing", title: "x" }), /不存在/);

  // Folder records merge last-writer-wins like items; bad records are dropped.
  const key = await c.importKey(session.session.key);
  const mine = await c.decrypt(local.vault, key);
  const other = structuredClone(mine);
  const rec = other.folders!.find((f) => f.name === "Empty")!;
  rec.order = 99;
  rec.updated += 10;
  rec.revision = "z";
  other.folders!.push({ id: "bad", kind: "entry", name: "x", order: 1, updated: 1, revision: "r", deleted: false });
  const merged = c.merge(mine, other);
  assert.equal(merged.folders!.find((f) => f.name === "Empty")!.order, 99);
  const sealed = await c.seal(other, key, local.vault.keys);
  const back = await c.decrypt(sealed, key);
  assert(!back.folders!.some((f) => f.id === "bad"), "invalid folder records dropped");
  await rpc("LOCK");
  delete local.vault;
});

test("lite responses leave out note media; fast base64 round-trips large data", async () => {
  const c = await import("../src/crypto");
  const big = new Uint8Array(3_000_001).map((_, i) => (i * 31) & 255);
  assert.deepEqual(c.unb64(c.b64(big)), big);
  assert.equal(c.b64(new Uint8Array([0, 255, 128])), "AP+A");
  await rpc("LOCK");
  delete local.vault;
  delete local.driveEnabled;
  quickTimers.clear();
  await rpc("CREATE", { password: "abcd" });
  await rpc("MEMO_UPSERT", {
    memo: {
      title: "m",
      body: "<p>body</p>",
      format: "html",
      images: [{ id: "i1", data: "AAAA", mime: "image/webp", w: 1, h: 1 }],
      drawing: [{ color: "#000000", width: 2, points: [[1, 1], [2, 2]] }],
    },
  });
  const full = await rpc("LIST");
  const lite = await rpc("LIST", { lite: true });
  assert.equal(full.memos[0].images.length, 1);
  assert.equal(lite.memos[0].images, undefined);
  assert.equal(lite.memos[0].drawing, undefined);
  assert.equal(lite.memos[0].body, "<p>body</p>");
  // A lite quick edit keeps the stored pictures.
  await rpc("MEMO_META", { id: full.memos[0].id, title: "renamed", lite: true });
  assert.equal((await rpc("LIST")).memos[0].images.length, 1);
  await rpc("LOCK");
  delete local.vault;
});

test("Drive conflict: flagged instead of syncing, use the Drive vault, or replace Drive with this one", async () => {
  const originalFetch = globalThis.fetch;
  const remote = new Map<string, any>();
  let nextId = 0,
    posts = 0;
  (chrome.runtime.getManifest as any) = () => ({
    oauth2: { client_id: "test.apps.googleusercontent.com" },
  });
  (chrome as any).identity = {
    getAuthToken: async () => ({ token: "synthetic-token" }),
    removeCachedAuthToken: async () => {},
    clearAllCachedAuthTokens: async () => {},
  };
  globalThis.fetch = async (input: any, init: any = {}) => {
    const u = String(input);
    if (init.method === "POST") {
      const json = String(init.body)
        .split("Content-Type: application/json\r\n\r\n")[1]
        .split("\r\n--")[0];
      const id = "c" + nextId++;
      remote.set(id, JSON.parse(json));
      posts++;
      return Response.json({ id });
    }
    const id = decodeURIComponent(u.split("/files/")[1]?.split("?")[0] || "");
    if (init.method === "DELETE")
      return new Response(null, { status: remote.delete(id) ? 204 : 404 });
    if (u.includes("alt=media"))
      return remote.has(id)
        ? Response.json(remote.get(id))
        : new Response("", { status: 404 });
    return Response.json({ files: [...remote.keys()].map((id) => ({ id })) });
  };
  const fresh = async (password: string, title: string) => {
    await rpc("LOCK");
    delete local.vault;
    delete local.driveEnabled;
    delete local.driveConflict;
    local.syncError = "";
    delete session.attempts;
    delete session.nextAttempt;
    quickTimers.clear();
    await rpc("CREATE", { password });
    await rpc("UPSERT", { entry: { title, url: "https://example.com" } });
    return local.vault.id as string;
  };
  const titles = (v: any) =>
    v.entries.filter((x: any) => !x.deleted).map((x: any) => x.title);
  try {
    // Drive holds vault A from another installation.
    const a = await fresh("drive-pw", "drive item");
    await rpc("SYNC");
    assert.equal(remote.size, 1);
    // A new installation creates vault B, then tries to connect Drive.
    const b = await fresh("local-pw", "local item");
    const drive = structuredClone([...remote.entries()]);
    await assert.rejects(rpc("SYNC"), /另一個保險庫/);
    let s = await rpc("STATUS");
    assert.equal(s.driveConflict, true);
    assert.equal(s.driveEnabled, undefined, "a failed first connect stays off");
    assert.deepEqual([...remote.entries()], drive, "Drive is untouched");
    assert.equal(local.vault.id, b);

    // Choice 1: use the Drive vault. A wrong password changes nothing.
    await assert.rejects(rpc("DRIVE_USE_REMOTE", { password: "local-pw" }));
    assert.equal(local.vault.id, b);
    delete session.attempts;
    delete session.nextAttempt;
    const used = await rpc("DRIVE_USE_REMOTE", { password: "drive-pw" });
    assert.equal(local.vault.id, a);
    assert.deepEqual(titles(used), ["drive item"]);
    s = await rpc("STATUS");
    assert.equal(s.driveConflict, false);
    assert.equal(s.driveEnabled, true);
    assert.equal(s.unlocked, true);
    assert.deepEqual(titles(await rpc("LIST")), ["drive item"]);
    await rpc("LOCK");
    await assert.rejects(rpc("UNLOCK", { password: "local-pw" }));
    delete session.attempts;
    delete session.nextAttempt;
    await rpc("UNLOCK", { password: "drive-pw" });
    const postsBefore = posts;
    await rpc("SYNC");
    assert.equal(posts, postsBefore, "now the same vault: nothing to upload");

    // Choice 2: keep this computer's vault C and replace Drive.
    const c = await fresh("c-pw", "c item");
    await assert.rejects(rpc("SYNC"), /另一個保險庫/);
    assert.equal((await rpc("STATUS")).driveConflict, true);
    await assert.rejects(
      rpc("DRIVE_REPLACE", { password: "c-pw" }),
      /確認/,
      "needs the explicit confirmation",
    );
    await assert.rejects(
      rpc("DRIVE_REPLACE", { password: "drive-pw", confirm: true }),
    );
    assert(
      [...remote.values()].every((x) => x.id === a),
      "Drive still has A",
    );
    delete session.attempts;
    delete session.nextAttempt;
    const kept = await rpc("DRIVE_REPLACE", {
      password: "c-pw",
      confirm: true,
    });
    assert.deepEqual(titles(kept), ["c item"]);
    assert.equal(remote.size, 1);
    assert.equal([...remote.values()][0].id, c);
    s = await rpc("STATUS");
    assert.equal(s.driveConflict, false);
    assert.equal(s.driveEnabled, true);
    const p = posts;
    assert.deepEqual(titles(await rpc("SYNC")), ["c item"]);
    assert.equal(posts, p);

    // Disconnecting also clears a pending conflict.
    await fresh("d-pw", "d item");
    await assert.rejects(rpc("SYNC"), /另一個保險庫/);
    await rpc("DISCONNECT");
    assert.equal((await rpc("STATUS")).driveConflict, false);
  } finally {
    globalThis.fetch = originalFetch;
    await rpc("LOCK");
    delete local.vault;
    delete local.driveEnabled;
    delete local.driveConflict;
  }
});

test("Drive storage full: clear message, nothing deleted, local data kept, sync resumes after space is freed", async () => {
  const originalFetch = globalThis.fetch;
  const remote = new Map<string, any>();
  let nextId = 0,
    full = false;
  (chrome.runtime.getManifest as any) = () => ({
    oauth2: { client_id: "test.apps.googleusercontent.com" },
  });
  (chrome as any).identity = {
    getAuthToken: async () => ({ token: "synthetic-token" }),
    removeCachedAuthToken: async () => {},
    clearAllCachedAuthTokens: async () => {},
  };
  globalThis.fetch = async (input: any, init: any = {}) => {
    const u = String(input);
    if (init.method === "POST") {
      if (full)
        return Response.json(
          {
            error: {
              errors: [
                {
                  domain: "usageLimits",
                  reason: "storageQuotaExceeded",
                  message: "The user's Drive storage quota has been exceeded.",
                },
              ],
              code: 403,
              message: "The user's Drive storage quota has been exceeded.",
            },
          },
          { status: 403 },
        );
      const json = String(init.body)
        .split("Content-Type: application/json\r\n\r\n")[1]
        .split("\r\n--")[0];
      const id = "f" + nextId++;
      remote.set(id, JSON.parse(json));
      return Response.json({ id });
    }
    const id = decodeURIComponent(u.split("/files/")[1]?.split("?")[0] || "");
    if (init.method === "DELETE")
      return new Response(null, { status: remote.delete(id) ? 204 : 404 });
    if (u.includes("alt=media"))
      return remote.has(id)
        ? Response.json(remote.get(id))
        : new Response("", { status: 404 });
    return Response.json({ files: [...remote.keys()].map((id) => ({ id })) });
  };
  try {
    await rpc("LOCK");
    delete local.vault;
    delete local.driveEnabled;
    delete local.driveConflict;
    local.syncError = "";
    quickTimers.clear();
    await rpc("CREATE", { password: "abcd" });
    await rpc("SYNC");
    const before = structuredClone([...remote.entries()]);
    full = true;
    await rpc("UPSERT", { entry: { title: "after full", url: "https://example.com" } });
    // Background sync after the edit records the clear message.
    const due = [...quickTimers.values()];
    quickTimers.clear();
    await Promise.all(due.map((t) => t.fn()));
    const s = await rpc("STATUS");
    assert.match(s.syncError, /空間已滿/);
    assert(!s.driveConflict);
    assert.deepEqual([...remote.entries()], before, "old snapshot is kept");
    await assert.rejects(rpc("SYNC"), /空間已滿/);
    assert.deepEqual(
      (await rpc("LIST")).entries.map((x: any) => x.title),
      ["after full"],
      "local data is kept",
    );
    // Other 403 errors keep the generic message.
    full = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init: any = {}) =>
      init.method === "POST"
        ? Response.json({ error: { code: 403, message: "rate" } }, { status: 403 })
        : realFetch(input, init);
    await assert.rejects(rpc("SYNC"), /Drive 請求失敗 \(403\)/);
    globalThis.fetch = realFetch;
    // Space freed: the next sync uploads and clears the message.
    await rpc("SYNC");
    assert.equal((await rpc("STATUS")).syncError, "");
    assert.equal(remote.size, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await rpc("LOCK");
    delete local.vault;
    delete local.driveEnabled;
  }
});

test("new installation: looks for a vault in Drive without prompting, or after the user asks", async () => {
  const originalFetch = globalThis.fetch;
  let files: string[] = [];
  let prompts = 0;
  let granted = false;
  (chrome.runtime.getManifest as any) = () => ({
    oauth2: { client_id: "test.apps.googleusercontent.com" },
  });
  (chrome as any).identity = {
    getAuthToken: async ({ interactive }: any) => {
      if (interactive) {
        prompts++;
        granted = true;
      }
      if (!granted) throw Error("OAuth2 not granted or revoked.");
      return { token: "synthetic-token" };
    },
    removeCachedAuthToken: async () => {},
    clearAllCachedAuthTokens: async () => {},
  };
  const requests: string[] = [];
  globalThis.fetch = async (input: any, init: any = {}) => {
    requests.push(`${init.method || "GET"} ${input}`);
    return Response.json({ files: files.map((id) => ({ id })) });
  };
  try {
    await rpc("LOCK");
    delete local.vault;
    // Not authorised yet: no prompt, no request, answer "unknown".
    assert.deepEqual(await rpc("DRIVE_PROBE"), { state: "unknown" });
    assert.equal(prompts, 0);
    assert.equal(requests.length, 0);
    // The user asks: prompt once, then list only (no download).
    files = ["snap"];
    assert.deepEqual(await rpc("DRIVE_PROBE", { interactive: true }), {
      state: "found",
    });
    assert.equal(prompts, 1);
    assert(requests.every((r) => r.startsWith("GET ") && !r.includes("alt=media")));
    // Already authorised (e.g. on another computer): found without a prompt.
    assert.deepEqual(await rpc("DRIVE_PROBE"), { state: "found" });
    assert.equal(prompts, 1);
    files = [];
    assert.deepEqual(await rpc("DRIVE_PROBE"), { state: "empty" });
    // Once a vault exists here, nothing is checked.
    await rpc("CREATE", { password: "abcd" });
    const n = requests.length;
    assert.deepEqual(await rpc("DRIVE_PROBE"), { state: "exists" });
    assert.equal(requests.length, n);
    // No OAuth client configured: nothing to check.
    await rpc("LOCK");
    delete local.vault;
    (chrome.runtime.getManifest as any) = () => ({});
    assert.deepEqual(await rpc("DRIVE_PROBE"), { state: "unavailable" });
  } finally {
    globalThis.fetch = originalFetch;
    (chrome.runtime.getManifest as any) = () => ({});
    delete local.vault;
  }
});

test("nested folders: create sub, rename/move a subtree, delete moves contents up, paths cleaned", async () => {
  await rpc("LOCK");
  delete local.vault;
  delete local.driveEnabled;
  quickTimers.clear();
  await rpc("CREATE", { password: "abcd" });
  const { folderNames } = await import("../src/sortable");
  const { cleanFolderName } = await import("../src/crypto");
  assert.equal(cleanFolderName("  Work / / Projects /"), "Work/Projects");
  const names = (v: any, kind = "entry") =>
    folderNames(kind as any, v.folders, (kind === "entry" ? v.entries : v.memos).filter((x: any) => !x.deleted));
  const add = async (title: string, folder: string) =>
    (await rpc("UPSERT", { entry: { title, url: `https://${title}.example`, folder } })).entries.find(
      (x: any) => x.title === title,
    ).id;
  await rpc("FOLDER_CREATE", { kind: "entry", name: "Work" });
  await rpc("FOLDER_CREATE", { kind: "entry", name: "Work/Projects" });
  await rpc("FOLDER_CREATE", { kind: "entry", name: "Home" });
  await assert.rejects(rpc("FOLDER_CREATE", { kind: "entry", name: "Work/Projects" }), /同名/);
  const p = await add("p", "Work/Projects");
  // A bookmark saved into a deep path creates its parents too.
  await add("q", "Work/Projects/2026");
  let v = await rpc("LIST");
  assert.deepEqual(names(v), ["Work", "Work/Projects", "Work/Projects/2026", "Home"]);
  // Rename the middle folder: the subtree and its items follow.
  v = await rpc("FOLDER_RENAME", { kind: "entry", from: "Work/Projects", to: "Work/Plans" });
  assert.deepEqual(names(v), ["Work", "Work/Plans", "Work/Plans/2026", "Home"]);
  assert.equal(v.entries.find((x: any) => x.id === p).folder, "Work/Plans");
  assert.equal(v.entries.find((x: any) => x.title === "q").folder, "Work/Plans/2026");
  // Move it under Home, placed first among Home's children.
  v = await rpc("FOLDER_RENAME", { kind: "entry", from: "Work/Plans", to: "Home/Plans", order: ["Home/Plans"] });
  assert.deepEqual(names(v), ["Work", "Home", "Home/Plans", "Home/Plans/2026"]);
  await assert.rejects(rpc("FOLDER_RENAME", { kind: "entry", from: "Home", to: "Home/Plans/Home" }), /子資料夾/);
  await assert.rejects(rpc("FOLDER_RENAME", { kind: "entry", from: "Home/Plans", to: "Work" }), /同名/);
  // Deleting Home/Plans moves its bookmark and subfolder up to Home.
  v = await rpc("FOLDER_DELETE", { kind: "entry", name: "Home/Plans" });
  assert.deepEqual(names(v), ["Work", "Home", "Home/2026"]);
  assert.equal(v.entries.find((x: any) => x.id === p).folder, "Home");
  assert.equal(v.entries.find((x: any) => x.title === "q").folder, "Home/2026");
  // Deleting a top-level folder moves things to the top level.
  v = await rpc("FOLDER_DELETE", { kind: "entry", name: "Home" });
  assert.deepEqual(names(v), ["Work", "2026"]);
  assert.equal(v.entries.find((x: any) => x.id === p).folder, "");
  // Notes use the same rules.
  await rpc("FOLDER_CREATE", { kind: "memo", name: "日記/2026" });
  v = await rpc("LIST");
  assert.deepEqual(names(v, "memo"), ["日記", "日記/2026"]);
});

test("split storage: old single vault migrates safely, bookmark saves leave notes untouched, backups and Drive hold everything", async () => {
  const c = await import("../src/crypto");
  await rpc("LOCK");
  delete local.vault;
  delete local.vaultMemos;
  delete local.vaultLayout;
  delete local.driveEnabled;
  delete session.attempts;
  delete session.nextAttempt;
  quickTimers.clear();
  // An older release's vault: one envelope with bookmarks and a note.
  await rpc("CREATE", { password: "abcd" });
  await rpc("UPSERT", { entry: { title: "old bookmark", url: "https://old.example" } });
  await rpc("MEMO_UPSERT", { memo: { title: "old note", body: "<p>keep me</p>", format: "html" } });
  const dek = await c.importKey(session.session.key);
  const everything = await c.decrypt(await rpc("EXPORT"), dek);
  local.vault = await c.seal(everything, dek, local.vault.keys);
  delete local.vaultMemos;
  delete local.vaultLayout;
  await rpc("LOCK");
  // Unlocking the old layout shows everything.
  let v = await rpc("UNLOCK", { password: "abcd" });
  assert(v.memos.some((m: any) => m.title === "old note" && !m.deleted));
  assert(v.entries.some((e: any) => e.title === "old bookmark"));
  // The next save converts it: both parts written together.
  await rpc("UPSERT", { entry: { title: "new bookmark", url: "https://new.example" } });
  assert.equal(local.vaultLayout, 3);
  assert(local.vaultMemos, "notes part written in the same save");
  const bookmarks = await c.decrypt(local.vault, dek);
  const notes = await c.decrypt(local.vaultMemos, dek);
  assert.equal(bookmarks.memos.length, 0, "bookmark part has no notes");
  assert.equal(notes.entries.length, 0, "notes part has no bookmarks");
  assert(notes.memos.some((m: any) => m.title === "old note"));
  // A bookmark edit leaves the encrypted notes exactly as they were.
  const notesBefore = local.vaultMemos;
  await rpc("UPSERT", { entry: { title: "another", url: "https://another.example" } });
  assert.equal(local.vaultMemos, notesBefore, "notes not re-encrypted");
  // A note edit leaves the bookmarks part alone.
  const bookmarksBefore = local.vault;
  await rpc("MEMO_UPSERT", { memo: { title: "second note", body: "<p>x</p>", format: "html" } });
  assert.equal(local.vault, bookmarksBefore, "bookmarks not re-encrypted");
  // Reads, backups and unlock always combine both parts.
  v = await rpc("LIST");
  assert.equal(v.memos.filter((m: any) => !m.deleted).length, 2);
  assert.equal(v.entries.filter((e: any) => !e.deleted).length, 3);
  const backup = await c.decrypt(await rpc("EXPORT"), dek);
  assert.equal(backup.memos.filter((m: any) => !m.deleted).length, 2, "backup has the notes");
  assert.equal(backup.entries.filter((e: any) => !e.deleted).length, 3, "backup has the bookmarks");
  await rpc("LOCK");
  v = await rpc("UNLOCK", { password: "abcd" });
  assert.equal(v.memos.filter((m: any) => !m.deleted).length, 2, "unlock shows notes");
  // A missing notes part is reported, never treated as "no notes".
  const saved = local.vaultMemos;
  delete local.vaultMemos;
  await assert.rejects(rpc("LIST"), /記事資料不完整/);
  await assert.rejects(
    rpc("UPSERT", { entry: { title: "must not save", url: "https://x.example" } }),
    /記事資料不完整/,
  );
  local.vaultMemos = saved;
  assert.equal((await rpc("LIST")).memos.filter((m: any) => !m.deleted).length, 2);
});

test("Drive: a damaged snapshot is skipped and kept; edits made while Drive is read are not lost; uploads hold everything", async () => {
  const c = await import("../src/crypto");
  const originalFetch = globalThis.fetch;
  const remote = new Map<string, any>();
  let nextId = 0;
  let gate: Promise<void> | null = null;
  (chrome.runtime.getManifest as any) = () => ({
    oauth2: { client_id: "test.apps.googleusercontent.com" },
  });
  (chrome as any).identity = {
    getAuthToken: async () => ({ token: "synthetic-token" }),
    removeCachedAuthToken: async () => {},
    clearAllCachedAuthTokens: async () => {},
  };
  globalThis.fetch = async (input: any, init: any = {}) => {
    const u = String(input);
    if (init.method === "POST") {
      const json = String(init.body)
        .split("Content-Type: application/json\r\n\r\n")[1]
        .split("\r\n--")[0];
      const id = "d" + nextId++;
      remote.set(id, JSON.parse(json));
      return Response.json({ id });
    }
    const id = decodeURIComponent(u.split("/files/")[1]?.split("?")[0] || "");
    if (init.method === "DELETE")
      return new Response(null, { status: remote.delete(id) ? 204 : 404 });
    if (u.includes("alt=media")) {
      if (gate) await gate; // Drive is slow: the user keeps editing meanwhile
      if (!remote.has(id)) return new Response("", { status: 404 });
      const body = remote.get(id);
      return new Response(typeof body === "string" ? body : JSON.stringify(body));
    }
    return Response.json({ files: [...remote.keys()].map((id) => ({ id })) });
  };
  try {
    await rpc("LOCK");
    delete local.vault;
    delete local.vaultMemos;
    delete local.vaultLayout;
    delete local.driveConflict;
    local.syncError = "";
    quickTimers.clear();
    await rpc("CREATE", { password: "abcd" });
    await rpc("MEMO_UPSERT", { memo: { title: "note in sync", body: "<p>n</p>", format: "html" } });
    await rpc("SYNC");
    const dek = await c.importKey(session.session.key);
    const [good] = [...remote.keys()];
    const pushed = await c.decrypt(remote.get(good), dek);
    assert(pushed.memos.some((m: any) => m.title === "note in sync"), "Drive snapshot has the notes");
    // One snapshot cut short (unreadable) and one with a bad ciphertext.
    remote.set("cut", '{"version":3,"id":');
    const bad = structuredClone(remote.get(good));
    bad.ciphertext = bad.ciphertext.slice(0, -8) + "AAAAAAAA";
    remote.set("bad", bad);
    await rpc("UPSERT", { entry: { title: "after damage", url: "https://d.example" } });
    await rpc("SYNC");
    const s = await rpc("STATUS");
    assert(!s.driveConflict, "not mistaken for another vault");
    assert.equal(s.syncError, "");
    assert(remote.has("cut") && remote.has("bad"), "unreadable snapshots are kept");
    const readable = () => [...remote.entries()].filter(([id]) => id !== "cut" && id !== "bad");
    assert.equal(readable().length, 1, "one current snapshot besides the damaged ones");
    assert((await c.decrypt(readable()[0][1], dek)).entries.some((e: any) => e.title === "after damage"));
    // A later sync does not keep re-uploading because of the damaged files.
    const ids = [...remote.keys()].sort();
    await rpc("SYNC");
    assert.deepEqual([...remote.keys()].sort(), ids, "nothing to upload");
    // Background sync: an edit made while Drive is being read is kept.
    local.driveEnabled = true;
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    await rpc("UPSERT", { entry: { title: "trigger", url: "https://t.example" } });
    const due = [...quickTimers.values()];
    quickTimers.clear();
    const syncing = Promise.all(due.map((t) => t.fn()));
    // The request queue is free while Drive is read.
    await rpc("UPSERT", { entry: { title: "typed during sync", url: "https://during.example" } });
    release();
    gate = null;
    await syncing;
    assert((await rpc("LIST")).entries.some((e: any) => e.title === "typed during sync"), "edit kept locally");
    for (const t of [...quickTimers.values()]) await t.fn();
    quickTimers.clear();
    assert.equal(readable().length, 1);
    assert(
      (await c.decrypt(readable()[0][1], dek)).entries.some((e: any) => e.title === "typed during sync"),
      "and uploaded",
    );
  } finally {
    globalThis.fetch = originalFetch;
    (chrome.runtime.getManifest as any) = () => ({});
    delete local.driveEnabled;
  }
});

test("notes media: pictures and audio stored once each, text edits leave them alone, unused ones removed, backups whole", async () => {
  const c = await import("../src/crypto");
  await rpc("LOCK");
  for (const k of Object.keys(local)) if (k.startsWith("vm:")) delete local[k];
  delete local.vault;
  delete local.vaultMemos;
  delete local.vaultLayout;
  delete local.vaultMedia;
  delete local.driveEnabled;
  quickTimers.clear();
  await rpc("CREATE", { password: "abcd" });
  const dek = await c.importKey(session.session.key);
  const pic = (id: string, fill: string) => ({ id, data: fill.repeat(4000), mime: "image/png", w: 4, h: 4 });
  const rec = { id: "r1", data: "QUJD".repeat(500), mime: "audio/webm", duration: 2, created: 1, x: 10, y: 10 };
  const a = await rpc("MEMO_UPSERT", {
    memo: { title: "with media", body: '<img data-veil-img="p1"><img data-veil-img="p2">', format: "html", images: [pic("p1", "AAAA"), pic("p2", "BBBB")], recordings: [rec] },
  });
  // Same picture in another note: stored once.
  const b = await rpc("MEMO_UPSERT", {
    memo: { title: "same picture", body: '<img data-veil-img="p9">', format: "html", images: [pic("p9", "AAAA")] },
  });
  const mediaKeys = () => Object.keys(local).filter((k) => k.startsWith("vm:")).sort();
  assert.equal(local.vaultLayout, 3);
  assert.equal(mediaKeys().length, 3, "two pictures and one clip, duplicates once");
  assert.deepEqual(mediaKeys(), [...local.vaultMedia].map((h: string) => "vm:" + h).sort());
  // The notes part holds references only; the records are encrypted.
  const notes = await c.decrypt(local.vaultMemos, dek);
  assert(notes.memos.every((m: any) => (m.images || []).every((i: any) => i.data.startsWith("\u0000vm:"))));
  assert(!JSON.stringify(local).includes("AAAAAAAAAAAA"), "no picture data in plain text");
  // Full reads (notebook) bring the data back; popup reads leave it out.
  const full = await rpc("LIST");
  assert.equal(full.memos.find((m: any) => m.id === a.id).images[0].data, "AAAA".repeat(4000));
  assert.equal(full.memos.find((m: any) => m.id === a.id).recordings[0].data, rec.data);
  const popup = await rpc("LIST", { lite: true });
  assert(popup.memos.every((m: any) => !m.images && !m.recordings), "popup gets no media");
  // Editing a note's text (popup quick rename) keeps every media record as is.
  const before = Object.fromEntries(mediaKeys().map((k) => [k, local[k]]));
  await rpc("MEMO_META", { id: a.id, title: "renamed", lite: true });
  for (const [k, r] of Object.entries(before)) assert.equal(local[k], r, "media untouched");
  const again = await rpc("LIST");
  assert.equal(again.memos.find((m: any) => m.id === a.id).images.length, 2, "pictures kept after a popup edit");
  // Backups hold the real data.
  const backup = await c.decrypt(await rpc("EXPORT"), dek);
  assert.equal((backup.memos.find((m: any) => m.id === a.id) as any).images[1].data, "BBBB".repeat(4000));
  // Deleting the first note: its own picture and clip go, the shared one stays.
  await rpc("MEMO_DELETE", { id: a.id, lite: true });
  assert.equal(mediaKeys().length, 1, "only the shared picture is left");
  assert.equal((await rpc("LIST")).memos.find((m: any) => m.id === b.id).images[0].data, "AAAA".repeat(4000));
  // A leftover record (cleanup cut short) is removed on the next unlock.
  local["vm:" + "f".repeat(64)] = { iv: "x", ciphertext: "y" };
  await rpc("LOCK");
  await rpc("UNLOCK", { password: "abcd" });
  await rpc("STATUS");
  assert(!local["vm:" + "f".repeat(64)], "orphan removed");
  assert.equal(mediaKeys().length, 1);
  // A missing record: the vault still opens, the reference is kept (never
  // dropped), and backups refuse with a clear message instead of losing it.
  const [only] = mediaKeys();
  const saved = local[only];
  delete local[only];
  await rpc("LOCK");
  await rpc("UNLOCK", { password: "abcd" });
  await assert.rejects(rpc("EXPORT"), /圖片或錄音資料不完整/);
  await rpc("MEMO_META", { id: b.id, title: "still referenced", lite: true });
  assert.equal(local.vaultMedia.length, 1, "reference kept after a save");
  local[only] = saved;
  await rpc("LOCK");
  await rpc("UNLOCK", { password: "abcd" });
  assert.equal((await rpc("LIST")).memos.find((m: any) => m.id === b.id).images[0].data, "AAAA".repeat(4000));
  assert(await rpc("EXPORT"));
});
