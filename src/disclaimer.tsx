import React from "react";
import { t } from "./i18n";

export const DISCLAIMER_ITEMS = [
  "主密碼與救援金鑰只由你保管。Veil Bookmark 不會在任何地方（本機、Google Drive 或開發者）儲存或傳送你的主密碼或救援金鑰。",
  "忘記主密碼時，唯一的救援方式是使用救援金鑰；開發者無法協助找回密碼、救援金鑰或解密資料。",
  "主密碼與救援金鑰都遺失時，所有加密的書籤與記事將永久無法開啟。",
  "救援金鑰與主密碼同樣重要：取得救援金鑰的人可以重設密碼並開啟你的資料。請離線妥善保管，並定期匯出加密備份。",
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
