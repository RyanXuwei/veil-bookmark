// Offline shell for the Veil Bookmark mobile web app. Pages are fetched from
// the network first (so updates arrive at once) and from the cache offline.
// Google sign-in and Drive requests are never cached.
const CACHE = "veil-web-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
// Android "Share" → Veil Bookmark posts here. What was shared stays in this
// worker's memory (never in storage) until the page takes it, once; the page
// keeps it in memory until the vault is unlocked and saves it encrypted.
const inbox = new Map();
self.addEventListener("message", (e) => {
  if (e.data?.type !== "takeShare") return;
  const item = inbox.get(e.data.id) || null;
  inbox.delete(e.data.id);
  e.ports[0]?.postMessage(item);
});
async function receiveShare(req) {
  const id = crypto.randomUUID();
  try {
    const f = await req.formData();
    const str = (k) => (typeof f.get(k) === "string" ? f.get(k) : "");
    inbox.set(id, {
      title: str("title"),
      text: str("text"),
      url: str("url"),
      files: f
        .getAll("files")
        .filter((x) => typeof x !== "string" && /^image\//.test(x.type))
        .slice(0, 10),
    });
    setTimeout(() => inbox.delete(id), 10 * 60_000);
  } catch {}
  return Response.redirect(new URL("./?share=" + id, self.registration.scope).href, 303);
}
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (
    req.method === "POST" &&
    url.origin === location.origin &&
    url.pathname === new URL("./share", self.registration.scope).pathname
  )
    return e.respondWith(receiveShare(req));
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.endsWith("/config.json")) return;
  const hashed = /\/assets\//.test(url.pathname);
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (hashed) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
