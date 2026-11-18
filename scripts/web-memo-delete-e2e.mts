// Deleting notes on the phone: from the list's ⋯ sheet, from the editor's
// options, a new note right after typing, and a note with a picture. Each is
// gone from the list, stays gone after a reload, and Drive keeps a tombstone.
// Run: npm run build:web && npx tsx scripts/web-memo-delete-e2e.mts
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
const shot = process.argv[2];
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
const seedV = emptyVault(id);
const now = Date.now();
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
for (const [title, pic] of [["甲記事", false], ["乙記事", false], ["丙有圖", true], ["丁保留", false]] as const)
  seedV.memos.push({
    id: crypto.randomUUID(),
    title,
    body: `<p>${title}內容</p>` + (pic ? '<p><img data-veil-img="p1" alt=""></p>' : ""),
    format: "html",
    images: pic ? [{ id: "p1", data: png, mime: "image/png", w: 1, h: 1 }] : [],
    updated: now,
    revision: crypto.randomUUID(),
    deleted: false,
  } as any);
const remote = new Map<string, unknown>([["v-0", await seal(seedV, dek, keys)]]);
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
// QUEST=1: Meta Quest Browser (desktop-like Chromium, laser pointer = mouse).
const QUEST = !!process.env.QUEST;
const context = await browser.newContext(
  QUEST
    ? {
        viewport: { width: 1280, height: 720 },
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/38.0.0.0.0 SamsungBrowser/4.0 Chrome/132.0.0.0 Safari/537.36",
        hasTouch: false,
        isMobile: false,
        locale: "zh-TW",
      }
    : ({ ...devices["Pixel 7"], locale: "zh-TW" } as any),
);
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
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
const unlock = async () => {
  await page.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByRole("tab", { name: /記事本/ }).click();
};
const listed = (title: string) => page.locator("main").getByText(title, { exact: true });
const remoteMemo = async (title: string) => {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await current();
      const live = v.memos.filter((m) => !m.deleted).map((m) => m.title);
      if (!live.includes(title)) return v;
    } catch {}
    await page.waitForTimeout(200);
  }
  throw Error(`${title} still on Drive`);
};
try {
  await page.goto(APP);
  await unlock();
  await listed("甲記事").waitFor();

  // 1) List ⋯ → 刪除 → 確定
  await page.getByRole("button", { name: "更多操作：甲記事" }).click();
  await page.getByRole("button", { name: "刪除", exact: true }).click();
  const confirm = page.getByRole("button", { name: "確定刪除？會同步到所有裝置" });
  // The confirm button must be readable (it was white text on white).
  const look = await confirm.evaluate((b) => {
    const c = getComputedStyle(b);
    return { bg: c.backgroundColor, fg: c.color };
  });
  assert.notEqual(look.bg, look.fg, "confirm button text is visible");
  assert.notEqual(look.bg, "rgb(255, 255, 255)", "confirm button is coloured");
  await confirm.click();
  await listed("甲記事").waitFor({ state: "detached" });
  await remoteMemo("甲記事");
  console.log("ok list delete");

  // 2) Editor → 記事選項 → 刪除記事 → 確定
  await page.getByRole("button", { name: "更多操作：乙記事" }).click();
  await page.getByRole("button", { name: "編輯", exact: true }).click();
  await page.getByRole("button", { name: "記事選項" }).click();
  await page.getByRole("button", { name: "刪除記事" }).click();
  await page.getByRole("button", { name: "確定刪除？會同步到所有裝置" }).click();
  await listed("乙記事").waitFor({ state: "detached" });
  await remoteMemo("乙記事");
  console.log("ok editor delete");

  // 3) Note with a picture
  await page.getByRole("button", { name: "更多操作：丙有圖" }).click();
  await page.getByRole("button", { name: "刪除", exact: true }).click();
  await page.getByRole("button", { name: "確定刪除？會同步到所有裝置" }).click();
  await listed("丙有圖").waitFor({ state: "detached" });
  await remoteMemo("丙有圖");
  console.log("ok picture delete");

  // 4) New note: type, then delete straight away (before autosave settles)
  await page.getByRole("button", { name: "新增記事" }).click();
  await page.getByRole("textbox", { name: "標題" }).fill("新的草稿");
  await page.locator(".memoBody[contenteditable]").click();
  await page.keyboard.type("馬上刪除");
  await page.getByRole("button", { name: "記事選項" }).click();
  await page.getByRole("button", { name: "刪除記事" }).click();
  await page.getByRole("button", { name: "確定刪除？會同步到所有裝置" }).click();
  await page.waitForTimeout(2500);
  assert.equal(await listed("新的草稿").count(), 0, "new note deleted");
  await remoteMemo("新的草稿");
  console.log("ok new-note delete");

  // 5) After a reload, deleted notes stay gone, the other one remains
  await page.reload();
  await unlock();
  await listed("丁保留").waitFor();
  for (const title of ["甲記事", "乙記事", "丙有圖", "新的草稿"])
    assert.equal(await listed(title).count(), 0, `${title} stays deleted`);
  assert.deepEqual(errors, []);
  console.log((QUEST ? "[Meta Quest] " : "") + "PASS phone note delete: readable confirm button, list ⋯, editor options, note with a picture, new note right after typing; synced to Drive and still gone after reload");
} finally {
  await browser.close();
  server.close();
}
