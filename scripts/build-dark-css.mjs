// Generates the dark theme from the light stylesheets: every colour
// declaration is repeated under html[data-theme="dark"] with its lightness
// inverted (hue kept), so the cascade order of the light theme is preserved.
// The note paper itself (user-chosen paper colour and ink) is left as is.
// Run after changing any stylesheet: npm run dark-css
// Output: src/dark.css (extension) and web/dark.css (mobile web). Do not edit.
import postcss from "postcss";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const DARK = 'html[data-theme="dark"]';
const PROPS =
  /^(--.*|color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline))?(-color)?|outline(-color)?|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?|scrollbar-color)$/;
// Paper and its content keep the user's paper colour and ink.
const PAPER =
  /\.nbPage|\.nbEditor|\.nbSheet|\.nbBinding|\.nbRing|\.paper\b|\.paperBody|\.editPaper|\.editor\b|\.memoBody|\.drawing|\.inkLayer|\.audioSticker|\.imageResize|\.freeImage/;
const COLOR =
  /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(white|black|gray|grey|silver)\b/g;
const NAMED = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
};

function parse(c) {
  if (NAMED[c]) return [...NAMED[c], 1];
  if (c[0] === "#") {
    let h = c.slice(1);
    if (h.length <= 4) h = [...h].map((x) => x + x).join("");
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const p = c
    .slice(c.indexOf("(") + 1, -1)
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((x) => (x.endsWith("%") ? parseFloat(x) / 100 : parseFloat(x)));
  return [p[0], p[1], p[2], p[3] ?? 1];
}
function toHsl(r, g, b) {
  (r /= 255), (g /= 255), (b /= 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min,
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
export function darken(c) {
  const [r, g, b, a] = parse(c);
  let [h, s, l] = toHsl(r, g, b);
  // White → deep slate, near-black ink → soft white, mid tones stay mid.
  let nl = 0.13 + (1 - l) * 0.77;
  if (l > 0.85) s *= 0.55; // pale tints become calm dark surfaces
  else if (s > 0.25 && l < 0.6) nl = Math.max(nl, 0.62); // accents stay readable
  nl = Math.min(0.92, Math.max(0.1, nl));
  const hsl = `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(nl * 100).toFixed(0)}%`;
  return a < 1 ? `${hsl} / ${+a.toFixed(3)})` : `${hsl})`;
}
function scope(sel) {
  sel = sel.trim();
  if (sel.startsWith(":root")) return DARK + sel.slice(5);
  if (/^html\b/.test(sel)) return DARK + sel.slice(4);
  if (sel.startsWith("[data-")) return DARK + sel;
  return `${DARK} ${sel}`;
}
function build(files, out) {
  const result = postcss.root();
  for (const f of files) {
    const css = postcss.parse(readFileSync(resolve(root, f), "utf8"));
    // Light values of colour variables, to judge and pin accent backgrounds.
    const vars = {};
    css.walkDecls(/^--/, (d) => (vars[d.prop] ??= d.value.trim()));
    const literal = (v) =>
      v.replace(/var\((--[\w-]+)\)/g, (m, n) => (n in vars && COLOR.test(vars[n]) ? ((COLOR.lastIndex = 0), vars[n]) : m));
    // Bars and buttons painted in a deep accent (e.g. the brand green)
    // already suit a dark page: keep the whole rule, so its light text stays,
    // and keep the rules for what sits inside such a bar too.
    const accent = (rule) => {
      let keep = false;
      rule.walkDecls(/^background(-color)?$/, (d) => {
        for (const c of literal(d.value).match(COLOR) || []) {
          const [r, g, b, a] = parse(c);
          const [, s, l] = toHsl(r, g, b);
          if (a > 0.6 && s > 0.15 && l < 0.45) keep = true;
          // Translucent white only makes sense on such a bar.
          if (a < 0.5 && l > 0.95) keep = true;
        }
      });
      return keep;
    };
    const bars = new Set();
    css.walkRules((rule) => {
      if (accent(rule))
        for (const s of rule.selectors)
          if (/^\.[\w-]+$/.test(s.trim())) bars.add(s.trim());
    });
    const inBar = (sel) =>
      [...bars].some((b) => new RegExp(`\\${b}(?![\\w-])[^,]*\\s`).test(sel));
    css.walkRules((rule) => {
      const at = rule.parent?.type === "atrule" ? rule.parent : null;
      if (at && (/print/.test(at.params) || /keyframes/.test(at.name))) return;
      const sels = rule.selectors.filter((s) => !PAPER.test(s));
      if (!sels.length) return;
      const keep = accent(rule) || sels.every(inBar);
      const decls = [];
      rule.walkDecls((d) => {
        if (!PROPS.test(d.prop)) return;
        if (/^background(-image)?$/.test(d.prop) && /url\(/.test(d.value)) return;
        COLOR.lastIndex = 0;
        if (d.prop.startsWith("--") && !COLOR.test(d.value)) return;
        decls.push(
          d.clone({
            value: keep
              ? literal(d.value)
              : d.value.replace(COLOR, (c) => darken(c)),
          }),
        );
      });
      if (!decls.length) return;
      const r = postcss.rule({ selectors: sels.map(scope) });
      r.append(decls);
      if (at) {
        const wrap = postcss.atRule({ name: at.name, params: at.params });
        wrap.append(r);
        result.append(wrap);
      } else result.append(r);
    });
  }
  writeFileSync(
    resolve(root, out),
    `/* Generated by scripts/build-dark-css.mjs from ${files.join(", ")}. Do not edit. */\n` +
      `${DARK} { color-scheme: dark; }\n` +
      result.toString() +
      "\n",
  );
  console.log(`${out}: ${result.nodes.length} rules`);
}
build(
  [
    "src/style.css",
    "src/popup.css",
    "src/notebook.css",
    "src/setup.css",
    "src/boba-support.css",
    "src/image-resize.css",
    "src/theme.css",
  ],
  "src/dark.css",
);
build(
  ["web/app.css", "src/boba-support.css", "src/image-resize.css", "src/theme.css"],
  "web/dark.css",
);
