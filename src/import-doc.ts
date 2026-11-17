// Turns a text, Markdown, HTML or Word (.docx) file into a note: safe HTML
// plus the pictures it contains. Everything happens on this device; nothing
// is uploaded and no remote picture is fetched.
import type { MemoImage } from "./crypto";
import { MEMO_IMAGES_MAX } from "./crypto";
import { importHtmlImages, importImage } from "./ruled";
import { sanitizeHtml, textToHtml } from "./sanitize";

export const IMPORT_ACCEPT =
  ".txt,.text,.md,.markdown,.html,.htm,.docx,text/plain,text/markdown,text/html,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const FILE_MAX = 30_000_000;

export type Imported = { title: string; html: string; images: MemoImage[] };

const escape = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`,
  );

/** Reads a text file whatever its encoding: UTF-8 (with or without BOM),
 *  UTF-16 with a BOM, or Big5 (common for older Traditional Chinese files). */
export function decodeText(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {}
  try {
    return new TextDecoder("big5", { fatal: true }).decode(bytes);
  } catch {}
  return new TextDecoder("utf-8").decode(bytes);
}

// ---- Markdown (the common subset) -------------------------------------------
function inlineMd(s: string) {
  let out = escape(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "<b>$1$2</b>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2">$1</a>',
  );
  return out;
}

export function markdownToHtml(md: string) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let code: string[] | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      closeList();
      code = [];
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const n = Math.min(3, h[1].length);
      out.push(`<h${n}>${inlineMd(h[2])}</h${n}>`);
    } else if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inlineMd((ul || ol)![1])}</li>`);
    } else if (/^\s*>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${inlineMd(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList();
      out.push("<hr>");
    } else if (!line.trim()) {
      closeList(); // a blank line only separates blocks in Markdown
    } else {
      closeList();
      out.push(`<p>${inlineMd(line)}</p>`);
    }
  }
  if (code) out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
  closeList();
  return out.join("");
}

