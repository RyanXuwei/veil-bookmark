// Bookmark tags as chips with a quick-pick list of tags already in use, and
// the popup hover text showing tags and the private memo.
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const shot = process.argv[2];
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/tags-test-" + Date.now()),
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
  await page.setViewportSize({ width: 380, height: 640 });
  await page.goto(base);
  await page.evaluate(async () => {
    const rpc = (type, data = {}) =>
      chrome.runtime.sendMessage({ type, ...data });
    await rpc("CREATE", { password: "1234" });
    const add = (title, tags, notes = "") =>
      rpc("UPSERT", {
        entry: { title, url: `https://${title}.example`, tags, notes },
      });
    await add("kyoto", "旅行, 日本", "清水寺早上 7 點前人少");
    await add("osaka", "旅行, 日本, 美食");
    await add("ramen", "美食");
    await add("nara", "旅行");
    await add("plain", "");
  });
  await page.reload();
  const row = (name) => page.locator(".quickLink", { hasText: name });
  await row("kyoto").waitFor();

  // Hover text: tags and memo; the URL only when there are neither.
  assert.equal(
    await row("kyoto").getAttribute("title"),
    "#旅行  #日本\n清水寺早上 7 點前人少",
  );
  assert.equal(await row("ramen").getAttribute("title"), "#美食");
  assert.equal(
    await row("plain").getAttribute("title"),
    "https://plain.example/",
  );

  // Manual add: chips and quick-pick.
  await page.getByRole("button", { name: "手動新增書籤" }).click();
  const tags = page.getByRole("combobox", { name: "標籤" });
  await page.getByText("私密備註").waitFor();
  assert.equal(await page.getByText("私人筆記").count(), 0);
  await tags.focus();
  const options = page.locator(".tagOptions li");
  // Focus shows the most used tags first.
  const optionText = async () =>
    (await options.allInnerTexts()).map((x) => x.replace(/\s/g, ""));
  assert.deepEqual(await optionText(), ["#旅行", "#日本", "#美食"]);
  await tags.pressSequentially("日");
  assert.deepEqual(await optionText(), ["#日本"]);
  if (shot) await page.screenshot({ path: resolve(shot, "tags-1.png") });
  await tags.press("Enter");
  // A comma completes a new tag; duplicates are ignored.
  await tags.pressSequentially("賞楓,日本,");
  const chips = page.locator(".tagChip");
  const chipText = async () =>
    (await chips.allInnerTexts()).map((x) => x.replace(/[#×\s]/g, ""));
  assert.deepEqual(await chipText(), ["日本", "賞楓"]);
  // Backspace on an empty field removes the last chip; × removes one.
  await tags.press("Backspace");
  assert.deepEqual(await chipText(), ["日本"]);
  await tags.pressSequentially("紅葉");
  // Clicking a suggestion picks it.
  await tags.fill("");
  await tags.pressSequentially("美");
  await options.first().click();
  assert.deepEqual(await chipText(), ["日本", "美食"]);
  await tags.pressSequentially("待確認");
  await page.getByLabel("名稱").fill("arashiyama");
  await page.getByLabel("網址").fill("https://arashiyama.example");
  await page.getByLabel("私密備註").fill("小火車要預約");
  if (shot) await page.screenshot({ path: resolve(shot, "tags-2.png") });
  // Typed text not yet turned into a chip is kept on save.
  await page.getByRole("button", { name: "加密儲存 →" }).click();
  await row("arashiyama").waitFor();
  const saved = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "LIST" });
    return r.data.entries.find((x) => x.title === "arashiyama");
  });
  assert.deepEqual(saved.tags, ["日本", "美食", "待確認"]);
  assert.equal(saved.notes, "小火車要預約");
  // Editing shows the saved tags as chips.
  await page
    .locator(".quickItem", { hasText: "arashiyama" })
    .locator(".quickMore")
    .click();
  await page.getByRole("button", { name: "編輯" }).click();
  assert.deepEqual(await chipText(), ["日本", "美食", "待確認"]);
  await page
    .locator(".tagChip", { hasText: "美食" })
    .getByRole("button")
    .click();
  assert.deepEqual(await chipText(), ["日本", "待確認"]);
  console.log(
    "PASS tags: chips, quick-pick by use, comma/Enter/Backspace/×, pending text kept; hover shows tags and memo",
  );
} finally {
  await context.close();
}
