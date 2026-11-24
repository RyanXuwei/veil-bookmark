import test from "node:test";
import assert from "node:assert/strict";
import {
  joinPages,
  onPage,
  PAGE_BREAK,
  replacePage,
  removePageItems,
  splitPages,
  storedPages,
} from "../src/memo-pages";
import { cleanDrawing, cleanRecordings, emptyVault } from "../src/crypto";
import { upsertMemo } from "../src/memo-ops";

const stroke = (page?: number) => ({
  color: "#30372d",
  width: 2,
  points: [
    [10, 10],
    [20, 20],
  ] as [number, number][],
  ...(page === undefined ? {} : { page }),
});

test("pages: split and join round-trip; one page has no break", () => {
  assert.deepEqual(splitPages("<p>a</p>"), ["<p>a</p>"]);
  assert.deepEqual(splitPages(""), [""]);
  const html = joinPages(["<p>a</p>", "<p>b</p>", "<p>c</p>"]);
  assert.equal(html, `<p>a</p>${PAGE_BREAK}<p>b</p>${PAGE_BREAK}<p>c</p>`);
  assert.deepEqual(splitPages(html), ["<p>a</p>", "<p>b</p>", "<p>c</p>"]);
});

test("pages: trailing blank pages are not stored, blank middle pages are", () => {
  assert.deepEqual(storedPages(["<p>a</p>", "<p><br></p>", ""], [], []), [
    "<p>a</p>",
  ]);
  assert.deepEqual(storedPages(["", ""], [], []), [""]);
  // A picture, a drawing or a voice note keeps a page.
  assert.equal(
    storedPages(["<p>a</p>", '<img data-veil-img="x" alt="">'], [], []).length,
    2,
  );
  assert.equal(
    storedPages(["<p>a</p>", "<p><br></p>"], [stroke(1)], []).length,
    2,
  );
  assert.equal(storedPages(["<p>a</p>", "", "<p>c</p>"], [], []).length, 3);
});

test("pages: strokes and voice notes move with their pages", () => {
  const all = [stroke(), stroke(1), stroke(2), stroke(2)];
  assert.equal(onPage(all, 0).length, 1);
  assert.equal(onPage(all, 2).length, 2);
  // Replacing page 1's strokes leaves the others; page 0 stores no field.
  const next = replacePage(all, 1, [stroke(), stroke()]);
  assert.equal(onPage(next, 1).length, 2);
  assert.equal(onPage(next, 2).length, 2);
  assert.ok(replacePage(all, 0, [stroke(5)]).some((s) => !("page" in s)));
  // Deleting page 1 drops its strokes and moves page 2 up.
  const after = removePageItems(all, 1);
  assert.deepEqual(
    after.map((s) => s.page),
    [undefined, 1, 1],
  );
  assert.deepEqual(removePageItems([stroke(1)], 0)[0], stroke());
});

test("pages: the page of strokes and recordings survives cleaning and saving", () => {
  const cleaned = cleanDrawing([
    stroke(3),
    stroke(),
    { ...stroke(), page: -1 },
    { ...stroke(), page: 1.5 },
    { ...stroke(), page: 500 },
  ]);
  assert.deepEqual(
    cleaned.map((s) => s.page),
    [3, undefined, undefined, undefined, undefined],
  );
  const rec = {
    id: "r1",
    data: "AAAA",
    mime: "audio/webm",
    duration: 1,
    created: 1,
    x: 0.1,
    y: 0.2,
    page: 2,
  };
  assert.equal(cleanRecordings([rec])[0].page, 2);
  const v = emptyVault("test");
  const m = upsertMemo(v, {
    title: "多頁",
    body: joinPages(["<p>一</p>", "<p>二</p>"]),
    format: "html",
    drawing: [stroke(1)],
    recordings: [rec],
  });
  assert.equal(m.body, `<p>一</p>${PAGE_BREAK}<p>二</p>`);
  assert.equal(m.drawing![0].page, 1);
  assert.equal(m.recordings![0].page, 2);
});
