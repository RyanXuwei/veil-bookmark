import React, { useEffect, useRef, useState } from "react";
import { t, tError } from "./i18n";
import {
  checkPlan,
  summaryPlan,
  startSummary,
  type SummarySource,
} from "./local-summary";
type Rpc = (type: string, data?: Record<string, unknown>) => Promise<any>;
const LANGS = [
  ["zh-Hant", "繁體中文"],
  ["zh", "简体中文"],
  ["en", "English"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["es", "Español"],
  ["de", "Deutsch"],
  ["fr", "Français"],
];
export function SummaryPage({ rpc }: { rpc: Rpc }) {
  const id = new URLSearchParams(location.search).get("summary");
  const [status, setStatus] = useState<any>(null),
    [source, setSource] = useState<SummarySource | null>(null),
    [input, setInput] = useState("en"),
    [output, setOutput] = useState("zh-Hant");
  const [password, setPassword] = useState(""),
    [result, setResult] = useState(""),
    [error, setError] = useState(""),
    [progress, setProgress] = useState(""),
    [busy, setBusy] = useState(false),
    [available, setAvailable] = useState<boolean | null>(null),
    [saved, setSaved] = useState("");
  const auth = useRef(""),
    epoch = useRef(0),
    controller = useRef<AbortController | null>(null);
  async function refresh() {
    const generation = epoch.current,
      s = await rpc("STATUS");
    if (generation !== epoch.current) return;
    setStatus(s);
    if (!s.unlocked) return;
    const r = await rpc("SUMMARY_GET", { id });
    if (generation !== epoch.current) return;
    auth.current = r.authorization;
    setSource(r.source);
    const language = String(r.source.language).toLowerCase();
    setInput(
      language.startsWith("zh")
        ? /hant|tw|hk/.test(language)
          ? "zh-Hant"
          : "zh"
        : LANGS.find(([code]) => language.startsWith(code))?.[0] ||
            (/[ぁ-ゟァ-ヿ]/.test(r.source.text)
              ? "ja"
              : /[\u3400-\u9fff]/.test(r.source.text)
                ? "zh-Hant"
                : "en"),
    );
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const changed = (c: any, area: string) => {
      if (area === "session" && c.session && !c.session.newValue) {
        epoch.current++;
        controller.current?.abort();
        setSource(null);
        setResult("");
        setSaved("");
        setPassword("");
        setBusy(false);
        auth.current = "";
        setStatus((s: any) => ({ ...s, unlocked: false }));
      }
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      epoch.current++;
      controller.current?.abort();
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);
  useEffect(() => {
    let current = true;
    setAvailable(null);
    if (source)
      void checkPlan(summaryPlan(input, output))
        .then((v) => current && setAvailable(v))
        .catch(() => current && setAvailable(false));
    return () => {
      current = false;
    };
  }, [source, input, output]);
  useEffect(() => {
    if (!source) return;
    const timer = setTimeout(
      () => {
        epoch.current++;
        controller.current?.abort();
        setSource(null);
        setResult("");
        setBusy(false);
        setError(t("摘要頁面已過期，請重新右鍵擷取"));
      },
      Math.max(0, source.at + 600000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [source]);
  async function run() {
    const generation = epoch.current;
    controller.current = new AbortController();
    setBusy(true);
    setError("");
    setProgress("");
    setResult("");
    try {
      const text = await startSummary(
        summaryPlan(input, output),
        source!.text,
        controller.current.signal,
        (s) => generation === epoch.current && setProgress(s),
      );
      if (generation === epoch.current) setResult(text);
    } catch (e) {
      if (generation === epoch.current)
        setError(t("本機摘要失敗，可重試或檢查 Chrome 模型狀態"));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  return (
    <main
      className="summaryPage"
      style={{
        maxWidth: 760,
        margin: "32px auto",
        padding: 24,
        background: "#fff",
        borderRadius: 16,
      }}
    >
      <h1>{t("本機 AI 摘要")}</h1>
      {status?.unlocked && (
        <button onClick={() => void rpc("LOCK")}>{t("上鎖")}</button>
      )}
      <p>
        {t(
          "摘要與翻譯在這台電腦執行，首次使用可能下載 Chrome 模型。存入後依原設定加密同步。",
        )}
      </p>
      {error && (
        <p role="alert" className="inlineError">
          {tError(error)}
        </p>
      )}
      {status && !status.unlocked && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            try {
              await rpc("UNLOCK", { password });
              setPassword("");
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <p>{t("請先解鎖 Veil，再產生摘要。")}</p>
          <input
            type="password"
            autoComplete="current-password"
            aria-label={t("主密碼")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button>{t("解鎖保險庫 →")}</button>
        </form>
      )}
      {source && (
        <>
          <h2>{source.title}</h2>
          <p style={{ overflowWrap: "anywhere" }}>{source.url}</p>
          {source.truncated && (
            <p className="note">{t("本摘要僅涵蓋頁面前段文字")}</p>
          )}
          <div className="row">
            <label>
              {t("來源語言（可修改）")}
              <select
                aria-label={t("來源語言（可修改）")}
                disabled={busy || !!result}
                value={input}
                onChange={(e) => setInput(e.target.value)}
              >
                {LANGS.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("摘要語言")}
              <select
                aria-label={t("摘要語言")}
                disabled={busy || !!result}
                value={output}
                onChange={(e) => setOutput(e.target.value)}
              >
                {LANGS.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {available === false && (
            <p role="status">
              {t(
                "此裝置或語言尚不支援 Chrome 本機摘要。需要支援本機 AI 的電腦版 Chrome，請確認模型、硬體與可用空間。",
              )}
            </p>
          )}
          {!saved && !result && (
            <button
              className="primary"
              disabled={busy || available !== true}
              onClick={() => void run()}
            >
              {busy ? t("處理中…") + " " + progress : t("開始本機摘要")}
            </button>
          )}
          {busy && !result && (
            <button
              onClick={() => {
                epoch.current++;
                controller.current?.abort();
                setBusy(false);
                setProgress("");
              }}
            >
              {t("取消")}
            </button>
          )}
          {result && !saved && (
            <>
              <label>
                {t("摘要")}
                <textarea
                  aria-label={t("摘要")}
                  rows={14}
                  value={result}
                  onChange={(e) => setResult(e.target.value)}
                  maxLength={30000}
                />
              </label>
              <button
                className="primary"
                disabled={busy || !result.trim()}
                onClick={async () => {
                  const generation = epoch.current;
                  setBusy(true);
                  setError("");
                  try {
                    const r = await rpc("SUMMARY_SAVE", {
                      id,
                      summary: result,
                      authorization: auth.current,
                    });
                    if (generation === epoch.current) {
                      setSaved(r.id);
                      setResult("");
                    }
                  } catch (e) {
                    if (generation === epoch.current)
                      setError((e as Error).message);
                  } finally {
                    if (generation === epoch.current) setBusy(false);
                  }
                }}
              >
                {t("加密存入記事本")}
              </button>
            </>
          )}
          {saved && (
            <p role="status">
              {t("已加入記事本")}{" "}
              <a href={"index.html?notes#" + saved}>{t("開啟記事")}</a>
            </p>
          )}
        </>
      )}
    </main>
  );
}
