/**
 * Ayudas de rendimiento para la descarga de batimetría (DEM).
 *
 * - Detección de gama del dispositivo (Android de gama media → menos carga).
 * - Limitador de peticiones simultáneas.
 * - Caché persistente (Cache Storage) de las respuestas de `/api/dem`,
 *   para que una tesela ya descargada no se vuelva a pedir nunca.
 *
 * Nada de esto cambia el dato: sólo *cuándo* y *cuántas veces* se descarga.
 */

export type DeviceTier = "low" | "mid" | "high";

let tierCache: DeviceTier | null = null;

export function deviceTier(): DeviceTier {
  if (tierCache) return tierCache;
  if (typeof navigator === "undefined") return (tierCache = "high");
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = typeof nav.deviceMemory === "number" ? nav.deviceMemory : 0;
  const cores = typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : 0;
  const isAndroid = /Android/i.test(nav.userAgent ?? "");
  if ((mem > 0 && mem <= 3) || (cores > 0 && cores <= 4)) return (tierCache = "low");
  if (isAndroid) return (tierCache = "mid");
  return (tierCache = "high");
}

/** Peticiones DEM simultáneas permitidas según la gama del dispositivo. */
export function maxDemConcurrency(): number {
  const t = deviceTier();
  return t === "low" ? 1 : t === "mid" ? 2 : 4;
}

// ── Limitador de concurrencia ──────────────────────────────────────
const queue: (() => void)[] = [];
let active = 0;

export async function withDemSlot<T>(fn: () => Promise<T>): Promise<T> {
  const limit = maxDemConcurrency();
  if (active >= limit) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = queue.shift();
    if (next) next();
  }
}

// ── Caché persistente de respuestas /api/dem ───────────────────────
const DEM_CACHE = "dem-json-v1";

function cachesAvailable(): boolean {
  return typeof caches !== "undefined" && typeof window !== "undefined";
}

export async function readDemCache(url: string): Promise<unknown | null> {
  if (!cachesAvailable()) return null;
  try {
    const cache = await caches.open(DEM_CACHE);
    const hit = await cache.match(url);
    if (!hit) return null;
    return await hit.json();
  } catch {
    return null;
  }
}

export async function writeDemCache(url: string, body: unknown): Promise<void> {
  if (!cachesAvailable()) return;
  try {
    const cache = await caches.open(DEM_CACHE);
    await cache.put(
      url,
      new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }),
    );
    // Poda sencilla: evita que la caché crezca sin control en móviles.
    const keys = await cache.keys();
    const MAX = deviceTier() === "low" ? 120 : 300;
    if (keys.length > MAX) {
      for (let i = 0; i < keys.length - MAX; i++) await cache.delete(keys[i]);
    }
  } catch {
    /* almacenamiento lleno o no disponible: se ignora */
  }
}

