// Phone "current folder": chips pick a top folder, folder headings go into
// subfolders (‹ 上一層 goes back), and the ＋ button files new bookmarks and
// notes in the folder the user is in. Notes get the same folder chips.
// Run: npm run build:web && npx tsx scripts/web-current-folder-e2e.mts [shots]
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
for (const [title, url, folder] of [
  ["一般書籤", "https://example.org/", ""],
  ["工作書籤", "https://example.org/work", "Work"],
  ["子資料夾書籤", "https://example.org/sub", "Work/Sub"],
])
  seedV.entries.push({
    id: crypto.randomUUID(),
    title,
    url,
    folder,
    tags: [],
    notes: "",
    updated: now,
    revision: crypto.randomUUID(),
    deleted: false,
  });
for (const [title, folder] of [
  ["日記一", "Diary"],
  ["日記二", "Diary/2026"],
  ["散記", ""],
])
  seedV.memos.push({
    id: crypto.randomUUID(),
    title,
    body: `<p>${title}</p>`,
    format: "html",
    folder,
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
const unlock = async () => {
  await page.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByText("一般書籤").waitFor();
};
async function waitDrive<T>(pick: (v: Vault) => T | undefined): Promise<T> {
  for (let i = 0; ; i++) {
    const v = await current().catch(() => null);
    const x = v && pick(v);
    if (x) return x;
    if (i > 100) throw Error("not saved to Drive");
    await page.waitForTimeout(100);
  }
}
const chips = page.locator(".chips").first();
const trail = page.locator(".folderTrail");
try {
  await page.goto(APP);
  await unlock();

  // All: the ＋ button files at the top level, as before.
  await page.getByRole("button", { name: "新增書籤" }).click();
  assert.equal(await page.getByRole("combobox", { name: "資料夾" }).inputValue(), "");
  await page.keyboard.press("Escape");

  // Work chip, then the "Work › Sub" heading goes into the subfolder.
  await chips.getByRole("button", { name: "Work", exact: true }).click();
  await page.getByRole("button", { name: "Work › Sub ›" }).click();
  await trail.getByText("Work › Sub").waitFor();
  assert.equal(await chips.getByRole("button", { name: "Work", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByText("工作書籤").count(), 0, "only Work/Sub is listed");
  if (shot) await page.screenshot({ path: resolve(shot, "phone-current-folder.png") });
  await page.getByRole("button", { name: "新增書籤" }).click();
  assert.equal(await page.getByRole("combobox", { name: "資料夾" }).inputValue(), "Work/Sub");
  await page.getByLabel("名稱").fill("新的子書籤");
  await page.getByLabel("網址").fill("https://example.com/new-sub");
  await page.getByRole("button", { name: "加密儲存 →" }).click();
  await page.getByText("新的子書籤").waitFor();
  const e = await waitDrive((v) => v.entries.find((x) => x.title === "新的子書籤"));
  assert.equal(e.folder, "Work/Sub");

  // ‹ 上一層 goes back to Work; new bookmarks go there.
  await trail.getByRole("button", { name: "‹ 上一層" }).click();
  await page.getByText("工作書籤").waitFor();
  assert.equal(await trail.count(), 0);
  await page.getByRole("button", { name: "新增書籤" }).click();
  assert.equal(await page.getByRole("combobox", { name: "資料夾" }).inputValue(), "Work");
  await page.keyboard.press("Escape");

  // Notes: folder chips; a new note in Diary/2026 is filed there.
  await page.getByRole("tab", { name: /記事本/ }).click();
  const memoChips = page.locator(".memoChips");
  await memoChips.getByRole("button", { name: "Diary", exact: true }).click();
  assert.equal(await page.locator("main strong", { hasText: "散記" }).count(), 0, "only Diary is listed");
  await page.getByRole("button", { name: "Diary › 2026 ›" }).click();
  await trail.getByText("Diary › 2026").waitFor();
  assert.equal(await page.locator("main strong", { hasText: "日記一" }).count(), 0);
  await page.getByRole("button", { name: "新增記事" }).click();
  await page.getByRole("textbox", { name: "標題" }).fill("新的日記");
  const body = page.locator(".memoBody[contenteditable=true]");
  await body.click();
  await page.keyboard.type("內容");
  await page.getByRole("button", { name: "← 完成" }).click();
  const m = await waitDrive((v) => v.memos.find((x) => x.title === "新的日記" && !x.deleted));
  assert.equal(m.folder, "Diary/2026");
  // All notes: a new note stays unfiled, as before.
  await memoChips.getByRole("button", { name: "全部", exact: true }).click();
  await page.locator("main strong", { hasText: "散記" }).waitFor();
  await page.getByRole("button", { name: "新增記事" }).click();
  await page.getByRole("textbox", { name: "標題" }).fill("頂層記事");
  await page.locator(".memoBody[contenteditable=true]").click();
  await page.keyboard.type("內容");
  await page.getByRole("button", { name: "← 完成" }).click();
  const top = await waitDrive((v) => v.memos.find((x) => x.title === "頂層記事" && !x.deleted));
  assert.equal(top.folder || "", "");
  console.log("PASS phone current folder: chips, subfolder headings, ‹ 上一層, new bookmarks and notes filed in the current folder");
} finally {
  await browser.close();
  server.close();
}
