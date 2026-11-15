import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const shots = resolve(root, "../previews");
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/about-test-" + Date.now()),
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
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 600 });
  await page.goto(`chrome-extension://${id}/index.html?popup`);
  await page.getByRole("heading", { name: "建立你的私密空間" }).waitFor();
  const footer = page.locator("footer");
  assert.equal(
    await footer.locator("a").getAttribute("href"),
    "https://github.com/RyanXuwei",
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    380,
  );
  await footer.screenshot({ path: resolve(shots, "21-footer-credit.png") });
  await page.getByRole("button", { name: "關於" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const text = await dialog.innerText();
  for (const s of ["Ryan Hsu", "BitingBox Studio", "2026-11-15", "程式製作年份", "0.1.6"])
    assert(text.includes(s), s);
  assert(text.includes("© 2026 Ryan Hsu. All rights reserved."), "copyright line");
  assert(!/\{|null/.test(text), "no placeholders");
  assert.equal(
    await dialog.getByRole("link").getAttribute("href"),
    "https://github.com/RyanXuwei",
  );
  await page.screenshot({ path: resolve(shots, "22-about-zh-TW.png") });
  await page.getByRole("button", { name: "關閉" }).click();
  await page.selectOption("select.langSelect", "en");
  await page.getByRole("button", { name: "About" }).click();
  await page.getByText("Production date").waitFor();
  await page.screenshot({ path: resolve(shots, "23-about-en.png") });
  console.log("PASS about/footer credits");
} finally {
  await context.close();
}
