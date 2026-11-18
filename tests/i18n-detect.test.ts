import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as any).navigator ??= { language: "en-US", languages: ["en-US"] };
const { detect } = await import("../src/i18n");

test("maps system languages to the app's five", () => {
  for (const [tag, want] of [
    ["zh-TW", "zh-TW"], ["zh-HK", "zh-TW"], ["zh-MO", "zh-TW"], ["zh-Hant", "zh-TW"], ["zh", "zh-TW"],
    ["zh-CN", "zh-CN"], ["zh-SG", "zh-CN"], ["zh-Hans-HK", "zh-CN"],
    ["ja", "ja"], ["ja-JP", "ja"], ["ko-KR", "ko"], ["en-GB", "en"], ["fr-FR", "en"], ["", "en"],
  ] as const) assert.equal(detect(tag), want, tag);
});

test("uses the first supported language in the system list", () => {
  assert.equal(detect(["fr-FR", "ja-JP", "en-US"]), "ja");
  assert.equal(detect(["de", "es"]), "en");
  assert.equal(detect(["ko", "zh-TW"]), "ko");
});
