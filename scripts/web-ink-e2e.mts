// Handwriting and voice notes on the phone: draw with a finger/pen, erase,
// undo, record a voice note (fake microphone), save; Drive gets the
// extension's formats (cleanDrawing / cleanRecordings accept them); the reader
// shows the drawing and plays the recording; editing text keeps both.
// Run: npm run build:web && npx tsx scripts/web-ink-e2e.mts [shots]
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
async function stroke(x0: number, y0: number, dx: number, dy: number) {
  const box = (await page.locator(".memoEdit .nbDrawing").boundingBox())!;
  await page.mouse.move(box.x + x0, box.y + y0);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++)
    await page.mouse.move(
      box.x + x0 + (dx * i) / 10,
      box.y + y0 + (dy * i) / 10,
    );
  await page.mouse.up();
}
try {
  await page.goto(APP);
  await unlock();
  await page.getByRole("button", { name: "新增記事" }).click();
  await page.getByRole("textbox", { name: "標題" }).fill("手寫錄音");
  // Draw two strokes, undo one, draw another in red, erase nothing yet.
  await page.getByRole("button", { name: "手寫" }).click();
  await stroke(40, 60, 150, 0);
  await stroke(40, 120, 150, 40);
  assert.equal(await page.locator(".memoEdit .nbDrawing path").count(), 2);
  await page.getByRole("button", { name: "復原最後一筆" }).click();
  assert.equal(await page.locator(".memoEdit .nbDrawing path").count(), 1);
  await page.getByRole("button", { name: /筆色 #c0392b/ }).click();
  await stroke(40, 200, 120, 60);
  assert.equal(await page.locator(".memoEdit .nbDrawing path").count(), 2);
  // Eraser removes the stroke it touches.
  await page.getByRole("button", { name: "橡皮擦" }).click();
  const box = (await page.locator(".memoEdit .nbDrawing").boundingBox())!;
  await page.mouse.click(box.x + 100, box.y + 60);
  assert.equal(await page.locator(".memoEdit .nbDrawing path").count(), 1);
  await page.getByRole("button", { name: "回到文字" }).click();
  // Record about two seconds.
  // Microphone refused (as after tapping "Don't allow"; headless Chromium
  // cannot show the real prompt, so the browser's answer is simulated): the
  // help explains how to allow it; after allowing, 重試 records.
  await page.evaluate(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    (window as any).__denyMic = true;
    navigator.mediaDevices.getUserMedia = (c) =>
      (window as any).__denyMic
        ? Promise.reject(
            new DOMException("Permission denied", "NotAllowedError"),
          )
        : real(c);
  });
  await page.getByRole("button", { name: "開始錄音" }).click();
  const help = page.getByRole("alertdialog", { name: "沒有麥克風權限。" });
  await help.waitFor();
  assert(
    (await help.textContent())!.includes("Android"),
    "help for this phone",
  );
  if (shot)
    await page.screenshot({ path: resolve(shot, "phone-mic-help.png") });
  await context.grantPermissions(["microphone"]);
  await page.evaluate(() => ((window as any).__denyMic = false));

  await help.getByRole("button", { name: "重試" }).click();
  await help.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "停止錄音" }).waitFor();
  await page.waitForTimeout(2300);
  await page.getByRole("button", { name: "停止錄音" }).click();
  await page.locator(".memoEdit .nbAudioSticker audio").waitFor();
  if (shot)
    await page.screenshot({ path: resolve(shot, "phone-ink-edit.png") });
  const saved = await memoOnDrive(
    "手寫錄音",
    (m) => m.drawing.length === 1 && m.recordings.length === 1,
  );
  assert.equal(saved.drawing[0].color, "#c0392b");
  assert.deepEqual(
    cleanDrawing(saved.drawing),
    saved.drawing,
    "the extension accepts the drawing",
  );
  assert.equal(
    cleanRecordings(saved.recordings).length,
    1,
    "the extension accepts the recording",
  );
  assert.match(saved.recordings[0].mime, /^audio\/(webm|mp4)/);
  assert(saved.recordings[0].duration >= 1);
  await page.getByRole("button", { name: "← 完成" }).click();

  // Reader: drawing shown, recording playable.
  await page.locator("main").getByText("手寫錄音", { exact: true }).click();
  const reader = page.getByRole("dialog");
  await reader.locator(".nbDrawing path").waitFor();
  // The player gets the recording as a blob: URL, which the page's security
  // policy must allow for media (checked through a CSP report listener).
  const blocked: string[] = [];
  page.on(
    "console",
    (m) =>
      /media-src|Refused to load media/.test(m.text()) &&
      blocked.push(m.text()),
  );
  await page.waitForFunction(() =>
    (
      document.querySelector(
        ".reader .nbAudioSticker audio",
      ) as HTMLAudioElement | null
    )?.src.startsWith("blob:"),
  );
  const src = await reader.locator(".nbAudioSticker audio").getAttribute("src");
  assert.match(src || "", /^blob:/);
  const allowed = await page.evaluate(() =>
    document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute("content")!
      .includes("media-src 'self' blob:"),
  );
  assert(allowed, "media from blob: URLs is allowed");
  if (shot)
    await page.screenshot({ path: resolve(shot, "phone-ink-read.png") });

  // Editing the text keeps the drawing and the recording.
  await reader.getByRole("button", { name: "編輯" }).click();
  await page
    .locator(".memoBody[contenteditable=true]")
    .click({ position: { x: 10, y: 8 } });
  await page.keyboard.type("補一句文字");
  await memoOnDrive(
    "手寫錄音",
    (m) =>
      m.body.includes("補一句文字") &&
      m.drawing.length === 1 &&
      m.recordings.length === 1,
  );
  assert.deepEqual(blocked, [], "no media blocked");
  // Insert a landscape image and resize with touch pointer events.
  const imageData = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 300;
    canvas.getContext("2d")!.fillRect(0, 0, 600, 300);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('.memoEdit input[type="file"]').setInputFiles({
    name: "resize.png",
    mimeType: "image/png",
    buffer: Buffer.from(imageData, "base64"),
  });
  const picture = page.locator(".memoEdit img[data-veil-img]");
  await picture.waitFor();
  const initialPicture = (await picture.boundingBox())!;
  await picture.tap({ position: { x: initialPicture.width - 12, y: initialPicture.height - 12 } });
  const handle = page.locator(".veilImageHandle.e");
  await handle.waitFor();
  const box2 = (await handle.boundingBox())!;
  const x = box2.x + box2.width / 2,
    y = box2.y + box2.height / 2;
  // Dispatch through Chromium's touch input, preserving native pointer capture.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: x - 100, y }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const width = +(await picture.getAttribute("width"))!;
  assert(width >= 32 && width < 350, "touch drag changes image width");
  const geometry = await picture.boundingBox();
  assert(
    Math.abs(geometry!.width / geometry!.height - 2) < 0.02,
    "touch resize keeps aspect ratio",
  );
  await memoOnDrive(
    "手寫錄音",
    (m) => m.body.includes(`width="${width}"`) && m.images.length === 1,
  );
  await page.getByRole("button", { name: "← 完成" }).click();
  await page.locator("main").getByText("手寫錄音", { exact: true }).click();
  await page.locator(".reader img[data-veil-img]").waitFor();
  assert.equal(
    +(await page.locator(".reader img[data-veil-img]").getAttribute("width"))!,
    width,
  );
  await page.getByRole("button", { name: "編輯", exact: true }).click();
  assert.equal(
    +(await page
      .locator(".memoEdit img[data-veil-img]")
      .getAttribute("width"))!,
    width,
    "image width survives encrypted sync and reopening",
  );
  const freePicture = page.locator('.memoEdit img[data-veil-img]');
  const freeBox = (await freePicture.boundingBox())!;
  await freePicture.tap({ position: { x: freeBox.width - 10, y: 10 } });
  await page.getByRole("button", { name: "自由模式", exact: true }).click();
  const movePicture = (await page.getByRole("button", { name: "移動圖片", exact: true }).boundingBox())!;
  const mx = movePicture.x + movePicture.width - 15, my = movePicture.y + 15;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: mx, y: my }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: mx - 25, y: my + 90 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const freeY = await freePicture.getAttribute("data-veil-y");
  assert(Number(freeY) > 0, "touch moves free picture");
  await page.getByRole("button", { name: "手寫", exact: true }).click();
  assert.equal(await page.locator(".veilImageResize").count(), 0, "picture controls leave the pen layer available");
  const onPhoto = (await freePicture.boundingBox())!;
  const px = onPhoto.x + onPhoto.width - 40, py = onPhoto.y + 20;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: px, y: py }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: px + 20, y: py + 25 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.equal(await page.locator(".memoEdit .nbDrawing path").count(), 2, "pen can draw over the free image");
  await page.getByRole("button", { name: "回到文字", exact: true }).click();
  await memoOnDrive("手寫錄音", m => m.body.includes('data-veil-mode="free"') && m.body.includes(`data-veil-y="${freeY}"`));
  await page.getByRole("button", { name: "← 完成" }).click();
  await page.locator("main").getByText("手寫錄音", { exact: true }).click();
  const readPicture = page.locator('.reader img[data-veil-img]');
  await readPicture.waitFor();
  assert.equal(await readPicture.getAttribute('data-veil-y'), freeY);
  assert.equal(await readPicture.evaluate(el => getComputedStyle(el).position), "absolute");
  if (shot) await page.screenshot({ path: resolve(shot, "image-free-mobile.png") });
  await page.getByRole("button", { name: "編輯", exact: true }).click();
  const again = page.locator('.memoEdit img[data-veil-img]');
  const ab = (await again.boundingBox())!;
  await again.tap({ position: { x: ab.width - 12, y: 12 } });
  await page.getByRole("button", { name: "圖文模式", exact: true }).click();
  assert.equal(await again.getAttribute("data-veil-mode"), null);
  if (shot)
    await page.screenshot({ path: resolve(shot, "image-resize-mobile.png") });
  assert.deepEqual(errors, []);
  console.log(
    "PASS phone handwriting and voice notes: microphone allowed by the site headers, refused permission explained with a retry, draw, undo, colour, erase, record, saved in the extension's formats, shown and playable in the reader, kept when the text is edited",
  );
} finally {
  await browser.close();
  server.close();
}
