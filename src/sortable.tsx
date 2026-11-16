// Popup folder tree with drag-and-drop ordering, shared by bookmarks and notes.
import React, { useRef, useState } from "react";
import type { Folder, FolderKind } from "./crypto";
import { t } from "./i18n";

type Orderable = { id: string; folder?: string; order?: number };

/** Items with a saved position first (in that order), the rest after. */
export function ordered<T extends Orderable>(
  list: T[],
  fallback: (a: T, b: T) => number,
) {
  return [...list].sort((a, b) =>
    a.order !== undefined && b.order !== undefined
      ? a.order - b.order
      : a.order !== undefined
        ? -1
        : b.order !== undefined
          ? 1
          : fallback(a, b),
  );
}

/** Folder names in display order: saved order first, then by name. */
export function folderNames(
  kind: FolderKind,
  records: Folder[] | undefined,
  items: Orderable[],
) {
  const live = (records || []).filter((f) => f.kind === kind && !f.deleted);
  const known = new Map(live.map((f) => [f.name, f.order]));
  const names = new Set([
    ...live.map((f) => f.name),
    ...items.map((x) => x.folder || "").filter(Boolean),
  ]);
  return [...names].sort((a, b) =>
    known.has(a) && known.has(b)
      ? known.get(a)! - known.get(b)!
      : known.has(a)
        ? -1
        : known.has(b)
          ? 1
          : a.localeCompare(b),
  );
}

type Drag = { type: "item"; id: string } | { type: "folder"; name: string };
type Hint =
  | { kind: "item"; id: string; after: boolean }
  | { kind: "into"; folder: string }
  | { kind: "folder"; name: string; after: boolean }
  | null;

