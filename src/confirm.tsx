// One confirmation dialog for every deletion in the extension: bookmarks,
// notes (popup and notebook page) and folders.
import React, { useEffect, useRef } from "react";
import { t } from "./i18n";

export function ConfirmDelete({
  title,
  detail,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  detail: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The safe choice has the focus; Escape cancels.
    cancel.current?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onCancel();
    };
    addEventListener("keydown", esc, true);
    return () => removeEventListener("keydown", esc, true);
  }, []);
  return (
    <div
      className="overlay confirmOverlay"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <section
        className="modal card confirmDelete"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2>{title}</h2>
        <p className="muted">{detail}</p>
        <div className="row">
          <button ref={cancel} onClick={onCancel}>
            {t("取消")}
          </button>
          <button className="danger" disabled={busy} onClick={onConfirm}>
            {t("刪除")}
          </button>
        </div>
      </section>
    </div>
  );
}

/** The detail line for a bookmark or a note. */
export const itemDeleteDetail = () =>
  t("刪除後會同步到所有裝置，無法復原。");
