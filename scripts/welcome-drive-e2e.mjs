// New installation: the welcome screen offers a Google Drive check when the
// account has not authorised Veil Bookmark yet, and switches to "restore from
// Drive" when a vault is found. Chrome for Testing has no Google account, so
// the "found" case answers DRIVE_PROBE in the page; the background side is
// covered by the unit tests.
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const shot = process.argv[2];
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/welcome-drive-test-" + Date.now()),
  {
    channel: "chromium",
    headless: true,
    locale: "zh-TW",
    args: [
      "--lang=zh-TW",
      `--disable-extensions-except=${resolve(root, "dist")}`,
      `--load-extension=${resolve(root, "dist")}`,
    ],
  },
);
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const base = `chrome-extension://${new URL(worker.url()).host}/index.html?popup`;
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 640 });

  // Not authorised: a check button, still on "create".
  await page.goto(base);
  const check = page.locator(".driveCheck");
  await check.waitFor();
  await page.getByRole("heading", { name: "建立你的私密空間" }).waitFor();
  assert.equal(await page.getByLabel("再次輸入密碼").count(), 1);
  if (shot) await page.screenshot({ path: resolve(shot, "welcome-1.png") });

  // A vault in Drive: the welcome screen switches to restoring it.
  const found = await context.newPage();
  await found.setViewportSize({ width: 380, height: 640 });
  await found.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m, ...rest) =>
      m?.type === "DRIVE_PROBE"
        ? Promise.resolve({ ok: true, data: { state: "found" } })
        : send(m, ...rest);
  });
  await found.goto(base);
  await found.getByRole("heading", { name: "在 Google Drive 找到你的保險庫" }).waitFor();
  assert.equal(await found.getByLabel("再次輸入密碼").count(), 0);
  assert.equal(await found.locator(".pwWarning").count(), 0);
  const restore = found.getByRole("button", { name: "從 Google Drive 還原 →" });
  await found.getByLabel("主密碼").fill("old");
  assert(await restore.isEnabled());
  if (shot) await found.screenshot({ path: resolve(shot, "welcome-2.png") });
  // The user can still start a new vault.
  await found.getByRole("button", { name: "改為建立新的保險庫" }).click();
  await found.getByRole("heading", { name: "建立你的私密空間" }).waitFor();
  assert.equal(await found.getByLabel("再次輸入密碼").count(), 1);
  console.log("PASS welcome: Drive check offered; found vault switches to restore; can still create");
} finally {
  await context.close();
}
