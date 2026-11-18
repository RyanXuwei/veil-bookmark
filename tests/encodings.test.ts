import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeText } from "../src/import-doc";

// Samples encoded by Python's codecs (Big5, GBK, Shift_JIS, EUC-JP, EUC-KR,
// UTF-8, UTF-16 with BOM): each must decode back to the original text.
const fixtures: Record<string, { enc: string; text: string; hex: string; declared?: string }> =
  JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures-encodings.json"), "utf8"));
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

test("text files in Traditional/Simplified Chinese, Japanese, Korean and Unicode encodings decode correctly", () => {
  for (const [name, f] of Object.entries(fixtures))
    assert.equal(decodeText(bytes(f.hex), f.declared), f.text, `${name} (${f.enc})`);
});
