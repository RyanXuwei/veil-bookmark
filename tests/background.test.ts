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
const store = (data: Record<string, any>) => ({
  get: async (keys: any) => {
    if (keys === null) return { ...data };
    const result: Record<string, any> = {};
    for (const k of typeof keys === "string" ? [keys] : keys)
      if (k in data) result[k] = data[k];
    return structuredClone(result);
  },
  set: async (x: any) => {
    Object.assign(data, structuredClone(x));
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
test("Drive encrypted snapshot merge, no-op sync, tombstones, concurrent snapshots, different vault rejection and HTTP failure", async () => {
  const { derive, decrypt, encrypt } = await import("../src/crypto");
  const originalFetch = globalThis.fetch;
  const remote: any[] = [];
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
      remote.push(JSON.parse(json));
      posts++;
      return Response.json({ id: String(remote.length - 1) });
    }
    if (u.includes("alt=media"))
      return Response.json(remote[Number(u.split("/").at(-1)?.split("?")[0])]);
    return Response.json({ files: remote.map((_, i) => ({ id: String(i) })) });
  };
  try {
    await rpc("UNLOCK", { password: "1234" });
    await rpc("SYNC");
    assert.equal(posts, 1);
    await rpc("SYNC");
    assert.equal(posts, 1);
    const key = await derive("1234", local.vault.salt);
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
    remote.push(await encrypt(cloud, key, local.vault.salt));
    const merged = await rpc("SYNC");
    assert(merged.entries.some((x: any) => x.id === "remote-new"));
    assert(merged.entries.some((x: any) => x.deleted));
    assert.equal(posts, 1);
    await rpc("UPSERT", {
      entry: { title: "local change", url: "https://example.net" },
    });
    await rpc("SYNC");
    assert.equal(posts, 2);
    assert(!JSON.stringify(remote).includes("local change"));
    assert(!JSON.stringify(remote).includes("remote secret"));
    const before = structuredClone(local.vault);
    fail = true;
    await assert.rejects(rpc("SYNC"), /503/);
    assert.deepEqual(local.vault, before);
    fail = false;
    remote.push({ ...remote[0], id: "different-vault" });
    await assert.rejects(rpc("SYNC"), /另一個保險庫/);
    assert.deepEqual(local.vault, before);
    remote.pop();
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
