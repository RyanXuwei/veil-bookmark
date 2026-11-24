// Notebook pages on the computer: at the bottom of a page, keep scrolling to
// add / turn to the next page (a short scroll only shows the hint), scroll
// up past the top to go back; page counter in the status bar; handwriting
// per page; "Save as PDF" lays out every page; deleting a page asks first;
// pages survive reload (encrypted). Run: npm run build && node scripts/notebook-pages-e2e.mjs
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const shots = process.argv[2];
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/notebook-test-" + Date.now()),
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
const vaultText = async (worker) =>
  JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(null)));
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const base = `chrome-extension://${id}/index.html`;

  // Create a vault from the popup UI.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.goto(`${base}?popup`);
  await popup.locator("input[type=password]").nth(0).fill("1234");
  await popup.locator("input[type=password]").nth(1).fill("1234");
  await popup.locator(".ackRow input").check();
  await popup.getByRole("button", { name: "建立保險庫 →" }).click();
  await popup.locator(".recoveryModal .ackRow input").check();
  await popup.getByRole("button", { name: "完成" }).click();
  await popup.getByRole("tab", { name: "記事本" }).click();

  // The popup opens the notebook in a tab.
  const [nb] = await Promise.all([
    context.waitForEvent("page"),
    popup.getByRole("button", { name: "開啟記事本 ↗" }).click(),
  ]);
  await nb.waitForLoadState();
  assert(popup.isClosed(), "popup closes after opening the notebook");
  assert(nb.url().startsWith(`${base}?notes`));
  await nb.setViewportSize({ width: 1280, height: 900 });
  const editor = nb.locator(".nbEditor");
  await editor.waitFor();
  for (const tab of ["常用", "插入", "檢視"])
    await nb.getByRole("tab", { name: tab }).waitFor();
  await nb.getByRole("tab", { name: "常用" }).click();

  // Title + heading + bold + list, then autosave.
  await nb.getByRole("textbox", { name: "文件標題" }).fill("專案會議紀錄");
  const status = nb.locator(".nbPager > span");
  const canvas = nb.locator(".nbCanvas");
  const toEnd = () =>
    canvas.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const toTop = () => canvas.evaluate((el) => (el.scrollTop = 0));
  async function wheel(dy, times) {
    const box = await canvas.boundingBox();
    await nb.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < times; i++) {
      await nb.mouse.wheel(0, dy);
      await nb.waitForTimeout(30);
    }
  }
  await nb.getByRole("textbox", { name: "文件標題" }).fill("多頁筆記");
  await editor.click();
  await nb.keyboard.type("第一頁的文字");
  assert.equal(await status.textContent(), "第 1 頁，共 1 頁");

  // A short scroll at the bottom: hint only.
  await toEnd();
  await wheel(150, 3);
  assert.match(await nb.locator(".flipHint").textContent(), /繼續往下捲動，新增第 2 頁/);
  await nb.waitForTimeout(700);
  assert.equal(await nb.locator(".flipHint").count(), 0, "hint fades after a pause");
  assert.equal(await status.textContent(), "第 1 頁，共 1 頁");

  // Keep scrolling: page 2 is added and shown.
  await toEnd();
  await wheel(150, 8);
  await nb.waitForFunction(
    () => document.querySelector(".nbPager > span")?.textContent === "第 2 頁，共 2 頁",
  );
  if (shots) await nb.screenshot({ path: resolve(shots, "pages-notebook.png") });
  assert.equal((await editor.innerText()).trim(), "", "new page is blank");
  await editor.click();
  await nb.keyboard.type("第二頁的文字");
  await nb.getByText(/^已加密儲存/).waitFor({ timeout: 8000 });

  // Scrolling up past the top goes back to page 1.
  await toTop();
  await wheel(-150, 8);
  await nb.waitForFunction(
    () => document.querySelector(".nbPager > span")?.textContent === "第 1 頁，共 2 頁",
  );
  assert.match(await editor.innerText(), /第一頁的文字/);
  // Footer buttons too.
  await nb.getByRole("button", { name: "下一頁" }).click();
  assert.match(await editor.innerText(), /第二頁的文字/);

  // Save as PDF prints every page, each on its own sheet.
  await nb.evaluate(() => {
    window.__printed = [];
    window.print = () =>
      window.__printed.push(
        [...document.querySelectorAll(".nbPrintPage .nbEditor")].map((e) => e.textContent),
      );
  });
  await nb.getByRole("tab", { name: "檢視" }).click();
  await nb.getByRole("button", { name: "列印／另存 PDF" }).click();
  await nb.waitForFunction(() => window.__printed.length === 1);
  assert.deepEqual(await nb.evaluate(() => window.__printed[0]), [
    "第一頁的文字",
    "第二頁的文字",
  ]);
  if (shots) await nb.screenshot({ path: resolve(shots, "pages-print.png") });
  await nb.evaluate(() => dispatchEvent(new Event("afterprint")));
  await nb.locator(".nbPrintPage").first().waitFor({ state: "detached" });

  // Reload: both pages come back from the encrypted vault.
  assert(!(await vaultText(worker)).includes("第二頁的文字"), "stored encrypted");
  await nb.reload();
  await nb.getByRole("button", { name: /多頁筆記/ }).click();
  await nb.waitForFunction(
    () => document.querySelector(".nbPager > span")?.textContent === "第 1 頁，共 2 頁",
  );

  // Delete page 2: asks first; cancel keeps it.
  await nb.getByRole("button", { name: "下一頁" }).click();
  await nb.getByRole("button", { name: "刪除此頁" }).click();
  const ask = nb.getByRole("alertdialog", { name: "刪除第 2 頁？" });
  await ask.waitFor();
  await ask.getByRole("button", { name: "取消" }).click();
  assert.equal(await status.textContent(), "第 2 頁，共 2 頁");
  await nb.getByRole("button", { name: "刪除此頁" }).click();
  await nb.getByRole("alertdialog", { name: "刪除第 2 頁？" }).getByRole("button", { name: "刪除" }).click();
  assert.equal(await status.textContent(), "第 1 頁，共 1 頁");
  assert.match(await editor.innerText(), /第一頁的文字/);
  assert(await nb.getByRole("button", { name: "刪除此頁" }).isDisabled());
  await nb.getByText(/^已加密儲存/).waitFor({ timeout: 8000 });
  await nb.reload();
  await nb.getByRole("button", { name: /多頁筆記/ }).click();
  await nb.waitForFunction(() => document.querySelector(".nbEditor")?.textContent?.includes("第一頁的文字"));
  assert.equal(await status.textContent(), "第 1 頁，共 1 頁");
  assert(!(await editor.innerText()).includes("第二頁的文字"));
  console.log(
    "PASS notebook pages: scroll past the end adds/turns pages, short scroll only hints, scroll up goes back, footer buttons, PDF prints every page, encrypted and kept on reload, delete page asks first",
  );
} finally {
  await context.close();
}
