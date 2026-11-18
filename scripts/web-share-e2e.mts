// Sharing into the mobile web app (Android share target, iPhone Shortcut):
// selected text and pictures become a note, a link alone becomes a bookmark.
// While the vault is locked the shared content stays in memory only (service
// worker → page), never in storage unencrypted.
// Run: npm run build:web && npx tsx scripts/web-share-e2e.mts
import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import assert from "node:assert/strict";
import {
  decrypt,
  emptyVault,
  newDataKey,
  newRecoveryCode,
  seal,
  setPassword,
  setRecovery,
  type Vault,
} from "../src/crypto";

const root = resolve(import.meta.dirname, "..");
const PASSWORD = "share-test-1234";
const SECRET = "只給自己看的段落 ZQX-4417";
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
  if (req.method !== "GET") return res.writeHead(405).end(); // like static hosting
  // A blank page (no CSP) to send the POST from, as Android's share sheet does.
  if (path === "/__share")
    return res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><meta charset="utf-8"><body>');
  let file = resolve(root, "web-dist", "." + path);
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
const APP = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

// ---- Drive with an existing vault ------------------------------------------
const dek = await newDataKey();
const id = crypto.randomUUID();
let keys = await setPassword(dek, id, PASSWORD);
keys = await setRecovery(dek, id, newRecoveryCode().bytes, keys);
const remote = new Map<string, unknown>([["v-0", await seal(emptyVault(id), dek, keys)]]);
let next = 1;
const current = async (): Promise<Vault> => {
  assert.equal(remote.size, 1);
  return decrypt([...remote.values()][0] as any, dek);
};
// 1x1 green PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices["Pixel 7"],
  locale: "zh-TW",
} as any);
await context.addInitScript(() => {
  if (localStorage.getItem("veilTestSeeded")) return;
  localStorage.setItem("veilTestSeeded", "1");
  localStorage.setItem(
    "veilAccount:share-user",
    JSON.stringify({
      id: "share-user",
      email: "share@example.com",
      name: "Share",
      token: "synthetic-token",
      expires: Date.now() + 3600_000,
    }),
  );
  sessionStorage.setItem("veilActiveAccount", "share-user");
});
await context.route("**/config.json", (r) =>
  r.fulfill({ json: { clientId: "test-client.apps.googleusercontent.com" } }),
);
await context.route("https://accounts.google.com/**", (r) =>
  r.fulfill({ body: "google sign-in", contentType: "text/plain" }),
);
await context.route("https://www.googleapis.com/**", async (route) => {
  const req = route.request();
  const u = req.url();
  if (u.includes("/about?"))
    return route.fulfill({
      json: { user: { permissionId: "share-user", emailAddress: "share@example.com", displayName: "Share" } },
    });
  if (req.method() === "POST") {
    const json = (req.postData() || "")
      .split("Content-Type: application/json\r\n\r\n")[1]
      .split("\r\n--")[0];
    const fid = "v-" + next++;
    remote.set(fid, JSON.parse(json));
    return route.fulfill({ json: { id: fid } });
  }
  const fid = decodeURIComponent(u.split("/files/")[1]?.split("?")[0] || "");
  if (req.method() === "DELETE")
    return route.fulfill({ status: remote.delete(fid) ? 204 : 404, body: "" });
  if (u.includes("alt=media"))
    return route.fulfill({ body: JSON.stringify(remote.get(fid)), contentType: "application/json" });
  return route.fulfill({ json: { files: [...remote.keys()].map((id) => ({ id })) } });
});

