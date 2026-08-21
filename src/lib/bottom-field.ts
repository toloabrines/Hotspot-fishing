/**
 * CAMPO DE FONDO PRE-MUESTREADO
 * =============================
 *
 * Problema que resuelve: la temperatura y la corriente de fondo solo se
 * pedían para los candidatos FINALES, así que el ranking ya había
 * descartado zonas antes de conocer esas variables.
 *
 * Solución: se muestrea una malla GRUESA (por defecto 8×8) sobre el área de
 * búsqueda con MEDSEA (4 km) a la profundidad más próxima al fondo de cada
 * punto, y se interpola bilinealmente a cada celda de la cuadrícula fina.
 * Así TODAS las celdas entran al scoring con temperatura, corriente,
 * oxígeno y salinidad de fondo estimados.
 *
 * Los TOP finales siguen pidiendo el valor exacto en su coordenada.
 */

import { fetchCopernicusValue } from "./copernicus-feature-info";

const MED_TEMP =
  "MEDSEA_ANALYSISFORECAST_PHY_006_013/cmems_mod_med_phy-tem_anfc_4.2km_P1D-m_202511";
const MED_CUR = "MEDSEA_ANALYSISFORECAST_PHY_006_013/cmems_mod_med_phy-cur_anfc_4.2km_P1D-m_202511";
const MED_SAL = "MEDSEA_ANALYSISFORECAST_PHY_006_013/cmems_mod_med_phy-sal_anfc_4.2km_P1D-m_202511";
// El BGC del Mediterráneo cambia de sufijo de versión con cada release del
// producto; probamos varios y nos quedamos con el primero que responde.
const MED_BGC_CANDIDATES = [
  "MEDSEA_ANALYSISFORECAST_BGC_006_014/cmems_mod_med_bgc-bio_anfc_4.2km_P1D-m_202411",
  "MEDSEA_ANALYSISFORECAST_BGC_006_014/cmems_mod_med_bgc-bio_anfc_4.2km_P1D-m_202311",
  "MEDSEA_ANALYSISFORECAST_BGC_006_014/cmems_mod_med_bgc-bio_anfc_4.2km_P1D-m",
];

const STYLE_TEMP = "cmap:thermal,vmin:10,vmax:26";
const STYLE_CUR = "cmap:RdBu_r,vmin:-1,vmax:1";
const STYLE_SAL = "cmap:haline,vmin:36,vmax:39.5";
const STYLE_O2 = "cmap:viridis,vmin:180,vmax:260";

export interface BottomFieldPoint {
  lat: number;
  lng: number;
  depthM: number | null;
  tempC: number | null;
  u: number | null;
  v: number | null;
  speed: number | null;
  o2: number | null;
  salinity: number | null;
}

export interface BottomField {
  cols: number;
  rows: number;
  south: number;
  west: number;
  north: number;
  east: number;
  points: BottomFieldPoint[];
  /** Muestra interpolada en cualquier lat/lng dentro del área. */
  sample(lat: number, lng: number): BottomFieldPoint | null;
  /** Gradiente local de salinidad normalizado 0..1 (detector de frente salino). */
  salinityFront(lat: number, lng: number): number;
  /** Cuántos puntos tienen al menos temperatura de fondo. */
  coverage: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function toCelsius(v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v > 200 ? v - 273.15 : v;
}

/** Elevación (negativa) más cercana al fondo, acotada al rango del modelo. */
function bottomElevation(depthM: number | null): number {
  if (depthM == null || !Number.isFinite(depthM) || depthM <= 0) return -10;
  return -Math.max(2, Math.min(2000, depthM - 1));
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─────────────── Caché en localStorage por fecha + área ───────────────

const LSKEY = "ov.bottomField.v1";
const TTL_MS = 12 * 60 * 60 * 1000;

interface CacheEntry {
  key: string;
  ts: number;
  data: Omit<BottomFieldPoint, never>[];
  meta: { cols: number; rows: number; south: number; west: number; north: number; east: number };
}

function readCache(key: string): CacheEntry | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LSKEY);
    if (!raw) return null;
    const list = JSON.parse(raw) as CacheEntry[];
    const hit = list.find((e) => e.key === key);
    if (!hit) return null;
    if (Date.now() - hit.ts > TTL_MS) return null;
    return hit;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(LSKEY);
    const list: CacheEntry[] = raw ? (JSON.parse(raw) as CacheEntry[]) : [];
    const next = [entry, ...list.filter((e) => e.key !== entry.key)].slice(0, 8);
    window.localStorage.setItem(LSKEY, JSON.stringify(next));
  } catch {
    /* quota */
  }
}

let bgcLayerResolved: string | null | undefined;

