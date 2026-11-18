// The "moved" page at the old mobile address: it clears Google tokens at once,
// the button clears only Veil Bookmark's own data (the origin is shared with
// other pages), and it points to the new address.
// Run: npx tsx scripts/moved-e2e.mts
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  if (!path.startsWith("/veil-bookmark/")) return res.writeHead(404).end();
  let file = resolve(root, "docs", path.slice("/veil-bookmark/".length));
  if (path.endsWith("/")) file = resolve(file, "index.html");
  try {
    res.writeHead(200, { "content-type": types[extname(file)] || "text/plain" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const OLD = `http://127.0.0.1:${port}/veil-bookmark/app/`;

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ locale: "zh-TW" })).newPage();
  // Seed the origin: Veil data, plus data that belongs to other pages.
  await page.goto(OLD);
  await page.evaluate(async () => {
    localStorage.setItem("veilGoogleToken", JSON.stringify({ token: "t", expires: Date.now() + 1e6 }));
    localStorage.setItem("veilGoogleConnected", "1");
    localStorage.setItem("veilAccount:A", JSON.stringify({ id: "A", email: "a@example.com", name: "A", token: "secret", expires: Date.now() + 1e6 }));
    localStorage.setItem("veilLang", "ja");
    localStorage.setItem("unityGameSave", "keep-me");
    sessionStorage.setItem("veilActiveAccount", "A");
    sessionStorage.setItem("otherSession", "keep-me-too");
    for (const name of ["veil-bookmark-web", "veil-bookmark-web:A", "veil-bookmark-bio", "other-game-db"])
      await new Promise<void>((res, rej) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => { r.result.close(); res(); };
        r.onerror = () => rej(r.error);
      });
  });
  await page.reload();
  await page.getByRole("heading", { name: /已搬到新網址/ }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: "前往新網址" }).getAttribute("href"),
    "https://veil-bookmark.bitingbox.win/",
  );
  // 1) Tokens are gone as soon as the page opens; nothing else is touched.
  const after = await page.evaluate(() => ({
    token: localStorage.getItem("veilGoogleToken"),
    connected: localStorage.getItem("veilGoogleConnected"),
    account: JSON.parse(localStorage.getItem("veilAccount:A")!),
    lang: localStorage.getItem("veilLang"),
    game: localStorage.getItem("unityGameSave"),
  }));
  assert.equal(after.token, null);
  assert.equal(after.connected, null);
  assert.equal(after.account.token, "");
  assert.equal(after.account.expires, 0);
  assert.equal(after.account.email, "a@example.com");
  assert.equal(after.lang, "ja", "settings stay until the button is used");
  assert.equal(after.game, "keep-me");
  // 2) The button removes Veil's data and only Veil's data.
  await page.getByRole("button", { name: "清除舊網址上的資料" }).click();
  await page.getByText("已清除").waitFor();
  const cleared = await page.evaluate(async () => ({
    veilKeys: Object.keys(localStorage).filter((k) => k.startsWith("veil")),
    game: localStorage.getItem("unityGameSave"),
    session: Object.keys(sessionStorage),
    dbs: ((await indexedDB.databases()) || []).map((d) => d.name).sort(),
  }));
  assert.deepEqual(cleared.veilKeys, []);
  assert.equal(cleared.game, "keep-me", "other pages' data is untouched");
  assert.deepEqual(cleared.session, ["otherSession"]);
  assert.deepEqual(cleared.dbs, ["other-game-db"]);
  console.log(
    "PASS moved page: points to the new address, clears tokens at once, button clears only Veil data (other pages' storage and databases untouched)",
  );
} finally {
  await browser.close();
  server.close();
}
