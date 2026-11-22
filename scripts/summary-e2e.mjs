// API sessions are synthetic; DOM extraction, extension RPCs and encryption are real.
// A disposable manifest adds the test origin because native context-menu grants
// cannot be triggered by Playwright. Production uses activeTab, not host access.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, ".."),
  temp = resolve(root, "../../work/summary-test-" + Date.now());
await mkdir(temp, { recursive: true });
const server = createServer((req, res) =>
  res
    .writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(
      '<html lang="zh-Hant"><title>測試文章</title><article><h1>頁面摘要測試</h1><p>應保留的文章內容。'.repeat(
        20,
      ) +
        '</p><form>FORM_SECRET<input value="PASSWORD_SECRET"></form><p style="display:none">HIDDEN_SECRET</p></article></html>',
    ),
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = "http://127.0.0.1:" + server.address().port;
await cp(resolve(root, "dist"), resolve(temp, "dist"), { recursive: true });
const manifest = JSON.parse(
  await readFile(resolve(temp, "dist/manifest.json"), "utf8"),
);
manifest.host_permissions.push("http://127.0.0.1/*");
await writeFile(resolve(temp, "dist/manifest.json"), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(
  resolve(temp, "profile"),
  {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${resolve(temp, "dist")}`,
      `--load-extension=${resolve(temp, "dist")}`,
    ],
  },
);
await context.addInitScript(() => {
  window.modelsStarted = 0;
  window.modelsDestroyed = 0;
  Object.defineProperty(window, "Summarizer", {
    configurable: true,
    value: {
      availability: async () => "available",
      create: async () => {
        if (!navigator.userActivation.isActive) throw Error("No activation");
        window.modelsStarted++;
        return {
          summarize: async (text) => {
            if (window.slowSummary)
              await new Promise((r) => setTimeout(r, 1200));
            return "English summary";
          },
          destroy: () => window.modelsDestroyed++,
        };
      },
    },
  });
  Object.defineProperty(window, "Translator", {
    configurable: true,
    value: {
      availability: async () => "available",
      create: async (options) => {
        window.modelsStarted++;
        return {
          translate: async (text) =>
            options.targetLanguage === "zh-Hant"
              ? "繁中摘要：保留重點 <script>bad()</script>"
              : text,
          destroy: () => window.modelsDestroyed++,
        };
      },
    },
  });
});
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host,
    base = `chrome-extension://${id}/index.html`;
  const control = await context.newPage();
  await control.goto(base + "?popup");
  await control.evaluate(async () => {
    await chrome.storage.local.set({ uiLang: "zh-TW" });
    const r = await chrome.runtime.sendMessage({
      type: "CREATE",
      password: "1234",
    });
    if (!r.ok) throw Error(r.error);
  });
  const site = await context.newPage();
  await site.goto(url);
  async function capture() {
    const created = context.waitForEvent("page");
    await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url: url + "/*" });
      await globalThis.veilOnClip(
        { menuItemId: "veil-summary", pageUrl: tab.url },
        tab,
      );
    }, url);
    const p = await created;
    await p.setViewportSize({ width: 900, height: 850 });
    await p.waitForLoadState();
    return p;
  }
  const p = await capture();
  await p.getByRole("button", { name: "開始本機摘要" }).waitFor();
  await p.waitForFunction(
    () => {const button=document.querySelector("button.primary");return button&&!button.disabled;},
  );
  assert.equal(await p.evaluate(() => window.modelsStarted), 0);
  const jobs = await worker.evaluate(() =>
    chrome.storage.session.get("summaryJobs"),
  );
  const source = Object.values(jobs.summaryJobs)[0];
  assert(source.text.includes("應保留"));
  assert(!/FORM_SECRET|HIDDEN_SECRET|PASSWORD_SECRET/.test(source.text));
  await p.getByRole("button", { name: "開始本機摘要" }).click();
  await p.getByLabel("摘要", { exact: true }).waitFor();
  await p.screenshot({
    path: resolve(root, "../previews/local-summary-preview.png"),
  });
  assert.match(
    await p.getByLabel("摘要", { exact: true }).inputValue(),
    /繁中摘要/,
  );
  await p.getByRole("button", { name: "加密存入記事本" }).click();
  await p.getByRole("link", { name: "開啟記事", exact: true }).waitFor();
  const notes = await control.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "LIST" });
    return r.data.memos;
  });
  assert.equal(notes.length, 1);
  assert(notes[0].body.includes("&lt;script&gt;"));
  assert(notes[0].body.includes(url));
  const disk = await worker.evaluate(() => chrome.storage.local.get(null));
  assert(!JSON.stringify(disk).includes("繁中摘要"));
  const q = await capture();
  await q.waitForFunction(
    () => {const button=document.querySelector("button.primary");return button&&!button.disabled;},
  );
  await q.evaluate(() => (window.slowSummary = true));
  await q.getByRole("button", { name: "開始本機摘要" }).click();
  await control.evaluate(() => chrome.runtime.sendMessage({ type: "LOCK" }));
  await q.getByLabel("主密碼", { exact: true }).waitFor();
  await q.waitForTimeout(1400);
  assert.equal(await q.getByLabel("摘要", { exact: true }).count(), 0);
  assert.equal(
    await q.evaluate(
      () =>
        window.modelsStarted > 0 &&
        window.modelsDestroyed >= window.modelsStarted,
    ),
    true,
  );
  assert.deepEqual(
    (await worker.evaluate(() => chrome.storage.session.get("summaryJobs")))
      .summaryJobs,
    undefined,
  );
  const r = await capture();
  await r.getByLabel("主密碼", { exact: true }).fill("1234");
  await r.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await r.getByRole("button", { name: "開始本機摘要" }).waitFor();
  await r.evaluate(() => {
    window.Translator.availability = async () => "unavailable";
  });
  await r.getByLabel("摘要語言").selectOption("ja");
  await r.getByText(/此裝置或語言尚不支援/).waitFor();
  assert(await r.getByRole("button", { name: "開始本機摘要" }).isDisabled());
  const jobId = new URL(r.url()).searchParams.get("summary");
  const invalid = await r.evaluate(
    async (id) =>
      chrome.runtime.sendMessage({
        type: "SUMMARY_SAVE",
        id,
        summary: "forged",
        authorization: "wrong",
      }),
    jobId,
  );
  assert(!invalid.ok);
  await worker.evaluate(async (id) => {
    const { summaryJobs } = await chrome.storage.session.get("summaryJobs");
    summaryJobs[id].at = Date.now() - 700000;
    await chrome.storage.session.set({ summaryJobs });
  }, jobId);
  const expired = await r.evaluate(
    async (id) => chrome.runtime.sendMessage({ type: "SUMMARY_GET", id }),
    jobId,
  );
  assert(!expired.ok);
  await p.screenshot({
    path: resolve(root, "../previews/local-summary-saved.png"),
  });
  console.log(
    "PASS summary: real page extraction, form/hidden exclusion, explicit model activation, Chinese translation chain, encrypted save/source link, escaped output, lock cancellation, locked capture/unlock, unavailable model, nonce and expiry guards.",
  );
} finally {
  await context.close();
  server.close();
}
