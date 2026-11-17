// Nested folders. A folder is named by its path, segments joined with "/"
// ("Work/Projects/2026"); items refer to the full path. Older releases that
// do not know about nesting simply show the path as one folder name.
import type { Folder, FolderKind } from "./crypto";

export const SEP = "/";

export const parentOf = (path: string) =>
  path.includes(SEP) ? path.slice(0, path.lastIndexOf(SEP)) : "";
export const baseName = (path: string) =>
  path.slice(path.lastIndexOf(SEP) + 1);
export const depthOf = (path: string) =>
  path ? path.split(SEP).length - 1 : 0;
/** True for the folder itself and everything below it. */
export const within = (path: string, folder: string) =>
  !!folder && (path === folder || path.startsWith(folder + SEP));
export const joinPath = (parent: string, name: string) =>
  parent ? parent + SEP + name : name;
/** "Work › Projects" for display. */
export const pathLabel = (path: string) => path.split(SEP).join(" › ");
/** One folder name typed by the user: a slash would start a new level. */
export const cleanSegment = (name: string) =>
  name.replace(/\//g, "／").replace(/[\u0000-\u001f]/g, " ").trim();

/** Every folder path with its ancestors, in tree order (depth first):
 *  siblings by their saved order, then by name. */
export function folderTree(
  kind: FolderKind,
  records: Folder[] | undefined,
  items: { folder?: string }[],
) {
  const live = (records || []).filter((f) => f.kind === kind && !f.deleted);
  const known = new Map(live.map((f) => [f.name, f.order]));
  const all = new Set<string>();
  for (const name of [
    ...live.map((f) => f.name),
    ...items.map((x) => x.folder || "").filter(Boolean),
  ])
    for (let p = name; p; p = parentOf(p)) all.add(p);
  const byParent = new Map<string, string[]>();
  for (const p of all) {
    const list = byParent.get(parentOf(p)) || [];
    list.push(p);
    byParent.set(parentOf(p), list);
  }
  const out: string[] = [];
  const walk = (parent: string) => {
    const list = (byParent.get(parent) || []).sort((a, b) =>
      known.has(a) && known.has(b)
        ? known.get(a)! - known.get(b)!
        : known.has(a)
          ? -1
          : known.has(b)
            ? 1
            : baseName(a).localeCompare(baseName(b)),
    );
    for (const p of list) {
      out.push(p);
      walk(p);
    }
  };
  walk("");
  return out;
}
