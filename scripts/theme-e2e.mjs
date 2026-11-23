// Appearance: extension pages follow the system light/dark setting by
// default; 「同步與備份 → 外觀」 forces light or dark for every extension page
// at once (popup, notebook) and is remembered.
// Run: npm run build && node scripts/theme-e2e.mjs
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/theme-test-" + Date.now()),
  {
    channel: "chromium",
    headless: true,
    locale: "zh-TW",
    colorScheme: "dark",
    args: [
      "--lang=zh-TW",
      `--disable-extensions-except=${resolve(root, "dist")}`,
      `--load-extension=${resolve(root, "dist")}`,
    ],
  },
);
try {
  const worker =
    context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  // An idle PC would lock the vault at once (chrome.idle).
  await worker.evaluate(() => chrome.idle.setDetectionInterval(86400));
  const id = new URL(worker.url()).host;
  const base = `chrome-extension://${id}/index.html`;
  const theme = (p) => p.evaluate(() => document.documentElement.dataset.theme);
  const until = (p, value) =>
    p.waitForFunction((v) => document.documentElement.dataset.theme === v, value, { timeout: 5000 });
  const bg = (p) =>
    p.evaluate(() => {
      const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
      return (r + g + b) / 3;
    });

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.goto(`${base}?popup`);
  await until(popup, "dark");
  assert.ok((await bg(popup)) < 80, "dark popup background");
  await popup.locator("input[type=password]").nth(0).fill("1234");
  await popup.locator("input[type=password]").nth(1).fill("1234");
  await popup.locator(".ackRow input").check();
  await popup.getByRole("button", { name: "建立保險庫 →" }).click();
  await popup.locator(".recoveryModal .ackRow input").check();
  await popup.getByRole("button", { name: "完成" }).click();

  const notes = await context.newPage();
  await notes.goto(`${base}?notes`);
  await until(notes, "dark");

  // Force light: both pages switch at once and stay light after reopening.
  await popup.getByRole("button", { name: "同步與備份" }).click();
  await popup.getByRole("radio", { name: "淺色" }).check();
  await until(popup, "light");
  await until(notes, "light");
  assert.ok((await bg(popup)) > 200, "light popup background");
  await notes.reload();
  await until(notes, "light");
  assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get("uiTheme")), { uiTheme: "light" });

  // Force dark while the system is light.
  await popup.emulateMedia({ colorScheme: "light" });
  await notes.emulateMedia({ colorScheme: "light" });
  await popup.getByRole("radio", { name: "深色" }).check();
  await until(notes, "dark");
  // Follow the system again → light now.
  await popup.getByRole("radio", { name: "跟隨系統" }).check();
  await until(popup, "light");
  await until(notes, "light");
  assert.equal(await theme(notes), "light");
  console.log("PASS appearance: follows the system, light/dark forced for all extension pages at once, remembered");
} finally {
  await context.close();
}
