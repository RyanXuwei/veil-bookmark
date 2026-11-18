// Notebook "View › Markdown preview": the note typed as Markdown is shown
// formatted (headings, lists, tasks, table, code, links) and ```mermaid
// blocks are drawn as diagrams; a broken diagram shows an error, not a crash;
// toggling back returns to the editable note unchanged. No CSP errors.
// Run: npm run build && node scripts/markdown-e2e.mjs [shots]
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const shots = process.argv[2];
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/markdown-test-" + Date.now()),
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
  await popup.goto(`${base}?popup`);
  await popup.locator("input[type=password]").nth(0).fill("1234");
  await popup.locator("input[type=password]").nth(1).fill("1234");
  await popup.locator(".ackRow input").check();
  await popup.getByRole("button", { name: "建立保險庫 →" }).click();
  await popup.locator(".recoveryModal .ackRow input").check();
  await popup.getByRole("button", { name: "完成" }).click();
  await popup.getByRole("tab", { name: "記事本" }).waitFor();

  const nb = await context.newPage();
  const problems = [];
  nb.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused/.test(m.text())) problems.push(m.text());
  });
  nb.on("pageerror", (e) => problems.push(String(e)));
  await nb.setViewportSize({ width: 1280, height: 900 });
  await nb.goto(`${base}?notes`);
  const editor = nb.locator(".nbEditor").last();
  await editor.waitFor();
  await editor.click();
  const md = [
    "# 專案計畫",
    "",
    "這是 **重點** 與 `code`，參考 [官網](https://example.com/doc)。",
    "",
    "- 第一項",
    "- [x] 已完成",
    "- [ ] 待辦",
    "",
    "| 項目 | 金額 |",
    "|---|---:|",
    "| 設計 | 100 |",
    "",
    "```mermaid",
    "graph TD",
    "  A[開始] --> B{檢查}",
    "  B -->|是| C[完成]",
    "```",
    "",
    "```mermaid",
    "this is not a diagram",
    "```",
    "",
    "<script>alert(1)</script>",
  ];
  for (const [i, line] of md.entries()) {
    if (line) await nb.keyboard.insertText(line);
    if (i < md.length - 1) await nb.keyboard.press("Enter");
  }
  await nb.getByRole("tab", { name: "檢視" }).click();
  await nb.getByRole("button", { name: "Markdown 預覽" }).click();
  const pv = nb.locator(".mdPreview");
  await pv.locator("h1", { hasText: "專案計畫" }).waitFor();
  assert.equal(await pv.locator("b", { hasText: "重點" }).count(), 1);
  assert.equal(await pv.locator("code", { hasText: "code" }).count(), 1);
  assert.equal(await pv.locator('a[href="https://example.com/doc"]').count(), 1);
  assert.equal(await pv.locator("li").count(), 3);
  assert.equal(await pv.locator("li.task input[checked]").count(), 1);
  assert.equal(await pv.locator("table td", { hasText: "100" }).getAttribute("style"), "text-align:right");
  await pv.locator(".mdMermaid.drawn svg").first().waitFor({ timeout: 20000 });
  assert((await pv.locator(".mdMermaid.drawn svg").first().textContent()).includes("檢查"));
  await pv.locator(".mdMermaid.failed .mdError").waitFor();
  assert.equal(await pv.locator("script").count(), 0, "HTML in the note is shown as text");
  assert((await pv.textContent()).includes("<script>alert(1)</script>"));
  assert(await nb.locator(".nbEditor:not(.mdPreview)").isHidden());
  if (shots) await nb.screenshot({ path: resolve(shots, "markdown-preview.png") });

  // Back to editing: the note is unchanged and editable.
  await nb.getByRole("button", { name: "Markdown 預覽" }).click();
  await pv.waitFor({ state: "detached" });
  assert((await editor.textContent()).includes("```mermaid"));
  assert.equal(await editor.getAttribute("contenteditable"), "true");
  assert.deepEqual(problems, [], "no CSP or page errors");
  console.log(
    "PASS markdown preview: headings, bold, code, link, lists, tasks, table alignment, Mermaid diagram drawn, broken diagram shows an error, HTML stays text, back to editing unchanged, no CSP errors",
  );
} finally {
  await context.close();
}
