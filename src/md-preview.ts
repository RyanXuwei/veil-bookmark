// Markdown preview for notes (extension notebook and phone): the note's text
// is read as Markdown, ```mermaid blocks are drawn as diagrams. Everything is
// escaped before it becomes HTML; links are limited to http(s).
// Mermaid (large) is loaded only when a note actually has a diagram.

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );

function inline(s: string) {
  const codes: string[] = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "<b>$1$2</b>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    .replace(
      /(^|[\s(])(https?:\/\/[^\s<)"]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
    );
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Markdown (GitHub style: headings, lists, task lists, quotes, code,
 *  tables, rules) → HTML; ```mermaid blocks become diagram placeholders. */
export function markdownPreview(md: string) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const lists: ("ul" | "ol")[] = [];
  const closeLists = () => {
    while (lists.length) out.push(`</${lists.pop()}>`);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w-]*)/.exec(line);
    if (fence) {
      closeLists();
      const body: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
      const lang = fence[1].toLowerCase();
      const src = body.join("\n");
      out.push(
        lang === "mermaid"
          ? `<div class="mdMermaid" data-src="${esc(src)}"><pre><code>${esc(src)}</code></pre></div>`
          : `<pre><code${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(src)}</code></pre>`,
      );
      continue;
    }
    // Table: header row, then a |---|:---:| separator.
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])
    ) {
      closeLists();
      const align = cells(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "",
      );
      const td = (tag: string, c: string, k: number) =>
        `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`;
      const head = cells(line).map((c, k) => td("th", c, k)).join("");
      const rows: string[] = [];
      i += 2;
      for (; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++)
        rows.push(`<tr>${cells(lines[i]).map((c, k) => td("td", c, k)).join("")}</tr>`);
      i--;
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (h) {
      closeLists();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (item) {
      const kind = /\d/.test(item[2]) ? "ol" : "ul";
      const depth = Math.floor(item[1].replace(/\t/g, "  ").length / 2) + 1;
      while (lists.length > depth) out.push(`</${lists.pop()}>`);
      if (lists.length === depth && lists[depth - 1] !== kind)
        out.push(`</${lists.pop()}>`);
      while (lists.length < depth) {
        out.push(`<${kind}>`);
        lists.push(kind);
      }
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
      out.push(
        task
          ? `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${inline(task[2])}</li>`
          : `<li>${inline(item[3])}</li>`,
      );
    } else if (/^\s*>\s?/.test(line)) {
      closeLists();
      const quote = [line.replace(/^\s*>\s?/, "")];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1]))
        quote.push(lines[++i].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeLists();
      out.push("<hr>");
    } else if (!line.trim()) {
      closeLists();
    } else {
      closeLists();
      const para = [line];
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() &&
        !/^(\s*```|#{1,6}\s|\s*([-*+]|\d+[.)])\s|\s*>|\s*([-*_])(\s*\3){2,}\s*$)/.test(lines[i + 1]) &&
        !(lines[i + 1].includes("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 2] || ""))
      )
        para.push(lines[++i]);
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
  }
  closeLists();
  return out.join("");
}

/** The note's text as typed, one line per paragraph (for the preview). */
export function editorText(root: HTMLElement) {
  const lines: string[] = [];
  const walk = (el: Element) => {
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + n.textContent;
        continue;
      }
      if (!(n instanceof Element)) continue;
      const tag = n.tagName;
      if (tag === "BR") {
        lines.push("");
        continue;
      }
      if (tag === "IMG" || n.getAttribute("contenteditable") === "false") continue;
      const block = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|PRE|UL|OL)$/.test(tag);
      if (block && (lines[lines.length - 1] ?? "") !== "") lines.push("");
      if (block && !lines.length) lines.push("");
      if (tag === "LI") lines[lines.length - 1] += "- ";
      walk(n);
      if (block) lines.push("");
    }
  };
  lines.push("");
  walk(root);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/ /g, " ").trim();
}

/** Same, from a note's stored HTML (the phone's reader). */
export function htmlText(html: string) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
  return editorText(doc.body);
}

let mermaidLoad: Promise<typeof import("mermaid").default> | null = null;
let seq = 0;
/** Draws the ```mermaid placeholders inside `root`. */
export async function drawDiagrams(root: HTMLElement) {
  const boxes = Array.from(root.querySelectorAll<HTMLElement>(".mdMermaid"));
  if (!boxes.length) return;
  mermaidLoad ??= import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      fontFamily: "inherit",
    });
    return m.default;
  });
  const mermaid = await mermaidLoad;
  for (const box of boxes) {
    const src = box.dataset.src || "";
    try {
      const { svg } = await mermaid.render(`veil-mmd-${++seq}`, src);
      box.innerHTML = svg;
      box.classList.add("drawn");
    } catch (e) {
      box.classList.add("failed");
      const msg = document.createElement("p");
      msg.className = "mdError";
      msg.textContent = "Mermaid: " + String((e as Error)?.message || e).split("\n")[0];
      box.prepend(msg);
    } finally {
      // Mermaid leaves a temporary element behind when a diagram fails.
      document.getElementById(`dveil-mmd-${seq}`)?.remove();
    }
  }
}
