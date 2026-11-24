// Notebook pages and quick photos on the phone: pull past the end of a page
// to turn to a new page, pull down at the top to go back, a light pull does
// nothing; handwriting stays on its page; blank pages at the end are not
// kept; the reader shows every page; deleting a page asks first; the camera
// button opens the phone's camera and the photo is stored encrypted.
// Run: npm run build:web && npx tsx scripts/web-pages-e2e.mts [shots]
import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import assert from "node:assert/strict";
import {
  decrypt,
  emptyVault,
  newDataKey,
  newRecoveryCode,
  seal,
  setPassword,
  setRecovery,
  type Vault,
} from "../src/crypto";

const root = resolve(import.meta.dirname, "..");
const PASSWORD = "share-test-1234";
const shot = process.argv[2];
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};
// The site's own headers (web/public/_headers, "/*" block), as Cloudflare
// sends them: the microphone must be allowed by its Permissions-Policy.
const siteHeaders: Record<string, string> = {};
{
  const text = await readFile(resolve(root, "web/public/_headers"), "utf8");
  const block = text.replace(/\r/g, "").split(/\n(?=\/)/)[0];
  for (const line of block.split("\n").slice(1)) {
    const m = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    if (m && m[1] !== "X-Frame-Options") siteHeaders[m[1]] = m[2];
  }
}
assert(siteHeaders["Permissions-Policy"], "headers read");
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  if (req.method !== "GET") return res.writeHead(405).end(); // like static hosting
  // A blank page (no CSP) to send the POST from, as Android's share sheet does.
  if (path === "/__share")
    return res
      .writeHead(200, { "content-type": "text/html" })
      .end('<!doctype html><meta charset="utf-8"><body>');
  let file = resolve(root, "web-dist", "." + path);
  if (path.endsWith("/")) file = resolve(file, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      ...siteHeaders,
      "content-type": types[extname(file)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const APP = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

// ---- Drive with an existing vault ------------------------------------------
const dek = await newDataKey();
const id = crypto.randomUUID();
let keys = await setPassword(dek, id, PASSWORD);
keys = await setRecovery(dek, id, newRecoveryCode().bytes, keys);
const seedV = emptyVault(id);
const now = Date.now();
import { cleanDrawing, cleanRecordings } from "../src/crypto";
const remote = new Map<string, unknown>([
  ["v-0", await seal(seedV, dek, keys)],
]);
let next = 1;
const current = async (): Promise<Vault> => {
  assert.equal(remote.size, 1);
  return decrypt([...remote.values()][0] as any, dek);
};
// 1x1 green PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const context = await browser.newContext({
  ...devices["Pixel 7"],
  locale: "zh-TW",
} as any);
await context.addInitScript(() => {
  if (localStorage.getItem("veilTestSeeded")) return;
  localStorage.setItem("veilTestSeeded", "1");
  localStorage.setItem(
    "veilAccount:share-user",
    JSON.stringify({
      id: "share-user",
      email: "share@example.com",
      name: "Share",
      token: "synthetic-token",
      expires: Date.now() + 3600_000,
    }),
  );
  sessionStorage.setItem("veilActiveAccount", "share-user");
});
await context.route("**/config.json", (r) =>
  r.fulfill({ json: { clientId: "test-client.apps.googleusercontent.com" } }),
);
await context.route("https://accounts.google.com/**", (r) =>
  r.fulfill({ body: "google sign-in", contentType: "text/plain" }),
);
await context.route("https://www.googleapis.com/**", async (route) => {
  const req = route.request();
  const u = req.url();
  if (u.includes("/about?"))
    return route.fulfill({
      json: {
        user: {
          permissionId: "share-user",
          emailAddress: "share@example.com",
          displayName: "Share",
        },
      },
    });
  if (req.method() === "POST") {
    const json = (req.postData() || "")
      .split("Content-Type: application/json\r\n\r\n")[1]
      .split("\r\n--")[0];
    const fid = "v-" + next++;
    remote.set(fid, JSON.parse(json));
    return route.fulfill({ json: { id: fid } });
  }
  const fid = decodeURIComponent(u.split("/files/")[1]?.split("?")[0] || "");
  if (req.method() === "DELETE")
    return route.fulfill({ status: remote.delete(fid) ? 204 : 404, body: "" });
  if (u.includes("alt=media"))
    return route.fulfill({
      body: JSON.stringify(remote.get(fid)),
      contentType: "application/json",
    });
  return route.fulfill({
    json: { files: [...remote.keys()].map((id) => ({ id })) },
  });
});

