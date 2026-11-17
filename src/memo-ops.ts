// Memo edits, shared by the extension's background service and the mobile
// web app.
import {
  cleanDrawing,
  cleanFolderName,
  cleanImages,
  cleanRecordings,
  imageBytes,
  MEMO_MAX,
  VAULT_IMAGE_BYTES,
  type Memo,
  type Vault,
} from "./crypto";

export const DEFAULT_PAPER = "#fff4be";

/**
 * Adds or replaces a memo. Fields left undefined (drawing, recordings,
 * images, folder) keep their stored value, so an editor that does not
 * handle them cannot erase them.
 */
export function upsertMemo(v: Vault, x: Record<string, any>): Memo {
  const old = v.memos.find((y) => y.id === x.id);
  const body = String(x.body || "");
  if (body.length > MEMO_MAX) throw Error("記事內容過長");
  const memo: Memo = {
    id: old?.id || crypto.randomUUID(),
    title: String(x.title || "")
      .trim()
      .slice(0, 300),
    body,
    format: x.format === "html" ? "html" : "text",
    paperColor: /^#[0-9a-f]{6}$/i.test(x.paperColor || "")
      ? x.paperColor.toLowerCase()
      : old?.paperColor || DEFAULT_PAPER,
    drawing:
      x.drawing === undefined ? old?.drawing || [] : cleanDrawing(x.drawing),
    recordings:
      x.recordings === undefined
        ? old?.recordings || []
        : cleanRecordings(x.recordings),
    images: x.images === undefined ? old?.images || [] : cleanImages(x.images),
    folder:
      x.folder === undefined ? old?.folder || "" : cleanFolderName(x.folder),
    ...(old?.order !== undefined && (x.folder === undefined || cleanFolderName(x.folder) === (old.folder || ""))
      ? { order: old.order }
      : {}),
    updated: Math.max(Date.now(), (old?.updated || 0) + 1),
    revision: crypto.randomUUID(),
    deleted: false,
  };
  const visible =
    memo.format === "html"
      ? memo.body.replace(/<[^>]*>|&nbsp;/g, "").trim()
      : memo.body.trim();
  if (
    !memo.title &&
    !visible &&
    !memo.drawing?.length &&
    !memo.recordings?.length &&
    !memo.images?.length
  )
    throw Error("請輸入記事標題或內容");
  if (!old && v.memos.filter((y) => !y.deleted).length >= 5000)
    throw Error("記事數量已達上限");
  if (
    v.memos
      .filter((y) => y.id !== memo.id && !y.deleted)
      .reduce(
        (n, y) =>
          n + (y.recordings || []).reduce((a, r) => a + r.data.length, 0),
        0,
      ) +
      (memo.recordings || []).reduce((n, r) => n + r.data.length, 0) >
    6000000
  )
    throw Error("錄音儲存空間已滿，請先刪除部分錄音");
  if (Array.isArray(x.images) && memo.images!.length !== x.images.length)
    throw Error("圖片數量或大小超過上限");
  if (
    v.memos
      .filter((y) => y.id !== memo.id && !y.deleted)
      .reduce((n, y) => n + imageBytes(y.images), 0) +
      imageBytes(memo.images) >
    VAULT_IMAGE_BYTES
  )
    throw Error("圖片儲存空間已滿，請先刪除部分圖片");
  v.memos = v.memos.filter((y) => y.id !== memo.id).concat(memo);
  return memo;
}

/** Marks a memo deleted and wipes its content (a tombstone that syncs). */
export function deleteMemo(v: Vault, id: string) {
  const x = v.memos.find((y) => y.id === id);
  if (!x || x.deleted) return false;
  x.deleted = true;
  x.body = "";
  x.title = "";
  x.drawing = [];
  x.recordings = [];
  x.images = [];
  x.updated = Math.max(Date.now(), x.updated + 1);
  x.revision = crypto.randomUUID();
  return true;
}
