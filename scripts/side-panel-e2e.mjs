// Side panel mode: the toolbar icon can open Chrome's side panel instead of
// the popup; the popup has a shortcut to the side panel; the panel page fills
// its width, stays open after actions and follows the vault lock.
// Run: npm run build && node scripts/side-panel-e2e.mjs [screenshot folder]
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const shots = process.argv[2];
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/side-panel-test-" + Date.now()),
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
    context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  // An idle PC would lock the vault at once (chrome.idle); only the lock
  // rule itself is out of scope here.
  await worker.evaluate(() => chrome.idle.setDetectionInterval(86400));
  const base = `chrome-extension://${id}/index.html`;

  // Manifest: side panel page and default behaviour (icon opens the popup).
  const options = await worker.evaluate(() => chrome.sidePanel.getOptions({}));
  assert.equal(options.path, "index.html?popup&panel");
  const state = () =>
    worker.evaluate(async () => ({
      popup: await chrome.action.getPopup({}),
      behavior: (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick,
    }));
  assert.match((await state()).popup, /index\.html\?popup$/);
  assert.equal((await state()).behavior, false);

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.goto(`${base}?popup`);
  await popup.locator("input[type=password]").nth(0).fill("1234");
  await popup.locator("input[type=password]").nth(1).fill("1234");
  await popup.locator(".ackRow input").check();
  await popup.getByRole("button", { name: "建立保險庫 →" }).click();
  await popup.locator(".recoveryModal .ackRow input").check();
  await popup.getByRole("button", { name: "完成" }).click();
  const rpc = (type, data = {}) =>
    popup.evaluate(
      async ([type, data]) => {
        const w = await chrome.windows.getCurrent();
        const r = await chrome.runtime.sendMessage({ type, sourceWindowId: w.id, ...data });
        if (!r.ok) throw Error(r.error);
        return r.data;
      },
      [type, data],
    );
  await rpc("UPSERT", { entry: { title: "側邊欄書籤", url: "https://example.com/side" } });

  // Popup shortcut: opens the side panel for this window, then closes.
  await popup.evaluate(() => {
    globalThis.__opened = [];
    globalThis.__closed = 0;
    chrome.sidePanel.open = async (o) => void globalThis.__opened.push(o);
    window.close = () => void globalThis.__closed++;
  });
  const button = popup.getByRole("button", { name: "在側邊欄開啟" });
  if (shots) await popup.screenshot({ path: resolve(shots, "popup-side-button.png") });
  await button.click();
  await popup.waitForFunction(() => globalThis.__closed === 1);
  const [opened] = await popup.evaluate(() => globalThis.__opened);
  const windowId = await popup.evaluate(async () => (await chrome.windows.getCurrent()).id);
  assert.deepEqual(opened, { windowId });

  // Setting: icon opens the side panel → popup cleared, panel behaviour on.
  await popup.getByRole("button", { name: "同步與備份" }).click();
  await popup.getByRole("radio", { name: "開啟側邊欄" }).check();
  for (let i = 0; i < 50 && (await state()).behavior !== true; i++)
    await popup.waitForTimeout(100);
  assert.deepEqual(await state(), { popup: "", behavior: true });
  if (shots) await popup.screenshot({ path: resolve(shots, "side-panel-setting.png") });
  // Survives a reopen.
  await popup.reload();
  await popup.getByRole("button", { name: "同步與備份" }).click();
  assert.equal(await popup.getByRole("radio", { name: "開啟側邊欄" }).isChecked(), true);

  // The panel page: fills the panel, no shortcut button, does not close.
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 520, height: 900 });
  await panel.goto(`${base}?popup&panel`);
  await panel.locator(".quickRow", { hasText: "側邊欄書籤" }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "在側邊欄開啟" }).count(), 0);
  const size = await panel.evaluate(() => {
    const app = document.querySelector(".app").getBoundingClientRect();
    return { width: app.width, height: app.height, list: document.querySelector(".quickList").getBoundingClientRect().height };
  });
  assert.equal(size.width, 520, "fills the panel width");
  assert.equal(size.height, 900, "fills the panel height");
  assert.ok(size.list > 500, "bookmark list grows with the panel");
  if (shots) await panel.screenshot({ path: resolve(shots, "side-panel.png") });
  await panel.evaluate(() => {
    globalThis.__closed = 0;
    window.close = () => void globalThis.__closed++;
  });
  await panel.locator(".viewTabs").getByRole("tab", { name: "記事本" }).click();
  const opening = context.waitForEvent("page");
  await panel.locator(".quickCapture").click();
  const notes = await opening;
  await notes.waitForLoadState();
  assert.match(notes.url(), /\?notes#new$/);
  await notes.close();
  assert.equal(await panel.evaluate(() => globalThis.__closed), 0, "panel stays open");

  // Lock elsewhere → the open panel shows the unlock screen.
  await rpc("LOCK");
  await panel.locator("input[type=password]").first().waitFor();
  assert.equal(await panel.locator(".quickRow").count(), 0);

  // Back to the popup.
  await popup.reload();
  await popup.locator("input[type=password]").first().fill("1234");
  await popup.keyboard.press("Enter");
  await popup.getByRole("button", { name: "同步與備份" }).click();
  await popup.getByRole("radio", { name: "開啟浮框" }).check();
  for (let i = 0; i < 50 && (await state()).behavior !== false; i++)
    await popup.waitForTimeout(100);
  const back = await state();
  assert.match(back.popup, /index\.html\?popup$/);
  assert.equal(back.behavior, false);
  console.log("side-panel-e2e: ok");
} finally {
  await context.close();
}