async function fetchO2(
  lat: number,
  lng: number,
  zoom: number,
  time: string,
  elevation: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const tryLayer = async (ds: string) => {
    const r = await fetchCopernicusValue(
      `${ds}/o2`,
      STYLE_O2,
      lat,
      lng,
      zoom,
      time,
      signal,
      elevation,
    );
    return r.value;
  };
  if (bgcLayerResolved === null) return null;
  if (bgcLayerResolved) return tryLayer(bgcLayerResolved).catch(() => null);
  for (const ds of MED_BGC_CANDIDATES) {
    try {
      const v = await tryLayer(ds);
      if (v != null && Number.isFinite(v)) {
        bgcLayerResolved = ds;
        return v;
      }
    } catch {
      /* siguiente candidato */
    }
  }
  bgcLayerResolved = null;
  return null;
}

export interface BuildBottomFieldArgs {
  south: number;
  west: number;
  north: number;
  east: number;
  zoom: number;
  time: string;
  /** Profundidad del fondo (m, positiva) en un punto; null si desconocida. */
  depthAt: (lat: number, lng: number) => number | null;
  /** Resolución de la malla gruesa (por lado). */
  side?: number;
  signal?: AbortSignal;
  /** Incluir oxígeno y salinidad (coste: 2 fetch extra por punto). */
  withBgc?: boolean;
}

export async function buildBottomField(args: BuildBottomFieldArgs): Promise<BottomField> {
  const side = Math.max(3, Math.min(12, args.side ?? 8));
  const { south, west, north, east, zoom, time, depthAt, signal } = args;
  const withBgc = args.withBgc !== false;

  const key = [
    time.slice(0, 10),
    south.toFixed(2),
    west.toFixed(2),
    north.toFixed(2),
    east.toFixed(2),
    side,
    withBgc ? "bgc" : "nobgc",
  ].join("|");

  const dLat = (north - south) / (side - 1);
  const dLng = (east - west) / (side - 1);

  const coords: { lat: number; lng: number }[] = [];
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      coords.push({ lat: south + r * dLat, lng: west + c * dLng });
    }
  }

  const cached = readCache(key);
  let points: BottomFieldPoint[];

  if (cached && cached.data.length === coords.length) {
    points = cached.data as BottomFieldPoint[];
  } else {
    points = await mapLimit(coords, 6, async ({ lat, lng }) => {
      const depthM = depthAt(lat, lng);
      const empty: BottomFieldPoint = {
        lat,
        lng,
        depthM,
        tempC: null,
        u: null,
        v: null,
        speed: null,
        o2: null,
        salinity: null,
      };
      if (depthM == null || depthM < 5) return empty;
      const elev = bottomElevation(depthM);
      try {
        const [t, u, v, sal, o2] = await Promise.all([
          fetchCopernicusValue(
            `${MED_TEMP}/thetao`,
            STYLE_TEMP,
            lat,
            lng,
            zoom,
            time,
            signal,
            elev,
          ).then((r) => r.value),
          fetchCopernicusValue(`${MED_CUR}/uo`, STYLE_CUR, lat, lng, zoom, time, signal, elev).then(
            (r) => r.value,
          ),
          fetchCopernicusValue(`${MED_CUR}/vo`, STYLE_CUR, lat, lng, zoom, time, signal, elev).then(
            (r) => r.value,
          ),
          withBgc
            ? fetchCopernicusValue(
                `${MED_SAL}/so`,
                STYLE_SAL,
                lat,
                lng,
                zoom,
                time,
                signal,
                elev,
              ).then((r) => r.value)
            : Promise.resolve(null),
          withBgc ? fetchO2(lat, lng, zoom, time, elev, signal) : Promise.resolve(null),
        ]);
        const speed =
          u != null && v != null && Number.isFinite(u) && Number.isFinite(v)
            ? Math.hypot(u, v)
            : null;
        return {
          lat,
          lng,
          depthM,
          tempC: toCelsius(t),
          u,
          v,
          speed,
          o2,
          salinity: sal,
        };
      } catch {
        return empty;
      }
    });
    writeCache({
      key,
      ts: Date.now(),
      data: points,
      meta: { cols: side, rows: side, south, west, north, east },
    });
  }

  const at = (r: number, c: number) => points[r * side + c];

  const sample = (lat: number, lng: number): BottomFieldPoint | null => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const fy = (lat - south) / (dLat || 1);
    const fx = (lng - west) / (dLng || 1);
    const r0 = Math.max(0, Math.min(side - 1, Math.floor(fy)));
    const c0 = Math.max(0, Math.min(side - 1, Math.floor(fx)));
    const r1 = Math.min(side - 1, r0 + 1);
    const c1 = Math.min(side - 1, c0 + 1);
    const ty = Math.max(0, Math.min(1, fy - r0));
    const tx = Math.max(0, Math.min(1, fx - c0));
    const quad = [
      { p: at(r0, c0), w: (1 - tx) * (1 - ty) },
      { p: at(r0, c1), w: tx * (1 - ty) },
      { p: at(r1, c0), w: (1 - tx) * ty },
      { p: at(r1, c1), w: tx * ty },
    ];
    const blend = (get: (p: BottomFieldPoint) => number | null): number | null => {
      let sum = 0;
      let wsum = 0;
      for (const { p, w } of quad) {
        if (!p) continue;
        const v = get(p);
        if (v == null || !Number.isFinite(v)) continue;
        sum += v * w;
        wsum += w;
      }
      // Si los vecinos con dato pesan poco, seguimos devolviendo su media:
      // es preferible una estimación gruesa a "sin dato" (que descartaba zonas).
      return wsum > 0.05 ? sum / wsum : null;
    };
    const u = blend((p) => p.u);
    const v = blend((p) => p.v);
    return {
      lat,
      lng,
      depthM: blend((p) => p.depthM),
      tempC: blend((p) => p.tempC),
      u,
      v,
      speed: u != null && v != null ? Math.hypot(u, v) : blend((p) => p.speed),
      o2: blend((p) => p.o2),
      salinity: blend((p) => p.salinity),
    };
  };

  // Escala de referencia del gradiente salino en el área (percentil alto).
  const salGrads: number[] = [];
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      const p = at(r, c);
      if (!p || p.salinity == null) continue;
      const e = c + 1 < side ? at(r, c + 1) : null;
      const n = r + 1 < side ? at(r + 1, c) : null;
      const gx = e?.salinity != null ? Math.abs(e.salinity - p.salinity) : 0;
      const gy = n?.salinity != null ? Math.abs(n.salinity - p.salinity) : 0;
      const g = Math.hypot(gx, gy);
      if (g > 0) salGrads.push(g);
    }
  }
  salGrads.sort((a, b) => a - b);
  const salRef = salGrads.length > 0 ? salGrads[Math.floor(salGrads.length * 0.85)] || 0.05 : 0.05;

  const salinityFront = (lat: number, lng: number): number => {
    const d = 0.04;
    const c0 = sample(lat, lng);
    const cE = sample(lat, lng + d);
    const cN = sample(lat + d, lng);
    if (!c0?.salinity || !cE?.salinity || !cN?.salinity) return 0;
    const g = Math.hypot(cE.salinity - c0.salinity, cN.salinity - c0.salinity);
    return clamp01(g / Math.max(0.01, salRef));
  };

  const coverage = points.filter((p) => p.tempC != null).length / Math.max(1, points.length);

  return {
    cols: side,
    rows: side,
    south,
    west,
    north,
    east,
    points,
    sample,
    salinityFront,
    coverage,
  };
}

