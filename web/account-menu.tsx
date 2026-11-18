import React, { useEffect, useRef, useState } from "react";
import { t, tError } from "../src/i18n";
import { account, accounts, activeAccount, selectAccount } from "./accounts";
import { prepareAccountSwitch, removeWorkspace, vault } from "./vault";
import { signInPopup } from "./google";

// A small round button in the header (the account's initial). Switching,
// adding, reconnecting and removing accounts live in the menu it opens.
export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const current = account();
  const label = current ? current.email : t("升級前的本機副本（離線）");
  function fail(message: string) {
    setError(message);
    setOpen(true); // errors are shown in the menu
  }
  async function connect(add = false) {
    if (document.querySelector(".editor, .memoEdit")) {
      fail(t("請先儲存並關閉編輯畫面，再切換帳戶"));
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
      fail((e as Error).message);
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
  // Tapping outside or pressing Escape closes the menu.
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="accountMenu" ref={box}>
      <button
        className="accountChip"
        aria-label={t("Google 帳戶") + "：" + label}
        aria-expanded={open}
        title={label}
        onClick={() => {
          setOpen(!open);
          setConfirmRemove(false);
        }}
      >
        {current ? (current.email[0] || "?").toUpperCase() : "⦸"}
      </button>
      {open && (
        <section className="accountPanel" aria-label={t("Google 帳戶")}>
          <select
            aria-label={t("切換帳戶")}
            disabled={busy}
            value={activeAccount()}
            onChange={async (e) => {
              if (document.querySelector(".editor, .memoEdit")) {
                fail(t("請先儲存並關閉編輯畫面，再切換帳戶"));
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
                fail((e as Error).message);
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
          <button disabled={busy} onClick={() => void connect(true)}>
            ＋ {t("新增帳戶")}
          </button>
          {current && !vault() && (
            <button disabled={busy} onClick={() => void connect()}>
              {t("重新連線 Google")}
            </button>
          )}
          {current &&
            (confirmRemove ? (
              <div className="accountRemoval">
                <p>
                  {t(
                    "只移除此帳戶的本機副本與解鎖設定，未同步的修改會遺失；其他帳戶及 Drive 資料不受影響。",
                  )}
                </p>
                <button
                  className="dangerText"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await removeWorkspace();
                      selectAccount("legacy");
                      location.reload();
                    } catch (e) {
                      setBusy(false);
                      fail((e as Error).message);
                    }
                  }}
                >
                  {t("確定移除此帳戶")}
                </button>
              </div>
            ) : (
              <button
                className="dangerText"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                {t("移除此帳戶")}
              </button>
            ))}
          {error && (
            <p className="error" role="alert">
              {tError(error)}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
