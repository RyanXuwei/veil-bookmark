import React, { useEffect, useRef, useState } from "react";
import { t, tError } from "./i18n";
type Rpc = (type: string, data?: Record<string, unknown>) => Promise<any>;

/** Shown in Sync & backup when Google Drive holds a different vault: the
 *  user keeps either the Drive copy or this computer's copy. */
export function DriveConflict({
  rpc,
  onDone,
}: {
  rpc: Rpc;
  onDone: (notice: string) => Promise<void> | void;
}) {
  const [choice, setChoice] = useState<"" | "drive" | "local">("");
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  function pick(c: typeof choice) {
    setChoice(c);
    setPassword("");
    setConfirmed(false);
    setError("");
  }
  async function useDrive() {
    // Keep a copy of this computer's vault before it is replaced.
    const data = await rpc("EXPORT");
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `Veil Bookmark-encrypted-${new Date().toISOString().slice(0, 10)}-this-computer.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    await rpc("DRIVE_USE_REMOTE", { password });
    return "已改用 Google Drive 上的保險庫。這台電腦原本的資料已下載為加密備份。";
  }
  async function keepLocal() {
    await rpc("DRIVE_REPLACE", { password, confirm: true });
    return "已用這台電腦的保險庫取代 Google Drive 上的資料。";
  }
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const notice = choice === "drive" ? await useDrive() : await keepLocal();
      if (!mounted.current) return;
      pick("");
      await onDone(notice);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="driveConflict" aria-labelledby="driveConflictTitle">
      <h4 id="driveConflictTitle">{t("Google Drive 上有另一個保險庫")}</h4>
      <p className="small">
        {t(
          "這台電腦和 Drive 上的資料用不同的金鑰加密，無法自動合併。請選擇要保留哪一份，同步才會繼續。",
        )}
      </p>
      {error && (
        <p className="inlineError" role="alert">
          {tError(error)}
        </p>
      )}
      {!choice ? (
        <div className="conflictChoices">
          <button onClick={() => pick("drive")}>
            <strong>{t("改用 Drive 上的保險庫")}</strong>
            <small>
              {t("需要 Drive 保險庫的主密碼。這台電腦的資料會先下載為備份。")}
            </small>
          </button>
          <button onClick={() => pick("local")}>
            <strong>{t("以這台電腦取代 Drive")}</strong>
            <small>{t("Drive 上的舊保險庫會被刪除，無法復原。")}</small>
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="small">
            {choice === "drive"
              ? t(
                  "這台電腦的書籤與記事會被 Drive 上的保險庫取代。開始前會自動下載這台電腦的加密備份。",
                )
              : t(
                  "Drive 上的舊保險庫會被刪除，改存這台電腦的資料。其他仍使用舊保險庫的裝置，之後需要改用新的保險庫。",
                )}
          </p>
          <label>
            {choice === "drive"
              ? t("Drive 保險庫的主密碼")
              : t("這台電腦的主密碼")}
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              disabled={busy}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {choice === "local" && (
            <label className="ackRow">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>{t("我了解 Drive 上的舊資料將被刪除，無法復原")}</span>
            </label>
          )}
          <div className="row">
            <button
              className={choice === "local" ? "danger" : "primary"}
              disabled={busy || !password || (choice === "local" && !confirmed)}
            >
              {busy
                ? t("處理中…")
                : choice === "drive"
                  ? t("改用 Drive 上的保險庫")
                  : t("刪除 Drive 舊資料並上傳")}
            </button>
            <button type="button" disabled={busy} onClick={() => pick("")}>
              {t("取消")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
