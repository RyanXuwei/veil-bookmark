import React from "react";
import { t } from "./i18n";

export const DISCLAIMER_ITEMS = [
  "主密碼只存在你的記憶中。Veil Bookmark 不會在任何地方（本機、Google Drive 或開發者）儲存、備份或傳送你的主密碼。",
  "沒有任何密碼救援或重設機制，開發者也無法協助找回密碼或解密資料。",
  "一旦遺失主密碼，所有加密的書籤與記事將永久無法開啟。",
  "請自行妥善保管主密碼，並定期匯出加密備份；備份檔同樣需要主密碼才能還原。",
  "本軟體依「現狀」提供，不提供任何明示或默示擔保。在法律允許的範圍內，開發者對資料遺失、無法存取或其他損害不負任何責任。",
];

export function Disclaimer() {
  return (
    <section className="disclaimer" aria-label={t("重要聲明")}>
      <h3>{t("重要聲明")}</h3>
      <ol>
        {DISCLAIMER_ITEMS.map((x) => (
          <li key={x}>{t(x)}</li>
        ))}
      </ol>
    </section>
  );
}
