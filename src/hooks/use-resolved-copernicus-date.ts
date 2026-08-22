import { useCallback, useEffect, useRef, useState } from "react";
import { LAYER_CONFIGS, type LayerType } from "../components/ocean-layers";

/**
 * Resuelve la fecha MÁS RECIENTE con datos reales para la(s) capa(s) dadas.
 *
 * Estrategia:
 *   1. Punto de partida = hoy. No usamos máximos hardcodeados: Copernicus
 *      decide si esa fecha existe o no.
 *   2. Sondeamos hoy → hoy-1 → ... → hoy-MAX_LOOKBACK.
 *   3. Cada sonda lleva un cache-buster ÚNICO (Date.now()+random) → nunca
 *      reusa una respuesta cacheada del navegador o de Cloudflare.
 *   4. Validamos que la respuesta sea JSON con `value` numérico finito.
 *      Si Copernicus devuelve XML (ExceptionReport) o `value: null`, no
 *      cuenta como dato disponible.
 *   5. Si una capa nunca encuentra dato en MAX_LOOKBACK días, prueba la
 *      siguiente capa de la lista (ej: sst_nrt → chl → sst_analysed).
 *
 * Devuelve:
 *   - resolvedDate: ISO YYYY-MM-DD (la última real con datos), o undefined
 *   - status: "probing" | "ok" (=hoy) | "fallback" (=N días atrás) | "none"
 *   - daysBack: cuántos días atrás respecto a hoy (0 = hoy)
 *   - probedLayer: qué capa de la lista resolvió la fecha
 *   - resolvedAt: timestamp cliente (ms) de cuándo se completó la sonda
 *   - refresh(): vuelve a sondear desde cero (para botón "Reciente")
 */

const MAX_LOOKBACK = 14;
// Punto océano abierto Atlántico Norte tropical — siempre cubierto por
// productos globales SST/CHL, lejos de cualquier máscara de tierra.
const PROBE_LAT = 16.5;
const PROBE_LNG = -28.0;
const PROBE_ZOOM = 5;

function isoMinusDays(fromIso: string, days: number): string {
  const d = new Date(`${fromIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function startCandidate(layer: LayerType): string {
  const today = todayIso();
  const range = LAYER_CONFIGS[layer].timeRange;
  if (!range || today >= range.min) return today;
  return range.min;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00.000Z`).getTime();
  const b = new Date(`${toIso}T00:00:00.000Z`).getTime();
  return Math.round((a - b) / 86_400_000);
}

function latLngToTile(lat: number, lng: number, zoom: number, tileSize = 256) {
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

async function probeDate(layer: LayerType, isoDate: string): Promise<boolean> {
  const cfg = LAYER_CONFIGS[layer];
  const wmtsLayer = encodeURIComponent(cfg.wmtsLayer);
  const style = encodeURIComponent(cfg.style);
  const time = encodeURIComponent(`${isoDate}T00:00:00.000Z`);
  const { tileX, tileY, i, j } = latLngToTile(PROBE_LAT, PROBE_LNG, PROBE_ZOOM);
  // Cache-buster ÚNICO por llamada: timestamp + random.
  // Garantiza que nunca reutilizamos una respuesta cacheada del navegador,
  // de un service worker o de cualquier CDN intermedia. Crítico para que
  // el botón "Reciente" detecte datos publicados hace minutos.
  const bust = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const url =
    `https://wmts.marine.copernicus.eu/teroWmts?SERVICE=WMTS&REQUEST=GetFeatureInfo` +
    `&VERSION=1.0.0&LAYER=${wmtsLayer}&STYLE=${style}` +
    `&FORMAT=image%2Fpng&TILEMATRIXSET=EPSG%3A3857` +
    `&TILEMATRIX=${PROBE_ZOOM}&TILEROW=${tileY}&TILECOL=${tileX}` +
    `&INFOFORMAT=application%2Fjson&I=${i}&J=${j}&TIME=${time}&_=${bust}`;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "cache-control": "no-cache", pragma: "no-cache" },
    });
    if (!res.ok) return false;
    const text = await res.text();
    // Copernicus devuelve XML (ExceptionReport) cuando la fecha está fuera
    // de rango. No es JSON parseable — lo descartamos explícitamente.
    if (text.trim().startsWith("<")) return false;
    let data: { features?: { properties?: { value?: number | null } }[] };
    try {
      data = JSON.parse(text);
    } catch {
      return false;
    }
    const props = data?.features?.[0]?.properties;
    return props != null && typeof props.value === "number" && Number.isFinite(props.value);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export interface ResolvedDate {
  /** Última fecha de cualquier capa resuelta (para el resumen visual). */
  resolvedDate: string | undefined;
  /** Fecha real más reciente por capa; el mapa la usa en modo automático. */
  resolvedByLayer: Partial<Record<LayerType, string>>;
  requestedDate: string;
  status: "probing" | "ok" | "fallback" | "none";
  daysBack: number;
  probedLayer: LayerType | undefined;
  resolvedAt: number | undefined;
  refresh: () => void;
}

export function useResolvedCopernicusDate(
  probeLayer: LayerType | LayerType[] = ["sst_analysed", "sst_nrt"],
): ResolvedDate {
  const [state, setState] = useState<Omit<ResolvedDate, "refresh">>({
    resolvedDate: undefined,
    resolvedByLayer: {},
    requestedDate: todayIso(),
    status: "probing",
    daysBack: 0,
    probedLayer: undefined,
    resolvedAt: undefined,
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const probeKey = Array.isArray(probeLayer) ? probeLayer.join("|") : probeLayer;
  const layersRef = useRef<LayerType[]>([]);
  layersRef.current = Array.isArray(probeLayer) ? probeLayer : [probeLayer];

  useEffect(() => {
    let cancelled = false;
    const layers = layersRef.current;
    const today = todayIso();

    setState((prev) => ({
      ...prev,
      requestedDate: today,
      status: "probing",
      resolvedAt: undefined,
    }));

    (async () => {
      const resolvedByLayer: Partial<Record<LayerType, string>> = {};

      for (const layer of layers) {
        const start = startCandidate(layer);
        for (let d = 0; d <= MAX_LOOKBACK; d++) {
          const candidate = isoMinusDays(start, d);

          const ok = await probeDate(layer, candidate);
          if (cancelled) return;
          if (ok) {
            resolvedByLayer[layer] = candidate;
            break;
          }
        }
      }

      if (cancelled) return;

      const dates = Object.values(resolvedByLayer).filter(Boolean) as string[];
      if (dates.length > 0) {
        const resolvedDate = dates.sort().at(-1)!;
        const realDaysBack = Math.max(0, daysBetween(today, resolvedDate));
        const probedLayer = layers.find((layer) => resolvedByLayer[layer] === resolvedDate);
        setState({
          resolvedDate,
          resolvedByLayer,
          requestedDate: today,
          status: realDaysBack === 0 ? "ok" : "fallback",
          daysBack: realDaysBack,
          probedLayer,
          resolvedAt: Date.now(),
        });
        return;
      }

      setState({
        resolvedDate: today,
        resolvedByLayer: {},
        requestedDate: today,
        status: "none",
        daysBack: 0,
        probedLayer: undefined,
        resolvedAt: Date.now(),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [probeKey, tick]);

  return { ...state, refresh };
}

