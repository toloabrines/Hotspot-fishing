/* Hotspot Fishing — Service Worker
 * Estrategia:
 *  - HTML/navegación: NetworkFirst (con fallback a caché) → siempre intenta versión fresca.
 *  - Assets propios (JS/CSS/imagenes mismos-origen): StaleWhileRevalidate.
 *  - Tiles WMS/oceanográficos: CacheFirst con expiración por tamaño (acelera y reduce datos/batería).
 *  - Nunca cachea APIs /api/ ni POST.
 */
const VERSION = "v1.1.0";
const HTML_CACHE = `html-${VERSION}`;
const ASSET_CACHE = `assets-${VERSION}`;
const TILE_CACHE = `tiles-${VERSION}`;
// Reducido de 400 → 150 para bajar presión de memoria en móviles
// (iOS WebView mata la app cuando la caché crece demasiado).
const TILE_MAX_ENTRIES = 150;

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => ![HTML_CACHE, ASSET_CACHE, TILE_CACHE].includes(k))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toDelete = keys.length - maxEntries;
  for (let i = 0; i < toDelete; i++) await cache.delete(keys[i]);
}

function isTileRequest(url) {
  const h = url.hostname;
  return (
    /tile|wms|wmts|geoserver|mapserv|copernicus|emodnet|gebco|openstreetmap|cartocdn|arcgis/i.test(
      h,
    ) ||
    /\/tile[s]?\//i.test(url.pathname) ||
    /\.(png|jpg|jpeg|webp)$/i.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Nunca interferir con APIs propias (datos dinámicos)
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return;

  // Navegación HTML → NetworkFirst
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(HTML_CACHE);
          cache.put(req, fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match(req, { ignoreSearch: true });
          return cached || caches.match("/");
        }
      })(),
    );
    return;
  }

  // Tiles oceanográficos / imágenes → CacheFirst con límite
  if (isTileRequest(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILE_CACHE);
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res && res.status === 200) {
            cache.put(req, res.clone());
            trimCache(TILE_CACHE, TILE_MAX_ENTRIES);
          }
          return res;
        } catch {
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Assets mismo-origen → StaleWhileRevalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(req);
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res && res.status === 200) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })(),
    );
  }
});

