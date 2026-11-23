// Phone appearance: follows the phone's light/dark setting by default; the
// 「外觀」 setting can force light or dark and is remembered. No CSP errors.
// Run: npm run build:web && npx tsx scripts/web-theme-e2e.mts [shots]
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
seedV.memos.push({
  id: crypto.randomUUID(),
  title: "計畫",
  body: "<p>第一行</p><p>第二行</p>",
  format: "html",
  images: [],
  updated: now,
  revision: "m1",
  deleted: false,
} as any);
seedV.entries.push({
  id: crypto.randomUUID(),
  title: "範例網站",
  url: "https://example.com/",
  folder: "",
  tags: ["參考"],
  notes: "",
  updated: now,
  revision: "e1",
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
  colorScheme: "dark",
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
const problems: string[] = [];
page.on("console", (m) => {
  if (m.type() === "error" && /Content Security Policy|Refused/.test(m.text())) problems.push(m.text());
});
page.on("pageerror", (e) => problems.push(String(e)));
const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
const bg = () =>
  page.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.map(Number);
    return (r + g + b) / 3;
  });
try {
  // Phone in dark mode, no choice made: dark.
  await page.goto(APP);
  assert.equal(await theme(), "dark");
  assert.ok((await bg()) < 80, "dark page background");
  if (shot) await page.screenshot({ path: resolve(shot, "phone-dark-unlock.png") });
  await page.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByText("範例網站").first().waitFor();
  if (shot) await page.screenshot({ path: resolve(shot, "phone-dark-main.png") });
  await page.getByRole("tab", { name: /記事本/ }).click();
  await page.getByText("計畫").first().click();
  await page.getByRole("dialog").getByText("第一行").waitFor();
  if (shot) await page.screenshot({ path: resolve(shot, "phone-dark-memo.png") });
  await page.keyboard.press("Escape");
  await page.goto(APP);
  await page.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByText("範例網站").first().waitFor();

  // Force light in 「同步與設定」 → 外觀; remembered after reload.
  await page.getByRole("button", { name: "同步與設定" }).click();
  const light = page.getByRole("radio", { name: "淺色" });
  await light.scrollIntoViewIfNeeded();
  if (shot) await page.screenshot({ path: resolve(shot, "phone-dark-settings.png") });
  await light.check();
  assert.equal(await theme(), "light");
  assert.ok((await bg()) > 200, "light page background");
  await page.reload();
  assert.equal(await theme(), "light");

  // Back to following the phone.
  await page.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByText("範例網站").first().waitFor();
  await page.getByRole("button", { name: "同步與設定" }).click();
  await page.getByRole("radio", { name: "跟隨系統" }).check();
  assert.equal(await theme(), "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light", null, { timeout: 5000 });
  assert.deepEqual(problems, []);
  console.log("PASS phone appearance: follows the phone (dark/light, live), forced light remembered, no CSP errors");
} finally {
  await browser.close();
  server.close();
}
