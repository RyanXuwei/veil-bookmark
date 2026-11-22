// Ruled-paper alignment: every text line (and pasted image) in the notebook
// must sit on the 32px grid, whatever formatting is used; pasted images are
// stored encrypted and survive reload.
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const shots = resolve(root, "../previews");
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/notebook-grid-test-" + Date.now()),
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
const SAMPLE = `<p>一般文字 Normal text</p>
<h1>標題一 Heading</h1>
<h2>標題二</h2>
<h3>標題三</h3>
<p>混合 <span style="font-size: x-large">特大字</span> 與 <span style="font-size: xx-large">超大字</span> 同一行</p>
<p><span style="font-size: xx-large">整行超大字 Large line</span></p>
<p><span style="font-size: small">小字</span> 上標 x<sup>2</sup> 下標 H<sub>2</sub>O</p>
<ul><li>項目一</li><li>項目二<ul><li>巢狀</li></ul></li></ol></ul>
<ol><li>編號</li></ol>
<blockquote>引用文字</blockquote>
<pre>程式碼 code()</pre>
<hr>
<p><b>粗體</b> <i>斜體</i> <u>底線</u> <s>刪除</s> <a href="https://example.com">連結</a></p>
<p>${"很長的段落會自動換行。".repeat(20)}</p>
<p>最後一行</p>`;

// Offset (px, unzoomed) of each visual line box from the grid line above it.
const misaligned = (page) =>
  page.evaluate(() => {
    const ed = document.querySelector(".nbEditor");
    const zoom = parseFloat(getComputedStyle(ed.closest(".nbPage")).zoom) || 1;
    const top = ed.getBoundingClientRect().top;
    const bad = [];
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      r.selectNodeContents(n);
      const block = n.parentElement.closest("p,h1,h2,h3,li,blockquote,pre,div");
      const lh = parseFloat(getComputedStyle(block).lineHeight);
      for (const rect of r.getClientRects()) {
        // Locate the line box: the block's line containing this rect.
        const bTop = block.getBoundingClientRect().top;
        // getComputedStyle is unzoomed; client rects are zoomed.
        const line = Math.floor(
          (rect.top + rect.height / 2 - bTop) / (lh * zoom),
        );
        const y = (bTop - top) / zoom + line * lh;
        const off = Math.round(y * 10) / 10;
        if (Math.abs(off - Math.round(off / 32) * 32) > 0.6)
          bad.push(`${n.textContent.slice(0, 12)} @${off}`);
      }
    }
    for (const b of ed.querySelectorAll(
      "p,h1,h2,h3,li,blockquote,pre,hr,img,ul,ol",
    )) {
      const rr = b.getBoundingClientRect();
      const t = (rr.top - top) / zoom,
        h = rr.height / zoom;
      if (b.tagName !== "LI" && b.tagName !== "UL" && b.tagName !== "OL")
        if (
          Math.abs(t - Math.round(t / 32) * 32) > 0.6 ||
          Math.abs(h - Math.round(h / 32) * 32) > 0.6
        )
          bad.push(`<${b.tagName}> top ${t.toFixed(1)} h ${h.toFixed(1)}`);
    }
    return bad;
  });

