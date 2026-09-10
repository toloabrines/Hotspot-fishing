/* Hotspot Fishing — service worker cleanup.
 * This worker intentionally does not cache or intercept requests.
 * On activation it removes app-file caches created by older versions, keeps
 * the independent DEM data cache, and unregisters itself so installed iOS
 * PWAs fall back to normal network loads.
 */
self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      try {
        const keys = await caches.keys();
        // No borres la caché de datos DEM: no contiene archivos de la app y
        // permite reabrir al instante las zonas batimétricas ya consultadas.
        await Promise.all(
          keys
            .filter(function (key) { return key !== "dem-json-v1"; })
            .map(function (key) { return caches.delete(key); }),
        );
      } catch (e) {}

      try {
        await self.clients.claim();
      } catch (e) {}

      try {
        await self.registration.unregister();
      } catch (e) {}

      try {
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        clients.forEach(function (client) {
          if ("navigate" in client) client.navigate(client.url);
        });
      } catch (e) {}
    })(),
  );
});

/* No fetch handler on purpose: all requests go directly to the network. */
