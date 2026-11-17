// Popup: drag-and-drop ordering of bookmarks, notes and folders; note folders;
// "…" quick menus for notes and folders.
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const shots = resolve(root, "../previews");
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/organize-test-" + Date.now()),
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
const titles = (sel) =>
  page.$$eval(sel, (els) => els.map((e) => e.querySelector(".quickText strong").textContent));
try {
  const worker =
    context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const base = `chrome-extension://${new URL(worker.url()).host}/index.html`;
  page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 640 });
  await page.goto(`${base}?popup`);
  await rpc("CREATE", { password: "1234" });
  for (const [title, folder] of [["Alpha", "Work"], ["Bravo", "Work"], ["Charlie", "Work"], ["Delta", ""]])
    await rpc("UPSERT", { entry: { title, url: `https://${title.toLowerCase()}.example`, folder } });
  await page.reload();
  const work = page.locator(".quickFolder", { hasText: "Work" });
  await work.locator("summary").click();
  const workItems = ".quickFolder:has(summary strong:text-is('Work')) .quickItem";
  assert.deepEqual(await titles(workItems), ["Alpha", "Bravo", "Charlie"]);

  // Drag Charlie above Alpha.
  const item = (t) => page.locator(".quickItem", { has: page.locator(`.quickText strong:text-is("${t}")`) });
  await item("Charlie").dragTo(item("Alpha"), { targetPosition: { x: 60, y: 4 } });
  await page.waitForFunction(() => !document.querySelector(".quickItem.dragging"));
  await page.waitForTimeout(300);
  assert.deepEqual(await titles(workItems), ["Charlie", "Alpha", "Bravo"]);
  // Drag Bravo below Charlie (bottom half of the target).
  await item("Bravo").dragTo(item("Charlie"), { targetPosition: { x: 60, y: 30 } });
  await page.waitForTimeout(300);
  assert.deepEqual(await titles(workItems), ["Charlie", "Bravo", "Alpha"]);
  // Drag Delta (unfiled) onto the Work folder: moves to the end of Work.
  await item("Delta").dragTo(work.locator("summary"));
  await page.waitForTimeout(300);
  assert.deepEqual(await titles(workItems), ["Charlie", "Bravo", "Alpha", "Delta"]);
  // Order survives a reload (stored encrypted).
  await page.reload();
  await page.locator(".quickFolder summary", { hasText: "Work" }).click();
  assert.deepEqual(await titles(workItems), ["Charlie", "Bravo", "Alpha", "Delta"]);
  // Drag back out of the folder to Unfiled.
  // The Unfiled drop zone appears once dragging starts.
  {
    const b = await item("Alpha").boundingBox();
    await page.mouse.move(b.x + 60, b.y + 10);
    await page.mouse.down();
    await page.mouse.move(b.x + 60, b.y + 30, { steps: 4 });
    const zone = page.locator(".quickRoot.dropZone");
    await zone.waitFor();
    const z = await zone.boundingBox();
    await page.mouse.move(z.x + 60, z.y + z.height / 2, { steps: 6 });
    await page.mouse.up();
  }
  await page.waitForTimeout(300);
  assert.deepEqual(await titles(".quickRoot > .quickItem"), ["Alpha"]);
  // Keyboard: Alt+ArrowUp moves Delta above Bravo.
  await item("Delta").locator(".quickLink").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await page.waitForTimeout(300);
  assert.deepEqual(await titles(workItems), ["Charlie", "Delta", "Bravo"]);

  // New empty folder, then drag it above Work.
  await page.getByRole("button", { name: "新增資料夾" }).click();
  await page.getByRole("textbox", { name: "資料夾名稱" }).fill("Home");
  await page.getByRole("button", { name: "建立", exact: true }).click();
  await page.locator(".quickFolder summary", { hasText: "Home" }).waitFor();
  const order = () => page.$$eval(".quickFolder > summary strong", (e) => e.map((x) => x.textContent));
  assert.deepEqual(await order(), ["Work", "Home"]);
  await page.locator(".quickFolder summary", { hasText: "Home" }).dragTo(
    page.locator(".quickFolder summary", { hasText: "Work" }),
    { targetPosition: { x: 60, y: 3 } },
  );
  await page.waitForTimeout(300);
  assert.deepEqual(await order(), ["Home", "Work"]);
  await page.screenshot({ path: resolve(shots, "60-bookmark-folders-dnd.png") });

  // Folder "…": rename, then delete (bookmarks move to Unfiled).
  await page.getByRole("button", { name: "資料夾操作：Work" }).click();
  await page.getByRole("button", { name: "重新命名" }).click();
  await page.getByRole("textbox", { name: "資料夾名稱" }).fill("Job");
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await page.locator(".quickFolder summary", { hasText: "Job" }).waitFor();
  await page.getByRole("button", { name: "資料夾操作：Job" }).click();
  await page.getByRole("button", { name: "刪除資料夾" }).click();
  await page.getByRole("alertdialog").getByText("會移到上一層").waitFor();
  await page.getByRole("alertdialog").getByRole("button", { name: "刪除", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".quickRoot > .quickItem").length === 4);
  assert.deepEqual(await order(), ["Home"]);

  // Nested folders: a subfolder from the menu, dragging a folder into
  // another, and moving one back to the top level.
  await page.getByRole("button", { name: "資料夾操作：Home" }).click();
  await page.getByRole("button", { name: "新增子資料夾" }).click();
  await page.getByRole("textbox", { name: "子資料夾名稱" }).fill("Trips");
  await page.getByRole("button", { name: "建立", exact: true }).click();
  await page.locator(".quickSub .quickFolder summary", { hasText: "Trips" }).waitFor();
  let nested = await rpc("LIST");
  assert(nested.folders.some((f) => f.name === "Home/Trips" && !f.deleted));
  await rpc("FOLDER_CREATE", { kind: "entry", name: "Later" });
  await page.reload();
  await page.locator(".quickFolder summary", { hasText: "Later" }).waitFor();
  // Drag "Later" onto the middle of "Home": it goes inside.
  await page.locator(".quickFolder summary", { hasText: "Later" }).dragTo(
    page.locator(".quickFolder summary", { hasText: "Home" }).first(),
    { targetPosition: { x: 60, y: 19 } },
  );
  for (let i = 0; i < 40; i++) {
    nested = await rpc("LIST");
    if (nested.folders.some((f) => f.name === "Home/Later" && !f.deleted)) break;
    await page.waitForTimeout(100);
  }
  assert(nested.folders.some((f) => f.name === "Home/Later" && !f.deleted), "dragged into Home");
  await page.screenshot({ path: resolve(shots, "57-nested-folders.png") });
  // "Move to folder" → top level.
  await page.locator(".quickFolder summary", { hasText: "Home" }).first().click();
  await page.getByRole("button", { name: "資料夾操作：Later" }).click();
  await page.getByRole("button", { name: "移到資料夾" }).click();
  await page.getByRole("combobox", { name: "移到資料夾" }).selectOption("");
  for (let i = 0; i < 40; i++) {
    nested = await rpc("LIST");
    if (nested.folders.some((f) => f.name === "Later" && !f.deleted)) break;
    await page.waitForTimeout(100);
  }
  assert(nested.folders.some((f) => f.name === "Later" && !f.deleted), "moved to the top level");
  await rpc("FOLDER_DELETE", { kind: "entry", name: "Later" });
  await rpc("FOLDER_DELETE", { kind: "entry", name: "Home/Trips" });
  await page.reload();

  // Notes tab: folders, "…" quick menu, drag ordering.
  for (const title of ["第一篇", "第二篇", "第三篇"])
    await rpc("MEMO_UPSERT", { memo: { title, body: `<p>${title}內容</p>`, format: "html" } });
  await page.getByRole("tab", { name: "記事本" }).click();
  await page.getByRole("button", { name: "新增資料夾" }).click();
  await page.getByRole("textbox", { name: "資料夾名稱" }).fill("日記");
  await page.getByRole("button", { name: "建立", exact: true }).click();
  await page.locator(".quickFolder summary", { hasText: "日記" }).waitFor();
  // Quick menu: rename and move.
  await page.getByRole("button", { name: "更多操作：第一篇" }).click();
  await page.getByRole("button", { name: "重新命名" }).click();
  await page.getByRole("textbox", { name: "記事標題" }).fill("第一篇（改）");
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await page.getByRole("button", { name: "更多操作：第一篇（改）" }).click();
  await page.getByRole("button", { name: "移到資料夾" }).click();
  await page.getByRole("combobox", { name: "移到資料夾" }).selectOption("日記");
  await page.locator(".quickFolder summary", { hasText: "日記" }).locator("small", { hasText: "1" }).waitFor();
  // Drag another note into the folder, above the first.
  await page.locator(".quickFolder summary", { hasText: "日記" }).click();
  await item("第三篇").dragTo(item("第一篇（改）"), { targetPosition: { x: 60, y: 4 } });
  await page.waitForTimeout(300);
  const diary = ".quickFolder:has(summary strong:text-is('日記')) .quickItem";
  assert.deepEqual(await titles(diary), ["第三篇", "第一篇（改）"]);
  const v = await rpc("LIST");
  const first = v.memos.find((m) => m.title === "第一篇（改）");
  assert.equal(first.body, "<p>第一篇內容</p>", "quick edit keeps the note body");
  assert.equal(first.folder, "日記");
  // Delete from the quick menu (two-step confirmation).
  await page.getByRole("button", { name: "更多操作：第二篇" }).click();
  await page.getByRole("button", { name: "刪除", exact: true }).click();
  await page.getByRole("alertdialog", { name: "刪除「第二篇」？" }).waitFor();
  await page.getByRole("alertdialog").getByRole("button", { name: "刪除", exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll(".quickText strong")].some((e) => e.textContent === "第二篇"));
  await page.getByRole("button", { name: "更多操作：第三篇" }).click();
  await page.screenshot({ path: resolve(shots, "61-note-folders-menu.png") });
  // Notebook page navigation groups notes by the same folders and order.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base}?notes`);
  await page.locator(".nbNav .nbNavFolder").first().waitFor();
  const nav = await page.$$eval(".nbNav li", (li) =>
    li.map((x) => (x.classList.contains("nbNavFolder") ? "#" : "") + (x.querySelector("strong")?.textContent || x.textContent)),
  );
  assert.deepEqual(nav, ["#日記", "第三篇", "第一篇（改）"]);
  console.log("PASS organize: drag-and-drop bookmarks/notes/folders, keyboard reorder, folder create/rename/delete, note folders and quick menu, notebook navigation grouped by folder");
} finally {
  await context.close();
}
