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
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  if (req.method !== "GET") return res.writeHead(405).end(); // like static hosting
  // A blank page (no CSP) to send the POST from, as Android's share sheet does.
  if (path === "/__share")
    return res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><meta charset="utf-8"><body>');
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
const APP = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

// ---- Drive with an existing vault ------------------------------------------
const dek = await newDataKey();
const id = crypto.randomUUID();
let keys = await setPassword(dek, id, PASSWORD);
keys = await setRecovery(dek, id, newRecoveryCode().bytes, keys);
const seedV = emptyVault(id);
const now = Date.now();
import { cleanDrawing, cleanRecordings } from "../src/crypto";
const remote = new Map<string, unknown>([["v-0", await seal(seedV, dek, keys)]]);
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
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const context = await browser.newContext({ ...devices["Pixel 7"], locale: "zh-TW" } as any);
await context.grantPermissions(["microphone"]);
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
      json: { user: { permissionId: "share-user", emailAddress: "share@example.com", displayName: "Share" } },
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
    return route.fulfill({ body: JSON.stringify(remote.get(fid)), contentType: "application/json" });
  return route.fulfill({ json: { files: [...remote.keys()].map((id) => ({ id })) } });
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
      const m = (await current()).memos.find((x) => x.title === title && !x.deleted);
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
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + x0 + (dx * i) / 10, box.y + y0 + (dy * i) / 10);
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
  await page.getByRole("button", { name: "開始錄音" }).click();
  await page.getByRole("button", { name: "停止錄音" }).waitFor();
  await page.waitForTimeout(2300);
  await page.getByRole("button", { name: "停止錄音" }).click();
  await page.locator(".memoEdit .nbAudioSticker audio").waitFor();
  if (shot) await page.screenshot({ path: resolve(shot, "phone-ink-edit.png") });
  const saved = await memoOnDrive("手寫錄音", (m) => m.drawing.length === 1 && m.recordings.length === 1);
  assert.equal(saved.drawing[0].color, "#c0392b");
  assert.deepEqual(cleanDrawing(saved.drawing), saved.drawing, "the extension accepts the drawing");
  assert.equal(cleanRecordings(saved.recordings).length, 1, "the extension accepts the recording");
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
  page.on("console", (m) => /media-src|Refused to load media/.test(m.text()) && blocked.push(m.text()));
  await page.waitForFunction(() =>
    (document.querySelector(".reader .nbAudioSticker audio") as HTMLAudioElement | null)?.src.startsWith("blob:"),
  );
  const src = await reader.locator(".nbAudioSticker audio").getAttribute("src");
  assert.match(src || "", /^blob:/);
  const allowed = await page.evaluate(
    () =>
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')!
        .getAttribute("content")!
        .includes("media-src 'self' blob:"),
  );
  assert(allowed, "media from blob: URLs is allowed");
  if (shot) await page.screenshot({ path: resolve(shot, "phone-ink-read.png") });

  // Editing the text keeps the drawing and the recording.
  await reader.getByRole("button", { name: "編輯" }).click();
  await page.locator(".memoBody[contenteditable=true]").click({ position: { x: 10, y: 8 } });
  await page.keyboard.type("補一句文字");
  await memoOnDrive("手寫錄音", (m) => m.body.includes("補一句文字") && m.drawing.length === 1 && m.recordings.length === 1);
  assert.deepEqual(blocked, [], "no media blocked");
  assert.deepEqual(errors, []);
  console.log("PASS phone handwriting and voice notes: draw, undo, colour, erase, record, saved in the extension's formats, shown and playable in the reader, kept when the text is edited");
} finally {
  await browser.close();
  server.close();
}
