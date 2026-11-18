// Mobile web app (docs/app) on a phone-sized screen against a simulated Google
// Drive: unlock with the master password, browse and edit bookmarks, read
// notes, sync both ways in the extension's snapshot format, work offline from
// the phone's encrypted copy, sign-in URL, share target and auto-lock.
// Run: npx vite build -c vite.web.config.ts && npx tsx scripts/web-e2e.mts [shots]
import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import assert from "node:assert/strict";
import {
  decrypt,
  emptyVault,
  newDataKey,
  seal,
  setPassword,
  setRecovery,
  newRecoveryCode,
  type Vault,
} from "../src/crypto";

// The account controls sit in a small menu behind the header's round button.
async function accountMenu(p: any) {
  if (!(await p.locator(".accountPanel").count()))
    await p.locator(".accountChip").click();
  return p.locator(".accountPanel");
}
async function accountSelect(p: any) {
  return (await accountMenu(p)).getByLabel("切換帳戶");
}

const root = resolve(import.meta.dirname, "..");
const shot = process.argv[2];
const PASSWORD = "phone-test-1234";

// ---- Static server: docs/ served at /veil-bookmark/ like GitHub Pages ------
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  if (!path.startsWith("/veil-bookmark/")) return res.writeHead(404).end();
  let file = resolve(root, "docs", path.slice("/veil-bookmark/".length));
  if (path.endsWith("/")) file = resolve(file, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": types[extname(file)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const APP = `http://127.0.0.1:${port}/veil-bookmark/app/`;

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices["Pixel 7"],
  locale: "zh-TW",
  serviceWorkers: "block",
});
const remote: Record<string, Map<string, any>> = {
  A: new Map(),
  B: new Map(),
  C: new Map(),
};
const posts: Record<string, number> = { A: 0, B: 0, C: 0 };
const deks: Record<string, CryptoKey> = {};
let seq = 0,
  mismatch = false;
