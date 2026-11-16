// Sync & backup shows the Drive conflict choices instead of an error, gates
// each choice behind a password (and a confirmation for replacing Drive), and
// hides them again after disconnecting. Real Drive calls are covered by the
// unit tests; here Drive is never reached.
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const shot = process.argv[2];
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/drive-conflict-test-" + Date.now()),
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
  await page.setViewportSize({ width: 380, height: 600 });
  await page.goto(base);
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: "CREATE", password: "1234" });
    // As left by a sync that found a different vault in Drive.
    await chrome.storage.local.set({
      driveConflict: true,
      syncError:
        "Google Drive 已有另一個保險庫，請在「同步與備份」選擇要保留哪一份。",
    });
  });
  await page.reload();
  // The main screen points to the choice.
  const hint = page.locator(".syncHint");
  await hint.waitFor();
  assert.match(await hint.innerText(), /另一個保險庫/);
  await hint.click();
  const box = page.locator(".driveConflict");
  await box.waitFor();
  assert.equal(await page.locator(".inlineError").count(), 0, "no raw error");
  assert.equal(
    await page.getByRole("button", { name: "連接 Google Drive" }).count(),
    0,
    "the plain connect button is replaced by the choices",
  );
  if (shot) await page.screenshot({ path: resolve(shot, "conflict-1.png") });

  // Choice 1 needs the Drive vault's password.
  await box.getByRole("button", { name: /改用 Drive 上的保險庫/ }).click();
  const use = box.getByRole("button", { name: "改用 Drive 上的保險庫", exact: true });
  assert(await use.isDisabled());
  await box.getByLabel("Drive 保險庫的主密碼").fill("x");
  assert(await use.isEnabled());
  await box.getByRole("button", { name: "取消" }).click();

  // Choice 2 needs this vault's password and the confirmation tick.
  await box.getByRole("button", { name: /以這台電腦取代 Drive/ }).click();
  const replace = box.getByRole("button", { name: "刪除 Drive 舊資料並上傳" });
  await box.getByLabel("這台電腦的主密碼").fill("wrong");
  assert(await replace.isDisabled(), "needs the confirmation");
  await box.getByLabel(/我了解 Drive 上的舊資料將被刪除/).check();
  assert(await replace.isEnabled());
  if (shot) await page.screenshot({ path: resolve(shot, "conflict-2.png") });
  // A wrong password is rejected before Drive is contacted.
  await replace.click();
  await box.locator(".inlineError").waitFor();
  assert.match(await box.locator(".inlineError").innerText(), /密碼/);

  // Disconnecting dismisses the conflict.
  await page.getByRole("button", { name: "中斷連線" }).click();
  await box.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "連接 Google Drive" }).waitFor();

  // Drive full: a hint on the main screen and a storage link in settings.
  await page.evaluate(async () => {
    await chrome.storage.local.set({
      driveEnabled: true,
      lastSync: Date.now(),
      syncError:
        "Google Drive 空間已滿。資料仍安全保存在這台電腦，清出空間後會自動繼續同步。",
    });
  });
  await page.reload();
  await hint.waitFor();
  assert.match(await hint.innerText(), /空間已滿/);
  if (shot) await page.screenshot({ path: resolve(shot, "full-1.png") });
  await hint.click();
  const link = page.getByRole("link", { name: /管理 Google 儲存空間/ });
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), "https://one.google.com/storage");
  if (shot) await page.screenshot({ path: resolve(shot, "full-2.png") });
  // An ordinary error shows no hint until sync has failed for over an hour.
  await page.evaluate(async () => {
    await chrome.storage.local.set({
      syncError: "Drive 請求失敗 (503)，本機資料已保留",
      lastSync: Date.now() - 10 * 60 * 1000,
    });
  });
  await page.reload();
  await page.locator(".quickBottom").waitFor();
  assert.equal(await hint.count(), 0);
  await page.evaluate(async () => {
    await chrome.storage.local.set({ lastSync: Date.now() - 2 * 3600 * 1000 });
  });
  await page.reload();
  await hint.waitFor();
  assert.match(await hint.innerText(), /1 小時/);
  console.log("drive conflict and storage-full e2e passed");
} finally {
  await context.close();
}
