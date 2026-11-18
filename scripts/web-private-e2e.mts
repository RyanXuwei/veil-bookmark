// The incognito-only folder on the phone: grey until opened, a dialog
// explains the phone's limits (取消 / 開啟), opening lists its bookmarks, and
// it is hidden again after the app is locked.
// Run: npm run build:web && npx tsx scripts/web-private-e2e.mts [shots]
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
  ["私密書籤", "https://example.net/secret", "🕶 無痕專用"],
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
try {
  await page.goto(APP);
  await unlock();
  const chip = page.getByRole("button", { name: "🕶 無痕專用" });
  await chip.waitFor();
  assert.match((await chip.getAttribute("class")) || "", /(^| )off( |$)/, "grey until opened");
  assert.equal(await page.getByText("私密書籤").count(), 0, "hidden at first");
  await page.locator("input[type=search]").fill("私密");
  assert.equal(await page.getByText("私密書籤").count(), 0, "not found by search");
  await page.locator("input[type=search]").fill("");
  if (shot) await page.screenshot({ path: resolve(shot, "phone-private-1.png") });

  // 取消 keeps it hidden.
  await chip.click();
  await page.getByRole("dialog", { name: "開啟無痕專用資料夾？" }).waitFor();
  await page.getByText("手機版無法支援完整的無痕功能").waitFor();
  if (shot) {
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(shot, "phone-private-2.png") });
  }
  await page.getByRole("button", { name: "取消" }).click();
  assert.equal(await page.getByText("私密書籤").count(), 0);

  // 開啟 lists the folder's bookmarks.
  await chip.click();
  await page.getByRole("button", { name: "開啟", exact: true }).click();
  await page.getByText("私密書籤").waitFor();
  assert.equal(await chip.getAttribute("aria-pressed"), "true");
  assert.doesNotMatch((await chip.getAttribute("class")) || "", /(^| )off( |$)/);
  assert.equal(await page.getByText("一般書籤").count(), 0, "only the folder's bookmarks while it is selected");
  if (shot) await page.screenshot({ path: resolve(shot, "phone-private-3.png") });

  // Locked and unlocked again: hidden again.
  await page.reload();
  await unlock();
  assert.equal(await page.getByText("私密書籤").count(), 0, "hidden again after locking");
  assert.match((await chip.getAttribute("class")) || "", /(^| )off( |$)/);
  console.log(
    "PASS phone incognito folder: grey and hidden (list and search) until opened, dialog with 取消/開啟, opening lists its bookmarks, hidden again after locking",
  );
} finally {
  await browser.close();
  server.close();
}
