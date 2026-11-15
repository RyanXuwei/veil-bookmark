// Drive setup guide page: rendering, redirect URI, client ID validation/saving,
// entry points from the popup. Never contacts Google (no vault is unlocked).
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const shots = resolve(root, "../previews");
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/setup-test-" + Date.now()),
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
const external = [];
context.on("request", (r) => {
  if (!/^(chrome-extension|data|about|chrome):/.test(r.url()))
    external.push(r.url());
});
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;

  // Entry point: the welcome screen's "restore from Drive" opens the guide when not set up.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${id}/index.html?popup`);
  await popup.getByRole("heading", { name: "建立你的私密空間" }).waitFor();
  const [guide] = await Promise.all([
    context.waitForEvent("page"),
    popup.getByRole("button", { name: "從 Google Drive 還原" }).click(),
  ]);
  await guide.waitForLoadState();
  assert(guide.url().endsWith("index.html?setup"));
  await guide.setViewportSize({ width: 1100, height: 1300 });
  await guide
    .getByRole("heading", { name: "設定 Google Drive 同步" })
    .waitFor();
  await guide.getByText("尚未設定", { exact: true }).waitFor();
  const redirect = `https://${id}.chromiumapp.org/`;
  assert.equal(await guide.locator(".copyField code").innerText(), redirect);
  const hrefs = await guide
    .locator("a.extLink")
    .evaluateAll((a) => a.map((x) => x.href));
  assert(
    hrefs.length === 4 &&
      hrefs.every((h) => h.startsWith("https://console.cloud.google.com/")),
  );
  await guide.screenshot({
    path: resolve(shots, "24-drive-setup.png"),
    fullPage: true,
  });

  const input = guide.getByRole("textbox", { name: "用戶端 ID" });
  const save = guide.getByRole("button", { name: "儲存並連接 Google Drive →" });
  await input.fill("GOCSPX-secret-looking-value");
  await guide.getByText("用戶端 ID 格式不正確").waitFor();
  assert(await save.isDisabled());
  await input.fill("1234567890-synthetic.apps.googleusercontent.com");
  assert(await save.isEnabled());
  await save.click();
  await guide.getByText("已設定，尚未連接").waitFor();
  await guide.getByText("新電腦請在工具列浮框輸入主密碼").waitFor();
  const stored = await worker.evaluate(() =>
    chrome.storage.local.get("oauthClientId"),
  );
  assert.equal(
    stored.oauthClientId,
    "1234567890-synthetic.apps.googleusercontent.com",
  );

  // Narrow layout: no horizontal scroll.
  await guide.setViewportSize({ width: 380, height: 900 });
  assert.equal(
    await guide.evaluate(() => document.documentElement.scrollWidth),
    380,
  );
  await guide.screenshot({ path: resolve(shots, "25-drive-setup-narrow.png") });

  // English rendering.
  await guide.setViewportSize({ width: 1100, height: 1300 });
  await guide.selectOption("select.langSelect", "en");
  await guide
    .getByRole("heading", { name: "Set up Google Drive sync" })
    .waitFor();
  await guide.screenshot({
    path: resolve(shots, "26-drive-setup-en.png"),
    fullPage: true,
  });

  // Removing the setup returns to "not set up".
  await guide
    .getByRole("button", { name: "Remove Google Drive setup" })
    .click();
  await guide.getByText("Not set up", { exact: true }).waitFor();
  assert.deepEqual(external, [], "setup page must not contact external hosts");
  console.log("PASS drive setup guide", redirect);
} finally {
  await context.close();
}
