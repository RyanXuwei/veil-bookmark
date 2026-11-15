import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/notepad-test-" + Date.now()),
  {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${resolve(root, "dist")}`,
      `--load-extension=${resolve(root, "dist")}`,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
);
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host,
    base = `chrome-extension://${id}/index.html`;
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const s = await original(constraints);
      window.capturedStreams = [...(window.capturedStreams || []), s];
      return s;
    };
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(base + "?popup");
  await page.evaluate(async () => {
    await chrome.storage.local.set({ uiLang: "zh-TW" });
    const r = await chrome.runtime.sendMessage({
      type: "CREATE",
      password: "1234",
    });
    if (!r.ok) throw Error(r.error);
  });
  await page.goto(base + "?notes");
  await page.locator(".nbEditor").waitFor();
  assert.equal(
    await page
      .locator(".nbPage")
      .evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(255, 244, 190)",
  );
  assert.match(
    await page
      .locator(".nbEditor")
      .evaluate((e) => getComputedStyle(e).backgroundImage),
    /svg/,
  );
  await page.getByRole("textbox", { name: "文件標題" }).fill("便簽功能示範");
  await page
    .locator(".nbEditor")
    .fill("把靈感留在這裡。\n可以寫字，也可以畫圖。");
  await page.getByRole("button", { name: "鉛筆", exact: true }).click();
  let box = await page.locator(".nbDrawing").boundingBox();
  await page.mouse.move(box.x + 160, box.y + 230);
  await page.mouse.down();
  for (let i = 0; i <= 25; i++)
    await page.mouse.move(
      box.x + 160 + i * 8,
      box.y + 230 + Math.sin(i / 3) * 35,
    );
  await page.mouse.up();
  assert.equal(await page.locator(".nbDrawing path").count(), 1);
  await page.getByRole("button", { name: "復原筆畫" }).click();
  assert.equal(await page.locator(".nbDrawing path").count(), 0);
  await page.mouse.move(box.x + 180, box.y + 260);
  await page.mouse.down();
  await page.mouse.move(box.x + 330, box.y + 300, { steps: 15 });
  await page.mouse.up();
  await page.getByRole("button", { name: "橡皮擦", exact: true }).click();
  await page.mouse.click(box.x + 250, box.y + 280);
  assert.equal(await page.locator(".nbDrawing path").count(), 0);
  await page.getByRole("button", { name: "鉛筆", exact: true }).click();
  await page.mouse.move(box.x + 160, box.y + 230);
  await page.mouse.down();
  for (let i = 0; i <= 25; i++)
    await page.mouse.move(
      box.x + 160 + i * 8,
      box.y + 230 + Math.sin(i / 3) * 35,
    );
  await page.mouse.up();
  await page
    .getByRole("button", { name: "紙張顏色 #dfeef4", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector(".nbSave").classList.contains("saved"),
  );
  await page.reload();
  await page.locator(".nbDrawing path").waitFor();
  assert.equal(
    await page
      .locator(".nbPage")
      .evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(223, 238, 244)",
  );
  await page.getByRole("button", { name: "開始錄音" }).click();
  await page.getByRole("button", { name: "停止錄音" }).waitFor();
  await page.waitForTimeout(1300);
  await page.getByRole("button", { name: "暫停錄音" }).click();
  await page.getByRole("button", { name: "繼續錄音" }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "停止錄音" }).click();
  await page.locator(".nbPlaceAudio").waitFor();
  box = await page.locator(".nbPlaceAudio").boundingBox();
  await page.mouse.click(box.x + 360, box.y + 330);
  await page.locator(".nbAudioSticker").waitFor();
  await page.waitForFunction(() =>
    document.querySelector(".nbSave").classList.contains("saved"),
  );
  const stored = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "LIST" });
    return r.data.memos.find((m) => !m.deleted);
  });
  assert.equal(stored.recordings.length, 1);
  assert(stored.recordings[0].data.length > 100);
  assert(stored.drawing.length === 1);
  const local = await worker.evaluate(() => chrome.storage.local.get(null));
  assert(!JSON.stringify(local).includes(stored.recordings[0].data));
  const handle = await page.locator(".nbAudioHandle").boundingBox();
  await page.mouse.move(handle.x + 30, handle.y + 8);
  await page.mouse.down();
  await page.mouse.move(handle.x + 90, handle.y + 70, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() =>
    document.querySelector(".nbSave").classList.contains("saved"),
  );
  await page.reload();
  await page.locator(".nbAudioSticker audio").waitFor();
  const moved = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "LIST" });
    return r.data.memos.find((m) => !m.deleted).recordings[0];
  });
  assert(moved.x > stored.recordings[0].x);
  assert(moved.y > stored.recordings[0].y);
  await page.locator("audio").evaluate(async (a) => {
    await a.play();
  });
  assert.equal(await page.locator("audio").evaluate((a) => a.paused), false);
  await page
    .getByRole("button", { name: "紙張顏色 #fff4be", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector(".nbSave").classList.contains("saved"),
  );
  await page.screenshot({
    path: resolve(root, "../previews/40-notepad-recording.png"),
  });
  await page.setViewportSize({ width: 600, height: 800 });
  assert(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <= 600,
  );
  await page.screenshot({
    path: resolve(root, "../previews/41-notepad-narrow.png"),
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: "＋ 新增" }).click();
  assert.equal(await page.locator(".nbDrawing path").count(), 0);
  assert.equal(await page.locator(".nbAudioSticker").count(), 0);
  assert.equal(
    await page
      .locator(".nbPage")
      .evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(255, 244, 190)",
  );
  await page.locator(".nbNav li button").first().click();
  await page.locator(".nbAudioSticker").waitFor();
  await page.getByRole("button", { name: "開始錄音" }).click();
  await page.getByRole("button", { name: "停止錄音" }).waitFor();
  await page.waitForFunction(() =>
    window.capturedStreams?.some((s) =>
      s.getTracks().some((t) => t.readyState === "live"),
    ),
  );
  await page.getByRole("button", { name: /上鎖/ }).click();
  await page.locator(".nbLockCard").waitFor();
  assert.equal(await page.locator("audio").count(), 0);
  assert.equal(await page.locator(".nbDrawing path").count(), 0);
  assert(
    await page.evaluate(() =>
      window.capturedStreams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ),
    ),
  );
  console.log(
    "PASS notepad: dashed paper/default and saved color; freehand/undo/eraser; real MediaRecorder with synthetic microphone; pause/resume, arbitrary placement/drag, encrypted audio, reload/playback, note isolation, narrow layout, lock wipe.",
  );
} finally {
  await context.close();
}
