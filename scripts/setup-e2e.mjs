// Google Drive connect guide (index.html?setup) with the built-in OAuth client:
// one-click steps, no Google Cloud setup, entry points, layout and i18n.
// Never starts a real Google sign-in and never contacts external hosts.
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const shots = resolve(root, "../previews");
const context = await chromium.launchPersistentContext(
  resolve(root, "../../work/setup-test-" + Date.now()),
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
const external = [];
context.on("request", (r) => {
  if (!/^(chrome-extension|data|about|chrome):/.test(r.url()))
    external.push(r.url());
});
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  assert.equal(id, "edehlgkopbgmnopdaepadcopfnkgcpab");
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.match(manifest.oauth2.client_id, /\.apps\.googleusercontent\.com$/);
  assert.deepEqual(manifest.oauth2.scopes, [
    "https://www.googleapis.com/auth/drive.appdata",
  ]);

  // Fresh install: "restore from Drive" first checks Drive (no password
  // needed yet), and the welcome screen offers that check up front.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 600 });
  await popup.goto(`chrome-extension://${id}/index.html?popup`);
  await popup.getByRole("heading", { name: "建立你的私密空間" }).waitFor();
  assert(
    await popup
      .getByRole("button", { name: "從 Google Drive 還原" })
      .isEnabled(),
  );
  await popup.locator(".driveCheck").waitFor();

  // Guide while no vault exists.
  const guide = await context.newPage();
  await guide.setViewportSize({ width: 1100, height: 1300 });
  await guide.goto(`chrome-extension://${id}/index.html?setup`);
  await guide.getByRole("heading", { name: "連接 Google Drive", exact: true }).waitFor();
  await guide.getByText("尚未連接", { exact: true }).waitFor();
  await guide.getByText("這台電腦還沒有保險庫", { exact: false }).waitFor();
  assert.equal(
    await guide.locator(".clientForm").count(),
    0,
    "no client ID form",
  );
  assert.equal(await guide.locator(".copyField").count(), 0, "no redirect URI");
  const connect = guide.getByRole("button", { name: "連接 Google Drive", exact: true });
  assert(await connect.isDisabled(), "connect needs an unlocked vault");

  // Unlocked: the connect button becomes available (not clicked: no real sign-in).
  await guide.evaluate(() =>
    chrome.runtime.sendMessage({ type: "CREATE", password: "1234" }),
  );
  await guide.reload();
  await guide.getByText("✓ 已解鎖").waitFor();
  assert(!(await connect.isDisabled()));
  const links = await guide
    .locator("a.extLink")
    .evaluateAll((a) => a.map((x) => x.href));
  assert.deepEqual(links, ["https://myaccount.google.com/permissions"]);
  await guide.screenshot({
    path: resolve(shots, "24-drive-setup.png"),
    fullPage: true,
  });

  // Sync & backup panel points to the one-click flow.
  await popup.reload();
  await popup.getByRole("button", { name: "同步與備份", exact: true }).click();
  await popup.getByText("一鍵連接", { exact: false }).waitFor();
  await popup.getByRole("button", { name: "連接說明" }).waitFor();

  // Narrow layout and English.
  await guide.setViewportSize({ width: 380, height: 900 });
  assert.equal(
    await guide.evaluate(() => document.documentElement.scrollWidth),
    380,
  );
  await guide.screenshot({ path: resolve(shots, "25-drive-setup-narrow.png") });
  await guide.setViewportSize({ width: 1100, height: 1300 });
  await guide.selectOption("select.langSelect", "en");
  await guide.getByRole("heading", { name: "Connect Google Drive", exact: true }).waitFor();
  await guide.screenshot({
    path: resolve(shots, "26-drive-setup-en.png"),
    fullPage: true,
  });
  assert.deepEqual(external, [], "guide must not contact external hosts");
  console.log("PASS drive connect guide (built-in OAuth client)", id);
} finally {
  await context.close();
}
