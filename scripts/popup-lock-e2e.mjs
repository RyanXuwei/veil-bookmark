// Delayed LIST responses and recovery secrets must not survive an external lock.
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/popup-lock-test-" + Date.now()),
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
  const control = await context.newPage();
  await control.goto(base);
  await control.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: "CREATE", password: "1234" });
    await chrome.runtime.sendMessage({
      type: "UPSERT",
      entry: { title: "秘密書籤回覆", url: "https://example.com/private" },
    });
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 600 });
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.listTest = {
      hold: true,
      holdCreate: false,
      waiting: [],
      release: () => {
        window.listTest.hold = false;
        window.listTest.holdCreate = false;
        for (const r of window.listTest.waiting.splice(0)) r();
      },
    };
    chrome.runtime.sendMessage = async (message, ...args) => {
      const result = await original(message, ...args);
      if (
        (message.type === "LIST" && window.listTest.hold) ||
        (message.type === "CREATE" && window.listTest.holdCreate)
      )
        await new Promise((r) => window.listTest.waiting.push(r));
      return result;
    };
  });
  await page.goto(base);
  await page.waitForFunction(() => window.listTest.waiting.length > 0);
  await control.evaluate(() => chrome.runtime.sendMessage({ type: "LOCK" }));
  await page.getByRole("button", { name: "解鎖保險庫 →" }).waitFor();
  await page.evaluate(() => window.listTest.release());
  await page.waitForTimeout(200);
  assert(!(await page.content()).includes("秘密書籤回覆"));
  assert.equal(await page.locator(".quickList").count(), 0);

  // Fresh synthetic vault, created through the UI to display its one-time key.
  await control.evaluate(async () => {
    await chrome.storage.local.remove("vault");
    await chrome.storage.session.clear();
  });
  await page.reload();
  await page.getByRole("button", { name: "建立保險庫 →" }).waitFor();
  await page.evaluate(() => window.listTest.release());
  await page.locator("input[type=password]").nth(0).fill("1234");
  await page.locator("input[type=password]").nth(1).fill("1234");
  await page.locator(".ackRow input").check();
  await page.getByRole("button", { name: "建立保險庫 →" }).click();
  await page.locator(".recoveryModal").waitFor();
  const key = await page
    .locator("[data-testid=recovery-code]")
    .getAttribute("data-code");
  assert(key);
  await control.evaluate(() => chrome.runtime.sendMessage({ type: "LOCK" }));
  await page.locator(".recoveryModal").waitFor({ state: "hidden" });
  assert(!(await page.content()).includes(key));
  await page.getByRole("button", { name: "解鎖保險庫 →" }).waitFor();
  // A create response delivered after locking must not reopen the key modal.
  await control.evaluate(async () => {
    await chrome.storage.local.remove("vault");
    await chrome.storage.session.clear();
  });
  await page.reload();
  await page.getByRole("button", { name: "建立保險庫 →" }).waitFor();
  await page.evaluate(() => {
    window.listTest.release();
    window.listTest.holdCreate = true;
  });
  await page.locator("input[type=password]").nth(0).fill("1234");
  await page.locator("input[type=password]").nth(1).fill("1234");
  await page.locator(".ackRow input").check();
  await page.getByRole("button", { name: "建立保險庫 →" }).click();
  await page.waitForFunction(() => window.listTest.waiting.length > 0);
  await control.evaluate(() => chrome.runtime.sendMessage({ type: "LOCK" }));
  await page.evaluate(() => window.listTest.release());
  await page.getByRole("button", { name: "解鎖保險庫 →" }).waitFor();
  assert.equal(await page.locator(".recoveryModal").count(), 0);
  console.log(
    "PASS popup lock regressions: stale LIST response ignored; one-time recovery key cleared on external lock; delayed create reply cannot reopen secrets.",
  );
} finally {
  await context.close();
}
