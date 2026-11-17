// Offline shell for the Veil Bookmark mobile web app. Pages are fetched from
// the network first (so updates arrive at once) and from the cache offline.
// Google sign-in and Drive requests are never cached.
const CACHE = "veil-web-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
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
