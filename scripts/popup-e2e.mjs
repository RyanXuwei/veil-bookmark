import { chromium } from "playwright";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createServer } from "node:http";
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<meta charset="utf-8"><title>${req.url === "/normal" ? "一般網頁" : "測試中的網頁"}</title><h1>Synthetic fixture</h1>`,
  );
});
// Pick a port in 41000–41999: a random OS port can land on one of Chrome's
// blocked ports (e.g. 3659) and fail with ERR_UNSAFE_PORT.
for (let attempt = 0; ; attempt++) {
  const port = 41000 + Math.floor(Math.random() * 1000);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    break;
  } catch (e) {
    if (attempt > 20) throw e;
  }
}
const origin = `http://127.0.0.1:${server.address().port}`;
const root = resolve(import.meta.dirname, ".."),
  shots = resolve(root, "../previews");
await mkdir(shots, { recursive: true });
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/popup-test-" + Date.now()),
  {
    channel: "chromium",
    headless: true,
    args: [
      "--enable-unsafe-extension-debugging",
      "--lang=zh-TW",
      `--disable-extensions-except=${resolve(root, "dist")}`,
      `--load-extension=${resolve(root, "dist")}`,
    ],
    viewport: { width: 1100, height: 800 },
    locale: "zh-TW",
  },
);
try {
  let worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const normal = await context.newPage();
  await normal.goto(`chrome-extension://${id}/index.html?popup`);
  await normal.getByRole("heading", { name: "建立你的私密空間" }).waitFor();
  assert.equal(
    (
      await normal.evaluate(() =>
        chrome.runtime.sendMessage({ type: "STATUS" }),
      )
    ).data.exists,
    false,
  );
  await normal.close();
  const settings = await context.newPage();
  await settings.goto(`chrome://extensions/?id=${id}`);
  await settings.evaluate(() =>
    chrome.developerPrivate.updateProfileConfiguration({
      inDeveloperMode: true,
    }),
  );

  await settings.evaluate(
    (id) =>
      chrome.developerPrivate.updateExtensionConfiguration({
        extensionId: id,
        incognitoAccess: true,
      }),
    id,
  );
  const wake = await context.newPage();
  await wake.goto(`chrome-extension://${id}/index.html?notes`);
  for (let i = 0; i < 50; i++) {
    let found;
    for (const candidate of context.serviceWorkers())
      try {
        if (
          await candidate.evaluate(() =>
            chrome.extension.isAllowedIncognitoAccess(),
          )
        )
          found = candidate;
      } catch {}
    if (found) {
      worker = found;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(
    await worker.evaluate(() => chrome.extension.isAllowedIncognitoAccess()),
  );
  const cdp = await context.browser().newBrowserCDPSession();
  const normalContext = (await cdp.send("Target.getTargets")).targetInfos.find(
    (t) => t.url === wake.url(),
  ).browserContextId;
  await worker.evaluate(
    (url) => chrome.windows.create({ url, incognito: true }),
    `${origin}/current`,
  );
  let privateWorker = worker; // Spanning mode uses one writer for both modes.
  // Keep all website traffic synthetic, including inside the private BrowserContext.
  const privatePage = (await cdp.send("Target.getTargets")).targetInfos.find(
    (t) =>
      t.type === "page" &&
      t.browserContextId !== normalContext &&
      t.url === `${origin}/current`,
  );
  assert(privatePage);
  // Playwright doesn't expose toolbar popup pages; attach the actual popup CDP target.
  let sid,
    seq = 0;
  const pending = new Map();
  cdp.on("Target.receivedMessageFromTarget", (e) => {
    const m = JSON.parse(e.message);
    if (pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(Error(m.error.message)) : resolve(m.result);
    }
  });
  function send(method, params = {}, sessionOverride = sid) {
    const n = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(
          Error(
            "CDP timeout: " +
              method +
              " " +
              (params.expression || "").slice(0, 250),
          ),
        );
      }, 8000);
      pending.set(n, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      cdp
        .send("Target.sendMessageToTarget", {
          sessionId: sessionOverride,
          message: JSON.stringify({ id: n, method, params }),
        })
        .catch(reject);
    });
  }
  async function evaluate(fn, arg, asBoolean = false) {
    const r = await send("Runtime.evaluate", {
      expression: `${asBoolean ? "!!" : ""}(${fn.toString()})(${JSON.stringify(arg) ?? ""})`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails)
      throw Error(
        r.exceptionDetails.text +
          ": " +
          r.exceptionDetails.exception?.description,
      );
    return r.result.value;
  }
  async function wait(fn, arg) {
    for (let i = 0; i < 80; i++) {
      if (await evaluate(fn, arg, true)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    const page = await evaluate(() => document.body.innerText).catch(
      (e) => "(unreadable: " + e.message + ")",
    );
    throw Error(
      "Popup condition timed out: " + fn + "\n--- popup text ---\n" + page,
    );
  }
  async function click(text) {
    await wait(
      (text) =>
        Array.from(document.querySelectorAll("button")).some(
          (b) => b.textContent.trim() === text && !b.disabled,
        ),
      text,
    );
    await evaluate((text) => {
      const b = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === text,
      );
      if (!b) throw Error("Missing button " + text);
      b.click();
    }, text);
  }
  async function fill(selector, value) {
    await evaluate(
      ({ selector, value }) => {
        const el = document.querySelector(selector);
        if (!el) throw Error("Missing input " + selector);
        const proto =
          el.tagName === "TEXTAREA"
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      { selector, value },
    );
  }
  async function screenshot(name) {
    console.log("Screenshot", name);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(shots, name), Buffer.from(data, "base64"));
  }
  sid = (
    await cdp.send("Target.attachToTarget", {
      targetId: privatePage.targetId,
      flatten: false,
    })
  ).sessionId;
  const webSid = sid;
  await new Promise((r) => setTimeout(r, 300));
  await wait(() => document.title === "測試中的網頁");
  async function open(mode = "private") {
    console.log("Opening", mode);
    for (const t of (await cdp.send("Target.getTargets")).targetInfos.filter(
      (t) => t.url.endsWith("index.html?popup"),
    ))
      await cdp.send("Target.closeTarget", { targetId: t.targetId });
    // Wait until Chrome has really destroyed the old popup, so we never
    // re-attach to a closing document.
    for (let i = 0; i < 50; i++) {
      const left = (await cdp.send("Target.getTargets")).targetInfos.some((t) =>
        t.url.endsWith("index.html?popup"),
      );
      if (!left) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 150));
    const tabTarget = (
      await cdp.send("Target.getTargets", {
        filter: [{ type: "tab", exclude: false }],
      })
    ).targetInfos.find((t) =>
      mode === "private"
        ? t.browserContextId !== normalContext
        : t.browserContextId === normalContext && t.url === `${origin}/normal`,
    );
    assert(tabTarget);
    await cdp.send("Extensions.triggerAction", {
      id,
      targetId: tabTarget.targetId,
    });
    let target;
    for (let i = 0; i < 50; i++) {
      target = (await cdp.send("Target.getTargets")).targetInfos.find((t) =>
        t.url.endsWith("index.html?popup"),
      );
      if (target) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(target);
    sid = (
      await cdp.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: false,
      })
    ).sessionId;
    await wait(
      () =>
        document.querySelector("form") || document.querySelector(".quickList"),
    );
  }
  await open();
  assert.equal(
    (
      await privateWorker.evaluate(() =>
        chrome.runtime.getContexts({ contextTypes: ["POPUP"] }),
      )
    ).length,
    1,
  );
  assert.equal(
    await evaluate(() => chrome.extension.inIncognitoContext),
    false,
  );
  assert.equal(
    await evaluate(async () => {
      const source = await chrome.windows.getCurrent();
      const r = await chrome.runtime.sendMessage({
        type: "STATUS",
        sourceWindowId: source.id,
      });
      return r.data.incognito;
    }),
    true,
  );
  await screenshot("11-incognito-create.png");
  await fill("input[type=password]", "1234");
  await fill("label:nth-of-type(2) input[type=password]", "1234");
  // Creating requires acknowledging that a lost password cannot be recovered.
  assert.equal(
    await evaluate(
      () =>
        [...document.querySelectorAll("button")].find(
          (b) => b.textContent.trim() === "建立保險庫 →",
        ).disabled,
    ),
    true,
  );
  assert(await evaluate(() => !!document.querySelector(".pwWarning")));
  await evaluate(() => document.querySelector(".ackRow input").click());
  await screenshot("31-password-warning.png");
  await click("建立保險庫 →");
  // The recovery key is shown once and must be acknowledged.
  await wait(() => !!document.querySelector("[data-testid=recovery-code]"));
  const recoveryKey = await evaluate(
    () => document.querySelector("[data-testid=recovery-code]").dataset.code,
  );
  assert.match(recoveryKey, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  assert(
    !JSON.stringify(
      await worker.evaluate(() => chrome.storage.local.get(null)),
    ).includes(recoveryKey),
    "recovery key is never stored",
  );
  await screenshot("32-recovery-key.png");
  assert.equal(
    await evaluate(
      () =>
        [...document.querySelectorAll("button")].find(
          (b) => b.textContent.trim() === "完成",
        ).disabled,
    ),
    true,
  );
  await evaluate(() =>
    document.querySelector(".recoveryModal .ackRow input").click(),
  );
  await click("完成");
  await wait(() => !document.querySelector(".recoveryModal"));
  await wait(() => document.querySelector(".quickList"));
  assert(
    await evaluate(() => !document.querySelector(".recoveryBanner")),
    "no reminder once a recovery key exists",
  );
  await click("＋ 收藏目前網頁");
  await wait(() => document.querySelector("[role=dialog]"));
  assert.equal(
    await evaluate(() => document.querySelector("input[type=url]").value),
    `${origin}/current`,
  );
  assert.equal(
    await evaluate(
      () => document.querySelector("[role=dialog] label input").value,
    ),
    "測試中的網頁",
  );
  await fill("input[list=folders]", "常用網站");
  await new Promise((r) => setTimeout(r, 150));
  await screenshot("12-incognito-add.png");
  await click("加密儲存 →");
  await wait(() => !document.querySelector("[role=dialog]"));
  await evaluate(async () => {
    for (const entry of [
      {
        title: "私人閱讀清單",
        url: "https://example.com/reading",
        folder: "",
        tags: "閱讀",
        notes: "",
      },
      {
        title: "收藏的靈感",
        url: "https://example.com/ideas",
        folder: "靈感",
        tags: "設計",
        notes: "",
      },
    ]) {
      const r = await chrome.runtime.sendMessage({ type: "UPSERT", entry });
      if (!r.ok) throw Error(r.error);
    }
  });
  await send("Page.reload");
  await wait(() => document.querySelectorAll(".quickFolder").length === 2);
  await evaluate(() => document.querySelector(".quickFolder summary").click());
  await screenshot("13-incognito-bookmarks.png");
  const dimensions = await evaluate(() => ({
    w: innerWidth,
    h: innerHeight,
    scroll: document.documentElement.scrollWidth,
  }));
  assert(
    dimensions.w <= 400 &&
      dimensions.h <= 600 &&
      dimensions.scroll <= dimensions.w,
  );
  assert.equal(
    (await cdp.send("Target.getTargets")).targetInfos.filter((t) =>
      t.url.includes("/index.html?notes"),
    ).length,
    1,
  );
  await fill('input[aria-label="搜尋書籤"]', "閱讀");
  await wait(() => document.querySelectorAll(".quickLink").length === 1);
  await fill('input[aria-label="搜尋書籤"]', "");
  await wait(() =>
    document.querySelector('.quickMore[aria-label="更多操作：私人閱讀清單"]'),
  );
  await evaluate(() =>
    document
      .querySelector('.quickMore[aria-label="更多操作：私人閱讀清單"]')
      .click(),
  );
  await click("編輯");
  await wait(() => document.querySelector("[role=dialog]"));
  await fill("[role=dialog] label input", "私人閱讀更新");
  await click("加密儲存 →");
  await wait(() => !document.querySelector("[role=dialog]"));
  await wait(() =>
    document.querySelector('.quickMore[aria-label="更多操作：私人閱讀更新"]'),
  );
  await evaluate(() =>
    document
      .querySelector('.quickMore[aria-label="更多操作：私人閱讀更新"]')
      .click(),
  );
  await click("刪除");
  await wait(() => !!document.querySelector("[role=alertdialog]"));
  await evaluate(() =>
    [...document.querySelectorAll("[role=alertdialog] button")]
      .find((b) => b.textContent.trim() === "刪除")
      .click(),
  );
  await wait(() => !document.querySelector("[role=alertdialog]"));
  await wait(
    () =>
      !document.querySelector(
        '.quickMore[aria-label="更多操作：私人閱讀更新"]',
      ),
  );
  await click("上鎖");
  await wait(() => !!document.querySelector("input[type=password]"));
  await screenshot("14-incognito-locked.png");
  await evaluate(() => window.close());
  for (let i = 0; i < 30; i++) {
    if (
      !(
        await privateWorker.evaluate(() =>
          chrome.runtime.getContexts({ contextTypes: ["POPUP"] }),
        )
      ).length
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await open();
  await fill("input[type=password]", "1234");
  await click("解鎖保險庫 →");
  await wait(() => document.querySelector(".quickList"));
  await evaluate(() => document.querySelector(".quickFolder summary").click());
  await evaluate(async (url) => {
    const r = await chrome.runtime.sendMessage({ type: "LIST" });
    const entry = r.data.entries.find(
      (x) => x.folder === "常用網站" && !x.deleted,
    );
    await chrome.runtime.sendMessage({
      type: "UPSERT",
      entry: {
        ...entry,
        url,
        tags: entry.tags.join(","),
      },
    });
  }, `${origin}/opened`);
  await evaluate(() => document.querySelector(".quickLink").click());
  let opened = false;
  for (let i = 0; i < 40; i++) {
    opened = (await privateWorker.evaluate(() => chrome.tabs.query({}))).some(
      (t) => t.url === `${origin}/opened` && t.incognito,
    );
    if (opened) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(opened);
  const same = await wake.evaluate(async () => {
    const source = await chrome.windows.getCurrent();
    return chrome.runtime.sendMessage({
      type: "LIST",
      sourceWindowId: source.id,
    });
  });
  assert.equal(same.ok, true);
  assert.equal(same.data.entries.filter((x) => !x.deleted).length, 2);
  const normalWeb = await context.newPage();
  await normalWeb.goto(`${origin}/normal`);
  await normalWeb.bringToFront();
  await open("normal");
  assert.equal(
    await evaluate(async () => {
      const source = await chrome.windows.getCurrent();
      const r = await chrome.runtime.sendMessage({
        type: "STATUS",
        sourceWindowId: source.id,
      });
      return r.data.incognito;
    }),
    false,
  );
  await wait(() => !!document.querySelector(".quickList"));
  await screenshot("16-normal-bookmarks.png");
  await click("＋ 收藏目前網頁");
  await wait(() => !!document.querySelector("input[type=url]"));
  assert.equal(
    await evaluate(() => document.querySelector("input[type=url]").value),
    `${origin}/normal`,
  );
  await click("加密儲存 →");
  await wait(() => !document.querySelector("[role=dialog]"));
  await wait(
    () =>
      !!document.querySelector('.quickMore[aria-label="更多操作：一般網頁"]'),
  );
  await evaluate(() =>
    document
      .querySelector('.quickMore[aria-label="更多操作：一般網頁"]')
      .click(),
  );
  await click("新分頁開啟");
  let normalTabs = [];
  for (let i = 0; i < 40; i++) {
    normalTabs = (await cdp.send("Target.getTargets")).targetInfos.filter(
      (t) =>
        t.type === "page" &&
        t.browserContextId === normalContext &&
        t.url === `${origin}/normal`,
    );
    if (normalTabs.length >= 2) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(normalTabs.length >= 2);
  await open("private");
  await wait(
    () =>
      !!document.querySelector('.quickMore[aria-label="更多操作：一般網頁"]'),
  );
  await screenshot("17-private-shared-bookmarks.png");
  // Notes tab: lists notes and links to the full notebook page (tested in
  // scripts/notebook-e2e.mjs).
  await click("記事本");
  await wait(() => !!document.querySelector(".quickCapture"));
  assert(
    await evaluate(() =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent.trim() === "開啟記事本 ↗",
      ),
    ),
  );
  await screenshot("30-memo-list.png");
  // "Mobile": QR code that opens the mobile web app.
  await click("手機版");
  await wait(() => {
    const img = document.querySelector(".mobileQr img");
    return !!img && img.complete && img.naturalWidth > 0;
  });
  assert(
    await evaluate(() =>
      document
        .querySelector(".mobileQr a")
        .href.startsWith("https://veil-bookmark.bitingbox.win/"),
    ),
  );
  await screenshot("31-mobile-qr.png");
  await click("×");
  await click("書籤");
  await wait(() => !!document.querySelector(".quickList .quickLink"));
  async function setLanguage(code) {
    await evaluate((code) => {
      const el = document.querySelector("select.langSelect");
      if (!el) throw Error("Missing language select");
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      ).set.call(el, code);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, code);
  }
  const languageChecks = [
    ["en", "Lock", "Sync & backup", "18-lang-en.png"],
    ["ja", "ロック", "同期とバックアップ", "19-lang-ja.png"],
    ["ko", "잠금", "동기화 및 백업", "19b-lang-ko.png"],
    ["zh-CN", "上锁", "同步与备份", "20-lang-zh-cn.png"],
  ];
  for (const [code, lockLabel, syncLabel, shot] of languageChecks) {
    await setLanguage(code);
    await wait(
      ([lockLabel, syncLabel]) =>
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent.trim() === lockLabel,
        ) &&
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent.trim() === syncLabel,
        ),
      [lockLabel, syncLabel],
    );
    assert.equal(
      await evaluate(() => document.documentElement.lang),
      code === "zh-CN" ? "zh-Hans" : code,
    );
    await screenshot(shot);
  }
  // The choice persists: reopen the popup and it is still Simplified Chinese.
  await open("private");
  await wait(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent.trim() === "上锁",
    ),
  );
  assert.equal(
    await evaluate(() => document.querySelector("select.langSelect").value),
    "zh-CN",
  );
  await setLanguage("zh-TW");
  await wait(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent.trim() === "上鎖",
    ),
  );
  await click("上鎖");
  await wait(() => !!document.querySelector("input[type=password]"));
  const locked = await wake.evaluate(() =>
    chrome.runtime.sendMessage({ type: "LIST" }),
  );
  assert.equal(locked.ok, false);
  assert(
    !JSON.stringify(
      await worker.evaluate(() => chrome.storage.local.get("vault")),
    ).includes("一般網頁"),
  );
  // Forgot password: reset it with the recovery key from vault creation.
  await click("忘記主密碼？使用救援金鑰");
  await wait(() => !!document.querySelector(".recoveryInput"));
  await fill(".recoveryInput", recoveryKey.toLowerCase());
  await fill(".recoverForm label:nth-of-type(2) input", "5678");
  await fill(".recoverForm label:nth-of-type(3) input", "5678");
  await screenshot("33-forgot-password.png");
  await click("重設主密碼 →");
  await wait(() => !!document.querySelector("[data-testid=recovery-code]"));
  const newKey = await evaluate(
    () => document.querySelector("[data-testid=recovery-code]").dataset.code,
  );
  assert.notEqual(newKey, recoveryKey, "a used recovery key is replaced");
  await evaluate(() =>
    document.querySelector(".recoveryModal .ackRow input").click(),
  );
  await click("完成");
  await wait(() => !!document.querySelector(".quickList .quickLink"));
  await click("上鎖");
  await wait(() => !!document.querySelector("input[type=password]"));
  await fill("input[type=password]", "5678");
  await click("解鎖保險庫 →");
  await wait(() => !!document.querySelector(".quickList .quickLink"));
  console.log(
    "PASS: recovery key shown once, not stored, forgot-password reset with new password and rotated key; password ack gate; notes tab links to Notes; mobile QR code; language switch zh-TW/zh-CN/en/ja/ko with persistence; normal and private native toolbar popups; shared vault/session; current-mode navigation; normal and private capture; shared lock; encrypted persistence",
    dimensions,
    "; no automatic management tab; activeTab current-page capture; 4-char create/unlock; folders/search/edit/delete; lock/reopen; opening bookmark.",
  );
} finally {
  await context.close();
  await new Promise((r) => server.close(r));
}
