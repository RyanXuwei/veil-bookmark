// Chrome's built-in APIs only. No network/model-provider fallback.
export const SUPPORTED_SUMMARY_LANGS = ["en", "ja", "es", "de", "fr"];
export type SummarySource = {
  title: string;
  url: string;
  text: string;
  language: string;
  truncated: boolean;
  at: number;
};
type LocalSession = {
  summarize?: (s: string) => Promise<string>;
  translate?: (s: string) => Promise<string>;
  destroy: () => void;
};
export type Plan = {
  api: any;
  options: Record<string, unknown>;
  kind: "summary" | "input" | "output";
};
export function summaryPlan(source: string, output: string): Plan[] {
  const api = globalThis as any;
  const middle = SUPPORTED_SUMMARY_LANGS.includes(source) ? source : "en";
  const plan: Plan[] = [
    {
      api: api.Summarizer,
      kind: "summary",
      options: {
        type: "key-points",
        format: "plain-text",
        length: "medium",
        outputLanguage: middle,
        expectedInputLanguages: [middle],
      },
    },
  ];
  if (source !== middle)
    plan.push({
      api: api.Translator,
      kind: "input",
      options: { sourceLanguage: source, targetLanguage: middle },
    });
  if (output !== middle)
    plan.push({
      api: api.Translator,
      kind: "output",
      options: { sourceLanguage: middle, targetLanguage: output },
    });
  return plan;
}
export async function checkPlan(plan: Plan[]) {
  for (const p of plan)
    if (!p.api || (await p.api.availability(p.options)) === "unavailable")
      return false;
  return true;
}
export function chunks(text: string, size = 3500): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const stop = text.lastIndexOf("\n", end);
      if (stop > i + size / 2) end = stop;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out.filter((s) => s.trim());
}
/** Start every create synchronously inside the user's click, before awaiting downloads. */
export function startSummary(
  plan: Plan[],
  text: string,
  signal: AbortSignal,
  progress: (s: string) => void,
): Promise<string> {
  const sessions: LocalSession[] = [];
  const pending = plan.map((p) =>
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        return p.api.create({
          ...p.options,
          signal,
          monitor: (m: any) =>
            m.addEventListener("downloadprogress", (e: any) =>
              progress(`${Math.round(e.loaded * 100)}%`),
            ),
        });
      })
      .then((s: LocalSession) => {
        sessions.push(s);
        if (signal.aborted) s.destroy();
        return s;
      }),
  );
  const cancel = () => sessions.forEach((s) => s.destroy());
  signal.addEventListener("abort", cancel, { once: true });
  return (async () => {
    try {
      const ready = await Promise.allSettled(pending);
      const failed = ready.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const engines = ready.map(
        (r) => (r as PromiseFulfilledResult<LocalSession>).value,
      );
      const get = (kind: Plan["kind"]) =>
        engines[plan.findIndex((p) => p.kind === kind)];
      const results: string[] = [];
      for (const [i, part] of chunks(text).entries()) {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        progress(`${i + 1}/${chunks(text).length}`);
        const input = get("input")
          ? await get("input")!.translate!(part)
          : part;
        results.push(await get("summary")!.summarize!(input));
      }
      let result = results.join("\n\n");
      if (results.length > 1) result = await get("summary")!.summarize!(result);
      if (get("output")) result = await get("output")!.translate!(result);
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (!result.trim()) throw Error("Empty summary");
      return result.trim();
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
    }
  })();
}
