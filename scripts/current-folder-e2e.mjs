// Popup "current folder": the last folder opened is where 收藏目前網頁, 手動新增,
// 新增資料夾 and 新增記事 put new things; at the top level they go to the top
// level as before. Kept while the browser runs, cleared when locked.
// Run: npm run build && node scripts/current-folder-e2e.mjs
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/current-folder-test-" + Date.now()),
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
let page;
const rpc = (type, data = {}) =>
  page.evaluate(
    async ([type, data]) => {
      const r = await chrome.runtime.sendMessage({ type, ...data });
      if (!r.ok) throw Error(r.error);
      return r.data;
    },
    [type, data],
  );
try {
  const worker =
    context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const base = `chrome-extension://${new URL(worker.url()).host}/index.html`;
  page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 640 });
  await page.goto(`${base}?popup`);
  await rpc("CREATE", { password: "1234" });
  await rpc("UPSERT", { entry: { title: "A", url: "https://a.example", folder: "Work" } });
  await rpc("UPSERT", { entry: { title: "B", url: "https://b.example", folder: "Work/Sub" } });
  await rpc("UPSERT", { entry: { title: "C", url: "https://c.example" } });
  await page.reload();
  let bar = page.locator(".currentFolder");
  const summary = (name) =>
    page.locator(`.quickFolder > summary:has(strong:text-is("${name}"))`);
  const folderField = page.getByLabel("資料夾", { exact: true });
  async function manualFolder() {
    await page.getByRole("button", { name: "手動新增書籤" }).click();
    const v = await folderField.inputValue();
    await page.getByRole("button", { name: "關閉" }).click();
    return v;
  }

  // Top level: as before.
  assert.equal(await bar.count(), 0);
  assert.equal(await manualFolder(), "");

  // Into Work, then Work/Sub.
  await summary("Work").click();
  await bar.getByText("目前資料夾：Work").waitFor();
  assert.equal(await manualFolder(), "Work");
  await summary("Sub").click();
  await bar.getByText("目前資料夾：Work › Sub").waitFor();
  assert.ok(await page.locator(".quickFolder.current > summary strong:text-is('Sub')").count());
  assert.equal(await manualFolder(), "Work/Sub");

  // A bookmark saved from the editor lands in Work/Sub.
  await page.getByRole("button", { name: "手動新增書籤" }).click();
  await page.getByLabel("網址").fill("https://new.example/");
  await page.getByLabel("名稱").fill("New");
  await page.getByRole("button", { name: "加密儲存 →" }).click();
  await page.locator(".overlay").waitFor({ state: "detached" });
  let v = await rpc("LIST");
  assert.equal(v.entries.find((x) => x.title === "New").folder, "Work/Sub");

  // 新增資料夾 creates a subfolder of the current folder.
  await page.getByRole("button", { name: "新增資料夾" }).click();
  await page.getByPlaceholder("子資料夾名稱").fill("Deep");
  await page.getByRole("button", { name: "建立" }).click();
  await summary("Deep").waitFor();
  v = await rpc("LIST");
  assert.ok(v.folders.some((f) => f.kind === "entry" && f.name === "Work/Sub/Deep" && !f.deleted));
  // The current folder stays where it was.
  assert.equal(await manualFolder(), "Work/Sub");

  // The next popup opens in the same folder.
  await page.reload();
  await bar.getByText("目前資料夾：Work › Sub").waitFor();
  assert.equal(await manualFolder(), "Work/Sub");

  // Renaming a folder above keeps the current folder with it.
  await page.locator(".quickFolder > summary:has(strong:text-is('Work')) .folderMore").click();
  await page.getByRole("button", { name: "重新命名" }).click();
  await page.locator(".nameForm.inline input").fill("Job");
  await page.locator(".nameForm.inline").getByRole("button", { name: "儲存" }).click();
  await bar.getByText("目前資料夾：Job › Sub").waitFor();
  await page.waitForTimeout(300);
  assert.equal(await manualFolder(), "Job/Sub");

  // Closing a folder goes up one level; 回最上層 goes to the top.
  await summary("Sub").click();
  await bar.getByText("目前資料夾：Job").waitFor();
  assert.equal(await manualFolder(), "Job");
  await bar.getByRole("button", { name: "回最上層" }).click();
  assert.equal(await bar.count(), 0);
  assert.equal(await manualFolder(), "");
  await page.getByRole("button", { name: "新增資料夾" }).click();
  await page.getByPlaceholder("資料夾名稱").fill("Top");
  await page.getByRole("button", { name: "建立" }).click();
  await summary("Top").waitFor();
  v = await rpc("LIST");
  assert.ok(v.folders.some((f) => f.kind === "entry" && f.name === "Top" && !f.deleted));

  // Locking forgets the current folder.
  await summary("Job").click();
  await bar.getByText("目前資料夾：Job").waitFor();
  await rpc("LOCK");
  const kept = await page.evaluate(() => chrome.storage.session.get("currentFolder"));
  assert.equal(kept.currentFolder, undefined);
  await page.reload();
  await page.locator("input[type=password]").fill("1234");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "手動新增書籤" }).waitFor();
  assert.equal(await bar.count(), 0);
  assert.equal(await manualFolder(), "");

  // Notes: 新增記事 inside a note folder opens the notebook with that folder,
  // and the new note is saved there.
  await rpc("MEMO_UPSERT", { memo: { title: "Old", body: "x", folder: "Diary" } });
  await page.reload();
  await page.getByRole("tab", { name: "記事本" }).click();
  await summary("Diary").click();
  await bar.getByText("目前資料夾：Diary").waitFor();
  const [nb] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "＋ 新增記事" }).click(),
  ]);
  await nb.waitForLoadState();
  assert.match(nb.url(), /[?&]folder=Diary#new$/);
  const editor = nb.locator(".nbEditor");
  await editor.waitFor();
  await nb.getByRole("textbox", { name: "文件標題" }).fill("Fresh");
  await editor.evaluate((el) => {
    el.innerHTML = "<p>hello</p>";
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await editor.focus();
  await nb.keyboard.press("Control+s");
  // The popup closed itself after opening the notebook.
  page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 640 });
  await page.goto(`${base}?popup`);
  bar = page.locator(".currentFolder");
  await page.waitForFunction(async () => {
    const r = await chrome.runtime.sendMessage({ type: "LIST" });
    return r.data.memos.some((m) => m.title === "Fresh");
  });
  v = await rpc("LIST");
  assert.equal(v.memos.find((m) => m.title === "Fresh").folder, "Diary");
  // The new popup is still in Diary.
  await page.getByRole("tab", { name: "記事本" }).click();
  await bar.getByText("目前資料夾：Diary").waitFor();
  // A note folder button makes a subfolder of the current note folder.
  await page.getByRole("button", { name: "新增資料夾" }).click();
  await page.getByPlaceholder("子資料夾名稱").fill("2026");
  await page.getByRole("button", { name: "建立" }).click();
  await summary("2026").waitFor();
  v = await rpc("LIST");
  assert.ok(v.folders.some((f) => f.kind === "memo" && f.name === "Diary/2026" && !f.deleted));
  // Bookmarks kept their own current folder (top level).
  await page.getByRole("tab", { name: "書籤" }).click();
  assert.equal(await bar.count(), 0);
  console.log("current-folder e2e passed");
} finally {
  await context.close();
}
