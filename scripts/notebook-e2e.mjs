// Encrypted notebook page (index.html?notes): ribbon formatting, autosave,
// reload, multiple notes, sanitising, lock/unlock, delete, layout.
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const shots = resolve(root, "../previews");
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
  await editor.click();
  await nb.keyboard.type("會議重點");
  await nb.getByRole("button", { name: "標題 1" }).click();
  await nb.keyboard.press("End");
  await nb.keyboard.press("Enter");
  await nb.getByRole("button", { name: "內文" }).click();
  await nb.keyboard.type("這段文字很重要 secret-body-text");
  await nb.keyboard.down("Shift");
  for (let i = 0; i < 16; i++) await nb.keyboard.press("ArrowLeft");
  await nb.keyboard.up("Shift");
  await nb.getByRole("button", { name: "粗體" }).click();
  assert.equal(
    await nb.getByRole("button", { name: "粗體" }).getAttribute("aria-pressed"),
    "true",
  );
  await nb.keyboard.press("End");
  await nb.keyboard.press("Enter");
  await nb.getByRole("button", { name: "項目符號" }).click();
  await nb.keyboard.type("第一項");
  await nb.keyboard.press("Enter");
  await nb.keyboard.type("第二項");
  await nb.getByText(/^已加密儲存/).waitFor({ timeout: 8000 });
  assert(!(await vaultText(worker)).includes("secret-body-text"));
  assert(!(await vaultText(worker)).includes("專案會議紀錄"));
  await nb.locator(".nbCanvas").evaluate((e) => (e.scrollTop = 0));
  await nb.screenshot({ path: resolve(shots, "34-notebook.png") });

  const stored = await nb.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "LIST" });
    return r.data.memos.filter((m) => !m.deleted);
  });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].format, "html");
  assert.equal(stored[0].title, "專案會議紀錄");
  assert.match(stored[0].body, /<h1[^>]*>會議重點<\/h1>/);
  assert.match(stored[0].body, /font-weight: ?bold|<b>|<strong>/);
  assert.match(
    stored[0].body,
    /<ul>.*<li>(<[^>]+>)?第一項.*<li>(<[^>]+>)?第二項.*<\/ul>/s,
  );

  // Hostile markup is stripped before it is stored.
  await editor.evaluate((el) => {
    el.insertAdjacentHTML(
      "beforeend",
      '<p>safe-tail</p><img src=x onerror="window.pwned=1"><script>window.pwned=2</script><a href="javascript:alert(1)">bad</a><iframe src="https://example.com"></iframe>',
    );
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await nb.waitForTimeout(1600);
  await nb.getByText(/^已加密儲存/).waitFor();
  const body = await nb.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "LIST" });
    return r.data.memos.find((m) => !m.deleted).body;
  });
  assert(body.includes("safe-tail"));
  assert(!/<img|<script|onerror|javascript:|<iframe/i.test(body), body);
  assert.equal(await nb.evaluate(() => window.pwned), undefined);

  // Reload restores the document from the encrypted vault.
  await nb.reload();
  await editor.waitFor();
  await nb.locator(".nbEditor h1").getByText("會議重點").waitFor();
  assert.equal(
    await nb.getByRole("textbox", { name: "文件標題" }).inputValue(),
    "專案會議紀錄",
  );

  // Second note and switching via the navigation pane.
  await nb.getByRole("button", { name: "＋ 新增" }).click();
  await editor.click();
  await nb.keyboard.type("第二份筆記內容");
  await nb.getByText(/^已加密儲存/).waitFor({ timeout: 8000 });
  await nb.locator(".nbNav li").nth(1).waitFor();
  assert.equal(await nb.locator(".nbNav li").count(), 2);
  await nb.locator(".nbNav li button", { hasText: "專案會議紀錄" }).click();
  await nb.locator(".nbEditor h1").getByText("會議重點").waitFor();

  // Status bar: counts and zoom.
  assert.match(await nb.locator(".nbStatus").innerText(), /第 1 頁，共 1 頁/);
  assert.match(await nb.locator(".nbStatus").innerText(), /\d+ 個字/);
  await nb.getByRole("button", { name: "放大" }).click();
  await nb.locator(".nbZoom", { hasText: "110%" }).waitFor();

  // Popup list shows plain-text previews, not markup.
  // (The popup closed itself after opening the notebook, like the real one.)
  const popup2 = await context.newPage();
  await popup2.setViewportSize({ width: 380, height: 640 });
  await popup2.goto(base + "?popup");
  await popup2.getByRole("tab", { name: "記事本" }).click();
  await popup2.locator(".memoLink").nth(1).waitFor();
  const popupText = await popup2.locator(".quickList").innerText();
  await popup2.close();
  assert(popupText.includes("專案會議紀錄") && !popupText.includes("<"));

  // English ribbon.
  await nb.selectOption("select.nbLang", "en");
  await nb.getByRole("tab", { name: "Home" }).waitFor();
  await nb.getByRole("button", { name: "Bold" }).waitFor();
  await nb.locator(".nbCanvas").evaluate((e) => (e.scrollTop = 0));
  await nb.screenshot({ path: resolve(shots, "35-notebook-en.png") });
  await nb.selectOption("select.nbLang", "zh-TW");
  await nb.getByRole("tab", { name: "常用" }).waitFor();

  // Narrow window: no horizontal page overflow.
  await nb.setViewportSize({ width: 600, height: 800 });
  assert(
    (await nb.evaluate(() => document.documentElement.scrollWidth)) <= 600,
  );
  await nb.screenshot({ path: resolve(shots, "36-notebook-narrow.png") });
  await nb.setViewportSize({ width: 1280, height: 900 });

  // Locking wipes the decrypted document from the page.
  await nb.getByRole("button", { name: /上鎖/ }).click();
  await nb.getByText("保險庫已上鎖。輸入主密碼以開啟你的記事。").waitFor();
  assert(!(await nb.content()).includes("會議重點"));
  await nb.getByRole("textbox", { name: "主密碼" }).fill("1234");
  await nb.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await nb.locator(".nbEditor h1").getByText("會議重點").waitFor();

  // Import a Markdown file: it becomes a new note and opens.
  await nb.locator('input[type=file][accept*=".docx"]').setInputFiles({
    name: "匯入測試.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 匯入標題\n\n- **粗體** 項目\n"),
  });
  await nb.locator(".nbEditor h1").getByText("匯入標題").waitFor();
  await nb.locator(".nbEditor li b").getByText("粗體").waitFor();
  assert.equal(await nb.locator(".nbTitle").inputValue(), "匯入測試");
  await nb.getByRole("tab", { name: "檢視" }).click();
  await nb.getByRole("button", { name: "刪除記事" }).click();
  await nb.getByRole("alertdialog").getByRole("button", { name: "刪除", exact: true }).click();
  await nb.waitForFunction(() => ![...document.querySelectorAll(".nbNav li")].some((x) => x.textContent.includes("匯入測試")));
  await nb.locator(".nbEditor h1").getByText("會議重點").waitFor();

  // Delete the open note (the same confirmation dialog as the popup).
  await nb.getByRole("tab", { name: "檢視" }).click();
  await nb.getByRole("button", { name: "刪除記事" }).click();
  await nb.getByRole("alertdialog").getByText("刪除後會同步到所有裝置").waitFor();
  await nb.getByRole("alertdialog").getByRole("button", { name: "刪除", exact: true }).click();
  await nb.waitForFunction(
    () => document.querySelectorAll(".nbNav li").length === 1,
  );
  console.log(
    "PASS notebook: ribbon formatting, autosave encrypted, sanitising, reload, multi-note, status bar, zoom, popup preview, i18n, narrow layout, lock wipe, unlock, delete",
  );
} finally {
  await context.close();
}
