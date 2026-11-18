// Right-click "Add to Veil notes" in the extension: selected text and
// pictures become notes (title, text, picture, link back to the page). While
// locked the note waits in memory-only session storage and is saved encrypted
// on unlock; nothing is written to disk unencrypted.
// Run: npm run build && node scripts/clip-e2e.mjs
import { chromium } from "playwright";
import { createServer } from "node:http";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const server = createServer((req, res) => {
  if (req.url === "/open.png")
    return res
      .writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" })
      .end(PNG);
  if (req.url === "/closed.png")
    return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/clip-test-" + Date.now()),
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
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert(manifest.permissions.includes("contextMenus"));
  // Both menu items exist (update fails for an unknown id).
  for (const item of ["veil-note-text", "veil-note-image"])
    for (let i = 0; ; i++)
      try {
        await worker.evaluate((x) => chrome.contextMenus.update(x, {}), item);
        break;
      } catch (e) {
        if (i > 20) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.goto(`${base}?popup`);
  await popup.locator("input[type=password]").nth(0).fill("1234");
  await popup.locator("input[type=password]").nth(1).fill("1234");
  await popup.locator(".ackRow input").check();
  await popup.getByRole("button", { name: "建立保險庫 →" }).click();
  await popup.locator(".recoveryModal .ackRow input").check();
  await popup.getByRole("button", { name: "完成" }).click();
  await popup.getByRole("tab", { name: "記事本" }).waitFor();

  const clip = (info, tab) =>
    worker.evaluate(([i, t]) => globalThis.veilOnClip(i, t), [info, tab]);
  const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}));
  const notes = async () => {
    await popup.reload();
    await popup.getByRole("tab", { name: "記事本" }).click();
    return popup.locator("body").innerText();
  };

  // 1) Unlocked: selected text → note right away.
  await clip(
    { menuItemId: "veil-note-text", selectionText: "第一段重點\n\n第二段 <b>不是 HTML</b>", pageUrl: SITE + "/article" },
    { title: "測試文章" },
  );
  assert.equal(await badge(), "✓");
  assert((await notes()).includes("測試文章"), "note listed with the page title");

  // 2) Picture the site allows → stored inside the note; otherwise a link.
  await clip({ menuItemId: "veil-note-image", srcUrl: SITE + "/open.png", pageUrl: SITE + "/gallery" }, { title: "相簿" });
  await clip({ menuItemId: "veil-note-image", srcUrl: SITE + "/closed.png", pageUrl: SITE + "/gallery2" }, { title: "另一個相簿" });

  // Read the notes in full from the notebook page's view of the vault.
  const vault = async () =>
    popup.evaluate(async () => {
      const w = await chrome.windows.getCurrent();
      const r = await chrome.runtime.sendMessage({ type: "LIST", sourceWindowId: w.id, lite: false });
      return r.data;
    });
  let v = await vault();
  const byTitle = (t) => v.memos.find((m) => m.title === t && !m.deleted);
  const text = byTitle("測試文章");
  assert(text.body.includes("<p>第一段重點</p>"));
  assert(text.body.includes("&lt;b&gt;不是 HTML&lt;/b&gt;"), "selection is plain text, escaped");
  assert(text.body.includes(`href="${SITE}/article"`), "link back to the page");
  const pic = byTitle("相簿");
  assert.equal(pic.images.length, 1, "picture stored in the note");
  assert(pic.body.includes(`data-veil-img="${pic.images[0].id}"`));
  const linked = byTitle("另一個相簿");
  assert.equal(linked.images.length, 0);
  assert(linked.body.includes(`href="${SITE}/closed.png"`), "falls back to the picture's link");

  // 3) Locked: waits in session storage only, saved on unlock.
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "LOCK" }));
  await clip(
    { menuItemId: "veil-note-text", selectionText: "上鎖時選取的祕密 QWZ-9931", pageUrl: SITE + "/later" },
    { title: "稍後再存" },
  );
  assert.equal(await badge(), "1");
  const disk = JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(null)));
  assert(!disk.includes("QWZ-9931"), "nothing unencrypted on disk");
  const mem = await worker.evaluate(() => chrome.storage.session.get("clips"));
  assert.equal(mem.clips.length, 1);
  await popup.reload();
  await popup.locator("input[type=password]").first().fill("1234");
  await popup.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await popup.getByRole("tab", { name: "記事本" }).waitFor();
  v = await vault();
  assert(byTitle("稍後再存")?.body.includes("QWZ-9931"), "saved after unlocking");
  assert.equal((await worker.evaluate(() => chrome.storage.session.get("clips"))).clips, undefined);
  assert.equal(await badge(), "✓");
  const disk2 = JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(null)));
  assert(!disk2.includes("QWZ-9931"), "saved encrypted");
  console.log(
    "PASS right-click to notes: menu items created, selected text (escaped, link back), picture stored or linked when the site blocks it, locked → memory only → saved encrypted on unlock, badge feedback",
  );
} finally {
  await context.close();
  server.close();
}
