// Notebook images and ruled-paper layout (extension pages only).
import {
  IMAGE_MAX,
  IMAGE_TYPES,
  type MemoImage,
} from "./crypto";

/** Height of one ruled line on the notebook paper, in CSS px. */
export const RULE = 32;
const MAX_EDGE = 1600;
const BLOCKS = "p,div,li,h1,h2,h3,blockquote,pre";

async function toBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Re-encodes a pasted or dropped picture: at most 1600px on the long edge,
 * WebP (keeps transparency), shrunk further until it fits IMAGE_MAX. Metadata
 * such as camera location is dropped because only the pixels are kept.
 */
export async function importImage(blob: Blob): Promise<MemoImage> {
  if (blob.type && !blob.type.startsWith("image/"))
    throw Error("無法讀取這張圖片");
  if (blob.size > 40_000_000) throw Error("圖片太大，請先縮小後再貼上");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw Error("無法讀取這張圖片");
  }
  try {
    let edge = MAX_EDGE;
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
      let out = await canvas.convertToBlob({
        type: "image/webp",
        quality: attempt ? 0.75 : 0.86,
      });
      if (!IMAGE_TYPES.includes(out.type))
        out = await canvas.convertToBlob({ type: "image/png" });
      const data = await toBase64(out);
      if (data.length <= IMAGE_MAX)
        return { id: crypto.randomUUID(), data, mime: out.type, w, h };
      edge = Math.round(Math.max(w, h) * 0.75);
    }
    throw Error("圖片太大，請先縮小後再貼上");
  } finally {
    bitmap.close();
  }
}

/** Pictures embedded as data: URLs in pasted HTML (e.g. copied from the notebook). */
export async function importHtmlImages(html: string) {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body>${html}`,
    "text/html",
  );
  const added: MemoImage[] = [];
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("src") || "";
    img.removeAttribute("data-veil-img");
    // Remote pictures are not fetched: that would reveal the note to a server.
    if (!/^data:image\/[\w.+-]+;base64,/i.test(src) || added.length >= 20) {
      img.remove();
      continue;
    }
    try {
      const image = await importImage(await (await fetch(src)).blob());
      added.push(image);
      img.setAttribute("data-veil-img", image.id);
    } catch {
      img.remove();
    }
  }
  return { html: doc.body.innerHTML, added };
}

export const imageSrc = (i: MemoImage) => `data:${i.mime};base64,${i.data}`;

/**
 * Keeps every line on the ruled grid: blocks with large text get a whole
 * number of rules, and images are sized to whole rules.
 */
export function layoutRuled(
  editor: HTMLElement,
  images: Map<string, MemoImage>,
) {
  const maxWidth = parseFloat(getComputedStyle(editor).width) || 634;
  for (const img of Array.from(
    editor.querySelectorAll<HTMLImageElement>("img[data-veil-img]"),
  )) {
    const i = images.get(img.dataset.veilImg || "");
    if (!i) {
      img.removeAttribute("src");
      img.classList.add("missing");
      img.style.width = img.style.height = "";
      continue;
    }
    const src = imageSrc(i);
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    const requested = Number(img.getAttribute("width"));
    if (Number.isInteger(requested) && requested >= 32 && requested <= 1600) {
      const width = Math.min(requested, maxWidth);
      const height = width * i.h / i.w;
      img.style.width = `${width}px`;
      img.style.height = `${height}px`;
      img.style.marginBottom = `${Math.ceil(height / RULE) * RULE - height}px`;
      continue;
    }
    img.style.marginBottom = "";
    let rows = Math.max(1, Math.round((Math.min(i.w, maxWidth) * i.h) / i.w / RULE));
    if ((rows * RULE * i.w) / i.h > maxWidth)
      rows = Math.max(1, Math.floor((maxWidth * i.h) / i.w / RULE));
    const height = rows * RULE;
    img.style.height = `${height}px`;
    img.style.width = `${Math.min(maxWidth, (height * i.w) / i.h)}px`;
  }
  for (const b of Array.from(editor.querySelectorAll<HTMLElement>(BLOCKS))) {
    let size = parseFloat(getComputedStyle(b).fontSize) || 0;
    for (const x of Array.from(b.querySelectorAll<HTMLElement>("*"))) {
      if (x.tagName === "IMG" || x.tagName === "BR" || x.matches(BLOCKS))
        continue;
      if (x.parentElement?.closest(BLOCKS) !== b) continue;
      size = Math.max(size, parseFloat(getComputedStyle(x).fontSize) || 0);
    }
    const rows = Math.max(1, Math.ceil((size * 1.15) / RULE));
    const value = rows > 1 ? `${rows * RULE}px` : "";
    if (b.style.lineHeight !== value) b.style.lineHeight = value;
  }
}
