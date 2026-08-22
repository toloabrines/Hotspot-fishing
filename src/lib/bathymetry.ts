/**
 * Batimetría real por coordenada — EMODnet (alta resolución, Europa) con
 * fallback a GEBCO (cobertura global). Es la FUENTE NUMÉRICA que alimenta
 * el modo "Pesca a fondo".
 *
 * IMPORTANTE: las consultas se enrutan por nuestro proxy server-side
 * (`/api/bathymetry`) para garantizar:
 *   - misma origen (sin CORS rotos)
 *   - timeout de 8s
 *   - cache HTTP 1h
 *
 * El proxy ya prueba EMODnet → GEBCO; aquí solo cacheamos en cliente y
 * añadimos logs visibles de diagnóstico.
 */

export type DepthSource = "emodnet" | "ncei" | "gebco" | "none";
export type DepthAttemptState = "ok" | "fail" | "skipped";

export interface DepthAttempts {
  emodnet: DepthAttemptState;
  ncei?: DepthAttemptState;
  gebco: DepthAttemptState;
}

export interface DepthSample {
  /** Profundidad positiva en metros, o null si no hay dato fiable. */
  depth: number | null;
  /** Fuente real de la lectura (para indicador UI y mezcla por celda). */
  source: DepthSource;
  /** Trazabilidad de la cascada numérica EMODnet → GEBCO. */
  attempts?: DepthAttempts;
}

interface CacheEntry {
  sample: DepthSample;
  ts: number;
}

const cache = new Map<string, CacheEntry>();
const POSITIVE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 9000;
const keyOf = (lat: number, lng: number) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;

// Estadísticas globales por corrida — el motor las imprime al terminar.
interface RunStats {
  emodnetOk: number;
  emodnetFail: number;
  gebcoOk: number;
  gebcoFail: number;
}
let runStats: RunStats = { emodnetOk: 0, emodnetFail: 0, gebcoOk: 0, gebcoFail: 0 };

export function resetBathymetryStats(): void {
  runStats = { emodnetOk: 0, emodnetFail: 0, gebcoOk: 0, gebcoFail: 0 };
}

export function getBathymetryStats(): RunStats {
  return { ...runStats };
}

async function fetchWithTimeout(
  url: string,
  ms: number,
  signal?: AbortSignal,
): Promise<Response | null> {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (signal?.aborted) return null;
  signal?.addEventListener("abort", abort, { once: true });
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(t);
  }
}

/**
 * Lectura puntual de profundidad. Usa el proxy `/api/bathymetry` que ya
 * implementa la cascada EMODnet → GEBCO con parsing robusto.
 *
 * Cachea por celda (~110 m a 3 decimales). Cache negativo corto (2 min)
 * evita martillear puntos sin cobertura dentro de la misma corrida.
 */
export async function fetchDepth(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<DepthSample> {
  const k = keyOf(lat, lng);
  const cached = cache.get(k);
  if (cached) {
    const ttl = cached.sample.depth != null ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - cached.ts < ttl) return cached.sample;
  }

  const url = `/api/bathymetry?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}&source=auto`;
  const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, signal);
  let sample: DepthSample = { depth: null, source: "none" };

  if (res && res.ok) {
    try {
      const json = (await res.json()) as {
        depth: number | null;
        source: DepthSource;
        attempts?: DepthAttempts;
      };
      sample = {
        depth: typeof json.depth === "number" && Number.isFinite(json.depth) ? json.depth : null,
        source: (json.source as DepthSource) ?? "none",
        attempts: json.attempts,
      };
    } catch {
      sample = { depth: null, source: "none" };
    }
  }

  // Actualizar estadísticas globales
  const attempts = sample.attempts;
  if (attempts) {
    if (attempts.emodnet === "ok") runStats.emodnetOk++;
    else if (attempts.emodnet === "fail") runStats.emodnetFail++;

    if (attempts.gebco === "ok") runStats.gebcoOk++;
    else if (attempts.gebco === "fail") runStats.gebcoFail++;
  } else if (sample.source === "emodnet" && sample.depth != null) {
    runStats.emodnetOk++;
  } else if (sample.source === "gebco" && sample.depth != null) {
    runStats.emodnetFail++;
    runStats.gebcoOk++;
  } else {
    runStats.emodnetFail++;
  }

  cache.set(k, { sample, ts: Date.now() });
  return sample;
}

/**
 * Profundidad puntual priorizando el DEM real de alta resolución (`/api/dem`,
 * que ya fusiona MBAR24/IHM 16 m + EMODnet). Sólo si no hay dato ahí se cae al
 * sondeo puntual EMODnet/GEBCO, que es mucho más grueso (~115–450 m) y puede
 * dar 25 m donde la carta real marca 60 m.
 */
export async function getDepthAtLatLng(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<DepthSample> {
  try {
    const { fetchDemGrid, snapBBox } = await import("./dem");
    const half = 0.004; // ~450 m: suficiente para caer en la tesela correcta
    const bbox = snapBBox(
      { south: lat - half, north: lat + half, west: lng - half, east: lng + half },
      0.002,
    );
    const grid = await fetchDemGrid(bbox, 96, signal);
    const d = grid?.depthAt(lat, lng) ?? null;
    if (d != null && Number.isFinite(d)) {
      return {
        depth: d,
        source: "emodnet",
        attempts: { emodnet: "ok", gebco: "skipped" },
      };
    }

  } catch {
    /* sin DEM: seguimos con la cascada puntual */
  }
  return fetchDepth(lat, lng, signal);
}


/**
 * Resumen de fuentes usadas en una corrida (para el indicador UI).
 */
export function summarizeSources(samples: { source: DepthSource }[]): {
  label: string;
  source: DepthSource | "mixed" | "none";
} {
  let nEmo = 0;
  let nGeb = 0;
  for (const s of samples) {
    if (s.source === "emodnet") nEmo++;
    else if (s.source === "gebco") nGeb++;
  }
  const total = nEmo + nGeb;
  if (total === 0) {
    return {
      label: "sin batimetría numérica; análisis basado solo en superficie",
      source: "none",
    };
  }
  if (nEmo > 0 && nGeb === 0) {
    return {
      label: `batimetría fina EMODnet activa (${nEmo} pts · ~115 m)`,
      source: "emodnet",
    };
  }
  if (nGeb > 0 && nEmo === 0) {
    return {
      label: `batimetría global GEBCO activa (${nGeb} pts · ~450 m, resolución limitada)`,
      source: "gebco",
    };
  }
  const pctEmo = Math.round((nEmo / total) * 100);
  const pctGeb = 100 - pctEmo;
  return {
    label: `batimetría mixta EMODnet ${pctEmo}% · GEBCO ${pctGeb}%`,
    source: "mixed",
  };
}