const page = await context.newPage();
// What Android does: a multipart POST to the share target.
async function share(fields: Record<string, string>, png = false) {
  await page.goto(APP + "__share");
  await page.evaluate(
    ({ fields, png }) => {
      const f = document.createElement("form");
      f.method = "post";
      f.enctype = "multipart/form-data";
      f.action = "./share";
      for (const [k, v] of Object.entries(fields)) {
        const i = document.createElement("input");
        i.name = k;
        i.value = v;
        f.append(i);
      }
      if (png) {
        const i = document.createElement("input");
        i.type = "file";
        i.name = "files";
        const dt = new DataTransfer();
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], "photo.png", { type: "image/png" }));
        i.files = dt.files;
        f.append(i);
      }
      document.body.append(f);
      f.submit();
    },
    { fields, png: png ? PNG.toString("base64") : "" },
  );
  await page.waitForURL(/\/$/);
}
// Everything the page can store: no shared text may be found unencrypted.
const stored = () =>
  page.evaluate(async () => {
    let out = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    for (const d of (await indexedDB.databases()) || []) {
      const db: IDBDatabase = await new Promise((ok, no) => {
        const r = indexedDB.open(d.name!);
        r.onsuccess = () => ok(r.result);
        r.onerror = () => no(r.error);
      });
      for (const s of Array.from(db.objectStoreNames)) {
        const all: unknown[] = await new Promise((ok) => {
          const r = db.transaction(s).objectStore(s).getAll();
          r.onsuccess = () => ok(r.result);
        });
        out += JSON.stringify(all);
      }
      db.close();
    }
    for (const k of await caches.keys()) {
      const c = await caches.open(k);
      for (const req of await c.keys()) out += req.url + (await (await c.match(req))!.text());
    }
    return out;
  });

try {
  // Install the service worker (as the home-screen app has it).
  await page.goto(APP);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole("heading", { name: "歡迎回來" }).waitFor();

  // 1) Selected text + picture shared while locked.
  await share(
    {
      title: "旅遊筆記 - 範例網站",
      text: `"${SECRET}"\nhttps://example.com/trip#:~:text=abc`,
    },
    true,
  );
  await page.getByText("解鎖後會把分享的內容加入記事本。").waitFor();
  assert(!page.url().includes("ZQX"), "nothing shared is left in the address");
  assert(!(await stored()).includes("ZQX-4417"), "shared text is not stored unencrypted while locked");
  await page.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByText("已加入記事本").waitFor();
  const editor = page.locator(".memoEdit");
  await editor.waitFor();
  await editor.getByText(SECRET).first().waitFor(); // text is in the note
  await editor.locator("img").first().waitFor(); // picture is in the note
  assert.equal(await editor.locator("img").count(), 1);
  let v: Vault;
  for (let i = 0; ; i++) {
    try {
      v = await current();
      if (v.memos.length) break;
    } catch {}
    if (i > 40) throw Error("note did not reach Drive");
    await page.waitForTimeout(250);
  }
  const memo = v.memos[0];
  assert.equal(memo.title, "旅遊筆記 - 範例網站");
  assert(memo.body.includes(SECRET));
  assert(memo.body.includes('href="https://example.com/trip#:~:text=abc"'), "source link kept");
  assert.equal(memo.images.length, 1);
  assert(!(await stored()).includes("ZQX-4417"), "only encrypted after saving");
  await page.getByRole("button", { name: "← 完成" }).click();

  // 2) A link alone becomes a bookmark (editor prefilled).
  await share({ title: "範例", text: "https://example.org/page" });
  await page.getByText("解鎖後即可收藏分享過來的網頁。").waitFor();
  await page.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByLabel("網址").waitFor();
  assert.equal(await page.getByLabel("網址").inputValue(), "https://example.org/page");
  await page.keyboard.press("Escape");

  // 3) Lost share (worker restarted): a clear message, no crash.
  await page.goto(APP + "?share=missing");
  await page.getByText("分享的內容沒有收到，請再分享一次。").waitFor();

  // 4) iPhone Shortcut: text in the address (GET) also becomes a note.
  await page.goto(APP + "?text=" + encodeURIComponent("捷徑分享的文字"));
  await page.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByText("已加入記事本").waitFor();
  assert.equal(new URL(page.url()).search, "", "text removed from the address");
  console.log(
    "PASS share into the app: text + picture → note (title, source link, image, synced), locked meanwhile with nothing stored unencrypted, link alone → bookmark, lost share message, iPhone Shortcut text → note",
  );
} finally {
  await browser.close();
  server.close();
}
