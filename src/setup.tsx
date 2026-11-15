import React, { useEffect, useState } from "react";
import "./setup.css";
import { LANGS, lang, saveLang, t, tError, type Lang } from "./i18n";

type Rpc = (type: string, data?: Record<string, unknown>) => Promise<any>;
const CLIENT_ID_RE = /^[\w-]+\.apps\.googleusercontent\.com$/;
const LINKS = {
  api: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
  consent: "https://console.cloud.google.com/auth/overview",
  audience: "https://console.cloud.google.com/auth/audience",
  client: "https://console.cloud.google.com/auth/clients/create",
};

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copyField">
      <code>{value}</code>
      <button
        type="button"
        onClick={() =>
          navigator.clipboard.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
        }
      >
        {done ? t("已複製") : t("複製")}
      </button>
    </div>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="extLink"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children} ↗
    </a>
  );
}

export function SetupPage({ rpc }: { rpc: Rpc }) {
  const [status, setStatus] = useState<any>(null);
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uiLang, setUiLang] = useState<Lang>(lang());
  async function refresh() {
    const s = await rpc("STATUS");
    setStatus(s);
    return s;
  }
  useEffect(() => {
    refresh()
      .then((s) => setClientId(s.oauthClientId || ""))
      .catch((e) => setError(e.message));
  }, []);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await refresh().catch(() => {});
      setBusy(false);
    }
  }
  const valid = CLIENT_ID_RE.test(clientId.trim());
  const builtIn = status?.oauthSource === "manifest";
  const state = !status
    ? ""
    : status.driveEnabled
      ? "on"
      : status.configured
        ? "ready"
        : "off";
  return (
    <div className="setup">
      <header className="setupHeader">
        <img className="productIcon" src="icons/32.png" alt="" />
        <strong>Veil Bookmark</strong>
        <select
          className="langSelect"
          aria-label={t("介面語言")}
          value={uiLang}
          onChange={(e) => {
            const next = e.target.value as Lang;
            setUiLang(next);
            void saveLang(next);
          }}
        >
          {LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </header>
      <main className="setupMain">
        <h1>
          {builtIn ? t("連接 Google Drive") : t("設定 Google Drive 同步")}
        </h1>
        <p className="lead">
          {builtIn
            ? t(
                "Veil Bookmark 已內建 Google 授權，不需要建立 Google Cloud 專案或輸入任何金鑰。資料直接在你的瀏覽器與 Google Drive 之間傳輸，不經過任何第三方伺服器。",
              )
            : t(
                "Veil Bookmark 使用你自己的 Google Cloud 專案連線 Drive，不經過任何第三方伺服器。只需設定一次，約 10 分鐘。",
              )}
        </p>
        <div className={`setupStatus ${state}`} role="status">
          <span className="dot" />
          {state === "on"
            ? t("已連接，自動同步中")
            : state === "ready"
              ? builtIn
                ? t("尚未連接")
                : t("已設定，尚未連接")
              : state === "off"
                ? t("尚未設定")
                : t("正在讀取…")}
        </div>
        {error && (
          <div className="alert" role="alert">
            {tError(error)}
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {t(notice)}
          </div>
        )}

        {builtIn ? (
          <ol className="steps">
            <li>
              <h2>{t("解鎖保險庫")}</h2>
              <p>
                {status?.exists
                  ? t("在工具列浮框輸入主密碼解鎖，再回到這一頁。")
                  : t(
                      "這台電腦還沒有保險庫：在工具列浮框輸入原本的主密碼，按「從 Google Drive 還原」即可取回資料。",
                    )}
              </p>
              {status?.unlocked && <p className="okLine">✓ {t("已解鎖")}</p>}
            </li>
            <li>
              <h2>{t("按「連接 Google Drive」")}</h2>
              <p>
                {t(
                  "Chrome 會開啟 Google 授權視窗。若 Chrome 尚未登入 Google，會先請你登入。",
                )}
              </p>
              {state === "on" ? (
                <p className="okLine">✓ {t("已連接，自動同步中")}</p>
              ) : (
                <button
                  className="primary"
                  disabled={busy || !status?.unlocked}
                  onClick={() =>
                    run(async () => {
                      await rpc("SYNC");
                      setNotice("已合併並同步加密收藏。");
                    })
                  }
                >
                  {busy ? t("處理中…") : t("連接 Google Drive")}
                </button>
              )}
            </li>
            <li>
              <h2>{t("選擇帳號並允許")}</h2>
              <p>
                {t(
                  "選擇要用來同步的 Google 帳號，按「允許」。授權畫面會說明 Veil Bookmark 只能存取它自己在 Drive 中的應用程式資料。",
                )}
              </p>
            </li>
            <li>
              <h2>{t("完成")}</h2>
              <p>
                {t(
                  "解鎖期間每 5 分鐘自動同步。其他電腦安裝後，在歡迎畫面輸入同一個主密碼，按「從 Google Drive 還原」。",
                )}
              </p>
            </li>
          </ol>
        ) : (
          <ol className="steps">
            <li>
              <h2>{t("啟用 Google Drive API")}</h2>
              <p>
                {t(
                  "登入 Google Cloud Console，建立（或選擇）一個專案，然後按「啟用」。",
                )}
              </p>
              <Ext href={LINKS.api}>{t("開啟 Drive API 頁面")}</Ext>
            </li>
            <li>
              <h2>{t("設定 OAuth 同意畫面")}</h2>
              <p>
                {t(
                  "應用程式名稱可填 Veil Bookmark，使用者類型選「外部」。在「目標對象」把你自己的 Gmail 加入測試使用者。",
                )}
              </p>
              <div className="linkRow">
                <Ext href={LINKS.consent}>{t("開啟 OAuth 同意畫面")}</Ext>
                <Ext href={LINKS.audience}>
                  {t("開啟目標對象（測試使用者）")}
                </Ext>
              </div>
            </li>
            <li>
              <h2>{t("建立 OAuth 用戶端")}</h2>
              <p>
                {t(
                  "應用程式類型選「網頁應用程式」。在「已授權的重新導向 URI」貼上下方網址，然後按「建立」。",
                )}
              </p>
              {status?.redirectUrl ? (
                <Copy value={status.redirectUrl} />
              ) : (
                <p className="muted">{t("正在讀取…")}</p>
              )}
              <p className="hint">
                {t(
                  "每台電腦的網址可能不同。在其他電腦設定時，把那台電腦顯示的網址加到同一個用戶端即可，不必重建。",
                )}
              </p>
              <Ext href={LINKS.client}>{t("開啟建立用戶端頁面")}</Ext>
            </li>
            <li>
              <h2>{t("貼上用戶端 ID 並連接")}</h2>
              <p>
                {t(
                  "複製剛建立的「用戶端 ID」貼在下方。不需要用戶端密碼（Client Secret），請勿貼上。",
                )}
              </p>
              <form
                className="clientForm"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await rpc("SET_CLIENT_ID", { clientId: clientId.trim() });
                    const s = await refresh();
                    if (!s.unlocked) {
                      setNotice(
                        s.exists
                          ? "已儲存。請在工具列浮框解鎖後，回到此頁按「連接 Google Drive」。"
                          : "已儲存。新電腦請在工具列浮框輸入主密碼，按「從 Google Drive 還原」。",
                      );
                      return;
                    }
                    await rpc("SYNC");
                    setNotice("已合併並同步加密收藏。");
                  });
                }}
              >
                <input
                  aria-label={t("用戶端 ID")}
                  placeholder="123456789-abc.apps.googleusercontent.com"
                  spellCheck={false}
                  autoComplete="off"
                  value={clientId}
                  disabled={status?.oauthSource === "manifest"}
                  onChange={(e) => setClientId(e.target.value)}
                />
                <button
                  className="primary"
                  disabled={
                    busy || !valid || status?.oauthSource === "manifest"
                  }
                >
                  {busy ? t("處理中…") : t("儲存並連接 Google Drive →")}
                </button>
              </form>
              {clientId && !valid && (
                <p className="inlineError">
                  {t(
                    "用戶端 ID 格式不正確，應以 .apps.googleusercontent.com 結尾",
                  )}
                </p>
              )}
              {state === "ready" && status?.unlocked && (
                <button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await rpc("SYNC");
                      setNotice("已合併並同步加密收藏。");
                    })
                  }
                >
                  {t("連接 Google Drive")}
                </button>
              )}
            </li>
          </ol>
        )}

        <section className="setupNotes">
          <h3>{t("隱私說明")}</h3>
          <ul>
            <li>
              {t(
                "只請求 drive.appdata 權限：資料放在 Drive 中你看不到的應用程式資料夾，不會讀取你的其他檔案。",
              )}
            </li>
            <li>{t("上傳前已用主密碼加密，Google 看不到書籤內容。")}</li>
            {builtIn ? (
              <li>
                {t(
                  "授權由 Chrome 管理。可隨時在 Google 帳戶的「第三方存取權」移除 Veil Bookmark，或在「同步與備份」中斷連線。",
                )}{" "}
                <Ext href="https://myaccount.google.com/permissions">
                  {t("Google 帳戶權限")}
                </Ext>
              </li>
            ) : (
              <li>
                {t(
                  "授權約 1 小時到期，解鎖期間會自動在背景更新；瀏覽器重新啟動後可能需要再按一次連接。",
                )}
              </li>
            )}
          </ul>
          {status?.oauthSource === "user" && (
            <button
              className="text danger"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await rpc("CLEAR_CLIENT_ID");
                  setClientId("");
                  setNotice("已移除 Google Drive 設定，本機收藏不受影響。");
                })
              }
            >
              {t("移除 Google Drive 設定")}
            </button>
          )}
        </section>
      </main>
      <footer>
        <span>Made by Ryan Hsu · BitingBox Studio</span>
      </footer>
    </div>
  );
}
