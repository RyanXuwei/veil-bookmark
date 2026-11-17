// Bookmark edits, shared by the extension's background service and the
// mobile web app.
import { cleanFolderName, safeUrl, type Entry, type Vault } from "./crypto";

/** Adds or replaces a bookmark from form input (tags as "a, b"). */
export function upsertEntry(
  v: Vault,
  x: {
    id?: string;
    title?: unknown;
    url?: unknown;
    folder?: unknown;
    tags?: unknown;
    notes?: unknown;
  },
): Entry {
  const old = v.entries.find((y) => y.id === x.id);
  const entry: Entry = {
    id: old?.id || crypto.randomUUID(),
    title: String(x.title || "")
      .trim()
      .slice(0, 300),
    url: safeUrl(String(x.url)),
    folder: String(x.folder || "")
      .trim()
      .slice(0, 100),
    tags: String(x.tags || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 30),
    notes: String(x.notes || "").slice(0, 5000),
    ...(old?.order !== undefined && old.folder === cleanFolderName(x.folder)
      ? { order: old.order }
      : {}),
    updated: Math.max(Date.now(), (old?.updated || 0) + 1),
    revision: crypto.randomUUID(),
    deleted: false,
  };
  if (!entry.title) throw Error("請填寫書籤名稱");
  v.entries = v.entries.filter((y) => y.id !== entry.id).concat(entry);
  return entry;
}

/** Marks a bookmark deleted (a tombstone, so the deletion syncs). */
export function deleteEntry(v: Vault, id: string) {
  const x = v.entries.find((y) => y.id === id);
  if (!x || x.deleted) return false;
  x.deleted = true;
  x.updated = Math.max(Date.now(), x.updated + 1);
  x.revision = crypto.randomUUID();
  return true;
}
