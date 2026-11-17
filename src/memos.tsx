import React, { useState } from "react";
import { memoText } from "./sanitize";
import type { Folder, Memo } from "./crypto";
import { lang, t } from "./i18n";
import { baseName, depthOf } from "./folders";
import { ConfirmDelete, itemDeleteDetail } from "./confirm";
import {
  FolderPlusIcon,
  FolderTree,
  NameForm,
  folderNames,
  ordered,
} from "./sortable";

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

type Organize = {
  reorder: (kind: "memo", folder: string, ids: string[]) => unknown;
  folderOrder: (kind: "memo", names: string[]) => unknown;
  create: (kind: "memo", name: string) => unknown;
  rename: (kind: "memo", from: string, to: string) => unknown;
  remove: (kind: "memo", name: string) => unknown;
  move: (kind: "memo", from: string, to: string, order?: string[]) => unknown;
};

export function MemoList({
  memos,
  folderRecords,
  busy,
  onOpen,
  onMeta,
  onDelete,
  organize,
}: {
  memos: Memo[];
  folderRecords?: Folder[];
  busy: boolean;
  onOpen: (m: MemoDraft) => void;
  onMeta: (id: string, meta: { title?: string; folder?: string }) => void;
  onDelete: (id: string) => void;
  organize: Organize;
}) {
  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const live = ordered(
    memos.filter((m) => !m.deleted),
    (a, b) => b.updated - a.updated,
  );
  const folders = folderNames("memo", folderRecords, live);
  const q = query.toLowerCase();
  const shown = live.filter((m) =>
    `${m.title} ${memoText(m)}`.toLowerCase().includes(q),
  );
  const open = (m: Memo) => onOpen({ id: m.id, title: m.title, body: m.body });
  function closeMenu() {
    setMenuId(null);
    setRenaming(null);
    setMoving(null);
    setDeleting(null);
  }

  const row = (m: Memo) => {
    const text = memoText(m);
    const preview = m.title && firstLine(text) ? firstLine(text) : "";
    return (
      <>
        <div className="quickRow">
          {renaming === m.id ? (
            <NameForm
              inline
              initial={m.title}
              placeholder={t("記事標題")}
              submit={t("儲存")}
              onSubmit={(title) => {
                closeMenu();
                onMeta(m.id, { title });
              }}
              onCancel={closeMenu}
            />
          ) : (
            <>
              <button
                className="quickLink memoLink"
                title={t("在記事本中開啟")}
                onClick={() => open(m)}
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
              <button
                className="quickMore"
                aria-label={t("更多操作：{title}", { title: memoTitle(m) })}
                aria-expanded={menuId === m.id}
                onClick={() => {
                  const next = menuId === m.id ? null : m.id;
                  closeMenu();
                  setMenuId(next);
                }}
              >
                ⋯
              </button>
            </>
          )}
        </div>
        {menuId === m.id && renaming !== m.id && (
          <div className="quickActions">
            <button disabled={busy} onClick={() => open(m)}>
              {t("在記事本中開啟")}
            </button>
            <button onClick={() => setRenaming(m.id)}>{t("重新命名")}</button>
            {moving === m.id ? (
              <select
                autoFocus
                aria-label={t("移到資料夾")}
                value={m.folder || ""}
                onChange={(e) => {
                  closeMenu();
                  onMeta(m.id, { folder: e.target.value });
                }}
              >
                <option value="">{t("未分類")}</option>
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {"\u00a0\u00a0".repeat(depthOf(f)) + baseName(f)}
                  </option>
                ))}
              </select>
            ) : (
              <button onClick={() => setMoving(m.id)}>{t("移到資料夾")}</button>
            )}
            <button onClick={() => setDeleting(m.id)}>{t("刪除")}</button>
          </div>
        )}
      </>
    );
  };

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
          {t("開啟記事本 ↗")}
        </button>
        <button
          className="quickNewFolder"
          title={t("新增資料夾")}
          aria-label={t("新增資料夾")}
          onClick={() => setCreating(true)}
        >
          <FolderPlusIcon />
        </button>
      </div>
      <div className="quickList" aria-label={t("加密記事清單")}>
        {query ? (
          <ul>
            {shown.map((m) => (
              <li className="quickItem" key={m.id}>
                {row(m)}
              </li>
            ))}
          </ul>
        ) : (
          <FolderTree
            kind="memo"
            folders={folders}
            items={live}
            busy={busy}
            renderItem={row}
            onReorder={(f, ids) => void organize.reorder("memo", f, ids)}
            onFolderOrder={(n) => void organize.folderOrder("memo", n)}
            onRenameFolder={(a, b) => void organize.rename("memo", a, b)}
            onDeleteFolder={(f) => void organize.remove("memo", f)}
            onMoveFolder={(a, b, o) => void organize.move("memo", a, b, o)}
            creating={creating}
            onCreate={(n) => {
              setCreating(false);
              void organize.create("memo", n);
            }}
            onCancelCreate={() => setCreating(false)}
          />
        )}
        {deleting && (
          <ConfirmDelete
            title={t("刪除「{title}」？", {
              title: memoTitle(live.find((m) => m.id === deleting) || {
                title: "",
                body: "",
              }),
            })}
            detail={itemDeleteDetail()}
            busy={busy}
            onCancel={() => setDeleting(null)}
            onConfirm={() => {
              const id = deleting;
              closeMenu();
              onDelete(id);
            }}
          />
        )}
        {!shown.length && (query || (!folders.length && !creating)) && (
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
