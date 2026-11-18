// Mobile web app: Face ID / fingerprint unlock with a passkey (WebAuthn PRF),
// using Chrome's virtual authenticator as the phone's biometric sensor.
// Run: npx vite build -c vite.web.config.ts && npx tsx scripts/web-bio-e2e.mts [shots]
import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import assert from "node:assert/strict";
import {
  emptyVault,
  newDataKey,
  seal,
  setPassword,
  type Vault,
} from "../src/crypto";

const root = resolve(import.meta.dirname, "..");
const shot = process.argv[2];
const PASSWORD = "bio-test-1234";
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
const port = (server.address() as { port: number }).port;
// WebAuthn needs a domain (not an IP) as the site ID.
const APP = `http://localhost:${port}/`;

const dek = await newDataKey();
const id = crypto.randomUUID();
const keys = await setPassword(dek, id, PASSWORD);
const v: Vault = emptyVault(id);
v.entries.push({
  id: "e1",
  title: "生物辨識測試書籤",
  url: "https://example.com/",
  folder: "",
  tags: [],
  notes: "",
  updated: Date.now(),
  revision: "r1",
  deleted: false,
});
const remote = new Map<string, unknown>([["s1", await seal(v, dek, keys)]]);

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices["Pixel 7"],
  locale: "zh-TW",
  serviceWorkers: "block",
});
await context.addInitScript(()=>{
 if(localStorage.getItem("veilBioTestSeeded"))return;
 localStorage.setItem("veilBioTestSeeded","1");
 localStorage.setItem("veilAccount:test-account",JSON.stringify({id:"test-account",email:"test@example.com",token:"synthetic-token",expires:Date.now()+3600000}));
});

await context.route("**/config.json", (r) =>
  r.fulfill({ json: { clientId: "test-client.apps.googleusercontent.com" } }),
);
await context.route("https://www.googleapis.com/**", async (route) => {
  const req = route.request();
  const u = req.url();
  if (u.includes("/about?"))
    return route.fulfill({
      json: {
        user: {
          permissionId: "test-account",
          emailAddress: "test@example.com",
          displayName: "Test",
        },
      },
    });
  if (req.method() === "POST") return route.fulfill({ json: { id: "x" } });
  const fid = decodeURIComponent(u.split("/files/")[1]?.split("?")[0] || "");
  if (u.includes("alt=media"))
    return route.fulfill({
      body: JSON.stringify(remote.get(fid)),
      contentType: "application/json",
    });
  return route.fulfill({
    json: { files: [...remote.keys()].map((id) => ({ id })) },
  });
});

await context.addInitScript(() =>
  sessionStorage.setItem("veilActiveAccount", "test-account"),
);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    ctap2Version: "ctap2_1",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    hasPrf: true,
    automaticPresenceSimulation: true,
  },
});
const record = () =>
  page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((r) => {
      const q = indexedDB.open("veil-bookmark-bio", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("kv");
      q.onsuccess = () => r(q.result);
    });
    return new Promise<any>((r) => {
      const q = db
        .transaction("kv")
        .objectStore("kv")
        .get("unlock:test-account");
      q.onsuccess = () => {
        db.close();
        r(q.result ?? null);
      };
    });
  });
const editRecord = (patch: Record<string, unknown>) =>
  page.evaluate(async (patch) => {
    const db: IDBDatabase = await new Promise((r) => {
      const q = indexedDB.open("veil-bookmark-bio", 1);
      q.onsuccess = () => r(q.result);
    });
    await new Promise<void>((r) => {
      const s = db.transaction("kv", "readwrite").objectStore("kv");
      const q = s.get("unlock:test-account");
      q.onsuccess = () => {
        s.put({ ...q.result, ...patch }, "unlock:test-account").onsuccess =
          () => r();
      };
    });
    db.close();
  }, patch);
