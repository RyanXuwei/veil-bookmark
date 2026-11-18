// A new user with no extension: the connected Google Drive has no vault, so
// the mobile web app offers to create one. The vault is uploaded in the
// extension's format (opens with the password and with the recovery key),
// bookmarks added afterwards sync, a reload unlocks it, and a Drive that
// already has a vault never gets a second one.
// Run: npm run build:web && npx tsx scripts/web-setup-e2e.mts
import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import assert from "node:assert/strict";
import {
  decrypt,
  openWithPassword,
  openWithRecovery,
  parseRecoveryCode,
  validateEnvelope,
  type SealedEnvelope,
} from "../src/crypto";

const root = resolve(import.meta.dirname, "..");
const PASSWORD = "new-user-5678";
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

// ---- Simulated Drive (empty) ----------------------------------------------
const remote = new Map<string, unknown>();
let next = 0;
const browser = await chromium.launch();
async function phone() {
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    locale: "zh-TW",
    serviceWorkers: "block",
  } as any);
  await context.addInitScript(() => {
    if (localStorage.getItem("veilTestSeeded")) return;
    localStorage.setItem("veilTestSeeded", "1");
    localStorage.setItem(
      "veilAccount:new-user",
      JSON.stringify({
        id: "new-user",
        email: "new@example.com",
        name: "New",
        token: "synthetic-token",
        expires: Date.now() + 3600_000,
      }),
    );
    sessionStorage.setItem("veilActiveAccount", "new-user");
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
        json: {
          user: {
            permissionId: "new-user",
            emailAddress: "new@example.com",
            displayName: "New",
          },
        },
      });
    if (req.headers()["authorization"] !== "Bearer synthetic-token")
      return route.fulfill({ status: 401, body: "" });
    if (req.method() === "POST") {
      const json = (req.postData() || "")
        .split("Content-Type: application/json\r\n\r\n")[1]
        .split("\r\n--")[0];
      const fid = "f-" + next++;
      remote.set(fid, JSON.parse(json));
      return route.fulfill({ json: { id: fid } });
    }
    const fid = decodeURIComponent(u.split("/files/")[1]?.split("?")[0] || "");
    if (req.method() === "DELETE")
      return route.fulfill({ status: remote.delete(fid) ? 204 : 404, body: "" });
    if (u.includes("alt=media"))
      return remote.has(fid)
        ? route.fulfill({
            body: JSON.stringify(remote.get(fid)),
            contentType: "application/json",
          })
        : route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      json: { files: [...remote.keys()].map((id) => ({ id })) },
    });
  });
  return context;
}
const only = () => {
  assert.equal(remote.size, 1, "Drive holds exactly one vault snapshot");
  return validateEnvelope([...remote.values()][0]) as SealedEnvelope;
};

try {
  const ctx = await phone();
  const page = await ctx.newPage();
  await page.goto(APP);
  // 1) Empty Drive → create screen (no "install the extension first").
  await page.getByRole("heading", { name: "建立你的保險庫" }).waitFor();
  assert.equal(await page.getByText("擴充功能「同步與備份」").count(), 0);
  const create = page.getByRole("button", { name: "建立保險庫 →" });
  await page.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await page.getByLabel("再次輸入密碼").fill(PASSWORD + "x");
  assert(await create.isDisabled(), "needs the acknowledgement first");
  await page.getByRole("checkbox").check();
  await create.click();
  await page.getByRole("alert").filter({ hasText: "兩次密碼不一致" }).waitFor();
  assert.equal(remote.size, 0, "nothing uploaded on a mismatch");
  if (shot) await page.screenshot({ path: resolve(shot, "setup-1.png") });
  await page.getByLabel("再次輸入密碼").fill(PASSWORD);
  await create.click();

  // 2) Recovery key shown once; the vault is already on Drive.
  const codeEl = page.getByTestId("recovery-code");
  await codeEl.waitFor();
  const code = (await codeEl.getAttribute("data-code"))!;
  assert.match(code, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  if (shot) await page.screenshot({ path: resolve(shot, "setup-2.png") });
  const env = only();
  assert.equal(env.version, 3);
  const { dek } = await openWithPassword(env, PASSWORD);
  const byRecovery = await openWithRecovery(env, parseRecoveryCode(code));
  assert.deepEqual(
    (await decrypt(env, byRecovery)).id,
    (await decrypt(env, dek)).id,
    "the recovery key opens the same vault",
  );
  const done = page.getByRole("button", { name: "完成" });
  assert(await done.isDisabled(), "must confirm the key was saved");
  await page.getByText("我已將救援金鑰保存在安全的地方").click();
  await done.click();

  // 3) Opened: add a bookmark, it syncs to Drive (still one snapshot).
  await page.getByRole("button", { name: "新增書籤" }).click();
  await page.getByLabel("名稱").fill("第一個書籤");
  await page.getByLabel("網址").fill("https://example.com/first");
  await page.getByRole("button", { name: "加密儲存 →" }).click();
  await page.getByText("已加密收藏").waitFor();
  await page.locator(".syncDot", { hasText: "已同步" }).waitFor();
  const after = await decrypt(only(), dek);
  assert(after.entries.some((x) => x.title === "第一個書籤" && !x.deleted));

  // 4) Reload → normal unlock screen; the password opens it.
  await page.reload();
  await page.getByRole("heading", { name: "歡迎回來" }).waitFor();
  await page.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByText("第一個書籤").waitFor();
  await ctx.close();

  // 5) Another phone on the same account: Drive already has the vault, so
  //    it asks for the password, never offers to create a second one.
  const other = await phone();
  const p2 = await other.newPage();
  await p2.goto(APP);
  await p2.getByRole("heading", { name: "歡迎回來" }).waitFor();
  await p2.waitForTimeout(800);
  assert.equal(
    await p2.getByRole("heading", { name: "建立你的保險庫" }).count(),
    0,
  );
  await p2.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await p2.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await p2.getByText("第一個書籤").waitFor();
  only();
  await other.close();
  console.log(
    "PASS new user without the extension: empty Drive offers to create a vault, mismatch/ack checks, recovery key shown once and opens the vault, uploaded in the extension's format, new bookmark syncs, reload unlocks, a second phone unlocks instead of creating another vault",
  );
} finally {
  await browser.close();
  server.close();
}
