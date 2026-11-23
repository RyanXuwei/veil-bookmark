// Light / dark appearance shared by the extension and the mobile web. The
// dark colours live in the generated dark.css (scripts/build-dark-css.mjs);
// this module only sets html[data-theme] and offers the picker.
import React from "react";
import { t } from "./i18n";
import "./theme.css";

export type Theme = "system" | "light" | "dark";
const CACHE = "veilTheme";
const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
export const isTheme = (x: unknown): x is Theme =>
  x === "system" || x === "light" || x === "dark";
let pref: Theme = cached();
function cached(): Theme {
  try {
    const v = localStorage.getItem(CACHE);
    return isTheme(v) ? v : "system";
  } catch {
    return "system";
  }
}
function paint() {
  const dark = pref === "dark" || (pref === "system" && !!media?.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
/** Applies a preference now and remembers it for the next page load. */
export function applyTheme(next: Theme) {
  pref = next;
  try {
    localStorage.setItem(CACHE, next);
  } catch {}
  paint();
}
export const themePref = () => pref;
media?.addEventListener?.("change", paint);
paint();

export function ThemePicker({
  value,
  onChange,
}: {
  value: Theme;
  onChange: (t: Theme) => void;
}) {
  const options: [Theme, string][] = [
    ["system", t("跟隨系統")],
    ["light", t("淺色")],
    ["dark", t("深色")],
  ];
  return (
    <div className="modeChoice" role="radiogroup" aria-label={t("外觀")}>
      {options.map(([mode, label]) => (
        <label key={mode}>
          <input
            type="radio"
            name="uiTheme"
            checked={value === mode}
            onChange={() => onChange(mode)}
          />
          {label}
        </label>
      ))}
    </div>
  );
}
