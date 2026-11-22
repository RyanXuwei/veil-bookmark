import test from "node:test";
import assert from "node:assert/strict";
import {
  summaryPlan,
  startSummary,
  checkPlan,
  chunks,
} from "../src/local-summary";
test("local summary translates Chinese through English, chunks long text and destroys every local session", async () => {
  const api = globalThis as any,
    oldS = api.Summarizer,
    oldT = api.Translator;
  const calls: string[] = [];
  let destroyed = 0;
  api.Summarizer = {
    availability: async () => "available",
    create: async (o: any) => {
      assert.deepEqual(o.expectedInputLanguages, ["en"]);
      return {
        summarize: async (s: string) => {
          calls.push("summary");
          return "summary";
        },
        destroy: () => destroyed++,
      };
    },
  };
  api.Translator = {
    availability: async () => "downloadable",
    create: async (o: any) => ({
      translate: async (s: string) => {
        calls.push(o.sourceLanguage + ">" + o.targetLanguage);
        return s;
      },
      destroy: () => destroyed++,
    }),
  };
  try {
    const p = summaryPlan("zh-Hant", "zh-Hant");
    assert(await checkPlan(p));
    await startSummary(
      p,
      "文".repeat(8000),
      new AbortController().signal,
      () => {},
    );
    assert.equal(calls.filter((c) => c === "zh-Hant>en").length, 3);
    assert.equal(calls.at(-1), "en>zh-Hant");
    assert.equal(destroyed, 3);
    assert.equal(chunks("abc\ndef").join(""), "abc\ndef");
    api.Translator.availability = async () => "unavailable";
    assert.equal(await checkPlan(summaryPlan("zh-Hant", "en")), false);
    api.Summarizer = undefined;
    assert.equal(await checkPlan(summaryPlan("en", "en")), false);
  } finally {
    api.Summarizer = oldS;
    api.Translator = oldT;
  }
});
test("aborting local model setup destroys sessions which finish loading late", async () => {
  const api = globalThis as any,
    oldS = api.Summarizer;
  let destroyed = 0;
  api.Summarizer = {
    create: async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { summarize: async () => "secret", destroy: () => destroyed++ };
    },
  };
  try {
    const c = new AbortController();
    const task = startSummary(
      summaryPlan("en", "en"),
      "article",
      c.signal,
      () => {},
    );
    setTimeout(() => c.abort(), 1);
    await assert.rejects(task);
    assert(destroyed >= 1);
  } finally {
    api.Summarizer = oldS;
  }
});
