// Notebook with Traditional/Simplified Chinese, English, Japanese and Korean
// in one note: saved encrypted and read back unchanged after a reload, and
// the fonts follow the interface language (regional Han forms) with a
// fallback for every script.
// Run: npm run build && node scripts/cjk-e2e.mjs [shots]
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const shots = process.argv[2];
const TEXT = [
  "繁體中文：這是一段測試文字，包含「標點」。",
  "简体中文：这是一段测试文字，包含“标点”。",
  "English: The quick brown fox jumps over the lazy dog.",
  "日本語：これはテストです。カタカナと漢字も使います。",
  "한국어: 이것은 테스트 문장입니다. 한글이 잘 보이나요?",
  "Emoji 🙂 and symbols ①②③ ㈱ ～",
];
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/cjk-test-" + Date.now()),
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
  await nb.setViewportSize({ width: 1280, height: 900 });
  await nb.goto(`${base}?notes`);
  const editor = nb.locator(".nbEditor");
  await editor.waitFor();
  await editor.click();
  for (const [i, line] of TEXT.entries()) {
    await nb.keyboard.insertText(line);
    if (i < TEXT.length - 1) await nb.keyboard.press("Enter");
  }
  await nb.keyboard.press("Control+s");
  await nb.getByText(/已加密儲存/).first().waitFor();
  // Nothing readable in storage: every script is encrypted.
  const stored = JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(null)));
  for (const probe of ["測試文字", "测试文字", "lazy dog", "テスト", "테스트"])
    assert(!stored.includes(probe), `${probe} is not stored in plain text`);
  await nb.reload();
  await editor.waitFor();
  const back = await editor.evaluate((el) =>
    [...el.querySelectorAll("p,div")].map((p) => p.textContent).filter(Boolean),
  );
  assert.deepEqual(back, TEXT, "every language reads back unchanged");

  const fonts = async () =>
    editor.evaluate((el) => ({
      lang: document.documentElement.lang,
      family: getComputedStyle(el).fontFamily,
      cjk: getComputedStyle(document.documentElement).getPropertyValue("--cjk").trim(),
    }));
  let f = await fonts();
  assert.equal(f.lang, "zh-Hant");
  assert(f.cjk.startsWith('"Microsoft JhengHei"'));
  for (const fb of ["Microsoft YaHei", "Yu Gothic", "Malgun Gothic", "Apple SD Gothic Neo"])
    assert(f.family.includes(fb), `fallback ${fb}`);
  if (shots) await nb.screenshot({ path: resolve(shots, "cjk-notebook.png") });
  for (const [ui, htmlLang, first] of [
    ["zh-CN", "zh-Hans", '"Microsoft YaHei"'],
    ["ja", "ja", '"Yu Gothic UI"'],
    ["ko", "ko", '"Malgun Gothic"'],
    ["en", "en", '"Microsoft JhengHei"'],
  ]) {
    await worker.evaluate((l) => chrome.storage.local.set({ uiLang: l }), ui);
    await nb.reload();
    await editor.waitFor();
    f = await fonts();
    assert.equal(f.lang, htmlLang);
    assert(f.cjk.startsWith(first), `${ui}: ${f.cjk}`);
    assert.deepEqual(
      await editor.evaluate((el) => [...el.querySelectorAll("p,div")].map((p) => p.textContent).filter(Boolean)),
      TEXT,
    );
  }
  console.log(
    "PASS CJK notebook: zh-TW/zh-CN/en/ja/ko (+emoji) saved encrypted and read back unchanged; fonts follow the interface language with fallbacks for every script",
  );
} finally {
  await context.close();
}
