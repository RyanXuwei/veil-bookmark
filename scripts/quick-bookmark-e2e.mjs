import { chromium } from "playwright";
import { createServer } from "node:http";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const server = createServer((req, res) => {
  const cors =
    req.url !== "/blocked" ? { "access-control-allow-origin": "*" } : {};
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...cors });
  if (req.url === "/slow") {
    setTimeout(() => res.end("<title>延遲名稱</title>"), 1200);
    return;
  }
  res.end(
    "<title>" +
      (req.url === "/target" ? "連結目標 &amp; 網頁" : "一般頁面") +
      "</title><p>Test page</p>",
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const SITE = "http://127.0.0.1:" + server.address().port;
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/quick-bookmark-test-" + Date.now()),
  {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${resolve(root, "dist")}`,
      `--load-extension=${resolve(root, "dist")}`,
    ],
  },
);
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host,
    base = `chrome-extension://${id}/index.html?popup`;
  const p = await context.newPage();
  await p.setViewportSize({ width: 380, height: 640 });
  await p.goto(base);
  async function rpc(type, data = {}) {
    const r = await p.evaluate(
      async ({ type, data }) => chrome.runtime.sendMessage({ type, ...data }),
      { type, data },
    );
    if (!r.ok) throw Error(r.error);
    return r.data;
  }
  await rpc("CREATE", { password: "1234" });
  await worker.evaluate(() => chrome.storage.local.set({ uiLang: "zh-TW" }));
  async function quick(
    path,
    title = "目前分頁名稱",
    link = "",
    incognito = false,
  ) {
    await worker.evaluate(
      async (x) => {
        await globalThis.veilOnClip(
          {
            menuItemId: "veil-bookmark",
            pageUrl: x.page,
            ...(x.link ? { linkUrl: x.link } : {}),
          },
          { url: x.page, title: x.title, incognito: x.incognito },
        );
      },
      { page: SITE + path, title, link, incognito },
    );
  }
  await quick("/page");
  let entries = (await rpc("LIST")).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "目前分頁名稱");
  await rpc("UPSERT", {
    entry: {
      ...entries[0],
      title: "自己取的名稱",
      tags: "保留標籤",
      notes: "保留備註",
    },
  });
  await quick("/page#fragment", "新分頁名稱");
  entries = (await rpc("LIST")).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "自己取的名稱");
  assert.equal(entries[0].notes, "保留備註");
  await quick("/page", "不是目標名稱", SITE + "/target");
  entries = (await rpc("LIST")).entries;
  assert.equal(
    entries.find((e) => e.url === SITE + "/target").title,
    "連結目標 & 網頁",
  );
  await quick("/page", "不是目標名稱", SITE + "/blocked");
  entries = (await rpc("LIST")).entries;
  assert.equal(
    entries.find((e) => e.url === SITE + "/blocked").title,
    "127.0.0.1",
  );
  const count = entries.length;
  await quick("/page", "bad", "javascript:alert(1)");
  assert.equal((await rpc("LIST")).entries.length, count);
  await quick("/private", "無痕標題", "", true);
  entries = (await rpc("LIST")).entries;
  const privateEntry = entries.find((e) => e.url === SITE + "/private");
  assert.equal(privateEntry.incognito, true);
  assert.equal(privateEntry.folder, "🕶 無痕專用");
  await rpc("LOCK");
  await quick("/locked", "上鎖時標題");
  await quick("/locked#x", "第二次標題");
  const pending = await worker.evaluate(() =>
    chrome.storage.session.get("bookmarkClips"),
  );
  assert.equal(pending.bookmarkClips.length, 1);
  const disk = JSON.stringify(
    await worker.evaluate(() => chrome.storage.local.get(null)),
  );
  assert(!disk.includes("上鎖時標題"));
  assert(!disk.includes(SITE + "/locked"));
  await worker.evaluate(async (site) => {
    const { bookmarkClips } = await chrome.storage.session.get("bookmarkClips");
    bookmarkClips.push({
      at: Date.now() - 31 * 60000,
      entry: {
        url: site + "/expired",
        title: "已過期",
        folder: "",
        incognito: false,
      },
    });
    await chrome.storage.session.set({ bookmarkClips });
  }, SITE);
  await rpc("UNLOCK", { password: "1234" });
  entries = (await rpc("LIST")).entries;
  assert.equal(entries.filter((e) => e.url === SITE + "/locked").length, 1);
  assert(!entries.some((e) => e.url === SITE + "/expired"));
  assert.equal(
    (await worker.evaluate(() => chrome.storage.session.get("bookmarkClips")))
      .bookmarkClips,
    undefined,
  );
  // The normal form accepts a blank name and resolves a title before saving.
  await p.reload();
  await p.getByRole("button", { name: "手動新增書籤", exact: true }).click();
  const dialog = p.getByRole("dialog");
  assert.equal(
    await dialog.getByLabel("名稱", { exact: true }).getAttribute("required"),
    null,
  );
  await dialog
    .getByLabel("網址", { exact: true })
    .fill(SITE + "/target?manual");
  await dialog.getByRole("button", { name: /儲存/ }).click();
  await dialog.waitFor({ state: "hidden" });
  entries = (await rpc("LIST")).entries;
  assert.equal(
    entries.find((e) => e.url === SITE + "/target?manual").title,
    "一般頁面",
  );
  await p.screenshot({
    path: resolve(root, "../previews/quick-bookmark-1.18.0.png"),
  });
  // A lookup completing after lock/unlock must not save the old editor's draft.
  await p.getByRole("button", { name: "手動新增書籤", exact: true }).click();
  await p
    .getByRole("dialog")
    .getByLabel("網址", { exact: true })
    .fill(SITE + "/slow");
  await p.getByRole("dialog").getByRole("button", { name: /儲存/ }).click();
  await p.waitForTimeout(100);
  await rpc("LOCK");
  await rpc("UNLOCK", { password: "1234" });
  await p.waitForTimeout(1500);
  assert(!(await rpc("LIST")).entries.some((e) => e.url === SITE + "/slow"));
  console.log(
    "PASS quick bookmarks: current-page title, link target title, CORS/domain fallback, duplicate metadata preserved, invalid URL rejected, private folder, locked session-only queue/unlock, blank-name manual form.",
  );
} finally {
  await context.close();
  server.close();
}
