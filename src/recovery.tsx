import React, { useState } from "react";
import { t } from "./i18n";

/** Shown once after a recovery key is created; it is never stored anywhere. */
export function RecoveryKeyModal({
  code,
  onDone,
  quick = false,
}: {
  code: string;
  onDone: () => void;
  // One button instead of a checkbox + button (the phone's first setup).
  quick?: boolean;
}) {
  const [saved, setSaved] = useState(quick);
  const [copied, setCopied] = useState(false);
  function download() {
    const body = [
      "Veil Bookmark — " + t("救援金鑰"),
      "",
      code,
      "",
      t("忘記主密碼時，可用這組金鑰重設密碼。"),
      t("請離線妥善保管，不要存放在同一台電腦或與主密碼放在一起。"),
      t("建立日期：{date}", { date: new Date().toISOString().slice(0, 10) }),
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "Veil-Bookmark-recovery-key.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    // Always above other panels (e.g. Security), which also use .overlay.
    <div className="overlay overlayTop">
      <section
        className="modal card recoveryModal"
        role="alertdialog"
        aria-modal="true"
        aria-label={t("你的救援金鑰")}
      >
        <h2>{t("你的救援金鑰")}</h2>
        <p className="muted">
          {t(
            "忘記主密碼時，這是唯一能救回資料的方式。這組金鑰只會顯示這一次，請現在就抄寫、列印或下載後離線保存。",
          )}
        </p>
        <code
          className="recoveryCode"
          data-testid="recovery-code"
          data-code={code}
          aria-label={code}
        >
          {code.split("-").map((g, i, all) => (
            <span key={i}>
              {g}
              {i < all.length - 1 && <i>-</i>}
            </span>
          ))}
        </code>
        <div className="row">
          <button
            type="button"
            onClick={() =>
              navigator.clipboard.writeText(code).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? t("已複製") : t("複製")}
          </button>
          <button type="button" onClick={download}>
            {t("下載文字檔 ↓")}
          </button>
        </div>
        <p className="recoveryWarn">
          ⚠{" "}
          {t(
            "取得這組金鑰的人可以重設你的密碼並開啟資料。不要和主密碼放在一起，也不要存在這台電腦。",
          )}
        </p>
        {!quick && (
          <label className="ackRow">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
            />
            <span>{t("我已將救援金鑰保存在安全的地方")}</span>
          </label>
        )}
        <button className="primary full" disabled={!saved} onClick={onDone}>
          {quick ? t("我已保存，開始使用 →") : t("完成")}
        </button>
      </section>
    </div>
  );
}

/** Forgot-password form: recovery key + new password (+ backup file on a new computer). */
export function RecoverForm({
  needFile,
  busy,
  onSubmit,
}: {
  needFile: boolean;
  busy: boolean;
  onSubmit: (d: {
    recoveryKey: string;
    newPassword: string;
    confirm: string;
    file: File | null;
  }) => void;
}) {
  const [recoveryKey, setKey] = useState("");
  const [newPassword, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [file, setFile] = useState<File | null>(null);
  return (
    <form
      className="recoverForm"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ recoveryKey, newPassword, confirm, file });
      }}
    >
      {needFile && (
        <label>
          {t("加密備份檔")}
          <input
            type="file"
            accept=".json,application/json"
            required
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
      )}
      <label>
        {t("救援金鑰")}
        <input
          autoFocus
          className="recoveryInput"
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          value={recoveryKey}
          onChange={(e) => setKey(e.target.value)}
          required
        />
      </label>
      <label>
        {t("新的主密碼")}
        <input
          type="password"
          autoComplete="new-password"
          minLength={4}
          placeholder={t("至少 4 個字元")}
          value={newPassword}
          onChange={(e) => setPw(e.target.value)}
          required
        />
      </label>
      <label>
        {t("再次輸入密碼")}
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </label>
      <p className="small muted">
        {t("完成後會產生一組新的救援金鑰，舊的金鑰將無法再使用。")}
      </p>
      <button className="primary full" disabled={busy}>
        {busy ? t("處理中…") : t("重設主密碼 →")}
      </button>
    </form>
  );
}

/** Settings section: status of the recovery key and (re)creation. */
export function RecoverySection({
  hasRecovery,
  busy,
  onCreate,
}: {
  hasRecovery: boolean;
  busy: boolean;
  onCreate: (password: string) => Promise<boolean>;
}) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  return (
    <section className="recoverySection">
      <h3>{t("救援金鑰")}</h3>
      {hasRecovery ? (
        <p className="muted">
          {t("已建立。產生新的救援金鑰後，舊的金鑰會立即失效。")}
        </p>
      ) : (
        <p className="inlineError">
          {t("尚未建立救援金鑰。忘記主密碼時將無法救回資料，建議立即建立。")}
        </p>
      )}
      {asking ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void onCreate(password).then((ok) => {
              if (!ok) return;
              setPassword("");
              setAsking(false);
            });
          }}
        >
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            aria-label={t("輸入目前的主密碼")}
            placeholder={t("輸入目前的主密碼")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className="primary" disabled={busy}>
            {t("確認")}
          </button>
        </form>
      ) : (
        <button
          className={hasRecovery ? "" : "primary"}
          onClick={() => setAsking(true)}
        >
          {hasRecovery ? t("產生新的救援金鑰") : t("建立救援金鑰")}
        </button>
      )}
    </section>
  );
}
