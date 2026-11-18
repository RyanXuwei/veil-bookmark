// Bookmarks saved in an incognito window are marked and always open in an
// incognito window, also when clicked from a normal window; the mark can be
// changed in the editor.
// Run: npm run build && node scripts/incognito-e2e.mjs
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/incognito-test-" + Date.now()),
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
  const base = `chrome-extension://${id}/index.html`;
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

  // Saved as incognito (what the popup does in an incognito window).
  await rpc("UPSERT", { entry: { title: "私密網站", url: "https://example.com/private", incognito: true } });
  await rpc("UPSERT", { entry: { title: "一般網站", url: "https://example.org/" } });
  await popup.reload();
  const priv = popup.locator(".quickRow", { hasText: "私密網站" });
  await priv.locator(".privTag", { hasText: "無痕" }).waitFor();
  assert.equal(await popup.locator(".quickRow", { hasText: "一般網站" }).locator(".privTag").count(), 0);

  // Clicked from a normal window → opens in a new incognito window; the
  // normal tab is not navigated.
  const v = await rpc("LIST");
  const pid = v.entries.find((x) => x.title === "私密網站").id;
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }));
  const before = tab.url;
  // An extension not allowed in incognito cannot list incognito windows, so
  // record what it asks Chrome to create.
  await worker.evaluate(() => {
    const real = chrome.windows.create.bind(chrome.windows);
    globalThis.__created = [];
    chrome.windows.create = (o) => {
      globalThis.__created.push(o);
      return real(o);
    };
  });
  await rpc("OPEN", { id: pid, incognito: false, targetTabId: tab.id });
  const created = await worker.evaluate(() => globalThis.__created);
  assert.deepEqual(created, [{ url: "https://example.com/private", incognito: true }], "opened in an incognito window");
  const after = await worker.evaluate((id) => chrome.tabs.get(id), tab.id);
  assert.equal(after.url, before, "the normal tab was left alone");

  // Editor shows the setting checked; unchecking it makes it a normal bookmark.
  await priv.locator(".quickMore").click();
  await popup.getByRole("button", { name: "編輯" }).click();
  const box = popup.getByRole("checkbox", { name: "一律用無痕視窗開啟" });
  assert(await box.isChecked());
  await box.uncheck();
  await popup.getByRole("button", { name: "加密儲存 →" }).click();
  await popup.locator(".quickRow", { hasText: "私密網站" }).locator(".privTag").waitFor({ state: "detached" });
  assert.equal("incognito" in (await rpc("LIST")).entries.find((x) => x.id === pid), false);

  // New bookmarks from a normal window start unchecked.
  await popup.getByRole("button", { name: "手動新增書籤" }).click();
  assert.equal(await popup.getByRole("checkbox", { name: "一律用無痕視窗開啟" }).isChecked(), false);
  console.log(
    "PASS incognito bookmarks: marked in the list, opened in an incognito window from a normal window (normal tab untouched), editor toggle, new bookmarks in a normal window unmarked",
  );
} finally {
  await context.close();
}
