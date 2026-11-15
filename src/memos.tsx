import React, { useState } from "react";
import type { Memo } from "./crypto";
import { lang, t } from "./i18n";

export type MemoDraft = { id: string; title: string; body: string };
export const emptyMemo: MemoDraft = { id: "", title: "", body: "" };

const firstLine = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .find(Boolean) || "";

export function memoTitle(m: { title: string; body: string }) {
  return m.title || firstLine(m.body).slice(0, 60) || t("未命名記事");
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
      </div>
      <div className="quickList" aria-label={t("加密記事清單")}>
        <ul>
          {shown.map((m) => {
            const preview =
              m.title && firstLine(m.body) ? firstLine(m.body) : "";
            return (
              <li className="quickItem" key={m.id}>
                <div className="quickRow">
                  <button
                    className="quickLink memoLink"
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

export function MemoEditor({
  memo,
  busy,
  onChange,
  onSave,
  onDelete,
  onClose,
}: {
  memo: MemoDraft;
  busy: boolean;
  onChange: (m: MemoDraft) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overlay">
      <section
        className="modal card memoModal"
        role="dialog"
        aria-modal="true"
        aria-label={t("記事編輯")}
      >
        <div className="modalTitle">
          <h2>{memo.id ? t("編輯記事") : t("新增加密記事")}</h2>
          <button onClick={onClose} aria-label={t("關閉")}>
            ×
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <label>
            {t("標題")}
            <input
              maxLength={300}
              value={memo.title}
              placeholder={t("選填")}
              onChange={(e) => onChange({ ...memo, title: e.target.value })}
            />
          </label>
          <label>
            {t("內容")}
            <textarea
              className="memoBody"
              autoFocus
              rows={12}
              maxLength={100_000}
              value={memo.body}
              onChange={(e) => onChange({ ...memo, body: e.target.value })}
            />
          </label>
          <div className="memoActions">
            {memo.id && (
              <button type="button" className="danger" onClick={onDelete}>
                {t("刪除")}
              </button>
            )}
            <button
              type="button"
              disabled={!memo.body}
              onClick={() =>
                navigator.clipboard.writeText(memo.body).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? t("已複製") : t("複製內容")}
            </button>
            <button
              className="primary"
              disabled={busy || (!memo.title.trim() && !memo.body.trim())}
            >
              {busy ? t("儲存中…") : t("加密儲存 →")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
