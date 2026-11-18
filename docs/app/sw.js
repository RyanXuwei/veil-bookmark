// The old offline shell is retired: this worker removes itself and its cache.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("veil-web")) await caches.delete(name);
      await self.registration.unregister();
    })(),
  ),
);
