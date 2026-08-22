/**
 * Cliente ligero para estimar la profundidad de la termoclina a partir del
 * perfil vertical de temperatura potencial (thetao) del producto Copernicus
 * GLOBAL_ANALYSISFORECAST_PHY_001_024.
 *
 * Estrategia (low-cost, low-credit):
 *   - Lanza N peticiones GetFeatureInfo WMTS (una por nivel de profundidad)
 *     usando el parámetro ELEVATION.
 *   - Calcula el gradiente vertical de temperatura entre niveles.
 *   - Devuelve la profundidad donde |dT/dz| es máximo y clasifica la
 *     intensidad (débil / media / fuerte).
 *
 * Solo se llama bajo demanda (clic del usuario), nunca en bucle.
 */

const COPERNICUS_WMTS = "https://wmts.marine.copernicus.eu/teroWmts";
const PROXY = "/api/tile-proxy";

// Capa thetao del modelo global de pronóstico físico (Copernicus).
const THETAO_LAYER =
  "GLOBAL_ANALYSISFORECAST_PHY_001_024/cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m_202406/thetao";
const THETAO_STYLE = "cmap:jet,vmin:273,vmax:303";

// Profundidades estándar a muestrear (metros). 6 niveles → ~6 fetches por clic.
// Cubren la capa de mezcla típica + arranque de termoclina permanente.
const DEPTHS = [5, 20, 50, 75, 100, 150] as const;

const REQUEST_TIMEOUT_MS = 6500;
const POSITIVE_TTL_MS = 60 * 60 * 1000; // 1 h
const CACHE = new Map<string, { result: ThermoclineResult; ts: number }>();

export interface ThermoclineResult {
  /** Profundidad estimada de la termoclina (m). null si no se pudo estimar. */
  depth: number | null;
  /** Gradiente en esa profundidad (°C/m, valor absoluto). */
  gradient: number | null;
  /** Clasificación cualitativa. */
  strength: "débil" | "media" | "fuerte" | null;
  /** Perfil muestreado (depth, T en °C). Útil para debug / tooltip extendido. */
  profile: Array<{ depth: number; tempC: number }>;
}

function latLngToTilePixel(lat: number, lng: number, zoom: number, tileSize = 256) {
  const n = Math.pow(2, zoom);
  const xTile = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yTile = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tileX = Math.floor(xTile);
  const tileY = Math.floor(yTile);
  const i = Math.floor((xTile - tileX) * tileSize);
  const j = Math.floor((yTile - tileY) * tileSize);
  return { tileX, tileY, i, j };
}

export async function fetchTempAtDepth(
  lat: number,
  lng: number,
  depth: number,
  time: string | undefined,
  signal: AbortSignal,
): Promise<number | null> {
  // zoom 7 → píxel ~1.2 km en Med (vs ~5 km a zoom 5). Evita "caer en
  // tierra" cuando el clic está cerca de la costa.
  const zoom = 7;
  const { tileX, tileY, i, j } = latLngToTilePixel(lat, lng, zoom);
  // Copernicus WMTS thetao usa ELEVATION negativo (profundidad bajo superficie).
  const elevation = -Math.abs(depth);
  const timeParam = time ? `&TIME=${encodeURIComponent(time)}` : "";
  const upstream =
    `${COPERNICUS_WMTS}?SERVICE=WMTS&REQUEST=GetFeatureInfo&VERSION=1.0.0` +
    `&LAYER=${encodeURIComponent(THETAO_LAYER)}&STYLE=${encodeURIComponent(THETAO_STYLE)}` +
    `&FORMAT=image%2Fpng&TILEMATRIXSET=EPSG%3A3857` +
    `&TILEMATRIX=${zoom}&TILEROW=${tileY}&TILECOL=${tileX}` +
    `&INFOFORMAT=application%2Fjson&I=${i}&J=${j}` +
    `&ELEVATION=${elevation}${timeParam}`;
  // Atravesar el proxy del proyecto (mismo patrón que el resto de capas) para evitar CORS.
  const url = `${PROXY}?url=${encodeURIComponent(upstream)}`;

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.features?.[0]?.properties?.value;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    // Copernicus devuelve thetao en Kelvin → convertir a °C.
    return raw > 100 ? raw - 273.15 : raw;
  } catch {
    return null;
  } finally {
    signal.removeEventListener("abort", onAbort);
    clearTimeout(t);
  }
}

function classifyStrength(gradAbs: number): "débil" | "media" | "fuerte" {
  if (gradAbs >= 0.15) return "fuerte";
  if (gradAbs >= 0.05) return "media";
  return "débil";
}

/**
 * Devuelve termoclina aproximada para (lat, lng). Reusa caché si está disponible.
 */
export async function fetchThermocline(
  lat: number,
  lng: number,
  time: string | undefined,
  signal: AbortSignal,
): Promise<ThermoclineResult> {
  const day = (time ?? "").slice(0, 10);
  // Granularidad ≈ 0.05° (~5 km) — ajustada al ~9 km del modelo global.
  const key = `${lat.toFixed(2)}|${lng.toFixed(2)}|${day}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.ts < POSITIVE_TTL_MS) return hit.result;

  const samples = await Promise.all(
    DEPTHS.map(async (d): Promise<{ depth: number; tempC: number | null }> => ({
      depth: d,
      tempC: await fetchTempAtDepth(lat, lng, d, time, signal),
    })),
  );

  const profile: Array<{ depth: number; tempC: number }> = samples
    .filter((s): s is { depth: number; tempC: number } => s.tempC != null)
    .sort((a, b) => a.depth - b.depth);

  if (profile.length < 3) {
    const empty: ThermoclineResult = { depth: null, gradient: null, strength: null, profile };
    CACHE.set(key, { result: empty, ts: Date.now() });
    return empty;
  }

  // Buscar el segmento con mayor caída (gradiente negativo más pronunciado).
  let bestDepth = profile[0].depth;
  let bestGradAbs = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const dz = profile[i + 1].depth - profile[i].depth;
    if (dz <= 0) continue;
    const dT = profile[i + 1].tempC - profile[i].tempC;
    const grad = dT / dz; // °C/m, normalmente negativo (T cae con profundidad)
    if (Math.abs(grad) > bestGradAbs) {
      bestGradAbs = Math.abs(grad);
      // Profundidad media del segmento → centro de la termoclina.
      bestDepth = (profile[i].depth + profile[i + 1].depth) / 2;
    }
  }

  const result: ThermoclineResult = {
    depth: Math.round(bestDepth),
    gradient: Number(bestGradAbs.toFixed(3)),
    strength: classifyStrength(bestGradAbs),
    profile,
  };
  CACHE.set(key, { result, ts: Date.now() });
  return result;
}