const unlockWithPassword = async () => {
  await page.getByLabel("主密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByText("生物辨識測試書籤").waitFor();
};
const bioButton = page.getByRole("button", { name: "使用 Face ID／指紋解鎖" });
const lockAndWait = async () => {
  await page.getByRole("button", { name: "上鎖" }).click();
  await page.getByRole("heading", { name: "歡迎回來" }).waitFor();
};

try {
  await page.goto(APP);
  assert.equal(await bioButton.count(), 0, "off until turned on");
  await unlockWithPassword();

  // Offered on the main screen right after a password unlock.
  const prompt = page.locator(".bioPrompt");
  await prompt.waitFor();
  if (shot) await page.screenshot({ path: resolve(shot, "bio-0-prompt.png") });
  await prompt.getByRole("button", { name: "立即啟用" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "已啟用生物辨識解鎖" })
    .waitFor();
  assert.equal(await prompt.count(), 0, "the offer leaves once it is on");

  // Sync & settings shows it is on (and can turn it off, tested below).
  await page.locator(".syncDot").click();
  await page.getByRole("heading", { name: "生物辨識解鎖" }).waitFor();
  await page.getByRole("button", { name: "停用生物辨識解鎖" }).waitFor();
  if (shot)
    await page.screenshot({ path: resolve(shot, "bio-1-settings.png") });
  const r = await record();
  assert(r.credential && r.wrapped && r.salt, "wrapped key stored");
  const json = JSON.stringify(r);
  assert(!json.includes(PASSWORD), "the master password is not stored");
  const { credentials } = await cdp.send("WebAuthn.getCredentials", {
    authenticatorId,
  });
  assert.equal(credentials.length, 1, "one passkey on the phone");
  await page.getByRole("button", { name: "關閉" }).click();

  // Lock → unlock with the fingerprint only.
  await lockAndWait();
  await bioButton.waitFor();
  if (shot) await page.screenshot({ path: resolve(shot, "bio-2-unlock.png") });
  await bioButton.click();
  await page.getByText("生物辨識測試書籤").waitFor();

  // Again (a second unlock with the same passkey).
  await lockAndWait();
  await bioButton.click();
  await page.getByText("生物辨識測試書籤").waitFor();

  // After 30 days the master password is required once, then it works again.
  await editRecord({ passwordAt: Date.now() - 31 * 24 * 3600 * 1000 });
  await lockAndWait();
  await page.getByText("生物辨識解鎖已超過 30 天").waitFor();
  assert.equal(await bioButton.count(), 0);
  await unlockWithPassword();
  await lockAndWait();
  await bioButton.waitFor();

  // A key that no longer matches the vault is discarded.
  await editRecord({ wrapped: btoa("x".repeat(48)) });
  await bioButton.click();
  await page
    .getByRole("alert")
    .filter({ hasText: "生物辨識資料已失效" })
    .waitFor();
  assert.equal(await record(), null);
  assert.equal(await bioButton.count(), 0);

  // Turn on again, then off in settings.
  await unlockWithPassword();
  await page.locator(".syncDot").click();
  await page.getByRole("button", { name: "啟用 Face ID／指紋解鎖" }).click();
  await page.getByRole("button", { name: "停用生物辨識解鎖" }).click();
  await page.getByText("已停用生物辨識解鎖").waitFor();
  assert.equal(await record(), null);
  await page.getByRole("button", { name: "關閉" }).click();
  await lockAndWait();
  assert.equal(await bioButton.count(), 0);

  // Clearing the phone also removes it.
  await unlockWithPassword();
  await page.locator(".syncDot").click();
  await page.getByRole("button", { name: "啟用 Face ID／指紋解鎖" }).click();
  await page.getByText("已啟用生物辨識解鎖").waitFor();
  await page
    .getByRole("button", { name: "移除此帳戶的本機資料並登出" })
    .click();
  await page.getByRole("button", { name: "確定清除並登出？" }).click();
  await page.getByRole("heading", { name: "在手機上開啟你的書籤" }).waitFor();
  assert.equal(await record(), null);

  // A phone without a biometric authenticator: the option says so.
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  const other = await browser.newContext({
    ...devices["Pixel 7"],
    locale: "zh-TW",
    serviceWorkers: "block",
  });
  await other.addInitScript(() =>
    localStorage.setItem(
      "veilAccount:test-account",
      JSON.stringify({
        id: "test-account",
        email: "test@example.com",
        name: "Test",
        token: "synthetic-token",
        expires: Date.now() + 3600_000,
      }),
    ),
  );
  await other.addInitScript(() =>
    sessionStorage.setItem("veilActiveAccount", "test-account"),
  );
  await other.route("**/config.json", (r) =>
    r.fulfill({ json: { clientId: "test-client.apps.googleusercontent.com" } }),
  );
  await other.route("https://www.googleapis.com/**", (route) => {
    const u = route.request().url();
    if (u.includes("/about?"))
      return route.fulfill({
        json: {
          user: {
            permissionId: "test-account",
            emailAddress: "test@example.com",
          },
        },
      });
    if (u.includes("alt=media"))
      return route.fulfill({
        body: JSON.stringify(remote.get("s1")),
        contentType: "application/json",
      });
    return route.fulfill({ json: { files: [{ id: "s1" }] } });
  });
  // A browser without WebAuthn.
  await other.addInitScript(() => {
    delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  });
  const p2 = await other.newPage();
  await p2.goto(APP);
  await p2.getByLabel("主密碼").fill(PASSWORD);
  await p2.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await p2.getByText("生物辨識測試書籤").waitFor();
  await p2.locator(".syncDot").click();
  await p2.getByText("不支援以 Face ID／指紋解鎖").waitFor();
  await other.close();
  console.log(
    "PASS web biometric: passkey + PRF wraps the data key (no password stored), unlock twice, 30-day password, stale key discarded, turn off, clear phone, unsupported phone",
  );
} finally {
  await browser.close();
  server.close();
}
