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
  },
  extension: {
    inIncognitoContext: true,
    isAllowedIncognitoAccess: async () => true,
  },
  storage: { local: store(local), session: store(session) },
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
  action: { onClicked: event("action") },
  idle: { setDetectionInterval: () => {}, onStateChanged: event("idle") },
  windows: {
    onCreated: event("created"),
    onRemoved: event("removed"),
    get: async (id: number) => fakeWindows.find((w) => w.id === id),
    getCurrent: async () => fakeWindows[0] || {},
    getAll: async () => fakeWindows,
  },
  tabs: { create: async () => {} },
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
  assert.deepEqual(await c.decrypt(local.vault, recovered), before);
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
    for (const t of due) t.fn();
    await rpc("STATUS"); // queued behind the sync it started
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
