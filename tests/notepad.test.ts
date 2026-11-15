import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanDrawing,
  cleanRecordings,
  emptyVault,
  newDataKey,
  setPassword,
  seal,
  decrypt,
} from "../src/crypto";

test("notepad drawings and recordings reject unsafe payloads, bound resources, and survive encryption", async () => {
  const stroke = {
    color: "#334455",
    width: 2,
    points: [
      [10, 20],
      [30, 40],
    ],
  };
  assert.equal(
    cleanDrawing([{ ...stroke, color: "url(https://example.com)" }, stroke])[0]
      .color,
    "#334455",
  );
  assert.equal(
    cleanDrawing([
      {
        ...stroke,
        points: [
          [NaN, 1],
          [0, Infinity],
          [-1, 1],
          [4, 5],
        ],
      },
    ])[0].points.length,
    1,
  );
  assert.equal(
    cleanDrawing(
      Array.from({ length: 250 }, () => ({
        ...stroke,
        points: Array.from({ length: 3000 }, () => [1, 2]),
      })),
    ).reduce((n, s) => n + s.points.length, 0),
    20000,
  );
  const clip = {
    id: "audio-1",
    data: btoa("synthetic recording bytes"),
    mime: "audio/webm",
    duration: 2,
    created: Date.now(),
    x: 0.2,
    y: 0.4,
  };
  assert.equal(
    cleanRecordings([
      { ...clip, mime: "text/html" },
      { ...clip, data: "A" },
      { ...clip, data: "not-audio!" },
      clip,
    ]).length,
    1,
  );
  assert.equal(cleanRecordings(Array(10).fill(clip)).length, 5);
  assert.equal(
    cleanRecordings([{ ...clip, data: "A".repeat(1400004) }]).length,
    0,
  );
  assert.equal(cleanRecordings([{ ...clip, x: -5, y: 50 }])[0].x, 0);
  const vault = emptyVault("notepad");
  vault.memos.push({
    id: "memo",
    title: "",
    body: "",
    paperColor: "#fff4be",
    drawing: cleanDrawing([stroke]),
    recordings: [clip],
    updated: 1,
    revision: "r",
    deleted: false,
  });
  const dek = await newDataKey();
  const keys = await setPassword(dek, vault.id, "1234");
  const encrypted = await seal(vault, dek, keys);
  assert(!JSON.stringify(encrypted).includes(clip.data));
  assert.deepEqual(await decrypt(encrypted, dek), vault);
});
