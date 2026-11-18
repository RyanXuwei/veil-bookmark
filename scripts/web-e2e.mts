// Mobile web app (web-dist) on a phone-sized screen against a simulated Google
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

// ---- Static server: web-dist/ served at the root like Cloudflare Pages ------
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
  let file = resolve(root, "web-dist", "." + path);
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
const APP = `http://127.0.0.1:${port}/`;

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

// ---- A minimal .docx for the import test (ZIP, stored, with CRC-32) -------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function zip(files: Record<string, Uint8Array | string>) {
  const enc = new TextEncoder();
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const data = typeof raw === "string" ? enc.encode(raw) : raw;
    const n = enc.encode(name);
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    local.push(h, Buffer.from(n), Buffer.from(data));
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, Buffer.from(n));
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const docx = zip({
  "[Content_Types].xml":
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  "word/document.xml": `<?xml version="1.0"?><w:document ${W_NS}><w:body>
<w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>會議紀錄</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>重點</w:t></w:r><w:r><w:t xml:space="preserve">：預算 &amp; 時程</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第一項</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第二項</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rLink"><w:r><w:t>參考網址</w:t></w:r></w:hyperlink></w:p>
<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>品項</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>金額</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>
</w:body></w:document>`,
  "word/_rels/document.xml.rels":
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rLink" Type="hyperlink" Target="https://example.com/ref" TargetMode="External"/><Relationship Id="rImg" Type="image" Target="media/image1.png"/></Relationships>',
  "word/styles.xml": `<?xml version="1.0"?><w:styles ${W_NS}><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style></w:styles>`,
  "word/numbering.xml": `<?xml version="1.0"?><w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
  "word/media/image1.png": Buffer.from(png, "base64"),
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
  if (
    localStorage.getItem("veilTestSeeded") ||
    (window as any).__noToken ||
    sessionStorage.getItem("veilTestNoToken")
  )
    return;
  localStorage.setItem("veilTestSeeded", "1");
  localStorage.setItem(
    "veilAccount:test-account",
    JSON.stringify({
      id: "test-account",
      email: "test@example.com",
      name: "Test",
      token: "synthetic-token",
      expires: Date.now() + 3600_000,
    }),
  );
});
await context.route("**/config.json", (r) =>
  r.fulfill({ json: { clientId: "test-client.apps.googleusercontent.com" } }),
);
await context.route("https://accounts.google.com/**", (r) => {
  authUrl = r.request().url();
  return r.fulfill({ body: "google sign-in", contentType: "text/plain" });
});
await context.route("https://www.googleapis.com/**", async (route) => {
  const req = route.request();
  const u = req.url();
  if (u.includes("/about?"))
    return route.fulfill({
      json: {
        user: {
          permissionId: "test-account",
          emailAddress: "test@example.com",
          displayName: "Test",
        },
      },
    });
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

await context.addInitScript(() =>
  sessionStorage.setItem("veilActiveAccount", "test-account"),
);
let page = await context.newPage();
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
  // The biometric offer can be put off; it does not come back by itself.
  await page
    .locator(".bioPrompt")
    .getByRole("button", { name: "以後再說" })
    .click();
  await page.getByRole("status").filter({ hasText: "同步與設定" }).waitFor();
  assert.equal(await page.locator(".bioPrompt").count(), 0);
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
  await page.locator("button.rowMain", { hasText: "京都行程" }).click();
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

  // ---- Notes: edit on the phone (picture kept), synced as the extension's
  // memo format ---------------------------------------------------------------
  await reader.getByRole("button", { name: "編輯" }).click();
  const edit = page.getByRole("dialog", { name: "編輯記事" });
  const text = edit.getByRole("textbox", { name: "記事內容" });
  await text.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await edit.getByRole("button", { name: "粗體" }).click();
  await page.keyboard.type("記得帶傘");
  assert.equal(
    await edit
      .getByRole("button", { name: "粗體" })
      .getAttribute("aria-pressed"),
    "true",
  );
  await edit.getByText("已加密儲存").waitFor();
  await snap("web-6-memo-edit.png");
  await edit.getByRole("button", { name: "← 完成" }).click();
  await edit.waitFor({ state: "detached" });
  await expectRemote(async (rv) => {
    const m = rv.memos.find((x) => x.title === "京都行程")!;
    assert.match(m.body, /<b>記得帶傘<\/b>/);
    assert.match(m.body, /清水寺/);
    assert.equal(m.images?.[0].data, png, "picture kept");
    assert.equal(m.folder, "旅行計畫");
  });

  // New note from ＋, with a heading and a list; then delete it.
  await page.getByRole("button", { name: "新增記事" }).click();
  const fresh0 = page.getByRole("dialog", { name: "新增記事" });
  await fresh0
    .getByRole("textbox", { name: "標題", exact: true })
    .fill("購物清單");
  await fresh0.getByRole("textbox", { name: "記事內容" }).click();
  await fresh0.getByRole("button", { name: "項目符號" }).click();
  await page.keyboard.type("牛奶");
  await page.keyboard.press("Enter");
  await page.keyboard.type("雞蛋");
  await fresh0.getByRole("button", { name: "記事選項" }).click();
  await page.getByRole("button", { name: "#dfeef4" }).click();
  await page.getByRole("button", { name: "關閉" }).click();
  await fresh0.getByRole("button", { name: "← 完成" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "已加密收藏記事" })
    .waitFor();
  await expectRemote(async (rv) => {
    const m = rv.memos.find((x) => x.title === "購物清單" && !x.deleted)!;
    assert.match(m.body, /<ul><li>牛奶<\/li><li>雞蛋<\/li><\/ul>/);
    assert.equal(m.paperColor, "#dfeef4");
    assert.equal(m.format, "html");
  });
  await page.locator("button.rowMain", { hasText: "購物清單" }).click();
  await page.getByRole("button", { name: "編輯" }).click();
  await page.getByRole("button", { name: "記事選項" }).click();
  await page.getByRole("button", { name: "刪除記事" }).click();
  await page
    .getByRole("button", { name: "確定刪除？會同步到所有裝置" })
    .click();
  await page.getByRole("status").filter({ hasText: "已刪除記事" }).waitFor();
  await expectRemote(async (rv) => {
    const m = rv.memos.find((x) => x.deleted)!;
    assert.equal(m.body, "");
    assert.equal(rv.memos.filter((x) => !x.deleted).length, 1);
  });
  await page.getByRole("tab", { name: /書籤/ }).click();

  // ---- Import: .docx, Markdown and a Big5 text file become notes ---------
  await page.getByRole("tab", { name: /記事本/ }).click();
  await page.locator('input[type=file][accept*=".docx"]').setInputFiles([
    {
      name: "會議.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: docx,
    },
    {
      name: "清單.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "## 待辦\n\n- **買** 牛奶\n- 寄信\n\n[說明](https://example.com/md)\n",
      ),
    },
    {
      name: "舊檔.txt",
      mimeType: "text/plain",
      buffer: Buffer.from([0xa4, 0xa4, 0xa4, 0xe5, 0x0a, 0x41]),
    },
    {
      name: "舊版.doc",
      mimeType: "application/msword",
      buffer: Buffer.from("x"),
    },
  ]);
  await page
    .getByRole("status")
    .filter({ hasText: "已匯入 3 則記事" })
    .waitFor();
  await page
    .getByRole("alert")
    .filter({ hasText: "不支援舊版 Word 文件" })
    .waitFor();
  await expectRemote(async (rv) => {
    const live = rv.memos.filter((m) => !m.deleted);
    const d = live.find((m) => m.title === "會議")!;
    assert(d, "docx imported");
    assert.match(d.body, /<h1>會議紀錄<\/h1>/);
    assert.match(d.body, /<b>重點<\/b>：預算 &amp; 時程/);
    assert.match(d.body, /<ol><li>第一項<\/li><li>第二項<\/li><\/ol>/);
    assert.match(
      d.body,
      /<a href="https:\/\/example\.com\/ref"[^>]*>參考網址<\/a>/,
    );
    assert.match(d.body, /<p>品項 \| 金額<\/p>/);
    assert.match(d.body, /&lt;script&gt;/, "text stays text");
    assert.doesNotMatch(d.body, /<script/i);
    assert.equal(d.images?.length, 1, "picture imported");
    assert.match(d.body, new RegExp(`data-veil-img="${d.images![0].id}"`));
    const m = live.find((x) => x.title === "清單")!;
    assert.match(
      m.body,
      /<h2>待辦<\/h2><ul><li><b>買<\/b> 牛奶<\/li><li>寄信<\/li><\/ul>/,
    );
    assert.match(m.body, /href="https:\/\/example\.com\/md"/);
    const t = live.find((x) => x.title === "舊檔")!;
    assert.match(t.body, /<p>中文<\/p><p>A<\/p>/, "Big5 text decoded");
  });
  await snap("web-8-import.png");
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
      const q = db
        .transaction("kv")
        .objectStore("kv")
        .get("vault:test-account");
      q.onsuccess = () => r(JSON.stringify(q.result));
    });
  });
  assert(
    stored.includes('"ciphertext"') && !stored.includes("清水寺"),
    "phone copy is encrypted",
  );
  await page.evaluate(() => {
    const key="veilAccount:test-account";const a=JSON.parse(localStorage.getItem(key)!);localStorage.setItem(key,JSON.stringify({...a,token:"",expires:0}));
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
    localStorage.setItem(
      "veilAccount:test-account",
      JSON.stringify({
        id: "test-account",
        email: "test@example.com",
        name: "Test",
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
  await page.close();
  const fresh = await context.newPage();
  await fresh.goto(APP);
  await fresh.evaluate(async () => {
    sessionStorage.setItem("veilTestNoToken", "1");
    localStorage.removeItem("veilAccount:test-account");
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.deleteDatabase("veil-bookmark-web");
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
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
    await fresh.evaluate(() =>
      sessionStorage.getItem("veilAccount:test-account"),
    ),
    null,
  );
  // The real reply is kept on this phone: a reload (or reopening the app)
  // stays connected instead of asking again.
  const scope = encodeURIComponent(
    "https://www.googleapis.com/auth/drive.appdata",
  );
  await fresh
    .getByRole("button", { name: /使用 Google 帳號連接 Drive/ })
    .click();
  await fresh.waitForURL(/accounts\.google\.com/);
  const state2 = new URL(authUrl).searchParams.get("state")!;
  await fresh.goto(
    `${APP}#access_token=synthetic-token&expires_in=3600&state=${state2}&scope=${scope}`,
  );
  await fresh.getByText("已連接 Google Drive").waitFor();
  await fresh.reload();
  await fresh.getByText("已連接 Google Drive").waitFor();
  const again = await context.newPage(); // A new tab, as after closing the app.
  await again.goto(APP);
  await again.evaluate(() => sessionStorage.setItem("veilTestNoToken", "1"));
  await again.reload();
  await again.getByText("已連接 Google Drive").waitFor();
  await again.close();
  // After the hour: a new token is requested without a prompt.
  await fresh.evaluate(() =>
    localStorage.setItem(
      "veilAccount:test-account",
      JSON.stringify({
        id: "test-account",
        email: "test@example.com",
        token: "old",
        expires: Date.now() - 1000,
      }),
    ),
  );
  await fresh.reload();
  await fresh.waitForURL(/accounts\.google\.com/);
  const silent = new URL(authUrl);
  assert.equal(silent.searchParams.get("prompt"), "none");
  const state3 = silent.searchParams.get("state")!;
  assert(state3.startsWith("s."));
  await fresh.goto(
    `${APP}#access_token=synthetic-token&expires_in=3600&state=${state3}&scope=${scope}`,
  );
  await fresh.getByText("已連接 Google Drive").waitFor();
  // Google refuses the silent request (signed out): no error, no loop.
  await fresh.evaluate(() =>
    localStorage.setItem(
      "veilAccount:test-account",
      JSON.stringify({
        id: "test-account",
        email: "test@example.com",
        token: "old",
        expires: Date.now() - 1000,
      }),
    ),
  );
  await fresh.reload();
  await fresh.waitForURL(/accounts\.google\.com/);
  const state4 = new URL(authUrl).searchParams.get("state")!;
  await fresh.goto(`${APP}#error=interaction_required&state=${state4}`);
  await fresh
    .getByRole("button", { name: /使用 Google 帳號連接 Drive/ })
    .waitFor();
  assert.equal(await fresh.getByRole("alert").count(), 0);
  await fresh.reload();
  await fresh
    .getByRole("button", { name: /使用 Google 帳號連接 Drive/ })
    .waitFor();
  await fresh.evaluate(() => {
    localStorage.removeItem("veilAccount:test-account");
    localStorage.removeItem("veilGoogleConnected");
  });
  await fresh.close();
  void state;

  // ---- Computers: Chrome goes to the extension; other browsers stay --------
  const desk = await browser.newContext({
    locale: "zh-TW",
    serviceWorkers: "block",
  });
  await desk.route("https://chromewebstore.google.com/**", (r) =>
    r.fulfill({ body: "store", contentType: "text/plain" }),
  );
  const other = await desk.newPage(); // Headless Chromium is not Google Chrome.
  await other.goto(APP);
  await other.getByRole("heading", { name: "在手機上開啟你的書籤" }).waitFor();
  // A string, not a function: tsx would add helpers the page does not have.
  await desk.addInitScript(
    `Object.defineProperty(Navigator.prototype, "userAgentData", { configurable: true, get: () => ({ mobile: false, brands: [{ brand: "Google Chrome", version: "142" }] }) });`,
  );
  const chrome = await desk.newPage();
  await chrome.goto(APP);
  await chrome.waitForURL(
    /chromewebstore\.google\.com\/detail\/chpabfajilpjflfmnkopjjcnoaaliefg/,
  );
  await chrome.goto(APP + "?desktop");
  await chrome.getByRole("heading", { name: "在手機上開啟你的書籤" }).waitFor();
  await desk.close();

  // ---- Not configured -------------------------------------------------------
  const bare = await context.newPage();
  await bare.route("**/config.json", (r) =>
    r.fulfill({ json: { clientId: "" } }),
  );
  await bare.goto(APP);
  await bare.evaluate(() => {
    sessionStorage.setItem("veilTestNoToken", "1");
    localStorage.removeItem("veilAccount:test-account");
    indexedDB.deleteDatabase("veil-bookmark-web");
  });
  await bare.reload();
  await bare.getByText("手機版尚未完成 Google 設定").waitFor();
  await bare.close();

  page = await context.newPage();
  await page.goto(APP);
  await page.evaluate(() =>
    localStorage.setItem(
      "veilAccount:test-account",
      JSON.stringify({
        id: "test-account",
        email: "test@example.com",
        token: "synthetic-token",
        expires: Date.now() + 3600000,
      }),
    ),
  );
  await page.reload();
  await page.getByLabel("主密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  // ---- Idle lock: any use of the page counts, even scrolling in a sheet ----
  await page.getByRole("button", { name: "上鎖" }).waitFor();
  await page.getByRole("button", { name: "上鎖" }).click();
  await page.getByRole("heading", { name: "歡迎回來" }).waitFor();
  await page.clock.install();
  await page.getByLabel("主密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByRole("button", { name: "上鎖" }).waitFor();
  await page.locator(".syncDot").click();
  const sheet = page.locator(".sheetBody");
  await sheet.waitFor();
  await page.clock.fastForward("14:00");
  const box = (await sheet.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.wheel(0, 200); // scrolling inside the sheet
  await page.clock.fastForward("14:00");
  assert.equal(
    await page.getByRole("heading", { name: "歡迎回來" }).count(),
    0,
    "still unlocked",
  );
  await page.getByRole("button", { name: "關閉" }).click();
  await page.clock.fastForward("16:00"); // no use for 16 minutes
  await page.getByRole("heading", { name: "歡迎回來" }).waitFor();
  await page.getByLabel("主密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();

  // ---- Clear this phone ------------------------------------------------------
  await page.getByRole("button", { name: "上鎖" }).waitFor();
  await page.locator(".syncDot").click();
  await page
    .getByRole("button", { name: "移除此帳戶的本機資料並登出" })
    .click();
  await page.getByRole("button", { name: "確定清除並登出？" }).click();
  await page.getByRole("heading", { name: "在手機上開啟你的書籤" }).waitFor();
  assert.equal(remote.size, 1, "clearing the phone leaves Drive alone");
  console.log(
    "PASS web app: unlock, folders/search, add/edit/delete synced as extension snapshots, two-way sync, notes reader with pictures, note editing (bold, list, paper color, new, delete; picture kept), import .docx/.md/Big5 .txt (old .doc refused), desktop Chrome redirect, offline copy, reconnect upload, share target, sign-in URL and state check, Google connection kept across reloads and tabs, silent renewal (accepted, refused without a loop), idle lock (scrolling in a sheet counts), unconfigured, clear phone",
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