const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
const unlock = async () => {
  await page.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "解鎖保險庫 →" }).click();
  await page.getByRole("tab", { name: /記事本/ }).click();
};
const memoOnDrive = async (title: string, ok: (m: any) => boolean) => {
  for (let i = 0; i < 80; i++) {
    try {
      const m = (await current()).memos.find(
        (x) => x.title === title && !x.deleted,
      );
      if (m && ok(m)) return m;
    } catch {}
    await page.waitForTimeout(200);
  }
  throw Error("not on Drive as expected: " + title);
};
const scrollToEnd = () =>
  page.evaluate(() => {
    const el = document.querySelector(".memoEdit") as HTMLElement;
    el.scrollTop = el.scrollHeight;
  });
// A finger drag on the page (Chromium touch input, like a phone).
async function drag(fromY: number, toY: number) {
  const x = 200;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: fromY }],
  });
  for (let i = 1; i <= 12; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: fromY + ((toY - fromY) * i) / 12 }],
    });
  const hint = (await page.locator(".flipHint").count())
    ? await page.locator(".flipHint").textContent()
    : null;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  return hint;
}
const pageLabel = () => page.locator(".memoEdit .pageBar span").textContent();
let cdp: any;
try {
  await page.goto(APP);
  cdp = await context.newCDPSession(page);
  await unlock();
  await page.getByRole("button", { name: "新增記事" }).click();
  await page.getByRole("textbox", { name: "標題" }).fill("多頁記事");
  const body = page.locator(".memoBody[contenteditable=true]");
  await body.click();
  await page.keyboard.type("第一頁內容");
  assert.equal(await pageLabel(), "第 1 頁，共 1 頁");

  // Bigger toolbar buttons for fingers.
  const tool = (await page
    .getByRole("button", { name: "粗體", exact: true })
    .boundingBox())!;
  assert(tool.height >= 48 && tool.width >= 50, "toolbar buttons are larger");

  // A light pull at the end only shows the hint.
  await scrollToEnd();
  const light = await drag(500, 420);
  assert.match(light || "", /繼續往上拉，新增第 2 頁/);
  await page.waitForTimeout(100);
  assert.equal(await pageLabel(), "第 1 頁，共 1 頁", "light pull keeps the page");
  assert.equal(await page.locator(".flipHint").count(), 0, "hint goes away");

  // A strong pull adds page 2 and opens it.
  await scrollToEnd();
  const strong = await drag(600, 250);
  assert.match(strong || "", /放開以新增第 2 頁/);
  await page.waitForFunction(() =>
    document.querySelector(".memoEdit .pageBar span")?.textContent?.includes("第 2 頁，共 2 頁"),
  );
  assert.equal((await body.textContent())!.trim(), "", "page 2 starts blank");
  await body.click();
  await page.keyboard.type("第二頁內容");
  // Handwriting on page 2.
  await page.getByRole("button", { name: "手寫", exact: true }).click();
  const ink = (await page.locator(".memoEdit .nbDrawing").boundingBox())!;
  await page.mouse.move(ink.x + 40, ink.y + 60);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++)
    await page.mouse.move(ink.x + 40 + i * 15, ink.y + 60 + i * 4);
  await page.mouse.up();
  await page.getByRole("button", { name: "回到文字", exact: true }).click();
  const two = await memoOnDrive(
    "多頁記事",
    (m) =>
      m.body.includes("第二頁內容") &&
      m.drawing.length === 1,
  );
  assert.deepEqual(
    two.body.split('<hr data-veil-page="">').map((x: string) => x.replace(/<[^>]*>/g, "")),
    ["第一頁內容", "第二頁內容"],
  );
  assert.equal(two.drawing[0].page, 1, "the stroke belongs to page 2");
  assert.deepEqual(cleanDrawing(two.drawing), two.drawing);
  if (shot) await page.screenshot({ path: resolve(shot, "pages-mobile.png") });

  // Turning past the last page adds a blank page; leaving it drops it.
  await scrollToEnd();
  await drag(600, 250);
  await page.waitForFunction(() =>
    document.querySelector(".memoEdit .pageBar span")?.textContent?.includes("第 3 頁，共 3 頁"),
  );
  await page.evaluate(() => ((document.querySelector(".memoEdit") as HTMLElement).scrollTop = 0));
  const back = await drag(250, 600);
  assert.match(back || "", /放開以翻到第 2 頁/);
  await page.waitForFunction(() =>
    document.querySelector(".memoEdit .pageBar span")?.textContent?.includes("第 2 頁，共 2 頁"),
  );
  assert.match((await body.textContent())!, /第二頁內容/);
  assert.equal(await page.locator(".memoEdit .nbDrawing path").count(), 1);
  await page.getByRole("button", { name: "上一頁" }).click();
  assert.match((await body.textContent())!, /第一頁內容/);
  assert.equal(
    await page.locator(".memoEdit .nbDrawing path").count(),
    0,
    "page 1 has no handwriting",
  );

  // Quick photo: the camera button opens the camera (capture) picker.
  const camera = page.locator('.memoEdit input[capture="environment"]');
  assert.equal(await camera.getAttribute("accept"), "image/*");
  await body.click();
  await page.keyboard.press("End");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "拍照插入" }).click(),
  ]);
  await chooser.setFiles({ name: "photo.png", mimeType: "image/png", buffer: PNG });
  await page.locator(".memoEdit img[data-veil-img]").waitFor();
  const withPhoto = await memoOnDrive(
    "多頁記事",
    (m) => m.images.length === 1,
  );
  assert.match(withPhoto.body.split('<hr data-veil-page="">')[0], /data-veil-img/);
  assert.equal(withPhoto.images[0].mime.startsWith("image/"), true);
  assert(!JSON.stringify(remote.values().next().value).includes(withPhoto.images[0].data.slice(0, 40)), "photo is encrypted on Drive");
  await page.getByRole("button", { name: "← 完成" }).click();

  // Reader: both pages, each with its own handwriting.
  await page.locator("main").getByText("多頁記事", { exact: true }).click();
  const reader = page.getByRole("dialog");
  await reader.locator(".readerPageLabel").nth(1).waitFor();
  assert.deepEqual(await reader.locator(".readerPageLabel").allTextContents(), [
    "第 1 頁，共 2 頁",
    "第 2 頁，共 2 頁",
  ]);
  assert.equal(await reader.locator(".inkArea").nth(1).locator(".nbDrawing path").count(), 1);
  assert.equal(await reader.locator(".inkArea").nth(0).locator(".nbDrawing path").count(), 0);
  await reader.locator(".inkArea").nth(0).locator("img[data-veil-img]").waitFor();

  // Deleting a page asks first; cancel keeps it.
  await reader.getByRole("button", { name: "編輯" }).click();
  await page.getByRole("button", { name: "下一頁" }).click();
  assert.equal(await pageLabel(), "第 2 頁，共 2 頁");
  await page.getByRole("button", { name: "刪除此頁" }).click();
  const ask = page.getByRole("dialog", { name: "刪除第 2 頁？" });
  await ask.waitFor();
  if (shot) await page.screenshot({ path: resolve(shot, "pages-delete-mobile.png") });
  await ask.getByRole("button", { name: "取消" }).click();
  assert.equal(await pageLabel(), "第 2 頁，共 2 頁", "cancel keeps the page");
  await page.getByRole("button", { name: "刪除此頁" }).click();
  await page
    .getByRole("dialog", { name: "刪除第 2 頁？" })
    .getByRole("button", { name: "刪除此頁" })
    .click();
  assert.equal(await pageLabel(), "第 1 頁，共 1 頁");
  assert.match((await body.textContent())!, /第一頁內容/);
  const one = await memoOnDrive(
    "多頁記事",
    (m) => !m.body.includes("data-veil-page") && m.drawing.length === 0,
  );
  assert(!one.body.includes("第二頁內容"));
  assert.equal(one.images.length, 1, "page 1's photo stays");
  assert(await page.getByRole("button", { name: "刪除此頁" }).isDisabled(), "the only page cannot be deleted");
  assert.deepEqual(errors, []);
  console.log(
    "PASS phone notebook pages: strong pull adds/turns pages, light pull does nothing, pull down goes back, handwriting per page, trailing blank page dropped, reader shows every page, delete page asks first, larger toolbar, camera quick photo encrypted",
  );
} finally {
  await browser.close();
  server.close();
}
