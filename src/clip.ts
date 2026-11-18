// Right-click "Add to Veil notes": selected text or a picture on a web page
// becomes a note, with the page's title and a link back to it.
import { safeUrl, type MemoImage } from "./crypto";
import { importImage } from "./ruled";
import { t } from "./i18n";

export type Clip = {
  title: string;
  body: string;
  format: "html";
  images: MemoImage[];
};

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
const link = (url: string) => {
  try {
    return safeUrl(url);
  } catch {
    return "";
  }
};

/** Fetches a picture for a note; null when the site does not allow it. */
export async function fetchPicture(src: string): Promise<MemoImage | null> {
  try {
    if (!/^(https?|data):/.test(src)) return null;
    const r = await fetch(src, { credentials: "omit", cache: "force-cache" });
    if (!r.ok) return null;
    return await importImage(await r.blob());
  } catch {
    return null;
  }
}

export function clipNote(x: {
  text?: string;
  pageTitle?: string;
  pageUrl?: string;
  picture?: MemoImage | null;
  pictureUrl?: string;
}): Clip {
  const text = (x.text || "").trim().slice(0, 200_000);
  const page = link(x.pageUrl || "");
  const paras = text
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`);
  const parts = [...paras];
  if (x.picture) parts.push(`<p><img data-veil-img="${x.picture.id}" alt=""></p>`);
  else if (x.pictureUrl && link(x.pictureUrl))
    parts.push(
      `<p><a href="${esc(link(x.pictureUrl))}">${esc(t("圖片連結"))}</a></p>`,
    );
  if (page)
    parts.push(
      `<p><a href="${esc(page)}">${esc(x.pageTitle || new URL(page).hostname)}</a></p>`,
    );
  const first = text.split("\n")[0].trim().slice(0, 80);
  return {
    title: (x.pageTitle || first || t("網頁圖片")).slice(0, 80),
    body: parts.join(""),
    format: "html",
    images: x.picture ? [x.picture] : [],
  };
}
