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
  await assert.rejects(
    rpc("MEMO_UPSERT", { memo: { title: " ", body: " " } }),
    /記事標題或內容/,
  );
  await assert.rejects(
    rpc("MEMO_UPSERT", { memo: { title: "big", body: "x".repeat(100_001) } }),
    /過長/,
  );
  const created = await rpc("MEMO_UPSERT", {
    memo: { title: "銀行提示", body: "secret memo text" },
  });
  assert(created.id);
  const edited = await rpc("MEMO_UPSERT", {
    memo: { id: created.id, title: "銀行提示", body: "updated text" },
  });
  assert.equal(edited.id, created.id);
  assert(edited.updated > created.updated);
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
