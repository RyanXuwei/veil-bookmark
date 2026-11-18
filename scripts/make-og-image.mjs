// Share-preview image (Open Graph, 1200x630) for the mobile web app and the
// home page. Run: node scripts/make-og-image.mjs
// Writes web/public/og-image.png and docs/og-image.png.
import { chromium } from "playwright";
import { readFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const icon = (await readFile(resolve(root, "public/icons/icon.svg"))).toString("base64");
const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;overflow:hidden}
body{position:relative;background:radial-gradient(120% 140% at 85% 20%,#3e6b57 0%,#244a3b 45%,#1a3a2e 100%);
  color:#f3f0de;font-family:"Microsoft JhengHei","Noto Sans TC","PingFang TC","Segoe UI",sans-serif}
.ring{position:absolute;border:1.5px solid #f3f0de1c;border-radius:50%}
.r1{width:760px;height:760px;right:-170px;top:-140px}
.r2{width:560px;height:560px;right:-70px;top:-40px}
.r3{width:360px;height:360px;right:30px;top:60px;border-color:#f3f0de26}
.icon{position:absolute;right:118px;top:148px;width:236px;height:236px;filter:drop-shadow(0 24px 36px #0b221830)}
.copy{position:absolute;left:84px;top:96px;width:640px}
.eyebrow{font:600 22px/1 "Segoe UI",sans-serif;letter-spacing:6px;color:#cabf94;margin-bottom:26px}
h1{font:700 86px/1.05 "Segoe UI",sans-serif;letter-spacing:-2px}
h2{margin-top:26px;font-weight:700;font-size:46px;line-height:1.3;letter-spacing:1px}
.chips{display:flex;gap:14px;margin-top:38px;flex-wrap:wrap}
.chip{padding:10px 20px;border-radius:999px;background:#f3f0de1a;border:1.5px solid #f3f0de33;font-size:24px;font-weight:600}
.url{position:absolute;left:84px;bottom:52px;font:500 24px/1 "Segoe UI",sans-serif;color:#c3d0bc;letter-spacing:.5px}
.by{position:absolute;right:84px;bottom:52px;font:500 22px/1 "Segoe UI",sans-serif;color:#9fb3a6}
</style>
<div class="ring r1"></div><div class="ring r2"></div><div class="ring r3"></div>
<img class="icon" src="data:image/svg+xml;base64,${icon}">
<div class="copy">
  <div class="eyebrow">PRIVATE BY DESIGN</div>
  <h1>Veil Bookmark</h1>
  <h2>只有你打得開的<br>私密書籤與記事本</h2>
  <div class="chips"><span class="chip">AES-256 加密</span><span class="chip">無伺服器</span><span class="chip">Face ID 解鎖</span></div>
</div>
<div class="url">veil-bookmark.bitingbox.win</div>
<div class="by">BitingBox Studio</div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  const out = resolve(root, "web/public/og-image.png");
  await page.screenshot({ path: out, type: "png" });
  await copyFile(out, resolve(root, "docs/og-image.png"));
  console.log("Wrote og-image.png (1200x630)");
} finally {
  await browser.close();
}
