import React, { useState } from "react";
import { memoText } from "./sanitize";
import type { Memo } from "./crypto";
import { lang, t } from "./i18n";

export type MemoDraft = { id: string; title: string; body: string };
export const emptyMemo: MemoDraft = { id: "", title: "", body: "" };

const firstLine = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .find(Boolean) || "";

export function memoTitle(m: { title: string; body: string; format?: string }) {
  return m.title || firstLine(memoText(m)).slice(0, 60) || t("未命名記事");
}

export function MemoList({
  memos,
  onOpen,
}: {
  memos: Memo[];
  onOpen: (m: MemoDraft) => void;
}) {
  const [query, setQuery] = useState("");
  const live = memos
    .filter((m) => !m.deleted)
    .sort((a, b) => b.updated - a.updated);
  const q = query.toLowerCase();
  const shown = live.filter((m) =>
    `${m.title} ${m.body}`.toLowerCase().includes(q),
  );
  return (
    <>
      <div className="quickSearch">
        <input
          autoFocus
          aria-label={t("搜尋記事")}
          placeholder={t("搜尋記事…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="quickTools">
        <button
          className="quickCapture"
          onClick={() => onOpen({ ...emptyMemo })}
        >
          {t("＋ 新增記事")}
        </button>
        <button onClick={() => onOpen({ ...emptyMemo })}>
          {t("開啟筆記本 ↗")}
        </button>
      </div>
      <div className="quickList" aria-label={t("加密記事清單")}>
        <ul>
          {shown.map((m) => {
            const text = memoText(m);
            const preview = m.title && firstLine(text) ? firstLine(text) : "";
            return (
              <li className="quickItem" key={m.id}>
                <div className="quickRow">
                  <button
                    className="quickLink memoLink"
                    title={t("在筆記本中開啟")}
                    onClick={() =>
                      onOpen({ id: m.id, title: m.title, body: m.body })
                    }
                  >
                    <span className="quickIcon">✎</span>
                    <span className="quickText">
                      <strong>{memoTitle(m)}</strong>
                      <small>
                        {new Date(m.updated).toLocaleDateString(lang())}
                        {preview && ` · ${preview.slice(0, 80)}`}
                      </small>
                    </span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        {!shown.length && (
          <div className="quickEmpty">
            <span>✎</span>
            <p>{query ? t("沒有符合的記事") : t("還沒有加密記事")}</p>
            <small>
              {query
                ? t("試試其他關鍵字")
                : t("密碼提示、帳號資訊或私人想法，都能加密記下。")}
            </small>
          </div>
        )}
      </div>
    </>
  );
}
