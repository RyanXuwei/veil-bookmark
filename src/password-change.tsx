import React, { useEffect, useRef, useState } from "react";
import { t, tError } from "./i18n";
type Rpc = (type: string, data?: Record<string, unknown>) => Promise<any>;
export function PasswordChangeSection({ rpc }: { rpc: Rpc }) {
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState("");
  const [proof, setProof] = useState<{
    verificationToken: string;
    expires: number;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!proof) return;
    const timer = window.setTimeout(
      () => {
        setProof(null);
        setNext("");
        setConfirm("");
      },
      Math.max(0, proof.expires - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [proof]);
  function reset() {
    setProof(null);
    setCurrent("");
    setNext("");
    setConfirm("");
    setError("");
    setSuccess(false);
  }
  async function verify() {
    setBusy(true);
    setError("");
    setSuccess(false);
    try {
      const r = await rpc("VERIFY_PASSWORD", { password: current });
      if (!mounted.current) return;
      setProof(r);
      setCurrent("");
    } catch (e) {
      if (mounted.current) {
        setProof(null);
        setError((e as Error).message);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function change() {
    if (!proof) return;
    setBusy(true);
    setError("");
    try {
      if (next !== confirm) throw Error("兩次密碼不一致");
      if (next.length < 4) throw Error("主密碼至少 4 個字元");
      await rpc("CHANGE_PASSWORD", {
        verificationToken: proof.verificationToken,
        newPassword: next,
        confirmPassword: confirm,
      });
      if (!mounted.current) return;
      reset();
      setSuccess(true);
    } catch (e) {
      if (mounted.current) {
        setError((e as Error).message);
        setProof(null);
        setNext("");
        setConfirm("");
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="passwordChange">
      <h3>{t("修改主密碼")}</h3>
      <p className="muted">
        {t("請先驗證原密碼，成功後才可輸入及確認新密碼。")}
      </p>
      {success && (
        <p className="notice" role="status">
          {t("主密碼已更新，下次請使用新密碼解鎖。")}
        </p>
      )}
      {error && (
        <p className="inlineError" role="alert">
          {tError(error)}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void verify();
        }}
      >
        <label>
          {t("原密碼")}
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            required
            disabled={busy || !!proof}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        {!proof ? (
          <button disabled={busy || !current}>
            {busy ? t("處理中…") : t("驗證原密碼")}
          </button>
        ) : (
          <div className="row">
            <span className="muted">{t("原密碼驗證成功")}</span>
            <button type="button" onClick={reset} disabled={busy}>
              {t("重新驗證")}
            </button>
          </div>
        )}
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void change();
        }}
      >
        <label>
          {t("新密碼")}
          <input
            type="password"
            autoComplete="new-password"
            minLength={4}
            required
            disabled={!proof || busy}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder={t("至少 4 個字元")}
          />
        </label>
        <label>
          {t("再次確認新密碼")}
          <input
            type="password"
            autoComplete="new-password"
            minLength={4}
            required
            disabled={!proof || busy}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={!proof || busy || next.length < 4 || !confirm}
        >
          {busy ? t("處理中…") : t("儲存新密碼")}
        </button>
      </form>
      <p className="small muted">
        {t("修改密碼不會清除收藏或記事，原救援金鑰仍可使用。")}
      </p>
    </section>
  );
}