// page.waitForFunction does not await async predicates; poll explicitly.
let page;
async function poll(fn, arg) {
  for (let i = 0; i < 75; i++) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("timed out");
}
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const base = `chrome-extension://${id}/index.html`;
  page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}?popup`);
  await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "CREATE", password: "1234" }),
  );
  await page.goto(`${base}?notes`);
  const editor = page.locator(".nbEditor");
  await editor.waitFor();
  await editor.click();
  // Paste formatted content the way the user would.
  await page.evaluate((html) => {
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    dt.setData("text/plain", "x");
    document
      .querySelector(".nbEditor")
      .dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
  }, SAMPLE);
  await page.waitForTimeout(300);
  let bad = await misaligned(page);
  await page.screenshot({ path: resolve(shots, "50-notebook-grid.png") });
  console.log(bad.length ? "MISALIGNED:\n" + bad.join("\n") : "text grid OK");
  if (process.env.MEASURE_ONLY) process.exit(0);
  assert.deepEqual(bad, [], "all lines on the ruled grid");
  for (const z of [80, 150]) {
    await page.evaluate((z) => {
      const input = document.querySelector("input[type=range]");
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      ).set;
      set.call(input, String(z));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, z);
    await page.waitForTimeout(200);
    await page.locator(".nbZoom", { hasText: `${z}%` }).waitFor();
    assert.deepEqual(await misaligned(page), [], `grid at zoom ${z}%`);
  }
  await page
    .getByRole("button", { name: "100%", exact: true })
    .first()
    .click()
    .catch(() => {});
  await page.evaluate(() => {
    const input = document.querySelector("input[type=range]");
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set.call(input, "100");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator(".nbZoom", { hasText: "100%" }).waitFor();

  // Click on any ruled line of a new note and type there.
  await page.getByRole("button", { name: /新增/ }).first().click();
  await page.waitForFunction(
    () => document.querySelector(".nbEditor").innerText.trim() === "",
  );
  const box = await editor.boundingBox();
  await page.mouse.click(box.x + 120, box.y + 5 * 32 + 16);
  await page.keyboard.type("第六行");
  const row = await page.evaluate(() => {
    const ed = document.querySelector(".nbEditor");
    const ps = [...ed.querySelectorAll("p")];
    const p = ps.find((x) => x.textContent === "第六行");
    return {
      index: ps.indexOf(p),
      top: p.getBoundingClientRect().top - ed.getBoundingClientRect().top,
    };
  });
  assert.deepEqual(
    row,
    { index: 5, top: 160 },
    "typed on the clicked (6th) line",
  );
  // Clicking on a line that already has text keeps normal caret behaviour.
  await page.mouse.click(box.x + 300, box.y + 5 * 32 + 16);
  assert.equal(await page.locator(".nbEditor p").count(), 6);

  // Paste a picture (as from a screenshot tool): encrypted, on whole rules.
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(900, 500);
    const g = c.getContext("2d");
    g.fillStyle = "#3a7bd5";
    g.fillRect(0, 0, 900, 500);
    g.fillStyle = "#fff";
    g.fillRect(100, 100, 300, 200);
    const blob = await c.convertToBlob({ type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
    dt.setData("text/html", '<img src="https://example.com/tracker.png">');
    document
      .querySelector(".nbEditor")
      .dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
  });
  const img = page.locator(".nbEditor img[data-veil-img]");
  await img.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".nbEditor img[data-veil-img]").naturalWidth > 0,
  );
  const geo = await img.evaluate((el) => {
    const ed = document.querySelector(".nbEditor").getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      top: r.top - ed.top,
      h: r.height,
      w: r.width,
      src: el.src.slice(0, 15),
    };
  });
  assert.equal(geo.top % 32, 0, "picture starts on a rule");
  assert.equal(geo.h % 32, 0, "picture is a whole number of rules tall");
  assert(geo.w <= 634 && geo.w > 500, "picture fits the page width");
  assert.equal(geo.src, "data:image/webp");
  assert.deepEqual(
    await misaligned(page),
    [],
    "text after picture stays on the grid",
  );
  await page.keyboard.type("圖片後的文字");
  await page.screenshot({ path: resolve(shots, "51-notebook-picture.png") });
  // Saved encrypted, referenced from the HTML by ID only.
  const memo = await poll(async () => {
    const v = await chrome.runtime.sendMessage({ type: "LIST" });
    const m = v.data.memos.find(
      (x) => !x.deleted && x.body.includes("圖片後的文字"),
    );
    return m && m.images?.length === 1 ? m : null;
  });
  assert.match(memo.body, /<img data-veil-img="[\w-]+" alt="">/);
  assert(
    !memo.body.includes("data:image") && !memo.body.includes("example.com"),
  );
  assert.equal(memo.images[0].mime, "image/webp");
  assert.deepEqual([memo.images[0].w, memo.images[0].h], [900, 500]);
  const stored = JSON.stringify(
    await page.evaluate(() => chrome.storage.local.get(null)),
  );
  assert(
    !stored.includes(memo.images[0].data.slice(0, 40)),
    "picture encrypted at rest",
  );

  // Reload: picture comes back from the encrypted vault.
  await page.goto(`${base}?notes#${memo.id}`);
  await page.waitForFunction(
    () =>
      document.querySelector(".nbEditor img[data-veil-img]")?.naturalWidth > 0,
  );

  // Copying a picture inside the notebook and pasting it makes a new copy.
  // Resize through real pointer controls, including zoomed page coordinates.
  const resize = async (dx) => {
    await img.click();
    const handle = page.locator(".veilImageHandle.e");
    await handle.waitFor();
    const b = await handle.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
  };
  await resize(-200);
  const resized = +(await img.getAttribute("width"));
  assert(resized >= 32 && resized < 500, "drag changes persisted width");
  const ratio = await img.evaluate(
    (el) =>
      el.getBoundingClientRect().width / el.getBoundingClientRect().height,
  );
  assert(Math.abs(ratio - 900 / 500) < 0.01, "aspect ratio preserved");
  await page.getByRole("slider").fill("150");
  await resize(-60);
  const zoomed = +(await img.getAttribute("width"));
  assert(Math.abs(zoomed - (resized - 40)) <= 2, "zoom-aware resizing");
  await page.getByRole("slider").fill("100");
  await poll(
    async ({ id, width }) => {
      const v = await chrome.runtime.sendMessage({ type: "LIST" });
      return v.data.memos.find(
        (m) => m.id === id && m.body.includes(`width="${width}"`),
      );
    },
    { id: memo.id, width: zoomed },
  );
  await page.goto(`${base}?notes#${memo.id}`);
  await img.waitFor();
  assert.equal(
    +(await img.getAttribute("width")),
    zoomed,
    "size survives encrypted save/reload",
  );
  await img.click();
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator(".veilImageResize").count(),
    0,
    "Escape clears selection",
  );
  // Controls are never stored inside the document.
  assert.equal(await page.locator(".nbEditor .veilImageResize").count(), 0);
  await img.click();
  await page.locator(".veilImageHandle.e").waitFor();
  await page.screenshot({ path: resolve(shots, "image-resize-desktop.png") });

  await page.getByRole("button", { name: "自由模式", exact: true }).click();
  assert.equal(await img.getAttribute("data-veil-mode"), "free");
  const beforeFree = await img.boundingBox();
  const mover = page.getByRole("button", { name: "移動圖片", exact: true });
  const moveBox = await mover.boundingBox();
  await page.mouse.move(moveBox.x + moveBox.width / 2, moveBox.y + moveBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(moveBox.x + moveBox.width / 2 + 65, moveBox.y + moveBox.height / 2 + 90, { steps: 8 });
  await page.mouse.up();
  const afterFree = await img.boundingBox();
  assert(Math.abs(afterFree.x - beforeFree.x - 65) < 2, "free picture moves horizontally");
  assert(Math.abs(afterFree.y - beforeFree.y - 90) < 2, "free picture moves vertically without occupying text flow");
  const freeX = await img.getAttribute("data-veil-x");
  const freeY = await img.getAttribute("data-veil-y");
  const originalFreeWidth = +(await img.getAttribute("width"));
  await page.locator(".veilImageHandle.e").focus();
  await page.keyboard.press("ArrowLeft");
  assert(+(await img.getAttribute("width")) < originalFreeWidth, "free pictures can also be resized");
  await poll(async ({ id, y }) => {
    const v = await chrome.runtime.sendMessage({ type: "LIST" });
    return v.data.memos.find(m => m.id === id && m.body.includes(`data-veil-y="${y}"`));
  }, { id: memo.id, y: freeY });
  await page.goto(`${base}?notes#${memo.id}`);
  await img.waitFor();
  assert.equal(await img.getAttribute("data-veil-mode"), "free");
  assert.equal(await img.getAttribute("data-veil-x"), freeX);
  assert.equal(await img.getAttribute("data-veil-y"), freeY);
  await img.click();
  await page.locator(".veilImageModes").waitFor();
  await page.getByRole("button", { name: "移動圖片", exact: true }).hover();
  assert.equal(await page.getByRole("button", { name: "移動圖片", exact: true })
    .evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)", "move surface never covers the picture");
  await page.screenshot({ path: resolve(shots, "image-free-desktop.png") });
  await page.getByRole("button", { name: "圖文模式", exact: true }).click();
  assert.equal(await img.getAttribute("data-veil-mode"), null);
  assert.equal(await img.evaluate(el => getComputedStyle(el).position), "static");
  assert.equal(await page.locator(".nbEditor img[data-veil-img]").count(), 1, "mode switching keeps one picture");

  await page.evaluate(() => {
    const src = document.querySelector(".nbEditor img[data-veil-img]").src;
    const ed = document.querySelector(".nbEditor");
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    const dt = new DataTransfer();
    dt.setData(
      "text/html",
      `<p>copy</p><img data-veil-img="other" src="${src}"><img src="https://example.com/x.png">`,
    );
    ed.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".nbEditor img[data-veil-img]").length === 2,
  );
  assert.equal(
    await page.locator('.nbEditor img[src^="https:"]').count(),
    0,
    "remote pictures are never loaded",
  );
  const ids = await page.$$eval(".nbEditor img[data-veil-img]", (x) =>
    x.map((i) => i.dataset.veilImg),
  );
  assert.notEqual(ids[0], ids[1]);

  // Deleting pictures from the text removes their data on save.
  await page.evaluate(() => {
    for (const i of document.querySelectorAll(".nbEditor img[data-veil-img]"))
      i.remove();
    document
      .querySelector(".nbEditor")
      .dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await poll(async (id) => {
    const v = await chrome.runtime.sendMessage({ type: "LIST" });
    const m = v.data.memos.find((x) => x.id === id);
    return m && m.images.length === 0;
  }, memo.id);
  // Save as PDF: Chrome's print dialog with the note title as file name.
  await page.getByRole("textbox", { name: "文件標題" }).fill("旅行/計畫:2026");
  await page.keyboard.type("x");
  await page.locator(".nbEditor").click({ position: { x: 20, y: 10 } });
  await page.keyboard.type("PDF 內容");
  await page.evaluate(() => {
    window.__printed = [];
    window.print = () => window.__printed.push(document.title);
  });
  await page.getByRole("tab", { name: "檢視" }).click();
  await page.getByRole("button", { name: "列印／另存 PDF" }).click();
  await page.waitForFunction(() => window.__printed.length === 1);
  assert.equal(
    await page.evaluate(() => window.__printed[0]),
    "旅行 計畫 2026x",
  );
  await page.evaluate(() => dispatchEvent(new Event("afterprint")));
  assert.equal(await page.title(), await page.evaluate(() => document.title));
  assert.notEqual(
    await page.title(),
    "旅行 計畫 2026x",
    "title restored after printing",
  );
  await page.emulateMedia({ media: "print" });
  await page.screenshot({ path: resolve(shots, "55-notebook-pdf-print.png") });
  const pdf = await page.pdf({
    preferCSSPageSize: true,
    printBackground: true,
  });
  assert(pdf.subarray(0, 5).toString() === "%PDF-" && pdf.length > 5000);
  await page.emulateMedia({ media: "screen" });
  console.log(
    "PASS notebook grid (zoom 80/100/150%), click any line to type, picture paste/drop encrypted, reload, copy, delete; save as PDF",
  );
} finally {
  await context.close();
}
