// The mobile web app's vault: opened with the master password from the
// encrypted snapshots in Google Drive (or this phone's encrypted copy when
// offline). The data key lives only in memory; edits are re-encrypted, kept
// on the phone and uploaded to Drive like the extension does.
import {
  decrypt,
  merge,
  openWithPassword,
  seal,
  validateEnvelope,
  type Envelope,
  type KeySlots,
  type SealedEnvelope,
  type Vault,
} from "../src/crypto";
import { readRemoteWith, removeSnapshots, upload } from "../src/drive";
import { deleteEntry, upsertEntry } from "../src/entry-ops";
import { mergeSnapshots, VaultMismatch } from "../src/sync-core";
import { token } from "./google";

// ---- Encrypted copy on this phone (IndexedDB) -------------------------------
const DB = "veil-bookmark-web";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idb<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
) {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = fn(d.transaction("kv", mode).objectStore("kv"));
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => reject(r.error);
    });
  } finally {
    d.close();
  }
}
const cacheGet = () => idb<unknown>("readonly", (s) => s.get("vault"));
const cacheSet = (e: SealedEnvelope) =>
  idb("readwrite", (s) => s.put(e, "vault"));
export const hasCache = async () => {
  try {
    return !!(await cacheGet());
  } catch {
    return false;
  }
};
/** Removes this phone's encrypted copy (Drive is not touched). */
export const clearCache = () => idb("readwrite", (s) => s.delete("vault"));

// ---- State ---------------------------------------------------------------
export type SyncState = {
  syncing: boolean;
  lastSync: number;
  error: string;
  // Edits on this phone not yet uploaded (e.g. the Google sign-in expired).
  pending: boolean;
};
let open: { v: Vault; dek: CryptoKey; keys: KeySlots } | null = null;
let sync: SyncState = {
  syncing: false,
  lastSync: 0,
  error: "",
  pending: false,
};
const listeners = new Set<() => void>();
export function subscribe(f: () => void) {
  listeners.add(f);
  return () => void listeners.delete(f);
}
const emit = () => listeners.forEach((f) => f());
export const vault = () => open?.v ?? null;
export const syncState = () => sync;
function setSync(next: Partial<SyncState>) {
  sync = { ...sync, ...next };
  emit();
}

let attempts = 0,
  nextAttempt = 0;
const NOT_FOUND =
  "Google Drive 上還沒有 Veil Bookmark 保險庫。請先在電腦的擴充功能「同步與備份」連接 Google Drive。";

/** Opens the vault with the master password. */
export async function unlock(password: string) {
  if (Date.now() < nextAttempt) throw Error("嘗試次數過多，請稍後再試");
  const t = token();
  let remote: Envelope[] = [];
  let ids: string[] = [];
  if (t) ({ envelopes: remote, ids } = await readRemoteWith(t));
  let cached: SealedEnvelope | null = null;
  try {
    const c = await cacheGet();
    if (c) {
      const e = validateEnvelope(c);
      if (e.version === 3) cached = e;
    }
  } catch {}
  const sealed = remote
    .filter((x): x is SealedEnvelope => x.version === 3)
    .sort((a, b) => b.keys.updated - a.keys.updated);
  const first = sealed[0] || (t && remote.length ? null : cached);
  if (!first)
    throw Error(
      remote.length
        ? "請先在電腦上用最新版的擴充功能同步一次，再用手機開啟。"
        : t
          ? NOT_FOUND
          : "請先連接 Google Drive",
    );
  let dek: CryptoKey;
  try {
    ({ dek } = await openWithPassword(first, password));
    attempts = 0;
  } catch (e) {
    nextAttempt =
      Date.now() + Math.min(60000, 1000 * 2 ** Math.min(attempts++, 6));
    throw e;
  }
  let v = await decrypt(first, dek);
  let keys = first.keys;
  // Edits made on this phone that were not uploaded yet.
  if (cached && cached !== first && cached.id === v.id)
    try {
      v = merge(v, await decrypt(cached, dek));
    } catch {}
  open = { v, dek, keys };
  if (t) {
    await syncNow(remote, ids);
  } else {
    await cacheSet(await seal(v, dek, keys));
    setSync({ pending: !!cached && !t });
  }
  emit();
}

export function lock() {
  open = null;
  clearTimeout(timer);
  emit();
}

// ---- Sync ----------------------------------------------------------------
let queue: Promise<unknown> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
function serialized<T>(fn: () => Promise<T>) {
  const r = queue.then(fn, fn);
  queue = r.catch(() => {});
  return r;
}

/** Merges Drive's snapshots and uploads this phone's changes. */
export function syncNow(pre?: Envelope[], preIds?: string[]) {
  return serialized(async () => {
    const o = open;
    if (!o) return;
    const t = token();
    if (!t) {
      setSync({ error: "", pending: true });
      return;
    }
    setSync({ syncing: true });
    const base = o.v;
    try {
      const r = pre
        ? { envelopes: pre, ids: preIds! }
        : await readRemoteWith(t);
      const m = await mergeSnapshots({
        v: o.v,
        dek: o.dek,
        keys: o.keys,
        envelopes: r.envelopes,
      });
      if (open !== o) return; // Locked meanwhile.
      // Keep edits made on this phone while Drive was being read.
      const edited = o.v !== base;
      const next = edited ? merge(m.v, o.v) : m.v;
      const snapshot = await seal(next, o.dek, m.keys);
      o.v = { ...next };
      o.keys = m.keys;
      if (edited) soon();
      await cacheSet(snapshot);
      if (m.upload) {
        await upload(t, snapshot);
        await removeSnapshots(t, r.ids);
      }
      setSync({
        syncing: false,
        lastSync: Date.now(),
        error: "",
        pending: edited,
      });
    } catch (e) {
      setSync({
        syncing: false,
        pending: true,
        error:
          e instanceof VaultMismatch
            ? "Google Drive 上的保險庫已被更換。請上鎖後用新的主密碼重新開啟。"
            : (e as Error).message,
      });
    }
  });
}
function soon() {
  clearTimeout(timer);
  setSync({ pending: true });
  timer = setTimeout(() => void syncNow(), 800);
}

// ---- Edits ---------------------------------------------------------------
async function save() {
  const o = open!;
  await cacheSet(await seal(o.v, o.dek, o.keys));
  emit();
  soon();
}
export async function saveEntry(x: Parameters<typeof upsertEntry>[1]) {
  if (!open) throw Error("已上鎖，請重新解鎖");
  // Validates before changing anything (throws on a bad name or URL).
  upsertEntry(open.v, x);
  open.v = { ...open.v };
  await save();
}
export async function removeEntry(id: string) {
  if (!open) throw Error("已上鎖，請重新解鎖");
  if (deleteEntry(open.v, id)) {
    open.v = { ...open.v };
    await save();
  }
}
