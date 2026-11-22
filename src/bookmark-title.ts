import { safeUrl } from "./crypto";

export function bookmarkDomain(url: string): string {
  return new URL(safeUrl(url.trim())).hostname.replace(/^www\./i, "");
}
export function bookmarkKey(url: string): string {
  const u = new URL(safeUrl(url.trim()));
  u.hash = "";
  return u.href.replace(/\/$/, "");
}
export function pageTitle(html: string): string {
  let text = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "";
  text = text.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (_, code: string) => {
      if (code[0] === "#") {
        const n =
          code[1].toLowerCase() === "x"
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
      }
      return (
        {
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
          nbsp: " ",
        } as Record<string, string>
      )[code.toLowerCase()];
    },
  );
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}
/** User-requested lookup only. Ordinary CORS applies; no proxy, cookies or new host permission. */
export async function lookupBookmarkTitle(
  raw: string,
  known?: { url?: string; title?: string },
): Promise<string> {
  const url = safeUrl(raw.trim()),
    fallback = bookmarkDomain(url);
  const match = (tab: { url?: string; title?: string }) => {
    try {
      return tab.title?.trim() &&
        tab.url &&
        bookmarkKey(tab.url) === bookmarkKey(url)
        ? tab.title.trim().slice(0, 300)
        : "";
    } catch {
      return "";
    }
  };
  if (known) {
    const title = match(known);
    if (title) return title;
  }
  try {
    if ((globalThis as any).chrome?.tabs?.query) {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      for (const tab of tabs) {
        const title = match(tab);
        if (title) return title;
      }
    }
  } catch {}
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      mode: "cors",
      cache: "no-store",
    });
    const type = response.headers.get("content-type") || "";
    if (
      !response.ok ||
      !/text\/html|application\/xhtml\+xml/i.test(type) ||
      !response.body
    ) {
      await response.body?.cancel();
      return fallback;
    }
    const reader = response.body.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (size < 262144) {
        const { done, value } = await reader.read();
        if (done) break;
        const part = value.subarray(0, 262144 - size);
        parts.push(part);
        size += part.length;
      }
    } finally {
      await reader.cancel();
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(
        type.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] || "utf-8",
      );
    } catch {
      decoder = new TextDecoder();
    }
    return pageTitle(decoder.decode(data)) || fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
