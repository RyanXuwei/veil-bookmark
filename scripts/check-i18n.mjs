// Verifies every translatable UI/background string has a 4-language entry.
import { readFileSync } from "node:fs";
const L = readFileSync("src/locales.ts", "utf8");
const missing = new Set();
for (const f of [
  "src/main.tsx",
  "src/setup.tsx",
  "src/memos.tsx",
  "src/disclaimer.tsx",
  "src/background.ts",
  "src/crypto.ts",
  "src/drive.ts",
]) {
  const s = readFileSync(f, "utf8");
  const re =
    /\b(?:t|Error|setError|setNotice)\(\s*(["`])((?:(?!\1)[^\\]|\\.)*)\1/g;
  for (const m of s.matchAll(re)) {
    let k = m[2];
    if (m[1] === "`") k = k.replace(/\$\{r\.status\}/, "{status}");
    if (/[㐀-鿿]/.test(k) && !L.includes(JSON.stringify(k) + ":"))
      missing.add(`${f}: ${k}`);
  }
}
// Disclaimer items are listed as plain strings and translated with t(x).
for (const m of readFileSync("src/disclaimer.tsx", "utf8").matchAll(
  /^\s+"([^"]+)",$/gm,
))
  if (!L.includes(JSON.stringify(m[1]) + ":"))
    missing.add(`src/disclaimer.tsx: ${m[1]}`);
if (/[\u0000]/.test(readFileSync("src/main.tsx", "utf8")))
  missing.add("src/main.tsx contains a NUL character");
if (missing.size) {
  console.error([...missing].join("\n"));
  process.exit(1);
}
console.log("i18n check passed");
