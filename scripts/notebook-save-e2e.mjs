// Deterministic notebook regressions: delayed RPC responses and storage errors.
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/notebook-save-test-" + Date.now()),
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
  const base = `chrome-extension://${new URL(worker.url()).host}/index.html`;
  const control = await context.newPage();
  await control.goto(base + "?popup");
  await control.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: "CREATE", password: "1234" });
  });
  const nb = await context.newPage();
  await nb.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.saveTest = {
      hold: false,
      fail: false,
      calls: [],
      release: () => {},
      waiters: [],
    };
    chrome.runtime.sendMessage = async (message, ...args) => {
      if (message.type !== "MEMO_UPSERT") return original(message, ...args);
      const c = window.saveTest;
      c.calls.push(structuredClone(message.memo));
      if (c.fail) return { ok: false, error: "Synthetic storage failure" };
      const response = await original(message, ...args);
      if (c.hold) await new Promise((r) => c.waiters.push(r));
      return response;
    };
    window.saveTest.release = () => {
      window.saveTest.hold = false;
      for (const r of window.saveTest.waiters.splice(0)) r();
    };
  });
  await nb.goto(base + "?notes#new");
  const editor = nb.locator(".nbEditor");
  await editor.waitFor();
  const write = async (text) =>
    editor.evaluate((el, text) => {
      el.innerHTML = `<p>${text}</p>`;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }, text);
  const list = () =>
    control.evaluate(async () => {
      const r = await chrome.runtime.sendMessage({ type: "LIST" });
      if (!r.ok) throw Error(r.error);
      return r.data.memos.filter((m) => !m.deleted);
    });

  // Editing and pressing save again before the first save's reply must use one ID.
  await nb.evaluate(() => (window.saveTest.hold = true));
  await nb.getByRole("textbox", { name: "文件標題" }).fill("延遲儲存測試");
  await write("first-version");
  await editor.focus();
  await nb.keyboard.press("Control+s");
  await nb.waitForFunction(() => window.saveTest.waiters.length === 1);
  await write("latest-version");
  await nb.keyboard.press("Control+s");
  await nb.waitForTimeout(200);
  await nb.evaluate(() => window.saveTest.release());
  await nb.getByText(/^已加密儲存/).waitFor();
  const saved = await list();
  assert.equal(
    saved.length,
    1,
    "overlapping saves must not duplicate a new document",
  );
  assert(saved[0].body.includes("latest-version"));
  const ids = await nb.evaluate(() => window.saveTest.calls.map((c) => c.id));
  assert(
    ids.slice(1).every((id) => id === saved[0].id),
    "subsequent saves must use the ID assigned by the first save",
  );

  // An existing document must stay visible if saving fails during navigation.
  await nb.evaluate(() => (window.saveTest.fail = true));
  await write("unsaved-draft");
  await nb.getByRole("button", { name: "＋ 新增" }).click();
  await nb.getByRole("alert").waitFor();
  assert.equal(
    await nb.getByRole("textbox", { name: "文件標題" }).inputValue(),
    "延遲儲存測試",
  );
  assert(
    (await editor.innerText()).includes("unsaved-draft"),
    "failed save must not discard the editor",
  );
  await nb.evaluate(() => (window.saveTest.fail = false));
  await editor.focus();
  await nb.keyboard.press("Control+s");
  await nb.getByText(/^已加密儲存/).waitFor();

  // Slow save replies arriving after an external lock cannot restore plaintext.
  await nb.evaluate(() => (window.saveTest.hold = true));
  await write("pending-private-text");
  await editor.focus();
  await nb.keyboard.press("Control+s");
  await nb.waitForFunction(() => window.saveTest.waiters.length === 1);
  await control.evaluate(() => chrome.runtime.sendMessage({ type: "LOCK" }));
  await nb.locator(".nbLocked").waitFor();
  await nb.evaluate(() => window.saveTest.release());
  await nb.waitForTimeout(150);
  assert(!(await nb.content()).includes("延遲儲存測試"));
  assert(!(await nb.content()).includes("pending-private-text"));
  await nb.getByRole("textbox", { name: "主密碼" }).fill("1234");
  await nb.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await editor.waitFor();
  assert((await editor.innerText()).includes("pending-private-text"));
  // Switching must wait for the old document, then load only the selected one.
  await control.evaluate(() =>
    chrome.runtime.sendMessage({
      type: "MEMO_UPSERT",
      memo: { title: "切換目標", body: "target-body", format: "text" },
    }),
  );
  await nb.reload();
  await editor.waitFor();
  await nb.locator(".nbNav button", { hasText: "切換目標" }).waitFor();
  await nb.evaluate(() => (window.saveTest.hold = true));
  await write("save-before-switch");
  await editor.focus();
  await nb.keyboard.press("Control+s");
  await nb.waitForFunction(() => window.saveTest.waiters.length === 1);
  await nb.locator(".nbNav button", { hasText: "切換目標" }).click();
  assert.equal(
    await nb.getByRole("textbox", { name: "文件標題" }).isDisabled(),
    true,
  );
  await nb.evaluate(() => window.saveTest.release());
  await nb.waitForFunction(
    () => document.querySelector(".nbTitle").value === "切換目標",
  );
  assert.equal((await editor.innerText()).trim(), "target-body");
  assert(
    (await list())
      .find((m) => m.title === "延遲儲存測試")
      .body.includes("save-before-switch"),
  );

  // Deleting during a new document's first save must delete its assigned ID.
  await nb.getByRole("button", { name: "＋ 新增" }).click();
  await nb.evaluate(() => (window.saveTest.hold = true));
  await nb.getByRole("textbox", { name: "文件標題" }).fill("暫存待刪除");
  await write("delete-after-save");
  await editor.focus();
  await nb.keyboard.press("Control+s");
  await nb.waitForFunction(() => window.saveTest.waiters.length === 1);
  await nb.getByRole("tab", { name: "檢視" }).click();
  nb.once("dialog", (d) => d.accept());
  await nb.getByRole("button", { name: "刪除記事" }).click();
  await nb.evaluate(() => window.saveTest.release());
  await nb.waitForFunction(
    () => document.querySelector(".nbTitle").value !== "暫存待刪除",
  );
  assert(!(await list()).some((m) => m.title === "暫存待刪除"));
  await nb.waitForTimeout(1300);
  assert.equal((await list()).length, 2);
  // A failed save requires explicit consent before locking and discarding a draft.
  await nb.evaluate(() => (window.saveTest.fail = true));
  await write("draft-before-failed-lock");
  nb.once("dialog", (d) => d.dismiss());
  await nb.getByRole("button", { name: /上鎖/ }).click();
  await nb.getByRole("alert").waitFor();
  assert.equal(await nb.locator(".nbLocked").count(), 0);
  assert((await editor.innerText()).includes("draft-before-failed-lock"));
  nb.once("dialog", (d) => d.accept());
  await nb.getByRole("button", { name: /上鎖/ }).click();
  await nb.locator(".nbLocked").waitFor();
  assert(!(await nb.content()).includes("draft-before-failed-lock"));
  console.log(
    "PASS notebook save regressions: one ID for overlapping saves, failure preserves draft, stale replies ignored after lock, switching waits, deletion cannot resurrect an in-flight note.",
  );
} finally {
  await context.close();
}
