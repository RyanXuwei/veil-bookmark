import React, { useEffect, useState } from "react";
import { t, tError } from "../src/i18n";
import { account, accounts, activeAccount, selectAccount } from "./accounts";
import { prepareAccountSwitch, removeWorkspace, vault } from "./vault";
import { signInPopup } from "./google";

export function AccountMenu() {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function connect(add = false) {
    if (document.querySelector(".editor, .memoEdit")) {
      setError(t("請先儲存並關閉編輯畫面，再切換帳戶"));
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await prepareAccountSwitch();
      await signInPopup(add);
      location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  useEffect(() => {
    const reconnect = () => void connect();
    const removed = (e: StorageEvent) => {
      if (e.key === "veilAccount:" + activeAccount() && !e.newValue) {
        location.reload();
      }
    };
    window.addEventListener("veil-connect", reconnect);
    window.addEventListener("storage", removed);
    return () => {
      window.removeEventListener("veil-connect", reconnect);
      window.removeEventListener("storage", removed);
    };
  }, [busy]);
  return (
    <section className="accountBar" aria-label={t("Google 帳戶")}>
      <label>
        {t("Google 帳戶")}
        <select
          aria-label={t("切換帳戶")}
          disabled={busy}
          value={activeAccount()}
          onChange={async (e) => {
            if (document.querySelector(".editor, .memoEdit")) {
              setError(t("請先儲存並關閉編輯畫面，再切換帳戶"));
              return;
            }
            const id = e.target.value;
            setBusy(true);
            setError("");
            try {
              await prepareAccountSwitch();
              selectAccount(id);
              location.reload();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          <option value="legacy">{t("升級前的本機副本（離線）")}</option>
          {accounts().map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
      </label>
      <button disabled={busy} onClick={() => void connect(true)}>
        {t("新增帳戶")}
      </button>
      {account() && !vault() && (
        <button disabled={busy} onClick={() => void connect()}>
          {t("重新連線 Google")}
        </button>
      )}
      {account() && (
        <button
          disabled={busy}
          onClick={() => setConfirmRemove(!confirmRemove)}
        >
          {t("移除此帳戶")}
        </button>
      )}
      {confirmRemove && (
        <div className="accountRemoval">
          <p>
            {t(
              "只移除此帳戶的本機副本與解鎖設定，未同步的修改會遺失；其他帳戶及 Drive 資料不受影響。",
            )}
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await removeWorkspace();
                selectAccount("legacy");
                location.reload();
              } catch (e) {
                setBusy(false);
                setError((e as Error).message);
              }
            }}
          >
            {t("確定移除此帳戶")}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {tError(error)}
        </p>
      )}
    </section>
  );
}
