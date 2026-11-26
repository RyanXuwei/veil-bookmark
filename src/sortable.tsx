// Popup folder tree with drag-and-drop ordering, shared by bookmarks and notes.
import React, { useEffect, useRef, useState } from "react";
import type { Folder, FolderKind } from "./crypto";
import { t } from "./i18n";
import {
  baseName,
  cleanSegment,
  depthOf,
  folderTree,
  joinPath,
  parentOf,
  pathLabel,
  within,
  PRIVATE_FOLDER,
} from "./folders";
const folderLabel = (p: string) =>
  p === PRIVATE_FOLDER ? t(PRIVATE_FOLDER) : baseName(p);
import { ConfirmDelete } from "./confirm";

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

/** Folder paths in display (tree) order, ancestors included. */
export function folderNames(
  kind: FolderKind,
  records: Folder[] | undefined,
  items: Orderable[],
) {
  return folderTree(kind, records, items);
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
  onMoveFolder,
  onDeleteFolder,
  creating,
  onCreate,
  onCancelCreate,
  current = "",
  onCurrent,
}: {
  kind: FolderKind;
  folders: string[]; // full paths in tree order (folderNames)
  items: T[]; // already in display order
  busy: boolean;
  renderItem: (x: T) => React.ReactNode;
  onReorder: (folder: string, ids: string[]) => void;
  onFolderOrder: (names: string[]) => void;
  onRenameFolder: (from: string, to: string) => void;
  /** Moves a folder (and everything in it) to a new full path; `order` is
   *  the new order of its siblings there. */
  onMoveFolder: (from: string, to: string, order?: string[]) => void;
  onDeleteFolder: (name: string) => void;
  creating: boolean;
  onCreate: (name: string) => void;
  onCancelCreate: () => void;
  /** The folder the user is in ("" = top level): the last folder opened.
   *  New items and new folders go there. */
  current?: string;
  onCurrent?: (folder: string) => void;
}) {
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [hint, setHint] = useState<Hint>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const openTimer = useRef(0);
  void kind;
  // A current folder chosen elsewhere (restored, or renamed) shows open.
  useEffect(() => {
    if (current) openPath(current);
  }, [current]);
  /** Keeps the current folder pointing at the same place after `from`
   *  became `to` (renamed or moved). */
  const follow = (from: string, to: string) => {
    if (onCurrent && within(current, from))
      onCurrent(to + current.slice(from.length));
  };
  const inFolder = (f: string) => items.filter((x) => (x.folder || "") === f);
  const children = (parent: string) =>
    folders.filter((f) => parentOf(f) === parent);
  const countIn = (f: string) =>
    items.filter((x) => within(x.folder || "", f)).length;
  const openPath = (f: string) =>
    setOpen((o) => {
      const next = new Set(o);
      for (let p = f; p; p = parentOf(p)) next.add(p);
      return next;
    });

  function end() {
    drag.current = null;
    setDragging(null);
    setHint(null);
    window.clearTimeout(openTimer.current);
  }
  function start(e: React.DragEvent, d: Drag) {
    if (busy) return e.preventDefault();
    e.stopPropagation();
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
  // A folder dropped on a folder: the upper and lower quarters place it
  // before or after (as a sibling), the middle puts it inside.
  const folderZone = (e: React.DragEvent): "before" | "after" | "into" => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.25 ? "before" : y > 0.75 ? "after" : "into";
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
  /** Moves `from` under `parent`, at `index` among its new siblings. */
  function placeFolder(from: string, parent: string, index?: number) {
    if (within(parent, from)) return; // not into itself
    const to = joinPath(parent, baseName(from));
    const siblings = children(parent).filter((f) => f !== from && f !== to);
    siblings.splice(index ?? siblings.length, 0, to);
    if (to === from) onFolderOrder(siblings);
    else {
      if (folders.includes(to)) return; // a sibling has the same name
      onMoveFolder(from, to, siblings);
      follow(from, to);
      if (open.has(from)) openPath(to);
    }
  }
  function dropFolder(target: string, zone: "before" | "after" | "into") {
    const d = drag.current;
    if (d?.type !== "folder" || d.name === target) return;
    if (zone === "into") return placeFolder(d.name, target);
    const parent = parentOf(target);
    const siblings = children(parent).filter((f) => f !== d.name);
    placeFolder(
      d.name,
      parent,
      siblings.indexOf(target) + (zone === "after" ? 1 : 0),
    );
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

  const folderNode = (f: string): React.ReactNode => {
    const h =
      hint?.kind === "into" && hint.folder === f
        ? " dropInto"
        : hint?.kind === "folder" && hint.name === f
          ? hint.after
            ? " dropAfter"
            : " dropBefore"
          : "";
    const count = countIn(f);
    const siblings = children(parentOf(f));
    const index = siblings.indexOf(f);
    const subs = children(f);
    const isOpen = open.has(f);
    return (
      <details
        className={
          "quickFolder" +
          (isOpen ? "" : " collapsed") +
          (current === f ? " current" : "") +
          h +
          (dragging?.type === "folder" && dragging.name === f
            ? " dragging"
            : "")
        }
        key={f}
        style={{ "--depth": depthOf(f) } as React.CSSProperties}
        // The menu and forms live in the folder element, so keep it rendered
        // open while they show; contents appear only when expanded.
        open={
          isOpen ||
          menu === f ||
          renaming === f ||
          creatingIn === f ||
          (creating && current === f) ||
          moving === f
        }
      >
        <summary
          draggable={!busy && renaming !== f}
          onClick={(e) => {
            e.preventDefault();
            if (renaming === f) return;
            // An open folder you are not in: go into it (a second click
            // closes it).
            if (open.has(f) && onCurrent && !within(current, f))
              return onCurrent(f);
            const next = new Set(open);
            if (next.has(f)) {
              next.delete(f);
              // Closing the folder you are in (or one around it) goes up.
              if (onCurrent && within(current, f)) onCurrent(parentOf(f));
            } else {
              next.add(f);
              onCurrent?.(f);
            }
            setOpen(next);
          }}
          onDragStart={(e) => start(e, { type: "folder", name: f })}
          onDragEnd={end}
          onDragOver={(e) => {
            const d = drag.current;
            if (!d) return;
            e.preventDefault();
            e.stopPropagation();
            if (d.type === "item" || folderZone(e) === "into") {
              if (d.type === "folder" && within(f, d.name)) return;
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
              const after = folderZone(e) === "after";
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
            e.stopPropagation();
            if (drag.current?.type === "item") dropInto(f);
            else dropFolder(f, folderZone(e));
            end();
          }}
        >
          <span>▰</span>
          {renaming === f ? (
            <NameForm
              inline
              initial={baseName(f)}
              placeholder={t("資料夾名稱")}
              submit={t("儲存")}
              onSubmit={(name) => {
                setRenaming(null);
                const to = joinPath(parentOf(f), cleanSegment(name));
                if (open.has(f)) openPath(to);
                follow(f, to);
                onRenameFolder(f, to);
              }}
              onCancel={() => setRenaming(null)}
            />
          ) : (
            <>
              <strong title={pathLabel(f)}>{folderLabel(f)}</strong>
              <small>{count}</small>
              <button
                type="button"
                className="quickMore folderMore"
                aria-label={t("資料夾操作：{title}", { title: baseName(f) })}
                aria-expanded={menu === f}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMoving(null);
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
              onClick={() => {
                setMenu(null);
                openPath(f);
                onCurrent?.(f);
                setCreatingIn(f);
              }}
            >
              {t("新增子資料夾")}
            </button>
            {moving === f ? (
              <select
                autoFocus
                aria-label={t("移到資料夾")}
                value={parentOf(f)}
                onChange={(e) => {
                  setMenu(null);
                  setMoving(null);
                  placeFolder(f, e.target.value);
                }}
              >
                <option value="">{t("最上層")}</option>
                {folders
                  .filter((p) => !within(p, f))
                  .map((p) => (
                    <option key={p} value={p}>
                      {"  ".repeat(depthOf(p)) + folderLabel(p)}
                    </option>
                  ))}
              </select>
            ) : (
              <button onClick={() => setMoving(f)}>{t("移到資料夾")}</button>
            )}
            <button
              disabled={index === 0}
              onClick={() => {
                const names = siblings.filter((x) => x !== f);
                names.splice(index - 1, 0, f);
                onFolderOrder(names);
              }}
            >
              {t("上移")}
            </button>
            <button
              disabled={index === siblings.length - 1}
              onClick={() => {
                const names = siblings.filter((x) => x !== f);
                names.splice(index + 1, 0, f);
                onFolderOrder(names);
              }}
            >
              {t("下移")}
            </button>
            <button
              onClick={() => {
                setMenu(null);
                setConfirmDelete(f);
              }}
            >
              {t("刪除資料夾")}
            </button>
          </div>
        )}
        {(isOpen || creatingIn === f || (creating && current === f)) && (
          <div className="quickSub">
            {creating && current === f && creatingIn !== f && (
              <NameForm
                placeholder={t("子資料夾名稱")}
                submit={t("建立")}
                onSubmit={(name) => onCreate(joinPath(f, cleanSegment(name)))}
                onCancel={onCancelCreate}
              />
            )}
            {creatingIn === f && (
              <NameForm
                placeholder={t("子資料夾名稱")}
                submit={t("建立")}
                onSubmit={(name) => {
                  setCreatingIn(null);
                  onCreate(joinPath(f, cleanSegment(name)));
                }}
                onCancel={() => setCreatingIn(null)}
              />
            )}
            {isOpen && subs.map(folderNode)}
            {isOpen && (
              <ul>
                {inFolder(f).map(row)}
                {!count && !subs.length && (
                  <li className="quickFolderEmpty">{t("拖曳項目到這裡")}</li>
                )}
              </ul>
            )}
          </div>
        )}
      </details>
    );
  };

  const draggedFolder =
    dragging?.type === "folder" ? dragging.name : null;
  return (
    <>
      {creating && !folders.includes(current) && (
        <NameForm
          placeholder={t("資料夾名稱")}
          submit={t("建立")}
          onSubmit={(name) => onCreate(cleanSegment(name))}
          onCancel={onCancelCreate}
        />
      )}
      {children("").map(folderNode)}
      <ul
        className={
          "quickRoot" +
          ((dragging?.type === "item" &&
            items.find((x) => x.id === dragging.id)?.folder) ||
          (draggedFolder && parentOf(draggedFolder))
            ? " dropZone"
            : "") +
          (hint?.kind === "into" && hint.folder === "" ? " dropInto" : "")
        }
        onDragOver={(e) => {
          const d = drag.current;
          if (!d || (d.type === "folder" && !parentOf(d.name))) return;
          e.preventDefault();
          if (hint?.kind !== "into" || hint.folder !== "")
            setHint({ kind: "into", folder: "" });
        }}
        onDrop={(e) => {
          e.preventDefault();
          const d = drag.current;
          if (d?.type === "folder") placeFolder(d.name, "");
          else dropInto("");
          end();
        }}
      >
        {inFolder("").map(row)}
        {((dragging?.type === "item" &&
          items.find((x) => x.id === dragging.id)?.folder) ||
          (draggedFolder && parentOf(draggedFolder))) && (
          <li className="quickFolderEmpty">{t("拖到這裡移到最上層")}</li>
        )}
      </ul>
      {confirmDelete !== null && (
        <ConfirmDelete
          title={t("刪除資料夾「{title}」？", {
            title: baseName(confirmDelete),
          })}
          detail={t(
            "資料夾裡的項目與子資料夾會移到上一層，不會被刪除。",
          )}
          busy={busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const f = confirmDelete;
            setConfirmDelete(null);
            if (onCurrent && within(current, f)) onCurrent(parentOf(f));
            onDeleteFolder(f);
          }}
        />
      )}
    </>
  );
}

/** Where new items go: "📂 Work › Projects", with a way back to the top. */
export function CurrentFolderBar({
  folder,
  onTop,
}: {
  folder: string;
  onTop: () => void;
}) {
  if (!folder) return null;
  return (
    <div className="currentFolder" role="status">
      <span title={pathLabel(folder)}>
        {t("目前資料夾：{folder}", {
          folder: pathLabel(folder).replace(PRIVATE_FOLDER, t(PRIVATE_FOLDER)),
        })}
      </span>
      <button type="button" onClick={onTop}>
        {t("回最上層")}
      </button>
    </div>
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
