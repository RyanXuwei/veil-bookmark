import test from "node:test";
import assert from "node:assert/strict";
import {
  bookmarkDomain,
  bookmarkKey,
  pageTitle,
  lookupBookmarkTitle,
} from "../src/bookmark-title";
import { emptyVault } from "../src/crypto";
import { upsertEntry } from "../src/entry-ops";
test("bookmark title: HTML entities, exact page matching, CORS failures and domain fallback", async () => {
  assert.equal(
    pageTitle("<title>  設計 &amp; &#x4E2D;&#25991;\n頁面 </title>"),
    "設計 & 中文 頁面",
  );
  assert.equal(bookmarkDomain("https://www.example.com:8443/a"), "example.com");
  assert.equal(
    bookmarkKey("https://EXAMPLE.com/a/#x"),
    "https://example.com/a",
  );
  assert.notEqual(
    bookmarkKey("https://example.com/A"),
    bookmarkKey("https://example.com/a"),
  );
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.referrerPolicy, "no-referrer");
    return new Response("<html><title>目標 &quot;網站&quot;</title></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  try {
    assert.equal(
      await lookupBookmarkTitle("https://example.com/a", {
        url: "https://example.com/a",
        title: "目前分頁",
      }),
      "目前分頁",
    );
    assert.equal(calls, 0);
    assert.equal(
      await lookupBookmarkTitle("https://example.com/target", {
        url: "https://example.com/parent",
        title: "錯誤父頁名稱",
      }),
      '目標 "網站"',
    );
    assert.equal(calls, 1);
    globalThis.fetch = async () => {
      throw Error("CORS denied");
    };
    assert.equal(
      await lookupBookmarkTitle("https://www.example.com/blocked"),
      "example.com",
    );
    globalThis.fetch = async () =>
      new Response("<title>Not HTML</title>", {
        headers: { "content-type": "application/pdf" },
      });
    assert.equal(
      await lookupBookmarkTitle("https://example.com/a.pdf"),
      "example.com",
    );
    await assert.rejects(() => lookupBookmarkTitle("javascript:alert(1)"));
    const v = emptyVault("test");
    assert.equal(
      upsertEntry(v, { url: "https://www.example.com/page", title: "  " })
        .title,
      "example.com",
    );
    assert.equal(
      upsertEntry(v, { url: "https://example.com", title: "自訂名稱" }).title,
      "自訂名稱",
    );
  } finally {
    globalThis.fetch = original;
  }
});
