import { LOCALES } from "./locales";

export const LANGS = [
  { code: "zh-TW", label: "繁體中文" },
  { code: "zh-CN", label: "简体中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
] as const;
export type Lang = (typeof LANGS)[number]["code"];

let current: Lang = detect(navigator.language);

export function detect(browser: string): Lang {
  const l = browser.toLowerCase();
  if (l.startsWith("zh")) return /hans|cn|sg/.test(l) ? "zh-CN" : "zh-TW";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("ko")) return "ko";
  if (l.startsWith("en")) return "en";
  return "en";
}
export function lang() {
  return current;
}
export function setLang(l: Lang) {
  current = l;
  document.documentElement.lang =
    l === "zh-TW" ? "zh-Hant" : l === "zh-CN" ? "zh-Hans" : l;
  document.title = t("Veil Bookmark · 私藏好去處");
}
export async function loadLang() {
  try {
    const { uiLang } = await chrome.storage.local.get<{ uiLang?: Lang }>(
      "uiLang",
    );
    if (uiLang && LANGS.some((x) => x.code === uiLang)) current = uiLang;
  } catch {}
  setLang(current);
  return current;
}
export async function saveLang(l: Lang) {
  setLang(l);
  await chrome.storage.local.set({ uiLang: l });
}

/** Translate a zh-TW source string; `{name}` placeholders are filled from vars. */
export function t(key: string, vars: Record<string, string | number> = {}) {
  const s = current === "zh-TW" ? key : (LOCALES[key]?.[current] ?? key);
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Translate an error message coming from the background service. */
export function tError(message: string) {
  if (LOCALES[message] || current === "zh-TW") return t(message);
  const drive = /^Drive 請求失敗 \((\d+)\)，本機資料已保留$/.exec(message);
  if (drive)
    return t("Drive 請求失敗 ({status})，本機資料已保留", { status: drive[1] });
  return message;
}
