// Allow-list HTML sanitizer for notebook documents. Runs in extension pages
// (DOMParser is not available in the service worker).
const KEEP = new Set([
  "P",
  "BR",
  "DIV",
  "SPAN",
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "S",
  "STRIKE",
  "SUB",
  "SUP",
  "H1",
  "H2",
  "H3",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "LI",
  "A",
  "HR",
  "FONT",
  "PRE",
  "CODE",
]);
const DROP = new Set([
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "LINK",
  "META",
  "BASE",
  "FORM",
  "INPUT",
  "BUTTON",
  "TEXTAREA",
  "SELECT",
  "SVG",
  "MATH",
  "VIDEO",
  "AUDIO",
  "SOURCE",
  "CANVAS",
  "TEMPLATE",
  "NOSCRIPT",
  "TITLE",
]);
const STYLES = [
  "color",
  "background-color",
  "text-align",
  "font-size",
  "font-weight",
  "font-style",
  "text-decoration",
  "text-decoration-line",
  "margin-left",
  "padding-left",
];
const SAFE_VALUE = /^[#(),.%\w\s-]{1,60}$/;

function cleanStyle(el: HTMLElement) {
  const keep: string[] = [];
  for (const prop of STYLES) {
    const v = el.style.getPropertyValue(prop);
    if (v && SAFE_VALUE.test(v) && !/url|expression|var\(/i.test(v))
      keep.push(`${prop}: ${v}`);
  }
  return keep.join("; ");
}

function clean(node: Node, doc: Document): Node | DocumentFragment | null {
  if (node.nodeType === Node.TEXT_NODE)
    return doc.createTextNode(node.textContent || "");
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as HTMLElement;
  if (DROP.has(el.tagName)) return null;
  // Only notebook images, referenced by ID; their data is stored encrypted
  // beside the document and is never loaded from a URL.
  if (el.tagName === "IMG") {
    const id = el.getAttribute("data-veil-img") || "";
    if (!/^[\w-]{1,64}$/.test(id)) return null;
    const img = doc.createElement("img");
    img.setAttribute("data-veil-img", id);
    img.setAttribute("alt", "");
    const width = el.getAttribute("width") || "";
    if (/^\d{1,4}$/.test(width) && +width >= 32 && +width <= 1600)
      img.setAttribute("width", String(+width));
    return img;
  }
  const children = doc.createDocumentFragment();
  for (const c of Array.from(el.childNodes)) {
    const x = clean(c, doc);
    if (x) children.appendChild(x);
  }
  if (!KEEP.has(el.tagName)) return children; // unwrap unknown elements
  const out = doc.createElement(el.tagName === "FONT" ? "span" : el.tagName);
  if (el.tagName === "FONT") {
    const color = el.getAttribute("color");
    if (color && /^#?[\w]{3,20}$/.test(color)) out.style.color = color;
  }
  const style = cleanStyle(el);
  if (style)
    out.setAttribute(
      "style",
      style +
        (out.getAttribute("style") ? "; " + out.getAttribute("style") : ""),
    );
  if (el.tagName === "A") {
    const href = el.getAttribute("href") || "";
    if (/^(https?:|mailto:)/i.test(href.trim())) {
      out.setAttribute("href", href.trim());
      out.setAttribute("target", "_blank");
      out.setAttribute("rel", "noopener noreferrer");
    }
  }
  out.appendChild(children);
  return out;
}

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body>${html}`,
    "text/html",
  );
  const box = doc.createElement("div");
  for (const c of Array.from(doc.body.childNodes)) {
    const x = clean(c, doc);
    if (x) box.appendChild(x);
  }
  return box.innerHTML;
}

const escape = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`,
  );

/** Plain-text memos from earlier versions become paragraphs. */
export function textToHtml(text: string) {
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => `<p>${line ? escape(line) : "<br>"}</p>`)
    .join("");
}

/** IDs of the notebook images a document refers to, in order, without repeats. */
export function imageIds(html: string) {
  return [
    ...new Set(
      [...html.matchAll(/data-veil-img="([\w-]{1,64})"/g)].map((m) => m[1]),
    ),
  ];
}

export function htmlToText(html: string) {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body>${html}`,
    "text/html",
  );
  for (const br of Array.from(doc.querySelectorAll("br"))) br.replaceWith("\n");
  for (const b of Array.from(
    doc.querySelectorAll("p,div,h1,h2,h3,li,blockquote,pre"),
  ))
    b.append("\n");
  return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Body of a memo as safe HTML, whatever format it was stored in. */
export function memoHtml(m: { body: string; format?: string }) {
  return m.format === "html" ? sanitizeHtml(m.body) : textToHtml(m.body);
}
export function memoText(m: { body: string; format?: string }) {
  return m.format === "html" ? htmlToText(m.body) : m.body;
}

/** Word-style counts: each CJK character counts as a word. */
export function countWords(text: string) {
  const cjk = text.match(/[぀-ヿ㐀-鿿가-힯]/g)?.length || 0;
  const latin =
    text
      .replace(/[぀-ヿ㐀-鿿가-힯]/g, " ")
      .match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length || 0;
  return { words: cjk + latin, chars: text.replace(/\s/g, "").length };
}
