// The mobile web app moved to its own address. This page only touches Veil
// Bookmark's own data on this origin (the origin is shared with other pages,
// so nothing else is cleared).
const own = (k) => k.startsWith("veil");

// 1) Google sign-in tokens are removed at once.
try {
  for (const store of [localStorage, sessionStorage]) {
    for (const k of Object.keys(store)) {
      if (k === "veilGoogleToken" || k === "veilGoogleConnected") store.removeItem(k);
      else if (k.startsWith("veilAccount:")) {
        try {
          const a = JSON.parse(store.getItem(k));
          a.token = "";
          a.expires = 0;
          store.setItem(k, JSON.stringify(a));
        } catch {
          store.removeItem(k);
        }
      }
    }
  }
} catch {}

// 2) The old offline shell is no longer wanted.
async function unregister() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) || [];
    for (const r of regs) if (r.scope.includes("/veil-bookmark/app/")) await r.unregister();
    for (const name of await caches.keys()) if (name.startsWith("veil-web")) await caches.delete(name);
  } catch {}
}
void unregister();

// 3) On request: this phone's encrypted copy, biometric setup and settings.
document.getElementById("clear").addEventListener("click", async () => {
  const out = document.getElementById("result");
  try {
    for (const store of [localStorage, sessionStorage])
      for (const k of Object.keys(store)) if (own(k)) store.removeItem(k);
    const dbs = (await indexedDB.databases?.()) || [];
    for (const d of dbs)
      if (d.name && d.name.startsWith("veil-bookmark"))
        await new Promise((resolve) => {
          const r = indexedDB.deleteDatabase(d.name);
          r.onsuccess = r.onerror = r.onblocked = () => resolve();
        });
    await unregister();
    out.textContent = "已清除。請前往新網址。";
  } catch {
    out.textContent = "清除時發生問題，請稍後再試。";
  }
});
