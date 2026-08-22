/**
 * Cliente WMTS GetFeatureInfo unificado contra Copernicus.
 *
 * Esta utilidad centraliza la consulta puntual de un valor en una capa WMTS.
 * Antes existían DOS rutas distintas:
 *   - Popup del mapa → llamaba directamente a `wmts.marine.copernicus.eu`
 *   - Motor de spots → leía píxeles del DOM (tiles ya pintados)
 *
 * Esa duplicidad causaba un bug visible: el popup mostraba SST/CHL/ALT
 * correctos en un punto, pero el "Top 1" del motor declaraba "sin dato"
 * porque la tile no estaba aún pintada en el DOM o la opacidad del pane era
 * baja. Unificando ambos caminos, el motor puede pedir GetFeatureInfo como
 * fallback y validar el TOP 1 antes de mostrarlo.
 *
 * La función es ligera (1 fetch JSON), con cache en memoria y timeout corto.
 * Está pensada para llamarse pocas veces por análisis (3 capas × 1 candidato)
 * — NO para barrer toda la grilla.
 */

const ENDPOINT = "https://wmts.marine.copernicus.eu/teroWmts";

const CACHE = new Map<string, { value: number | null; units?: string; ts: number }>();
const POSITIVE_TTL_MS = 30 * 60 * 1000; // 30 min
const NEGATIVE_TTL_MS = 30 * 60 * 1000; // 30 min (igual que positivo: el
// resultado "sin dato" debe ser tan estable como el dato. Antes caducaba en
// 60 s y por eso repetir el análisis un minuto después podía cambiar el Top 1.
const REQUEST_TIMEOUT_MS = 6500;

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

export interface FeatureInfoResult {
  value: number | null;
  units?: string;
}

/**
 * Consulta puntual GetFeatureInfo. Devuelve `{ value: null }` si la celda
 * no tiene dato, si el servicio falla o si el timeout salta. Nunca lanza.
 */
export async function fetchCopernicusValue(
  wmtsLayer: string,
  style: string,
  lat: number,
  lng: number,
  zoom: number,
  time?: string,
  signal?: AbortSignal,
  elevation?: number,
): Promise<FeatureInfoResult> {
  // Clave de cache: capa + estilo + coords (4 dec ≈ 11 m) + día.
  const day = (time ?? "").slice(0, 10);
  const key = `${wmtsLayer}|${style}|${lat.toFixed(4)}|${lng.toFixed(4)}|${day}|${zoom}|${elevation ?? ""}`;
  const hit = CACHE.get(key);
  if (hit) {
    const ttl = hit.value != null ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - hit.ts < ttl) return { value: hit.value, units: hit.units };
  }

  const { tileX, tileY, i, j } = latLngToTilePixel(lat, lng, zoom);
  const layer = encodeURIComponent(wmtsLayer);
  const styleEnc = encodeURIComponent(style);
  const normalizedTime = time
    ? time.includes("T")
      ? time
      : `${time.slice(0, 10)}T00:00:00.000Z`
    : undefined;
  const timeParam = normalizedTime ? `&TIME=${encodeURIComponent(normalizedTime)}` : "";
  const elevationParam = elevation != null ? `&ELEVATION=${encodeURIComponent(elevation)}` : "";
  const buildUrl = (includeTime: boolean) => {
    const timed = includeTime ? timeParam : "";
    const upstreamUrl =
      `${ENDPOINT}?SERVICE=WMTS&REQUEST=GetFeatureInfo` +
      `&VERSION=1.0.0&LAYER=${layer}&STYLE=${styleEnc}` +
      `&FORMAT=image%2Fpng&TILEMATRIXSET=EPSG%3A3857` +
      `&TILEMATRIX=${zoom}&TILEROW=${tileY}&TILECOL=${tileX}` +
      `&INFOFORMAT=application%2Fjson&I=${i}&J=${j}${timed}${elevationParam}`;
    return `/api/tile-proxy?url=${encodeURIComponent(upstreamUrl)}`;
  };

  const fetchJson = async (url: string) =>
    fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { accept: "application/json", "cache-control": "no-cache", pragma: "no-cache" },
    });

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res = await fetchJson(buildUrl(true));
    if (!res.ok && normalizedTime) res = await fetchJson(buildUrl(false));
    if (!res.ok) {
      CACHE.set(key, { value: null, ts: Date.now() });
      return { value: null };
    }
    let data = await res.json();
    if (typeof data?.error === "string" && /Upstream\s+400/.test(data.error) && normalizedTime) {
      // En SST/CHL el día actual puede no estar publicado todavía aunque el
      // calendario de la app ya haya avanzado. El proxy devuelve 200 con
      // sentinel "Upstream 400", así que hay que reintentar explícitamente sin
      // TIME para pedir el último dato disponible de Copernicus.
      CACHE.delete(key);
      res = await fetchJson(buildUrl(false));
      if (!res.ok) return { value: null };
      data = await res.json();
    }
    if (typeof data?.error === "string" && /Upstream\s+(429|503|502|400)/.test(data.error)) {
      // Rate-limit temporal: no lo guardamos como "sin dato", porque si no el
      // popup queda vacío durante 1 minuto aunque Copernicus responda después.
      CACHE.delete(key);
      return { value: null };
    }
    const props = data?.features?.[0]?.properties;
    const raw = props?.value;
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const units = typeof props?.units === "string" ? (props.units as string) : undefined;
    CACHE.set(key, { value, units, ts: Date.now() });
    return { value, units };
  } catch {
    if (ctrl.signal.aborted || signal?.aborted) {
      CACHE.delete(key);
      return { value: null };
    }
    CACHE.set(key, { value: null, ts: Date.now() });
    return { value: null };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    clearTimeout(t);
  }
}

