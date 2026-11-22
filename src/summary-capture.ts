import type { SummarySource } from "./local-summary";
export const SUMMARY_TTL = 10 * 60_000;
export async function captureSummary(tabId: number) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (!/^https?:$/.test(location.protocol)) throw Error("Unsupported page");
      const root =
        document.querySelector('article, main, [role="main"]') || document.body;
      if (!root) throw Error("Empty page");
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null,
        text = "",
        count = 0;
      while ((node = walker.nextNode()) && count++ < 50000) {
        const parent = node.parentElement;
        if (
          !parent ||
          parent.closest(
            'script,style,noscript,nav,aside,header,footer,form,input,textarea,select,button,[hidden],[aria-hidden="true"]',
          )
        )
          continue;
        if (
          !parent.getClientRects().length ||
          getComputedStyle(parent).visibility === "hidden"
        )
          continue;
        const value = node.textContent?.trim();
        if (value) text += value + "\n";
        if (text.length > 24000) break;
      }
      return {
        title: document.title.slice(0, 200),
        url: location.href,
        text: text.slice(0, 24000),
        language: document.documentElement.lang,
        truncated: text.length > 24000 || count >= 50000,
        at: Date.now(),
      };
    },
  });
  if (!result?.text.trim()) throw Error("Empty page");
  const id = crypto.randomUUID();
  const { summaryJobs = {} } = await chrome.storage.session.get<{
    summaryJobs?: Record<string, SummarySource>;
  }>("summaryJobs");
  const fresh = Object.entries(summaryJobs)
    .filter(([, v]) => Date.now() - v.at < SUMMARY_TTL)
    .slice(-2);
  await chrome.storage.session.set({
    summaryJobs: { ...Object.fromEntries(fresh), [id]: result },
  });
  await chrome.alarms.create("veil-summary-expire:" + id, {
    when: Date.now() + SUMMARY_TTL,
  });
  await chrome.tabs.create({
    url: chrome.runtime.getURL("index.html?summary=" + id),
  });
}
