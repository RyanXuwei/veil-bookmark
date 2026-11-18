// The selection belongs to a tab. Tokens and encrypted copies belong to a
// verified Drive user, never to the browser's current Google session.
export type Account = {
  id: string;
  email: string;
  name: string;
  token: string;
  expires: number;
};
const PREFIX = "veilAccount:";
export const activeAccount = () =>
  sessionStorage.getItem("veilActiveAccount") || "legacy";
export const workspaceKey = (key: string, id = activeAccount()) =>
  id === "legacy" ? key : `${key}:${id}`;
export function accounts(): Account[] {
  const result: Account[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (!key.startsWith(PREFIX)) continue;
    try {
      const a = JSON.parse(localStorage.getItem(key)!);
      if (a.id && key === PREFIX + a.id) result.push(a);
    } catch {}
  }
  return result.sort((a, b) => a.email.localeCompare(b.email));
}
export const account = (id = activeAccount()) =>
  accounts().find((a) => a.id === id);
export function selectAccount(id: string) {
  sessionStorage.setItem("veilActiveAccount", id);
}
export function storeAccount(a: Account) {
  localStorage.setItem(PREFIX + a.id, JSON.stringify(a));
}
export function removeAccount() {
  localStorage.removeItem(PREFIX + activeAccount());
}
export async function identify(
  t: string,
): Promise<Omit<Account, "token" | "expires">> {
  const r = await fetch(
    "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress,displayName)",
    { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" },
  );
  if (!r.ok) throw Error("無法確認 Google 帳戶，請重新連線");
  const { user } = await r.json();
  if (
    typeof user?.permissionId !== "string" ||
    !/^[\w-]{1,200}$/.test(user.permissionId) ||
    typeof user.emailAddress !== "string"
  )
    throw Error("無法確認 Google 帳戶，請重新連線");
  return {
    id: user.permissionId,
    email: user.emailAddress,
    name: user.displayName || user.emailAddress,
  };
}
// Also used by other tabs using the same account. Fail closed on old browsers.
export async function accountLock<T>(
  fn: () => Promise<T>,
  id = activeAccount(),
): Promise<T> {
  if (!navigator.locks)
    throw Error("此瀏覽器不支援安全的多帳戶儲存，請更新瀏覽器");
  return navigator.locks.request("veil-workspace:" + id, fn);
}
export async function kv<T>(
  dbName: string,
  key: string,
  mode: IDBTransactionMode,
  value?: T,
  remove = false,
): Promise<T | undefined> {
  const d = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = d.transaction("kv", mode),
        s = tx.objectStore("kv");
      const r =
        mode === "readonly"
          ? s.get(key)
          : remove
            ? s.delete(key)
            : s.put(value, key);
      tx.oncomplete = () => resolve(r.result as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("Storage aborted"));
    });
  } finally {
    d.close();
  }
}
