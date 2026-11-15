import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/password-change-test-" + Date.now()),
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
    await chrome.runtime.sendMessage({
      type: "UPSERT",
      entry: { title: "preserved", url: "https://example.com" },
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "同步與備份", exact: true }).click();
  const section = page.locator(".passwordChange"),
    old = section.getByLabel("原密碼", { exact: true }),
    next = section.getByLabel("新密碼", { exact: true }),
    again = section.getByLabel("再次確認新密碼");
  assert(await next.isDisabled());
  assert(await again.isDisabled());
  await old.fill("wrong");
  await section.getByRole("button", { name: "驗證原密碼" }).click();
  await section.getByRole("alert").waitFor();
  assert(await next.isDisabled());
  await page.evaluate(() =>
    chrome.storage.session.remove(["attempts", "nextAttempt"]),
  );
  await old.fill("1234");
  await section.getByRole("button", { name: "驗證原密碼" }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector(
        '.passwordChange input[autocomplete="new-password"]',
      ).disabled,
  );
  assert(await old.isDisabled());
  assert(!(await again.isDisabled()));
  await next.fill("5678");
  await again.fill("9999");
  await section.getByRole("button", { name: "儲存新密碼" }).click();
  await section.getByText("兩次密碼不一致").waitFor();
  assert(await next.isDisabled());
  await old.fill("1234");
  await section.getByRole("button", { name: "驗證原密碼" }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector(
        '.passwordChange input[autocomplete="new-password"]',
      ).disabled,
  );
  await next.fill("5678");
  await again.fill("5678");
  await section.getByRole("button", { name: "儲存新密碼" }).click();
  await section.getByText("主密碼已更新，下次請使用新密碼解鎖。").waitFor();
  assert(await next.isDisabled());
  assert.equal(await next.inputValue(), "");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "關閉", exact: true })
    .click();
  await page.getByRole("button", { name: "上鎖", exact: true }).click();
  await page.getByLabel("主密碼", { exact: true }).fill("1234");
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByRole("alert").waitFor();
  await page.evaluate(() =>
    chrome.storage.session.remove(["attempts", "nextAttempt"]),
  );
  await page.getByLabel("主密碼", { exact: true }).fill("5678");
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.locator(".quickLink", { hasText: "preserved" }).waitFor();
  console.log(
    "PASS password change: fields gated by old password verification; wrong password/mismatch rejected; old password invalid; new password and data verified.",
  );
} finally {
  await context.close();
}