for (const a of ["A", "B"]) {
  const v = emptyVault("vault-" + a);
  const dek = await newDataKey();
  deks[a] = dek;
  v.entries.push({
    id: a,
    title: "Only " + a,
    url: "https://example.com/" + a,
    folder: "",
    tags: [],
    notes: "",
    updated: 1,
    revision: a,
    deleted: false,
  });
  if (a === "A")
    remote[a].set(
      a,
      await seal(v, dek, await setPassword(dek, v.id, PASSWORD)),
    );
  else
    (globalThis as any).seedB = await seal(
      v,
      dek,
      await setPassword(dek, v.id, PASSWORD),
    );
}
await context.route("**/app/config.json", (r) =>
  r.fulfill({ json: { clientId: "test.apps.googleusercontent.com" } }),
);
await context.route("https://www.googleapis.com/**", async (route) => {
  const req = route.request(),
    u = req.url(),
    a = (req.headers().authorization || "").replace("Bearer token-", "");
  if (!remote[a]) return route.fulfill({ status: 401, body: "" });
  if (u.includes("/about?"))
    return route.fulfill({
      json: {
        user: {
          permissionId: mismatch && a === "A" ? "B" : a,
          emailAddress: a + "@example.com",
          displayName: a,
        },
      },
    });
  if (req.method() === "POST") {
    posts[a]++;
    const body = req.postData()!;
    const json = body
      .split("Content-Type: application/json\r\n\r\n")[1]
      .split("\r\n--")[0];
    const id = "new-" + ++seq;
    remote[a].set(id, JSON.parse(json));
    return route.fulfill({ json: { id } });
  }
  const fid = decodeURIComponent(u.split("/files/")[1]?.split("?")[0] || "");
  if (req.method() === "DELETE") {
    remote[a].delete(fid);
    return route.fulfill({ status: 204, body: "" });
  }
  if (u.includes("alt=media"))
    return route.fulfill({ json: remote[a].get(fid) });
  return route.fulfill({
    json: { files: [...remote[a].keys()].map((id) => ({ id })) },
  });
});
await context.route("https://accounts.google.com/**", async (route) => {
  const url = new URL(route.request().url());
  assert.equal(url.searchParams.get("prompt"), "select_account");
  const callback =
    APP +
    "#" +
    new URLSearchParams({
      access_token: "token-C",
      expires_in: "3600",
      scope: "https://www.googleapis.com/auth/drive.appdata",
      state: url.searchParams.get("state")!,
    });
  return route.fulfill({
    contentType: "text/html",
    body: `<script>location.replace(${JSON.stringify(callback)})</script>`,
  });
});
async function pageFor(id: string) {
  const p = await context.newPage();
  await p.addInitScript((id) => {
    if (!sessionStorage.getItem("veilActiveAccount"))
      sessionStorage.setItem("veilActiveAccount", id);
  }, id);
  await p.goto(APP);
  return p;
}
async function open(p: any, title: string) {
  // Switching reloads the page (closing the menu); otherwise close it.
  const panel = p.locator(".accountPanel");
  if (await panel.count()) {
    await p.keyboard.press("Escape").catch(() => {});
    await panel.waitFor({ state: "detached" });
  }
  await p.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await p.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await p.getByText(title, { exact: true }).waitFor();
}
async function readCache(p: any, id: string) {
  return p.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("veil-bookmark-web", 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<any>((res) => {
      const r = db
        .transaction("kv")
        .objectStore("kv")
        .get("vault:" + id);
      r.onsuccess = () => {
        db.close();
        res(r.result);
      };
    });
  }, id);
}
try {
  const a = await pageFor("A");
  await a.evaluate(() => {
    for (const id of ["A", "B"])
      localStorage.setItem(
        "veilAccount:" + id,
        JSON.stringify({
          id,
          email: id + "@example.com",
          name: id,
          token: "token-" + id,
          expires: Date.now() + 3600000,
        }),
      );
  });
  await a.reload();
  await open(a, "Only A");
  await a.locator(".syncDot", { hasText: "已同步" }).waitFor();
  const b = await pageFor("B");
  await b.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await b.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await b.getByRole("alert").filter({ hasText: "還沒有" }).waitFor();
  assert.equal(posts.B, 0);
  assert.equal(await readCache(b, "B"), undefined);
  remote.B.set("B", (globalThis as any).seedB);
  await b.reload();
  await open(b, "Only B");
  await b.locator(".syncDot", { hasText: "已同步" }).waitFor();
  assert.equal(await a.getByText("Only B", { exact: true }).count(), 0);
  assert.equal(await b.getByText("Only A", { exact: true }).count(), 0);
  assert.equal(await (await accountSelect(a)).inputValue(), "A");
  assert.equal(await (await accountSelect(b)).inputValue(), "B");
  // Offline work remains with A after switching the tab to B and back.
  await a.evaluate(() => {
    const k = "veilAccount:A",
      v = JSON.parse(localStorage.getItem(k)!);
    v.token = "";
    v.expires = 0;
    localStorage.setItem(k, JSON.stringify(v));
  });
  await a.getByRole("button", { name: "新增書籤", exact: true }).click();
  await a.getByLabel("名稱", { exact: true }).fill("Offline A");
  await a
    .getByLabel("網址", { exact: true })
    .fill("https://example.com/offline");
  await a.getByRole("button", { name: "加密儲存 →", exact: true }).click();
  await a.getByText("Offline A", { exact: true }).waitFor();
  await (await accountSelect(a)).selectOption("B");
  await a.getByLabel("主密碼", { exact: true }).waitFor();
  assert.equal(await a.getByText("Offline A", { exact: true }).count(), 0);
  await open(a, "Only B");
  await (await accountSelect(a)).selectOption("A");
  await open(a, "Offline A");
  assert.equal(posts.B, 0);
  assert.equal((await readCache(a, "A")).a.id, "vault-A");
  assert.equal((await readCache(a, "B")).a.id, "vault-B");
  // Add C through the real popup/callback flow; no A/B payload is sent to C.
  await (await accountMenu(a)).getByRole("button", { name: /新增帳戶$/ }).click();
  await a.waitForFunction(
    () => sessionStorage.getItem("veilActiveAccount") === "C",
  );
  await a.getByLabel("主密碼", { exact: true }).waitFor();
  assert.equal(posts.C, 0);
  assert.equal(await readCache(a, "C"), undefined);
  assert.equal(await (await accountSelect(b)).inputValue(), "B");
  // Same-account concurrent edits merge against the latest local encrypted copy.
  await (await accountSelect(a)).selectOption("B");
  await open(a, "Only B");
  async function add(p: any, title: string) {
    await p.getByRole("button", { name: "新增書籤", exact: true }).click();
    await p.getByLabel("名稱", { exact: true }).fill(title);
    await p
      .getByLabel("網址", { exact: true })
      .fill("https://example.com/" + title);
    await p.getByRole("button", { name: "加密儲存 →", exact: true }).click();
    await p.getByText(title, { exact: true }).waitFor();
  }
  await Promise.all([add(a, "Tab1"), add(b, "Tab2")]);
  await a.waitForTimeout(1600);
  await a.reload();
  await open(a, "Tab1");
  await a.getByText("Tab2", { exact: true }).waitFor();
  // A token identifying B cannot be used for an A workspace.
  await a.evaluate(() => {
    localStorage.setItem(
      "veilAccount:A",
      JSON.stringify({
        id: "A",
        email: "A@example.com",
        token: "token-A",
        expires: Date.now() + 3600000,
      }),
    );
  });
  mismatch = true;
  await (await accountSelect(a)).selectOption("A");
  await a.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await a.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await a.getByRole("alert").filter({ hasText: "工作區不符" }).waitFor();
  mismatch = false;
  // A pre-upgrade copy, including unsynced edits, is linked only to its real Drive.
  const savedA = await readCache(a, "A");
  const legacy = await context.newPage();
  await legacy.goto(APP);
  await legacy.evaluate(async (saved) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("veil-bookmark-web", 1);
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(saved, "vault");
      tx.objectStore("kv").delete("vault:A");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    sessionStorage.removeItem("veilActiveAccount");
    localStorage.setItem(
      "veilGoogleToken",
      JSON.stringify({ token: "token-A", expires: Date.now() + 3600000 }),
    );
  }, savedA);
  await legacy.reload();
  await legacy.waitForFunction(
    () => sessionStorage.getItem("veilActiveAccount") === "A",
  );
  await open(legacy, "Offline A");
  assert.equal((await readCache(legacy, "A")).a.id, "vault-A");
  // Removing B removes B alone, including on another tab displaying B.
  await (await accountMenu(b)).getByRole("button", { name: /移除此帳戶$/ }).click();
  await b.getByRole("button", { name: "確定移除此帳戶", exact: true }).click();
  await b.waitForFunction(() => !localStorage.getItem("veilAccount:B"));
  assert.equal(await readCache(b, "B"), undefined);
  assert((await readCache(legacy, "A")).a.id === "vault-A");
  await legacy.screenshot({
    path: resolve(root, "../previews/mobile-accounts.png"),
    fullPage: true,
  });
  await accountMenu(legacy);
  await legacy.screenshot({ path: resolve(root, "../previews/mobile-accounts-menu.png") });
  await legacy.keyboard.press("Escape");
  const beforeB=posts.B;
  const unmatched=await context.newPage();await unmatched.goto(APP);
  await unmatched.evaluate(()=>{
    sessionStorage.removeItem('veilActiveAccount');
    localStorage.setItem('veilGoogleToken',JSON.stringify({token:'token-B',expires:Date.now()+3600000}));
  });await unmatched.reload();
  await unmatched.getByLabel('主密碼',{exact:true}).waitFor();
  assert.equal(await (await accountSelect(unmatched)).inputValue(),'legacy');
  await open(unmatched,'Offline A');assert.equal(posts.B,beforeB);assert.equal(await readCache(unmatched,'B'),undefined);
  console.log(
    "PASS mobile accounts: separate tabs/caches, empty Drive isolation, offline edit retention, OAuth add-account popup, same-account concurrent writers, server identity mismatch fails closed.",
  );
} finally {
  await context.close();
  await browser.close();
  server.close();
}