export function FolderTree<T extends Orderable>({
  kind,
  folders,
  items,
  busy,
  renderItem,
  onReorder,
  onFolderOrder,
  onRenameFolder,
  onDeleteFolder,
  creating,
  onCreate,
  onCancelCreate,
}: {
  kind: FolderKind;
  folders: string[];
  items: T[]; // already in display order
  busy: boolean;
  renderItem: (x: T) => React.ReactNode;
  onReorder: (folder: string, ids: string[]) => void;
  onFolderOrder: (names: string[]) => void;
  onRenameFolder: (from: string, to: string) => void;
  onDeleteFolder: (name: string) => void;
  creating: boolean;
  onCreate: (name: string) => void;
  onCancelCreate: () => void;
}) {
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [hint, setHint] = useState<Hint>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const openTimer = useRef(0);
  const inFolder = (f: string) => items.filter((x) => (x.folder || "") === f);

  function end() {
    drag.current = null;
    setDragging(null);
    setHint(null);
    window.clearTimeout(openTimer.current);
  }
  function start(e: React.DragEvent, d: Drag) {
    if (busy) return e.preventDefault();
    drag.current = d;
    setDragging(d);
    setMenu(null);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", d.type === "item" ? d.id : d.name);
  }
  const lower = (e: React.DragEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  function dropOnItem(target: T, after: boolean) {
    const d = drag.current;
    if (d?.type !== "item" || d.id === target.id) return;
    const folder = target.folder || "";
    const ids = inFolder(folder)
      .map((x) => x.id)
      .filter((id) => id !== d.id);
    ids.splice(ids.indexOf(target.id) + (after ? 1 : 0), 0, d.id);
    onReorder(folder, ids);
  }
  function dropInto(folder: string) {
    const d = drag.current;
    if (d?.type !== "item") return;
    const ids = inFolder(folder)
      .map((x) => x.id)
      .filter((id) => id !== d.id);
    onReorder(folder, [...ids, d.id]);
  }
  function dropFolder(target: string, after: boolean) {
    const d = drag.current;
    if (d?.type !== "folder" || d.name === target) return;
    const names = folders.filter((f) => f !== d.name);
    names.splice(names.indexOf(target) + (after ? 1 : 0), 0, d.name);
    onFolderOrder(names);
  }
  function move(x: T, step: -1 | 1) {
    const ids = inFolder(x.folder || "").map((y) => y.id);
    const i = ids.indexOf(x.id);
    if (i + step < 0 || i + step >= ids.length) return;
    [ids[i], ids[i + step]] = [ids[i + step], ids[i]];
    onReorder(x.folder || "", ids);
  }

  const row = (x: T) => {
    const h = hint?.kind === "item" && hint.id === x.id ? hint : null;
    return (
      <li
        key={x.id}
        className={
          "quickItem" +
          (dragging?.type === "item" && dragging.id === x.id
            ? " dragging"
            : "") +
          (h ? (h.after ? " dropAfter" : " dropBefore") : "")
        }
        draggable={!busy}
        onDragStart={(e) => start(e, { type: "item", id: x.id })}
        onDragEnd={end}
        onDragOver={(e) => {
          if (drag.current?.type !== "item") return;
          e.preventDefault();
          e.stopPropagation();
          const after = lower(e);
          if (h?.after !== after || !h)
            setHint({ kind: "item", id: x.id, after });
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          dropOnItem(x, lower(e));
          end();
        }}
        onKeyDown={(e) => {
          // Keyboard reordering: Alt + ↑ / ↓.
          if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown"))
            return;
          e.preventDefault();
          move(x, e.key === "ArrowUp" ? -1 : 1);
        }}
      >
        {renderItem(x)}
      </li>
    );
  };

  return (
    <>
      {creating && (
        <NameForm
          placeholder={t("資料夾名稱")}
          submit={t("建立")}
          onSubmit={onCreate}
          onCancel={onCancelCreate}
        />
      )}
      {folders.map((f) => {
        const h =
          hint?.kind === "into" && hint.folder === f
            ? " dropInto"
            : hint?.kind === "folder" && hint.name === f
              ? hint.after
                ? " dropAfter"
                : " dropBefore"
              : "";
        const count = inFolder(f).length;
        return (
          <details
            className={
              "quickFolder" +
              (open.has(f) ? "" : " collapsed") +
              h +
              (dragging?.type === "folder" && dragging.name === f
                ? " dragging"
                : "")
            }
            key={f}
            // The menu and rename form live in the folder element, so keep it
            // rendered open while they show; items appear only when expanded.
            open={open.has(f) || menu === f || renaming === f}
          >
            <summary
              draggable={!busy && renaming !== f}
              onClick={(e) => {
                e.preventDefault();
                if (renaming === f) return;
                const next = new Set(open);
                if (next.has(f)) next.delete(f);
                else next.add(f);
                setOpen(next);
              }}
              onDragStart={(e) => start(e, { type: "folder", name: f })}
              onDragEnd={end}
              onDragOver={(e) => {
                const d = drag.current;
                if (!d) return;
                e.preventDefault();
                if (d.type === "item") {
                  if (hint?.kind !== "into" || hint.folder !== f) {
                    setHint({ kind: "into", folder: f });
                    // Hovering a closed folder opens it.
                    window.clearTimeout(openTimer.current);
                    openTimer.current = window.setTimeout(
                      () => setOpen((o) => new Set(o).add(f)),
                      700,
                    );
                  }
                } else {
                  const after = lower(e);
                  if (
                    hint?.kind !== "folder" ||
                    hint.name !== f ||
                    hint.after !== after
                  )
                    setHint({ kind: "folder", name: f, after });
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag.current?.type === "item") dropInto(f);
                else dropFolder(f, lower(e));
                end();
              }}
            >
              <span>▰</span>
              {renaming === f ? (
                <NameForm
                  inline
                  initial={f}
                  placeholder={t("資料夾名稱")}
                  submit={t("儲存")}
                  onSubmit={(to) => {
                    setRenaming(null);
                    if (open.has(f)) setOpen((o) => new Set(o).add(to));
                    onRenameFolder(f, to);
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <>
                  <strong>{f}</strong>
                  <small>{count}</small>
                  <button
                    type="button"
                    className="quickMore folderMore"
                    aria-label={t("資料夾操作：{title}", { title: f })}
                    aria-expanded={menu === f}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setConfirmDelete(null);
                      setMenu(menu === f ? null : f);
                    }}
                  >
                    ⋯
                  </button>
                </>
              )}
            </summary>
            {menu === f && (
              <div className="quickActions">
                <button
                  onClick={() => {
                    setMenu(null);
                    setRenaming(f);
                  }}
                >
                  {t("重新命名")}
                </button>
                <button
                  disabled={folders.indexOf(f) === 0}
                  onClick={() => {
                    const names = folders.filter((x) => x !== f);
                    names.splice(folders.indexOf(f) - 1, 0, f);
                    onFolderOrder(names);
                  }}
                >
                  {t("上移")}
                </button>
                <button
                  disabled={folders.indexOf(f) === folders.length - 1}
                  onClick={() => {
                    const names = folders.filter((x) => x !== f);
                    names.splice(folders.indexOf(f) + 1, 0, f);
                    onFolderOrder(names);
                  }}
                >
                  {t("下移")}
                </button>
                {confirmDelete === f ? (
                  <button
                    className="danger"
                    onClick={() => {
                      setMenu(null);
                      setConfirmDelete(null);
                      onDeleteFolder(f);
                    }}
                  >
                    {count
                      ? t("確定刪除？{count} 個項目會移到未分類", { count })
                      : t("確定刪除？")}
                  </button>
                ) : (
                  <button onClick={() => setConfirmDelete(f)}>
                    {t("刪除資料夾")}
                  </button>
                )}
              </div>
            )}
            {open.has(f) && (
              <ul>
                {inFolder(f).map(row)}
                {!count && (
                  <li className="quickFolderEmpty">{t("拖曳項目到這裡")}</li>
                )}
              </ul>
            )}
          </details>
        );
      })}
      <ul
        className={
          "quickRoot" +
          (dragging?.type === "item" &&
          items.find((x) => x.id === dragging.id)?.folder
            ? " dropZone"
            : "") +
          (hint?.kind === "into" && hint.folder === "" ? " dropInto" : "")
        }
        onDragOver={(e) => {
          if (drag.current?.type !== "item") return;
          e.preventDefault();
          if (hint?.kind !== "into" || hint.folder !== "")
            setHint({ kind: "into", folder: "" });
        }}
        onDrop={(e) => {
          e.preventDefault();
          dropInto("");
          end();
        }}
      >
        {inFolder("").map(row)}
        {dragging?.type === "item" &&
          items.find((x) => x.id === dragging.id)?.folder && (
            <li className="quickFolderEmpty">{t("拖到這裡移出資料夾")}</li>
          )}
      </ul>
    </>
  );
}

/** Small inline name form (new folder, rename). */
export function NameForm({
  initial = "",
  placeholder,
  submit,
  onSubmit,
  onCancel,
  inline,
}: {
  initial?: string;
  placeholder: string;
  submit: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  inline?: boolean;
}) {
  const [name, setName] = useState(initial);
  return (
    <form
      className={inline ? "nameForm inline" : "nameForm"}
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (name.trim()) onSubmit(name.trim());
      }}
    >
      <input
        autoFocus
        maxLength={100}
        aria-label={placeholder}
        placeholder={placeholder}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCancel();
        }}
      />
      <button type="submit">{submit}</button>
      <button type="button" onClick={onCancel}>
        {t("取消")}
      </button>
    </form>
  );
}

export function FolderPlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10.5v5M9.5 13h5" />
    </svg>
  );
}
