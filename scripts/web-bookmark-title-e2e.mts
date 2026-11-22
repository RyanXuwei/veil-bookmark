// Focused mobile bookmark-name regression with a synthetic Drive.
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
} from "../src/crypto";

const root = resolve(import.meta.dirname, "..");
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

const dek = await newDataKey(),
  v = emptyVault("bookmark-mobile-test");
const keys = await setPassword(dek, v.id, PASSWORD);
let snapshot = await seal(v, dek, keys);
const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices["Pixel 7"],
  locale: "zh-TW",
  serviceWorkers: "block",
});
context.setDefaultTimeout(10000);
await context.addInitScript(() => {
  sessionStorage.setItem("veilActiveAccount", "test-account");
  localStorage.setItem(
    "veilAccount:test-account",
    JSON.stringify({
      id: "test-account",
      email: "test@example.com",
      token: "synthetic-token",
      expires: Date.now() + 3600000,
    }),
  );
});
await context.route("**/config.json", (r) =>
  r.fulfill({ json: { clientId: "test.apps.googleusercontent.com" } }),
);
await context.route("https://blank-name.example/**", (r) => r.abort());
await context.route("https://www.googleapis.com/**", async (route) => {
  const req = route.request(),
    url = req.url();
  if (url.includes("/about?"))
    return route.fulfill({
      json: {
        user: {
          permissionId: "test-account",
          emailAddress: "test@example.com",
        },
      },
    });
  if (req.method() === "POST") {
    const data = req
      .postData()!
      .split("Content-Type: application/json\r\n\r\n")[1]
      .split("\r\n--")[0];
    snapshot = JSON.parse(data);
    return route.fulfill({ json: { id: "snapshot" } });
  }
  if (req.method() === "DELETE")
    return route.fulfill({ status: 204, body: "" });
  if (url.includes("alt=media")) return route.fulfill({ json: snapshot });
  return route.fulfill({ json: { files: [{ id: "snapshot" }] } });
});
try {
  const p = await context.newPage();
  await p.goto(APP);
  await p.getByLabel("主密碼", { exact: true }).fill(PASSWORD);
  await p.getByRole("button", { name: "解鎖保險庫 →", exact: true }).click();
  const later = p.getByRole("button", { name: "以後再說", exact: true });
  if (await later.count()) await later.click();
  await p.getByRole("button", { name: "新增書籤", exact: true }).click();
  const editor = p.getByRole("dialog");
  assert.equal(
    await editor.getByLabel("名稱", { exact: true }).getAttribute("required"),
    null,
  );
  await editor
    .getByLabel("網址", { exact: true })
    .fill("https://blank-name.example/test");
  await editor.getByRole("button", { name: "加密儲存 →", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await p.getByText("blank-name.example", { exact: true }).first().waitFor();
  await p.waitForTimeout(1200);
  const saved = await decrypt(snapshot, dek);
  assert.equal(saved.entries[0].title, "blank-name.example");
  await p.getByRole("button", { name: "新增書籤", exact: true }).click();
  await p
    .getByRole("dialog")
    .getByLabel("名稱", { exact: true })
    .fill("我自己的名稱");
  await p
    .getByRole("dialog")
    .getByLabel("網址", { exact: true })
    .fill("https://blank-name.example/custom");
  await p
    .getByRole("dialog")
    .getByRole("button", { name: "加密儲存 →", exact: true })
    .click();
  await p.getByText("我自己的名稱", { exact: true }).first().waitFor();
  console.log(
    "PASS mobile bookmark names: optional name, blocked lookup falls back to domain, encrypted snapshot, manual title preserved.",
  );
} finally {
  await context.close();
  await browser.close();
  server.close();
}