// ---- ZIP (for .docx) ---------------------------------------------------------
async function inflate(data: Uint8Array) {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files of a ZIP archive, read lazily. */
export function unzip(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw Error("無法讀取這個檔案");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map<string, () => Promise<Uint8Array>>();
  const names = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = names.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    files.set(name, async () => {
      const start =
        local +
        30 +
        view.getUint16(local + 26, true) +
        view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflate(data);
      throw Error("無法讀取這個檔案");
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---- Word (.docx) --------------------------------------------------------------
const W = (el: Element, name: string) =>
  Array.from(el.children).find((c) => c.localName === name) || null;
const attr = (el: Element | null, name: string) =>
  el?.getAttribute("w:" + name) ?? el?.getAttribute(name) ?? null;
const on = (el: Element | null) =>
  !!el && !/^(0|false|none)$/i.test(attr(el, "val") || "");
const HIGHLIGHT: Record<string, string> = {
  yellow: "#fff176",
  green: "#c8e6c9",
  cyan: "#b2ebf2",
  magenta: "#f8bbd0",
  lightGray: "#e0e0e0",
  red: "#ffcdd2",
  blue: "#bbdefb",
};
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
};

export async function docxToHtml(buf: ArrayBuffer) {
  const zip = unzip(buf);
  const read = async (name: string) => {
    const f = zip.get(name);
    return f ? new TextDecoder().decode(await f()) : "";
  };
  const xml = (s: string) =>
    new DOMParser().parseFromString(s, "application/xml");
  const docXml = await read("word/document.xml");
  if (!docXml) throw Error("無法讀取這個檔案");
  const doc = xml(docXml);
  // Relationships: hyperlinks and pictures.
  const rels = new Map<string, string>();
  for (const r of Array.from(
    xml(await read("word/_rels/document.xml.rels")).getElementsByTagName(
      "Relationship",
    ),
  ))
    rels.set(r.getAttribute("Id") || "", r.getAttribute("Target") || "");
  // Heading styles, whatever the document's language.
  const headings = new Map<string, number>();
  for (const s of Array.from(
    xml(await read("word/styles.xml")).getElementsByTagNameNS("*", "style"),
  )) {
    const id = attr(s, "styleId") || "";
    const name = attr(W(s, "name"), "val") || id;
    const m = /^heading\s*(\d)$/i.exec(name) || /^Heading(\d)$/.exec(id);
    if (m) headings.set(id, Math.min(3, Number(m[1])));
    else if (/^title$/i.test(name)) headings.set(id, 1);
    else if (/^(quote|intense quote)$/i.test(name)) headings.set(id, 0);
  }
  // Numbered or bulleted lists.
  const numbering = xml(await read("word/numbering.xml"));
  const abstractFmt = new Map<string, Map<string, string>>();
  for (const a of Array.from(numbering.getElementsByTagNameNS("*", "abstractNum"))) {
    const levels = new Map<string, string>();
    for (const l of Array.from(a.getElementsByTagNameNS("*", "lvl")))
      levels.set(attr(l, "ilvl") || "0", attr(W(l, "numFmt"), "val") || "");
    abstractFmt.set(attr(a, "abstractNumId") || "", levels);
  }
  const numFmt = new Map<string, Map<string, string>>();
  for (const n of Array.from(numbering.getElementsByTagNameNS("*", "num")))
    numFmt.set(
      attr(n, "numId") || "",
      abstractFmt.get(attr(W(n, "abstractNumId"), "val") || "") || new Map(),
    );

  const images: MemoImage[] = [];
  let skipped = 0;
  async function picture(id: string) {
    const target = rels.get(id);
    if (!target || images.length >= MEMO_IMAGES_MAX) return "";
    const path = target.startsWith("/") ? target.slice(1) : "word/" + target;
    const file = zip.get(path.replace(/\/\.\//g, "/"));
    const mime = MIME[(path.split(".").pop() || "").toLowerCase()];
    if (!file || !mime) {
      skipped++;
      return "";
    }
    try {
      const image = await importImage(new Blob([(await file()) as BlobPart], { type: mime }));
      images.push(image);
      return `<img data-veil-img="${image.id}" alt="">`;
    } catch {
      skipped++;
      return "";
    }
  }

  async function runs(el: Element): Promise<string> {
    let out = "";
    for (const c of Array.from(el.children)) {
      const n = c.localName;
      if (n === "r") out += await run(c);
      else if (n === "hyperlink") {
        const href = rels.get(c.getAttribute("r:id") || "") || "";
        const inner = await runs(c);
        out += /^https?:\/\//i.test(href)
          ? `<a href="${escape(href)}">${inner}</a>`
          : inner;
      } else if (["ins", "smartTag", "fldSimple", "sdt", "sdtContent"].includes(n))
        out += await runs(c);
    }
    return out;
  }
  async function run(r: Element) {
    const pr = W(r, "rPr");
    let text = "";
    for (const c of Array.from(r.children)) {
      const n = c.localName;
      if (n === "t") text += escape(c.textContent || "");
      else if (n === "tab") text += "&emsp;";
      else if (n === "br" || n === "cr") text += "<br>";
      else if (n === "drawing" || n === "pict") {
        const blip =
          c.getElementsByTagNameNS("*", "blip")[0] ||
          c.getElementsByTagNameNS("*", "imagedata")[0];
        const id =
          blip?.getAttribute("r:embed") || blip?.getAttribute("r:id") || "";
        if (id) text += await picture(id);
      }
    }
    if (!text || !pr) return text;
    const style: string[] = [];
    const color = attr(W(pr, "color"), "val");
    if (color && /^[0-9a-f]{6}$/i.test(color) && color !== "000000")
      style.push(`color: #${color}`);
    const hl = HIGHLIGHT[attr(W(pr, "highlight"), "val") || ""];
    if (hl) style.push(`background-color: ${hl}`);
    if (style.length) text = `<span style="${style.join("; ")}">${text}</span>`;
    if (on(W(pr, "b"))) text = `<b>${text}</b>`;
    if (on(W(pr, "i"))) text = `<i>${text}</i>`;
    if (on(W(pr, "u"))) text = `<u>${text}</u>`;
    if (on(W(pr, "strike")) || on(W(pr, "dstrike"))) text = `<s>${text}</s>`;
    const va = attr(W(pr, "vertAlign"), "val");
    if (va === "superscript") text = `<sup>${text}</sup>`;
    if (va === "subscript") text = `<sub>${text}</sub>`;
    return text;
  }

  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  async function paragraph(p: Element) {
    const pr = W(p, "pPr");
    const styleId = attr(W(pr || p, "pStyle"), "val") || "";
    const numPr = pr && W(pr, "numPr");
    const inner = (await runs(p)) || "<br>";
    if (numPr) {
      const fmt =
        numFmt.get(attr(W(numPr, "numId"), "val") || "")?.get(
          attr(W(numPr, "ilvl"), "val") || "0",
        ) || "bullet";
      const kind = fmt === "bullet" || fmt === "none" ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inner}</li>`);
      return;
    }
    closeList();
    const level = headings.get(styleId);
    const align = attr(pr && W(pr, "jc"), "val");
    const css =
      align === "center" || align === "right"
        ? ` style="text-align: ${align}"`
        : "";
    if (level === 0) out.push(`<blockquote>${inner}</blockquote>`);
    else if (level) out.push(`<h${level}${css}>${inner}</h${level}>`);
    else out.push(`<p${css}>${inner}</p>`);
  }
  async function block(el: Element) {
    for (const c of Array.from(el.children)) {
      if (c.localName === "p") await paragraph(c);
      else if (c.localName === "tbl") {
        // Notes have no tables: one line per row, cells separated by " | ".
        closeList();
        for (const tr of Array.from(c.children).filter((x) => x.localName === "tr")) {
          const cells: string[] = [];
          for (const tc of Array.from(tr.children).filter((x) => x.localName === "tc")) {
            const parts: string[] = [];
            for (const p of Array.from(tc.getElementsByTagNameNS("*", "p")))
              parts.push(await runs(p));
            cells.push(parts.filter(Boolean).join(" "));
          }
          out.push(`<p>${cells.join(" | ")}</p>`);
        }
      } else if (c.localName === "sdt" || c.localName === "sdtContent")
        await block(c);
    }
  }
  const body = doc.getElementsByTagNameNS("*", "body")[0];
  if (!body) throw Error("無法讀取這個檔案");
  await block(body);
  closeList();
  return { html: out.join(""), images, skipped };
}

// ---- Entry point ---------------------------------------------------------------
export async function importFile(file: File): Promise<Imported & { skipped: number }> {
  const name = file.name || "";
  const ext = (name.split(".").pop() || "").toLowerCase();
  const title = name.replace(/\.[^.]+$/, "").trim().slice(0, 300);
  if (file.size > FILE_MAX) throw Error("檔案太大，無法匯入");
  if (ext === "doc")
    throw Error("不支援舊版 Word 文件（.doc），請先在 Word 另存為 .docx 再匯入");
  const buf = await file.arrayBuffer();
  if (ext === "docx") {
    const r = await docxToHtml(buf);
    return { title, html: sanitizeHtml(r.html), images: r.images, skipped: r.skipped };
  }
  const text = decodeText(new Uint8Array(buf));
  if (ext === "md" || ext === "markdown")
    return { title, html: sanitizeHtml(markdownToHtml(text)), images: [], skipped: 0 };
  if (ext === "html" || ext === "htm") {
    const body = new DOMParser().parseFromString(text, "text/html").body;
    const { html, added } = await importHtmlImages(body?.innerHTML || "");
    return { title, html: sanitizeHtml(html), images: added, skipped: 0 };
  }
  if (ext === "txt" || ext === "text" || file.type.startsWith("text/"))
    return { title, html: textToHtml(text), images: [], skipped: 0 };
  throw Error("不支援這種檔案，請選擇 .txt、.md、.html 或 .docx");
}
