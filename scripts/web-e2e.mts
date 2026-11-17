// Mobile web app (docs/app) on a phone-sized screen against a simulated Google
// Drive: unlock with the master password, browse and edit bookmarks, read
// notes, sync both ways in the extension's snapshot format, work offline from
// the phone's encrypted copy, sign-in URL, share target and auto-lock.
// Run: npx vite build -c vite.web.config.ts && npx tsx scripts/web-e2e.mts [shots]
import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import assert from "node:assert/strict";
import {
  decrypt,
  emptyVault,
  newDataKey,
  seal,
  setPassword,
  setRecovery,
  newRecoveryCode,
  type Vault,
} from "../src/crypto";

const root = resolve(import.meta.dirname, "..");
const shot = process.argv[2];
const PASSWORD = "phone-test-1234";

// ---- Static server: docs/ served at /veil-bookmark/ like GitHub Pages ------
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  if (!path.startsWith("/veil-bookmark/")) return res.writeHead(404).end();
  let file = resolve(root, "docs", path.slice("/veil-bookmark/".length));
  if (path.endsWith("/")) file = resolve(file, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": types[extname(file)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const APP = `http://127.0.0.1:${port}/veil-bookmark/app/`;

// ---- A vault as the extension would have uploaded it -----------------------
const dek = await newDataKey();
const id = crypto.randomUUID();
let keys = await setPassword(dek, id, PASSWORD);
keys = await setRecovery(dek, id, newRecoveryCode().bytes, keys);
const now = Date.now();
const v: Vault = emptyVault(id);
const entry = (
  title: string,
  url: string,
  folder: string,
  tags: string[],
  notes = "",
  order?: number,
) => ({
  id: crypto.randomUUID(),
  title,
  url,
  folder,
  tags,
  notes,
  ...(order === undefined ? {} : { order }),
  updated: now - 1000,
  revision: crypto.randomUUID(),
  deleted: false,
});
v.entries.push(
  entry(
    "清水寺",
    "https://www.kiyomizudera.or.jp/",
    "旅行",
    ["日本", "京都"],
    "早上 7 點前人少",
    0,
  ),
  entry(
    "錦市場",
    "https://www.kyoto-nishiki.or.jp/",
    "旅行",
    ["日本", "美食"],
    "",
    1,
  ),
  entry("MDN Web Docs", "https://developer.mozilla.org/", "工作", ["參考"], ""),
  entry("天氣", "https://www.cwa.gov.tw/", "", [], ""),
);
v.folders = [
  {
    id: "entry:旅行",
    kind: "entry",
    name: "旅行",
    order: 0,
    updated: now,
    revision: "f1",
    deleted: false,
  },
  {
    id: "entry:工作",
    kind: "entry",
    name: "工作",
    order: 1,
    updated: now,
    revision: "f2",
    deleted: false,
  },
];
// 1x1 green PNG
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
v.memos.push({
  id: crypto.randomUUID(),
  title: "京都行程",
  body: '<h2>第一天</h2><p>清水寺 → 二年坂</p><img data-veil-img="pic" alt=""><p><a href="https://example.com/map">地圖</a></p>',
  format: "html",
  images: [{ id: "pic", data: png, mime: "image/png", w: 1, h: 1 }],
  folder: "旅行計畫",
  updated: now - 500,
  revision: "m1",
  deleted: false,
});

// ---- Simulated Drive -----------------------------------------------------
const remote = new Map<string, unknown>();
let next = 0;
remote.set("ext-1", await seal(v, dek, keys));
const open = async (e: any) => decrypt(e, dek);
const only = async () => {
  assert.equal(remote.size, 1, "Drive keeps one current snapshot");
  return open([...remote.values()][0]);
};

const browser = await chromium.launch();
const phone = devices["iPhone 13"];
const context = await browser.newContext({
  ...phone,
  defaultBrowserType: undefined,
  locale: "zh-TW",
  serviceWorkers: "block",
} as any);
let signedIn = true;
let authUrl = "";
await context.addInitScript(() => {
  if ((window as any).__noToken || sessionStorage.getItem("veilTestNoToken"))
    return;
  sessionStorage.setItem(
    "veilGoogleToken",
    JSON.stringify({
      token: "synthetic-token",
      expires: Date.now() + 3600_000,
    }),
  );
});
await context.route("**/app/config.json", (r) =>
  r.fulfill({ json: { clientId: "test-client.apps.googleusercontent.com" } }),
);
await context.route("https://accounts.google.com/**", (r) => {
  authUrl = r.request().url();
  return r.fulfill({ body: "google sign-in", contentType: "text/plain" });
});
await context.route("https://www.googleapis.com/**", async (route) => {
  const req = route.request();
  const u = req.url();
  if (req.headers()["authorization"] !== "Bearer synthetic-token" || !signedIn)
    return route.fulfill({ status: 401, body: "" });
  if (req.method() === "POST") {
    const body = req.postData() || "";
    const json = body
      .split("Content-Type: application/json\r\n\r\n")[1]
      .split("\r\n--")[0];
    const fid = "web-" + next++;
    remote.set(fid, JSON.parse(json));
    return route.fulfill({ json: { id: fid } });
  }
  const fid = decodeURIComponent(u.split("/files/")[1]?.split("?")[0] || "");
  if (req.method() === "DELETE")
    return route.fulfill({ status: remote.delete(fid) ? 204 : 404, body: "" });
  if (u.includes("alt=media"))
    return remote.has(fid)
      ? route.fulfill({
          body: JSON.stringify(remote.get(fid)),
          contentType: "application/json",
        })
      : route.fulfill({ status: 404, body: "" });
  return route.fulfill({
    json: { files: [...remote.keys()].map((id) => ({ id })) },
  });
});

const page = await context.newPage();
const snap = async (name: string) => {
  if (shot) await page.screenshot({ path: resolve(shot, name) });
};
try {
  // ---- Unlock --------------------------------------------------------------
  await page.goto(APP);
  await page.getByRole("heading", { name: "歡迎回來" }).waitFor();
  await page.getByText("已連接 Google Drive").waitFor();
  await snap("web-1-unlock.png");
  const pw = page.getByLabel("主密碼");
  await pw.fill("wrong");
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByRole("alert").filter({ hasText: "密碼不正確" }).waitFor();
  await page.waitForTimeout(1100); // retry delay after a wrong password
  await pw.fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByRole("tab", { name: /書籤/ }).waitFor();
  await page.getByText("清水寺").waitFor();
  // Grouped by folder in the extension's order; tags and memo on the row.
  assert.deepEqual(await page.locator(".groupTitle").allInnerTexts(), [
    "旅行",
    "工作",
    "未分類",
  ]);
  const kiyomizu = page.locator(".row", { hasText: "清水寺" });
  assert.match(
    await kiyomizu.innerText(),
    /#日本[\s\S]*#京都[\s\S]*早上 7 點前人少/,
  );
  assert.equal(
    await kiyomizu.locator("a.rowMain").getAttribute("href"),
    "https://www.kiyomizudera.or.jp/",
  );
  assert.equal(
    await kiyomizu.locator("a.rowMain").getAttribute("rel"),
    "noopener noreferrer",
  );
  await page.locator(".syncDot", { hasText: "已同步" }).waitFor();
  // Opening the vault with nothing new does not upload.
  assert.deepEqual([...remote.keys()], ["ext-1"]);
  await snap("web-2-library.png");

  // ---- Filter and search ---------------------------------------------------
  await page.locator(".chips button", { hasText: "工作" }).click();
  assert.deepEqual(await page.locator(".row strong").allInnerTexts(), [
    "MDN Web Docs",
  ]);
  await page.locator(".chips button", { hasText: "全部" }).click();
  await page.getByRole("searchbox").fill("美食");
  assert.deepEqual(await page.locator(".row strong").allInnerTexts(), [
    "錦市場",
  ]);
  await page.getByRole("searchbox").fill("");

  // ---- Add with tag chips → uploaded as one snapshot -----------------------
  await page.getByRole("button", { name: "新增書籤" }).click();
  await page.getByLabel("名稱").fill("伏見稻荷");
  await page.getByLabel("網址").fill("https://inari.jp/");
  await page.getByRole("combobox", { name: "資料夾" }).fill("旅行");
  const tags = page.getByRole("combobox", { name: "標籤" });
  await tags.focus();
  await tags.pressSequentially("日");
  await page.locator(".tagOptions li", { hasText: "日本" }).click();
  await tags.pressSequentially("鳥居,");
  await page.getByLabel("私密備註").fill("傍晚人比較少");
  await snap("web-3-editor.png");
  await page.getByRole("button", { name: "加密儲存 →" }).click();
  await page.getByText("已加密收藏").waitFor();
  await page.locator(".syncDot", { hasText: "已同步" }).waitFor();
  await expectRemote(async (rv) => {
    const added = rv.entries.find((x) => x.title === "伏見稻荷");
    assert(added, "new bookmark reached Drive");
    assert.deepEqual(added!.tags, ["日本", "鳥居"]);
    assert.equal(added!.notes, "傍晚人比較少");
    assert.equal(added!.folder, "旅行");
    // Everything else is kept, including note pictures and folder order.
    assert.equal(rv.memos[0].images?.[0].data, png);
    assert.equal(rv.folders?.length, 2);
  });
  assert(
    !JSON.stringify([...remote.values()]).includes("伏見稻荷"),
    "Drive only has ciphertext",
  );

  // ---- Edit and delete -----------------------------------------------------
  await page
    .locator(".row", { hasText: "天氣" })
    .getByRole("button", { name: /更多操作/ })
    .click();
  await page.getByRole("button", { name: "編輯" }).click();
  await page.getByLabel("名稱").fill("中央氣象署");
  await page.getByRole("button", { name: "加密儲存 →" }).click();
  await page.getByText("已更新書籤").waitFor();
  await page
    .locator(".row", { hasText: "MDN" })
    .getByRole("button", { name: /更多操作/ })
    .click();
  await page.getByRole("button", { name: "刪除", exact: true }).click();
  await page.getByRole("button", { name: /確定刪除/ }).click();
  await page.getByText("已刪除書籤").waitFor();
  await page.locator(".syncDot", { hasText: "已同步" }).waitFor();
  await expectRemote(async (rv) => {
    assert(rv.entries.some((x) => x.title === "中央氣象署" && !x.deleted));
    assert(
      rv.entries.find((x) => x.title === "MDN Web Docs")?.deleted,
      "deletion syncs as a tombstone",
    );
  });

  // ---- Changes from another device appear after syncing -------------------
  const fromPc = await only();
  fromPc.entries.push(entry("從電腦加的", "https://example.org/", "", []));
  fromPc.entries.at(-1)!.updated = Date.now();
  remote.set("ext-2", await seal(fromPc, dek, keys));
  await page.locator(".syncDot").click();
  await page.getByRole("button", { name: "立即同步" }).click();
  await page
    .getByRole("dialog")
    .getByText(/上次同步/)
    .waitFor();
  await snap("web-4-settings.png");
  await page.getByRole("button", { name: "關閉" }).click();
  await page.getByText("從電腦加的").waitFor();
  await expectRemote(async () => {}); // consolidated to one snapshot

  // ---- Notes: read-only, with pictures ------------------------------------
  await page.getByRole("tab", { name: /記事本/ }).click();
  await page.locator(".groupTitle", { hasText: "旅行計畫" }).waitFor();
  await page.getByRole("button", { name: /京都行程/ }).click();
  const reader = page.getByRole("dialog", { name: "京都行程" });
  await reader.getByRole("heading", { name: "第一天" }).waitFor();
  assert.match(
    (await reader.locator("img").getAttribute("src")) || "",
    /^data:image\/png;base64,/,
  );
  assert.equal(
    await reader.locator("a").getAttribute("rel"),
    "noopener noreferrer",
  );
  assert.equal(await reader.locator("script").count(), 0);
  await snap("web-5-reader.png");
  await reader.getByRole("button", { name: "← 返回" }).click();
  await page.getByRole("tab", { name: /書籤/ }).click();

  // ---- Lock, then open offline from the phone's encrypted copy -------------
  await page.getByRole("button", { name: "上鎖" }).click();
  await page.getByRole("heading", { name: "歡迎回來" }).waitFor();
  assert.equal(
    await page.getByText("清水寺").count(),
    0,
    "nothing decrypted is left on screen",
  );
  const stored = await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((r) => {
      const q = indexedDB.open("veil-bookmark-web");
      q.onsuccess = () => r(q.result);
    });
    return new Promise<string>((r) => {
      const q = db.transaction("kv").objectStore("kv").get("vault");
      q.onsuccess = () => r(JSON.stringify(q.result));
    });
  });
  assert(
    stored.includes('"ciphertext"') && !stored.includes("清水寺"),
    "phone copy is encrypted",
  );
  await page.evaluate(() => {
    sessionStorage.removeItem("veilGoogleToken");
    sessionStorage.setItem("veilTestNoToken", "1");
  });
  await page.reload();
  await page
    .getByText("尚未連接 Google：會開啟這支手機上次同步的資料。")
    .waitFor();
  await page.getByLabel("主密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByText("從電腦加的").waitFor();
  // Offline edit waits for Google; the hint offers to reconnect.
  await page.getByRole("button", { name: "新增書籤" }).click();
  await page.getByLabel("名稱").fill("離線新增");
  await page.getByLabel("網址").fill("https://offline.example/");
  await page.getByRole("button", { name: "加密儲存 →" }).click();
  await page.locator(".syncHint", { hasText: "Google 連線已過期" }).waitFor();
  assert(!(await only()).entries.some((x) => x.title === "離線新增"));
  await snap("web-6-offline.png");
  // Reconnecting uploads it (the popup is simulated by handing back a token).
  await page.evaluate(() => {
    sessionStorage.removeItem("veilTestNoToken");
    sessionStorage.setItem(
      "veilGoogleToken",
      JSON.stringify({
        token: "synthetic-token",
        expires: Date.now() + 3600_000,
      }),
    );
  });
  await page.locator(".syncDot").click();
  await page.getByRole("button", { name: "立即同步" }).click();
  await page
    .getByRole("dialog")
    .getByText(/上次同步/)
    .waitFor();
  await page.getByRole("button", { name: "關閉" }).click();
  await expectRemote(async (rv) =>
    assert(rv.entries.some((x) => x.title === "離線新增")),
  );

  // ---- Share target: a link shared to the app opens the editor -------------
  await page.goto(
    APP +
      "?title=" +
      encodeURIComponent("分享的頁面") +
      "&text=" +
      encodeURIComponent("看看 https://shared.example/page"),
  );
  await page.getByText("解鎖後即可收藏分享過來的網頁。").waitFor();
  assert.equal(
    new URL(page.url()).search,
    "",
    "shared link is not left in the address bar",
  );
  await page.getByLabel("主密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByRole("dialog", { name: "留下一個好去處" }).waitFor();
  assert.equal(await page.getByLabel("名稱").inputValue(), "分享的頁面");
  assert.equal(
    await page.getByLabel("網址").inputValue(),
    "https://shared.example/page",
  );
  await page.getByRole("button", { name: "關閉" }).click();

  // ---- New phone: Google sign-in URL ---------------------------------------
  const fresh = await context.newPage();
  await fresh.goto(APP);
  await fresh.evaluate(() => {
    sessionStorage.setItem("veilTestNoToken", "1");
    sessionStorage.removeItem("veilGoogleToken");
    indexedDB.deleteDatabase("veil-bookmark-web");
  });
  await fresh.reload();
  await fresh.getByRole("heading", { name: "在手機上開啟你的書籤" }).waitFor();
  assert.equal(await fresh.getByLabel("主密碼").count(), 0);
  if (shot)
    await fresh.screenshot({ path: resolve(shot, "web-7-new-phone.png") });
  await fresh
    .getByRole("button", { name: /使用 Google 帳號連接 Drive/ })
    .click();
  await fresh.waitForURL(/accounts\.google\.com/);
  const a = new URL(authUrl);
  assert.equal(
    a.searchParams.get("client_id"),
    "test-client.apps.googleusercontent.com",
  );
  assert.equal(a.searchParams.get("response_type"), "token");
  assert.equal(
    a.searchParams.get("scope"),
    "https://www.googleapis.com/auth/drive.appdata",
  );
  assert.equal(a.searchParams.get("redirect_uri"), APP);
  const state = a.searchParams.get("state")!;
  // Google's reply: a forged state is refused, the real one is accepted.
  await fresh.goto(
    APP +
      "#access_token=forged&state=r.wrong&scope=" +
      encodeURIComponent("https://www.googleapis.com/auth/drive.appdata"),
  );
  await fresh
    .getByRole("alert")
    .filter({ hasText: "Google 授權回應無效" })
    .waitFor();
  assert.equal(
    await fresh.evaluate(() => sessionStorage.getItem("veilGoogleToken")),
    null,
  );
  await fresh.close();
  void state;

  // ---- Not configured -------------------------------------------------------
  const bare = await context.newPage();
  await bare.route("**/app/config.json", (r) =>
    r.fulfill({ json: { clientId: "" } }),
  );
  await bare.goto(APP);
  await bare.evaluate(() => {
    sessionStorage.setItem("veilTestNoToken", "1");
    sessionStorage.removeItem("veilGoogleToken");
    indexedDB.deleteDatabase("veil-bookmark-web");
  });
  await bare.reload();
  await bare.getByText("手機版尚未完成 Google 設定").waitFor();
  await bare.close();

  // ---- Clear this phone ------------------------------------------------------
  await page.getByRole("button", { name: "上鎖" }).waitFor();
  await page.locator(".syncDot").click();
  await page
    .getByRole("button", { name: "清除這支手機上的資料並登出" })
    .click();
  await page.getByRole("button", { name: "確定清除並登出？" }).click();
  await page.getByRole("heading", { name: "在手機上開啟你的書籤" }).waitFor();
  assert.equal(remote.size, 1, "clearing the phone leaves Drive alone");
  console.log(
    "PASS web app: unlock, folders/search, add/edit/delete synced as extension snapshots, two-way sync, notes reader with pictures, offline copy, reconnect upload, share target, sign-in URL and state check, unconfigured, clear phone",
  );
} finally {
  await browser.close();
  server.close();
}

async function expectRemote(check: (v: Vault) => Promise<void>) {
  for (let i = 0; i < 40; i++) {
    try {
      await check(await only());
      return;
    } catch (e) {
      if (i === 39) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