// ─────────────── Curvas de respuesta biológica ───────────────

/** Temperatura de fondo → 0..1. Óptimo demersal mediterráneo 13–16 °C. */
export function bottomTempFactor(tempC: number | null | undefined, optimum = 14.5): number | null {
  if (tempC == null || !Number.isFinite(tempC)) return null;
  const d = Math.abs(tempC - optimum);
  // Campana suave: pleno hasta ±1.5 °C, cae a 0 a ±6 °C.
  if (d <= 1.5) return 1;
  return clamp01(1 - (d - 1.5) / 4.5);
}

/** Corriente de fondo → 0..1. Óptimo 0.05–0.20 m/s. */
export function bottomCurrentFactor(speed: number | null | undefined): number | null {
  if (speed == null || !Number.isFinite(speed)) return null;
  if (speed < 0.02) return 0.25; // agua parada: poca actividad
  if (speed <= 0.05) return 0.25 + ((speed - 0.02) / 0.03) * 0.65;
  if (speed <= 0.2) return 1;
  if (speed <= 0.4) return clamp01(1 - (speed - 0.2) / 0.25);
  return 0.05;
}

/**
 * Oxígeno disuelto (mmol/m³ en MEDSEA BGC) → 0..1.
 * < 90 mmol/m³ (~2 ml/l) hipoxia; 180–260 óptimo.
 */
export function oxygenFactor(o2: number | null | undefined): number | null {
  if (o2 == null || !Number.isFinite(o2)) return null;
  if (o2 < 90) return clamp01(o2 / 180);
  if (o2 < 180) return 0.5 + ((o2 - 90) / 90) * 0.4;
  if (o2 <= 260) return 1;
  return 0.9;
}

