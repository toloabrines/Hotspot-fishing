import { useEffect, useMemo, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { isPointInArea, type SearchArea } from "../lib/geo-area";
import { getLandMask, type LandMask } from "../lib/land-mask";
import {
  getDepthAtLatLng,
  summarizeSources,
  resetBathymetryStats,
  getBathymetryStats,
  type DepthSource,
} from "../lib/bathymetry";
import { bicubicFillGrid, bicubicSmoothGrid } from "../lib/bicubic";
import { fetchCopernicusValue } from "../lib/copernicus-feature-info";
import { fetchThermocline, fetchTempAtDepth } from "../lib/thermocline";
import {
  fetchCopernicusCurrentVector,
  currentDepthLabel,
  type CurrentVectorResult,
} from "../lib/copernicus-currents";
import { getKnownSpotsInBounds, evaluateRecallAtK } from "../lib/known-spots";
import {
  MIX_WEIGHTS,
  SURFACE_BLOCK_WEIGHTS,
  getWeights,
  weightedScore,
  setLearnedWeights,
  type FishingModeKey,
} from "../lib/scoring-weights";
import {
  saveCatchReport,
  recomputeLearnedWeights,
  getLearningState,
} from "../lib/catch-learning.functions";
import {
  buildBottomField,
  bottomTempFactor,
  bottomCurrentFactor,
  oxygenFactor,
  type BottomField,
} from "../lib/bottom-field";
import { buildFsleField, emptyFsleField } from "../lib/fsle-proximity";
import { computeSquidScore, type SquidBreakdown } from "../lib/squid-engine";
import { computeDriftScore, type DriftBreakdown } from "../lib/drift-engine";
import { computeCoastGeometry, type CoastGeometry } from "../lib/coast-geometry";
import { buildDriftCorridors, type DriftCorridor, type DriftCorridorCell } from "../lib/drift-corridor";
import { renderDriftCorridors } from "./drift-corridor-render";
import {
  fetchMarineConditions,
  EMPTY_MARINE,
  type MarineConditions,
} from "../lib/marine-conditions";
import { LAYER_CONFIGS, type LayerType } from "./ocean-layers";

/**
 * FishingHotspots — MOTOR UNIFICADO de scoring (v3).
 *
 * Un único algoritmo. Cada celda calcula:
 *   - score_fondo      ∈ [0..100]  (5 factores, ver computeBottomScore)
 *   - score_superficie ∈ [0..100]  (5 factores, ver computeSurfaceScore)
 *   - score_total      ∈ [0..100]  (pesos según modo)
 *
 * Modo "Pesca a superficie":  total = 0.75·sup + 0.25·fondo
 * Modo "Pesca a fondo":       total = 0.75·fondo + 0.25·sup
 *
 * + bonus de sinergia si AMBOS subscores ≥ 60
 * + penalizaciones por baja calidad de muestreo / artefactos
 *
 * Cada hotspot se etiqueta con una explicación real basada en los
 * factores que efectivamente disparan su puntuación.
 */

export type { FishingSpot } from "./FishingHotspots.types";
export { spotsToGpx, downloadSpotsGpx, toDegMin, toDegMinSec } from "./FishingHotspots.types";
import { toDegMinSec as _toDMS } from "./FishingHotspots.types";
import type { FishingSpot } from "./FishingHotspots.types";

interface FishingHotspotsProps {
  enabled: boolean;
  /** Profundidad mínima/máxima objetivo (m, positivos). */
  minDepth?: number;
  maxDepth?: number;
  /** Score mínimo (0..1) para mostrar. */
  minScore?: number;
  maxSpots?: number;
  onSpotsChange?: (spots: FishingSpot[], routes: FishingSpot[][]) => void;
  recomputeTrigger?: number;
  clearTrigger?: number;
  searchArea?: SearchArea | null;
  debug?: boolean;
  hotZoneOnly?: boolean;
  hotZoneMode?: "precise" | "explore";
  fishingMode?: "surface" | "bottom" | "squid" | "drift";
  /**
   * Fechas resueltas por capa (mismo origen que el popup). Se usan para
   * UNIFICAR popup ↔ análisis: si el motor lee "sin dato" del raster, hace
   * un GetFeatureInfo puntual a Copernicus contra ESTAS fechas — exactamente
   * lo mismo que el popup. Sin esto, popup y motor podían divergir.
   */
  layerTimes?: Partial<Record<LayerType, string>>;
  onLoadingChange?: (loading: boolean) => void;
  /**
   * Notifica al exterior la fase actual del análisis. Permite mostrar al
   * usuario un mensaje vivo ("Leyendo datos…", "Calculando gradientes…").
   * Se llama con `null` cuando termina (con éxito o error).
   */
  onProgress?: (phase: string | null) => void;
  /** Notifica errores reales del análisis con el mensaje exacto. */
  onAnalysisError?: (message: string) => void;
  onAnalysisSummary?: (summary: {
    cellsAnalyzed: number;
    maxScore: number;
    bestCluster: { lat: number; lng: number; score: number; cells: number } | null;
    insideArea: boolean;
    mode: "surface" | "bottom";
    /** Mensaje específico cuando no se encuentra nada (no genérico). */
    noResultReason?: string;
    /** Fuente real de batimetría usada en la corrida (EMODnet/GEBCO/mix). */
    bathymetrySource?: DepthSource | "mixed" | "none";
    /** Etiqueta legible para el indicador UI. */
    bathymetryLabel?: string;
    /**
     * Estado real por capa de DATOS NUMÉRICOS (no la mera presencia visual
     * en el mapa). "ok" = se pudo extraer al menos un valor real para el
     * scoring; "sin dato" = la capa no respondió con valores utilizables.
     * Se usa para mostrar al usuario exactamente qué se ha podido leer.
     */
    layerStatus?: {
      sst: "ok" | "sin dato";
      chl: "ok" | "sin dato";
      alt: "ok" | "sin dato";
      bat: "ok" | "sin dato";
    };
  }) => void;
  /**
   * Permite al usuario fijar un spot como waypoint persistente desde el
   * popup. Si no se pasa, no se renderiza el botón.
   */
  onSaveWaypoint?: (
    lat: number,
    lng: number,
    score: number,
    depth: number | null,
    reason: string,
    defaultName: string,
  ) => void;
}

const PANE_NAME = "fishing-hotspots-pane";
const RECOMPUTE_DEBOUNCE_MS = 380;

// ─────────────────── utilidades de raster ───────────────────

function pixelToValue(r: number, g: number, b: number, a: number): number {
  if (a < 30) return NaN;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return 0.65 * sat + 0.35 * lum;
}

function rasterizePane(map: L.Map, paneClass: string): HTMLCanvasElement | null {
  const size = map.getSize();
  const w = size.x;
  const h = size.y;
  if (w <= 0 || h <= 0) return null;
  const container = map.getContainer();
  const paneEl = container.querySelector<HTMLElement>(`.${paneClass}`);
  if (!paneEl) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const containerRect = container.getBoundingClientRect();
  const tiles = paneEl.querySelectorAll<HTMLImageElement>("img.leaflet-tile-loaded");
  let drawn = 0;
  tiles.forEach((img) => {
    if (!img.complete || img.naturalWidth === 0) return;
    if (!img.crossOrigin) {
      try {
        img.crossOrigin = "anonymous";
      } catch {
        /* ignore */
      }
    }
    const rect = img.getBoundingClientRect();
    try {
      ctx.drawImage(
        img,
        rect.left - containerRect.left,
        rect.top - containerRect.top,
        rect.width,
        rect.height,
      );
      drawn += 1;
    } catch {
      /* CORS — saltar */
    }
  });
  return drawn > 0 ? canvas : null;
}

interface Sample {
  v: number;
  grad: number;
  gx: number;
  gy: number;
  hasData: boolean;
  /** Fuente del valor: "exact" si el píxel central tenía dato, "nearest" si vino de búsqueda en anillos, "bilinear" si vino de promedio bilinear, "none" si no se obtuvo nada. */
  source: "exact" | "nearest" | "bilinear" | "none";
  /** Distancia en píxeles al píxel con dato más cercano (0 si exact). */
  distancePx: number;
}

function sampleAt(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  px: number,
  py: number,
  step: number,
): Sample {
  const get = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= w || y >= h) return NaN;
    const i = (y * w + x) * 4;
    return pixelToValue(data[i], data[i + 1], data[i + 2], data[i + 3]);
  };
  const c = get(px, py);
  const n = get(px, py - step);
  const s = get(px, py + step);
  const e = get(px + step, py);
  const wv = get(px - step, py);
  if (Number.isNaN(c)) {
    return { v: 0, grad: 0, gx: 0, gy: 0, hasData: false, source: "none", distancePx: -1 };
  }
  const gx = (Number.isNaN(e) ? c : e) - (Number.isNaN(wv) ? c : wv);
  const gy = (Number.isNaN(s) ? c : s) - (Number.isNaN(n) ? c : n);
  const grad = Math.sqrt(gx * gx + gy * gy);
  return { v: c, grad, gx, gy, hasData: true, source: "exact", distancePx: 0 };
}

/**
 * Muestreo con fallback: si el píxel exacto no tiene dato (pane semi-transparente,
 * tile aún sin cargar, hueco de cobertura), busca en anillos concéntricos hasta
 * `maxRadiusPx` y, si encuentra varios píxeles válidos en el anillo, devuelve
 * la media bilinear. Devuelve `source` indicando qué se usó.
 *
 * Esto desacopla "la capa se ve" de "el motor consigue extraer un valor":
 * aunque el píxel exacto del centroide caiga en una banda transparente entre
 * tiles o sobre la sombra de un marker, encontramos dato cercano si existe.
 */
function sampleWithFallback(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  px: number,
  py: number,
  step: number,
  maxRadiusPx: number,
): Sample {
  // 1) Intento exacto
  const exact = sampleAt(data, w, h, px, py, step);
  if (exact.hasData) return exact;

  // 2) Anillos concéntricos: 2, 4, 8, 16, 32 px (hasta maxRadiusPx)
  const radii: number[] = [];
  for (let r = 2; r <= maxRadiusPx; r *= 2) radii.push(r);
  for (const r of radii) {
    const found: { x: number; y: number; v: number }[] = [];
    // Muestreamos 8 puntos cardinales/diagonales del anillo
    const offsets: [number, number][] = [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
      [r, r],
      [r, -r],
      [-r, r],
      [-r, -r],
    ];
    for (const [dx, dy] of offsets) {
      const x = px + dx;
      const y = py + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      const v = pixelToValue(data[i], data[i + 1], data[i + 2], data[i + 3]);
      if (!Number.isNaN(v)) found.push({ x, y, v });
    }
    if (found.length === 0) continue;

    if (found.length === 1) {
      // Nearest-neighbor puro
      const f = found[0];
      const sub = sampleAt(data, w, h, f.x, f.y, step);
      return { ...sub, source: "nearest", distancePx: r };
    }
    // Bilinear/promedio ponderado por inverso de distancia
    let sumV = 0;
    let sumGx = 0;
    let sumGy = 0;
    let sumW = 0;
    for (const f of found) {
      const dist = Math.hypot(f.x - px, f.y - py);
      const wgt = 1 / Math.max(1, dist);
      const sub = sampleAt(data, w, h, f.x, f.y, step);
      if (!sub.hasData) continue;
      sumV += sub.v * wgt;
      sumGx += sub.gx * wgt;
      sumGy += sub.gy * wgt;
      sumW += wgt;
    }
    if (sumW > 0) {
      const v = sumV / sumW;
      const gx = sumGx / sumW;
      const gy = sumGy / sumW;
      return {
        v,
        gx,
        gy,
        grad: Math.sqrt(gx * gx + gy * gy),
        hasData: true,
        source: "bilinear",
        distancePx: r,
      };
    }
  }

  return { v: 0, grad: 0, gx: 0, gy: 0, hasData: false, source: "none", distancePx: -1 };
}

/**
 * Suaviza una imagen RGBA con un box-blur separable de radio `r` (kernel
 * (2r+1)×(2r+1)). Sirve para eliminar el ruido sub-tile y las costuras
 * WMTS antes de calcular gradientes SST: en Mediterráneo los frentes
 * reales son persistentes a > 5 px y sobreviven al suavizado, mientras
 * que las discontinuidades artificiales de tile (1-2 px) desaparecen.
 *
 * Implementación naive pero suficiente: O(W·H·r). Para r=2 sobre un
 * viewport típico (~1000×700) son ~3.5M ops, ejecutado una sola vez por
 * análisis. No bloquea.
 */
function boxBlurRgba(src: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  if (r < 1) return src;
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  // Pasada horizontal
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let rs = 0,
        gs = 0,
        bs = 0,
        as = 0,
        n = 0;
      for (let k = -r; k <= r; k++) {
        const xi = x + k;
        if (xi < 0 || xi >= w) continue;
        const i = (y * w + xi) * 4;
        const a = src[i + 3];
        if (a < 30) continue;
        rs += src[i];
        gs += src[i + 1];
        bs += src[i + 2];
        as += a;
        n++;
      }
      const o = (y * w + x) * 4;
      if (n === 0) {
        tmp[o] = src[o];
        tmp[o + 1] = src[o + 1];
        tmp[o + 2] = src[o + 2];
        tmp[o + 3] = src[o + 3];
      } else {
        tmp[o] = rs / n;
        tmp[o + 1] = gs / n;
        tmp[o + 2] = bs / n;
        tmp[o + 3] = as / n;
      }
    }
  }
  // Pasada vertical
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let rs = 0,
        gs = 0,
        bs = 0,
        as = 0,
        n = 0;
      for (let k = -r; k <= r; k++) {
        const yi = y + k;
        if (yi < 0 || yi >= h) continue;
        const i = (yi * w + x) * 4;
        const a = tmp[i + 3];
        if (a < 30) continue;
        rs += tmp[i];
        gs += tmp[i + 1];
        bs += tmp[i + 2];
        as += a;
        n++;
      }
      const o = (y * w + x) * 4;
      if (n === 0) {
        out[o] = tmp[o];
        out[o + 1] = tmp[o + 1];
        out[o + 2] = tmp[o + 2];
        out[o + 3] = tmp[o + 3];
      } else {
        out[o] = rs / n;
        out[o + 1] = gs / n;
        out[o + 2] = bs / n;
        out[o + 3] = as / n;
      }
    }
  }
  return out;
}

/**
 * Varianza local de pixelToValue en una ventana cuadrada centrada en (px,py).
 * Devuelve 0 si no hay suficientes muestras válidas. Sirve para detectar
 * "manchas homogéneas" (centro de tile SST con color casi uniforme) que NO
 * deben ganar el ranking aunque su gradiente puntual sea moderado.
 */
function localValueVariance(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  px: number,
  py: number,
  radius: number,
): number {
  const vals: number[] = [];
  for (let dy = -radius; dy <= radius; dy += 2) {
    for (let dx = -radius; dx <= radius; dx += 2) {
      const x = px + dx,
        y = py + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      const v = pixelToValue(data[i], data[i + 1], data[i + 2], data[i + 3]);
      if (!Number.isNaN(v)) vals.push(v);
    }
  }
  if (vals.length < 8) return 0;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  let acc = 0;
  for (const v of vals) acc += (v - m) * (v - m);
  return acc / vals.length;
}

/**
 * Detecta seams de tile WMTS: discontinuidades artificiales axis-aligned
 * (líneas horizontales o verticales nítidas de 1–2 px) provocadas por
 * cambios de paleta entre teselas vecinas. Un frente oceánico real NO es
 * estrictamente axis-aligned y persiste al desplazarse perpendicular al
 * gradiente. Si detectamos un seam → degradamos sstGradiente a casi cero
 * para que ese punto no gane el ranking.
 */
function isAxisAlignedSeam(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  px: number,
  py: number,
  gx: number,
  gy: number,
  step: number,
): boolean {
  const ax = Math.abs(gx);
  const ay = Math.abs(gy);
  const mag = Math.hypot(gx, gy);
  if (mag < 1e-3) return false;
  // Sólo sospechamos seam si el gradiente es muy axis-aligned
  const horizontalSeam = ay > 5 * ax; // frontera horizontal (∇ vertical)
  const verticalSeam = ax > 5 * ay; // frontera vertical (∇ horizontal)
  if (!horizontalSeam && !verticalSeam) return false;
  // Si la magnitud cae bruscamente al desplazarse paralelo al seam,
  // y se mantiene perpendicular, es un seam (línea recta nítida).
  const off = step * 3;
  const probes: Sample[] = [];
  if (horizontalSeam) {
    // muestreamos a lo largo del eje x (paralelo al seam horizontal)
    probes.push(sampleAt(data, w, h, px - off, py, step));
    probes.push(sampleAt(data, w, h, px + off, py, step));
  } else {
    probes.push(sampleAt(data, w, h, px, py - off, step));
    probes.push(sampleAt(data, w, h, px, py + off, step));
  }
  let parallelMagAvg = 0;
  let n = 0;
  for (const p of probes) {
    if (!p.hasData) continue;
    parallelMagAvg += Math.hypot(p.gx, p.gy);
    n++;
  }
  if (n === 0) return false;
  parallelMagAvg /= n;
  // Si paralelo al seam la magnitud cae >70%, es seam.
  return parallelMagAvg < mag * 0.3;
}

// ─────────────────── batimetría (EMODnet + GEBCO) ───────────────────
//
// La lectura de profundidad vive en `lib/bathymetry.ts`. Aquí solo
// reexportamos el tipo y consumimos `fetchDepth` que prioriza EMODnet
// (alta resolución en Europa) con fallback automático a GEBCO global.
// El motor cachea por celda dentro del módulo, así no repetimos llamadas
// entre re-cómputos del mismo área.

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isValidLatLng = (lat: unknown, lng: unknown): lat is number =>
  isFiniteNumber(lat) &&
  isFiniteNumber(lng) &&
  lat >= -90 &&
  lat <= 90 &&
  lng >= -180 &&
  lng <= 180;
const safeScore100 = (v: unknown): number =>
  isFiniteNumber(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0;

// ─────────────────── MOTOR UNIFICADO ───────────────────
//
// Cada candidato pasa por dos sub-motores:
//   computeBottomScore  → 5 factores de fondo
//   computeSurfaceScore → 5 factores de superficie
// Luego se combinan según el modo + bonus sinergia − penalizaciones.

interface BottomFactors {
  pendiente: number; // 0..1
  rugosidad: number; // 0..1
  profundidad: number; // 0..1
  transicion: number; // 0..1
  consistencia: number; // 0..1
  // crudos (para popup)
  slopeMperKm: number;
  roughnessM: number;
  transitionM: number;
  depthM: number | null;
  /** true si la celda tiene batimetría útil (no fallback). */
  hasBathy: boolean;
  depthDeltaM: number;
  distToBreakM: number | null;
  nearIsobaths: number[];
  reliefClass: "monte" | "depresion" | "ladera" | "plano";
  /** Rugosidad a mayor escala (std-dev en ventana 5×5) en metros. Capta
   *  relieves grandes (cabezos, montículos) que el 3×3 no resuelve. */
  roughness5x5M: number;
  /** Curvatura del fondo (laplaciano discreto) en m/km². Positiva =
   *  cuenco/depresión (cañón); negativa = monte/cabezo; ~0 = ladera/plano. */
  curvatureMperKm2: number;
  /** Magnitud del quiebre de pendiente: 0..1. >0.6 indica que esta celda
   *  es un máximo local de pendiente respecto a sus 8 vecinos (break of slope). */
  slopeBreakStrength: number;
  /** Clasificación física derivada de curvatura + slope-break. */
  reliefType: "cañón" | "monte" | "quiebre" | "ladera" | "llano";
  /** TPI 3×3 (Topographic Position Index): media(vecinos) − z, en metros.
   *  Convención: positivo = celda MÁS SOMERA que el entorno (cabezo,
   *  cumbre); negativo = depresión. A escala de 1 celda. */
  tpi3M: number;
  /** TPI 5×5: igual que tpi3M pero a escala mayor — capta cabezos extensos
   *  y montes submarinos que la ventana 3×3 no resuelve. */
  tpi5M: number;
  /** Orientación de la ladera (aspect) en grados, 0–360 (N=0, E=90).
   *  null si la pendiente es ~0 (sin orientación). */
  aspectDeg: number | null;
  /** Temperatura del agua de FONDO (°C) en (lat,lng) y profundidad real,
   *  obtenida del producto thetao Copernicus con ELEVATION = -depthM.
   *  Se rellena solo para los TOP candidatos validados (post-fetch).
   *  null si no se ha consultado o no hay dato. */
  bottomTempC?: number | null;
  /** Corriente REAL a la profundidad más cercana al fondo (MEDSEA uo/vo con
   *  ELEVATION = -depthM). Se rellena solo para los TOP candidatos en modo
   *  fondo/calamar. Contiene velocidad (m/s), rumbo (°), profundidad usada
   *  y componentes u/v. */
  bottomCurrent?: CurrentVectorResult | null;
}

interface SurfaceFactors {
  sstGradiente: number; // 0..1
  chl: number; // 0..1
  corriente: number; // 0..1
  adt: number; // 0..1
  coherencia: number; // 0..1
  /** Señal simple de respaldo (0..1) para no dejar sin Top 1 si los gradientes son débiles. */
  fallbackSignal: number;
  fallbackDominant?: "alt" | "sst" | "chl" | null;
  /** Compresión de isóbatas + transición + pendiente derivada de bF. 0..1 */
  bathyEdge: number;
  /** Varianza local SST normalizada (0..1). Cerca de 0 → mancha homogénea. */
  localStructure: number;
  /** True si el gradiente SST viene de una costura artificial WMTS. */
  seamArtifact: boolean;
  /** Qué capas tienen datos reales (para renormalizar pesos). */
  hasSst: boolean;
  hasChl: boolean;
  hasAlt: boolean;
  /** Origen del valor muestreado por capa (para debug y popup). */
  sstSource?: Sample["source"];
  chlSource?: Sample["source"];
  altSource?: Sample["source"];
  /** Si la altimetría falla, motivo concreto. */
  altMissReason?: "pane_no_tiles" | "off_screen" | "no_coverage_nearby" | "no_data_at_pixel" | null;
  /**
   * Valores REALES leídos por GetFeatureInfo en la coordenada exacta
   * del spot (no normalizados). Se rellenan tras la validación TOP.
   * Sirven para construir un popup específico de cada punto y para el
   * bloque debug.
   */
  rawValues?: {
    sst?: { value: number; units?: string }; // °C
    chl?: { value: number; units?: string }; // mg/m³
    /** Topografía dinámica absoluta (ADT) en m — NO es la anomalía (SLA). */
    adt?: { value: number; units?: string }; // m (ADT)
    /** MÓDULO de la corriente superficial (m/s). Siempre ≥ 0: se calcula
     *  como √(u²+v²) a partir de las componentes uo/vo, nunca a partir de
     *  un canal escalar con signo (ADT/SLA). */
    currentSpeed?: { value: number; units?: string }; // m/s
    /** Rumbo HACIA donde fluye la corriente superficial (0–360°). */
    currentDirDeg?: number;
  };

  /**
   * Termoclina (perfil vertical de temperatura). Se consulta SOLO para
   * los TOP candidatos validados — no se calcula en toda la grilla por
   * coste. Una termoclina somera (15–30 m) concentra pelágicos en
   * superficie; profunda (>60 m) los dispersa.
   */
  thermoclineDepth?: number | null;
  thermoclineGradient?: number | null;
  thermoclineStrength?: "débil" | "media" | "fuerte" | null;
  /**
   * Componentes vectoriales de la corriente geostrófica (m/s) en el punto
   * exacto. uo = componente este (+E), vo = componente norte (+N).
   * Solo se rellena para los TOP candidatos validados.
   */
  currentU?: number | null;
  currentV?: number | null;
  /**
   * Vorticidad relativa ζ = ∂v/∂x − ∂u/∂y (1/s). Valores altos en módulo
   * indican rotación (eddies, meandros) que concentra bait y pelágicos.
   */
  currentVorticity?: number | null;
  /**
   * Divergencia ∇·u = ∂u/∂x + ∂v/∂y (1/s). Negativa = convergencia
   * (frente que acumula plancton); positiva = divergencia (upwelling).
   */
  currentDivergence?: number | null;
  /**
   * Alineación de la corriente con la batimetría. 0 = corriente cruza
   * isóbatas perpendicularmente (compresión, frentes), 1 = corriente
   * paralela al veril (poca interacción).
   */
  currentBathyCross?: number | null;
  /**
   * Persistencia temporal del frente SST: 0 = el valor SST cambió mucho
   * entre días (ruido), 1 = se mantiene estable (frente real).
   */
  sstPersistence?: number | null;
}

export type ConfidenceLevel = "muy_alta" | "alta" | "media" | "baja" | "parcial";

/**
 * Etiqueta legible de CALIDAD DE PESCA derivada del score total (0..100).
 * Esto NO es lo mismo que la confianza de datos.
 */
export type QualityLabel = "Excelente" | "Muy buena" | "Buena" | "Aceptable" | "Floja";

export function qualityFromScore(scoreTotal: number): QualityLabel {
  if (scoreTotal >= 85) return "Excelente";
  if (scoreTotal >= 70) return "Muy buena";
  if (scoreTotal >= 55) return "Buena";
  if (scoreTotal >= 40) return "Aceptable";
  return "Floja";
}

/**
 * Etiqueta de calidad ESPECÍFICA para "Pesca a fondo" — escala equilibrada.
 * Coincide con los buckets del scoring progresivo:
 *   80–100 Muy alta · 65–79 Alta · 50–64 Media · 35–49 Aceptable · <35 Baja
 */
export type BottomQualityLabel = "Muy alta" | "Alta" | "Media" | "Aceptable" | "Baja";
export function qualityFromScoreBottom(scoreTotal: number): BottomQualityLabel {
  if (scoreTotal >= 80) return "Muy alta";
  if (scoreTotal >= 65) return "Alta";
  if (scoreTotal >= 50) return "Media";
  if (scoreTotal >= 35) return "Aceptable";
  return "Baja";
}

/**
 * Etiqueta de calidad ESPECÍFICA para "Pesca a superficie" — escala
 * equilibrada (mismo enfoque que la de fondo). Antes se reutilizaba
 * `qualityFromScore` con umbrales 85/70/55/40, demasiado severos para el
 * rango real del score de superficie: zonas con frente térmico claro y 3
 * capas reales caían como "Floja". Los nuevos buckets son:
 *   75–100 Excelente · 60–74 Muy buena · 45–59 Buena · 30–44 Aceptable · <30 Floja
 */
export function qualityFromScoreSurface(scoreTotal: number): QualityLabel {
  if (scoreTotal >= 75) return "Excelente";
  if (scoreTotal >= 60) return "Muy buena";
  if (scoreTotal >= 45) return "Buena";
  if (scoreTotal >= 30) return "Aceptable";
  return "Floja";
}

/** Punto cardinal (16 rumbos) a partir de grados 0–360. */
export function cardinalFromDeg(deg: number): string {
  const dirs = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO",
  ];
  const d = ((deg % 360) + 360) % 360;
  return dirs[Math.round(d / 22.5) % 16];
}

/**
 * Formato canónico de una corriente: SIEMPRE módulo positivo + rumbo + cardinal.
 * Ej.: "0,07 m/s · 118° · ESE". Nunca puede salir un valor negativo: la
 * velocidad es un módulo, el signo pertenece a las componentes u/v.
 */
export function formatCurrent(speedMps: number, dirDeg?: number | null): string {
  const spd = Math.abs(speedMps);
  const base = `${spd.toFixed(2).replace(".", ",")} m/s`;
  if (dirDeg == null || !Number.isFinite(dirDeg)) return base;
  const d = Math.round(((dirDeg % 360) + 360) % 360);
  return `${base} · de ${d}° ${cardinalFromDeg(d)}`;
}

/** Etiqueta cualitativa de intensidad de corriente (para textos y score). */
export function currentStrengthLabel(speedMps: number): string {
  const s = Math.abs(speedMps);
  if (s < 0.03) return "prácticamente nula";
  if (s < 0.08) return "muy débil";
  if (s < 0.2) return "débil";
  if (s < 0.4) return "moderada";
  if (s < 0.7) return "fuerte";
  return "muy fuerte";
}



/**
 * CONFIANZA DE DATOS — depende SOLO de la disponibilidad y frescura de
 * datos reales (SST, CHL, ALT, BAT), NO del score de pesca.
 *
 * Reglas:
 *  - "muy_alta": las 4 capas con dato real (SST + CHL + ALT + BAT)
 *  - "alta":    3 capas reales
 *  - "media":   2 capas reales
 *  - "baja":    0–1 capa real, o error de carga, o punto en tierra,
 *               o capas desactualizadas
 */
export function computeDataConfidence(args: {
  hasSst: boolean;
  hasChl: boolean;
  hasAlt: boolean;
  hasBathy: boolean;
  loadError?: boolean;
  onLand?: boolean;
  outdated?: boolean;
}): ConfidenceLevel {
  if (args.loadError || args.onLand || args.outdated) return "baja";
  const n =
    (args.hasSst ? 1 : 0) + (args.hasChl ? 1 : 0) + (args.hasAlt ? 1 : 0) + (args.hasBathy ? 1 : 0);
  if (n >= 4) return "muy_alta";
  if (n === 3) return "alta";
  if (n === 2) return "media";
  return "baja";
}

interface ScoreBreakdown {
  scoreFondo: number; // 0..100
  scoreSuperficie: number; // 0..100
  scoreTotal: number; // 0..100 (final, ya con sinergia y penalización)
  bonusSinergia: number; // 0..15
  penalizacion: number; // 0..20
  reasons: string[];
  rank: "top" | "muy_bueno" | "interesante" | "flojo" | "sin_interes";
  confidence: ConfidenceLevel;
  /** Etiquetas de capas usadas: "bathy", "sst", "chl", "alt" */
  layersUsed: string[];
  /** Capas que faltaron y degradaron la confianza */
  layersMissing: string[];
  /**
   * Modo "Pesca superficie" — coincidencia de gradientes.
   * Indica qué gradiente domina la decisión del Top 1 superficie.
   */
  surfaceGradientDominant?: "alt" | "sst" | "chl" | null;
  surfaceGradientMode?: boolean;
  /**
   * Sub-scores por capa (0..100). Solo presentes las capas con datos.
   * Permiten ver en el popup qué variable está limitando la puntuación.
   */
  componentScores?: {
    sst?: number;
    chl?: number;
    alt?: number;
    current?: number;
    bathy?: number;
    /** Desglose específico de FONDO / CALAMAR (0..100). */
    estructura?: number;
    veril?: number;
    profundidadOk?: number;
    tempFondo?: number;
    corrFondo?: number;
    oxigeno?: number;
    frenteSalino?: number;
    fsle?: number;
    luna?: number;
    calidadDatos?: number;
    /** Desglose específico de PESCA A LA DERIVA (fluixa, 0..100). */
    deriva?: number;
    abrigo?: number;
    oleaje?: number;
    punta?: number;
    canal?: number;
    distCosta?: number;
    persistencia?: number;
  };

  /**
   * Vector de factores normalizados 0..1 que produjo esta puntuación.
   * Se envía con el informe de captura para el aprendizaje adaptativo.
   */
  factorsSnapshot?: Record<string, number>;
}

/**
 * Expansión gamma para gradientes oceanográficos. Los gradientes mediterráneos
 * son típicamente débiles (0.1-0.3 sobre 1.0) y comprimían todo el ranking
 * a 15-25/100. Con γ=0.45 un gradiente de 0.2 → 47/100, 0.4 → 66/100,
 * 0.6 → 78/100 — usa toda la escala.
 */
const expandGradient = (g: number) => Math.pow(clamp01(g), 0.45);

/** Calcula sub-scores 0..100 por capa para mostrar en el popup. */
function computeComponentScores(
  sF: SurfaceFactors,
  bF: BottomFactors,
): NonNullable<ScoreBreakdown["componentScores"]> {
  const out: NonNullable<ScoreBreakdown["componentScores"]> = {};
  if (sF.hasSst) out.sst = Math.round(expandGradient(sF.sstGradiente) * 100);
  if (sF.hasChl) out.chl = Math.round(expandGradient(sF.chl) * 100);
  if (sF.hasAlt) {
    out.alt = Math.round(expandGradient(sF.adt) * 100);
    out.current = Math.round(expandGradient(sF.corriente) * 100);
  }
  if (bF.hasBathy) {
    const bEdge = clamp01(0.5 * bF.pendiente + 0.35 * bF.transicion + 0.15 * bF.rugosidad);
    out.bathy = Math.round(expandGradient(bEdge) * 100);
  }
  return out;
}

/**
 * Score de fondo con renormalización: si no hay batimetría, los 4 factores
 * batimétricos se anulan y el score se reduce, pero el sistema NO se bloquea
 * (devolverá un score bajo de fondo y dependerá de superficie).
 */
function computeBottomFromFactors(f: BottomFactors): number {
  if (!f.hasBathy) {
    // Sin batimetría → todos los factores batimétricos = 0.
    // Score de fondo = 0 pero el motor sigue funcionando con superficie.
    return 0;
  }
  // 30 + 25 + 20 + 15 + 10 = 100
  const s =
    f.pendiente * 0.3 +
    f.rugosidad * 0.25 +
    f.profundidad * 0.2 +
    f.transicion * 0.15 +
    f.consistencia * 0.1;
  return Math.round(clamp01(s) * 100);
}

/**
 * Score V2 — exclusivo para "Pesca a fondo" sobre datos REALES de EMODnet.
 *
 * Versión v3 (rev. estructura): incorpora rugosidad a 5×5, curvatura del
 * fondo (laplaciano) y quiebre de pendiente para anclar el Top 1 a
 * estructuras físicas reales (cañones, montes, breaks plataforma→talud)
 * en lugar de a un único máximo de pendiente local.
 *
 * Normalizaciones:
 *   normSlope   = clamp(slope / 30, 0, 1)            // 30 m/km = pendiente fuerte
 *   normRough   = clamp(roughness3x3 / 10, 0, 1)     // 10 m std-dev = relieve marcado
 *   normRoughW  = clamp(roughness5x5 / 15, 0, 1)     // 15 m std-dev = relieve a >1 celda
 *   normEdge    = clamp(transition / 15, 0, 1)       // 15 m de Δ = corte claro
 *   normCurv    = clamp(|laplacian| / 4, 0, 1)       // 4 m/km² = cuenco/monte claro
 *   normBreak   = slopeBreakStrength (ya 0..1)
 *   depthBonus  = 1 si depth ∈ [min..max], 0 si no
 *
 * Pesos (v3):
 *   pendiente 24% · rugosidad3 14% · rugosidad5 12% · transición 10%
 *   curvatura 14% · break 16% · bonus profundidad 10%   (Σ = 100)
 *
 * La profundidad NUNCA elimina el spot, solo aporta bonus.
 */
/**
 * Perfiles de pesos del scoring de FONDO según el contexto batimétrico
 * dominante de la zona analizada. Se eligen automáticamente a partir de
 * la profundidad media del área (ver `pickBottomProfile`).
 *
 *   - plataforma  (mean depth <  200 m): manda RUGOSIDAD + CURVATURA
 *                  (cabezos rocosos, bajos). Pendiente menos importante.
 *   - talud       (200–800 m): manda QUIEBRE + PENDIENTE + transición
 *                  (shelf-break clásico).
 *   - abisal      (> 800 m): manda CURVATURA + QUIEBRE (cañones,
 *                  montículos abisales). Profundidad casi neutra.
 */
export type BottomProfile = "plataforma" | "talud" | "abisal";

export interface BottomWeights {
  slope: number; // pendiente
  rough3: number; // rugosidad 3x3
  rough5: number; // rugosidad 5x5
  edge: number; // transición batimétrica
  curv: number; // curvatura (laplaciano)
  brk: number; // quiebre de pendiente
  depth: number; // bonus por estar en rango objetivo
  tpi: number; // Topographic Position Index multi-escala (cabezos)
}

export const BOTTOM_PROFILE_WEIGHTS: Record<BottomProfile, BottomWeights> = {
  // Σ = 1.00 cada perfil. TPI mete una señal robusta de "cabezo / cumbre"
  // que en plataforma y talud es el mejor predictor de demersales.
  plataforma: {
    slope: 0.18,
    rough3: 0.14,
    rough5: 0.12,
    edge: 0.08,
    curv: 0.14,
    brk: 0.1,
    depth: 0.12,
    tpi: 0.12,
  },
  talud: {
    slope: 0.24,
    rough3: 0.12,
    rough5: 0.1,
    edge: 0.1,
    curv: 0.08,
    brk: 0.16,
    depth: 0.1,
    tpi: 0.1,
  },
  abisal: {
    slope: 0.22,
    rough3: 0.1,
    rough5: 0.12,
    edge: 0.08,
    curv: 0.18,
    brk: 0.14,
    depth: 0.1,
    tpi: 0.06,
  },
};

/** Selecciona perfil a partir de la profundidad media (m, positiva). */
export function pickBottomProfile(meanDepthM: number): BottomProfile {
  if (!Number.isFinite(meanDepthM) || meanDepthM <= 0) return "plataforma";
  if (meanDepthM < 200) return "plataforma";
  if (meanDepthM < 800) return "talud";
  return "abisal";
}

/**
 * Ajuste estacional del rango de profundidad objetivo.
 * Mediterráneo norte: en VERANO la termoclina baja → demersales más
 * profundos; en INVIERNO suben hacia la plataforma.
 *   - Jun–Sep: +20 % al rango (más profundo).
 *   - Dic–Feb: -10 % (más somero).
 *   - Resto:   sin cambio.
 * No altera los pesos estructurales, solo el `depthBonus`.
 */
export function seasonalDepthRange(
  minDepth: number,
  maxDepth: number,
  date: Date = new Date(),
): {
  minDepth: number;
  maxDepth: number;
  season: "verano" | "invierno" | "intermedia";
  factor: number;
} {
  const m = date.getUTCMonth(); // 0..11
  let factor = 1;
  let season: "verano" | "invierno" | "intermedia" = "intermedia";
  if (m >= 5 && m <= 8) {
    factor = 1.2;
    season = "verano";
  } else if (m === 11 || m <= 1) {
    factor = 0.9;
    season = "invierno";
  }
  return {
    minDepth: Math.max(0, Math.round(minDepth * factor)),
    maxDepth: Math.max(minDepth + 1, Math.round(maxDepth * factor)),
    season,
    factor,
  };
}

function computeBottomScoreV2(
  slopeMperKm: number,
  roughnessM: number,
  transitionM: number,
  depthM: number | null,
  minDepth: number,
  maxDepth: number,
  roughness5x5M: number = 0,
  curvatureMperKm2: number = 0,
  slopeBreakStrength: number = 0,
  weights: BottomWeights = BOTTOM_PROFILE_WEIGHTS.talud,
  tpi3M: number = 0,
  tpi5M: number = 0,
): { score: number; depthBonus: number; contribs: Record<keyof BottomWeights, number> } {
  const normSlope = clamp01(slopeMperKm / 30);
  const normRough = clamp01(roughnessM / 10);
  const normRoughW = clamp01(roughness5x5M / 15);
  const normEdge = clamp01(transitionM / 15);
  const normCurv = clamp01(Math.abs(curvatureMperKm2) / 4);
  const normBreak = clamp01(slopeBreakStrength);
  // TPI: solo premiamos cabezos (positivo = más somero que entorno).
  // Combinamos 3×3 y 5×5 (peso 0.6/0.4) para no sesgar al cabezo de 1 celda
  // y normalizamos a una escala típica de 12 m de relieve relativo.
  const tpiPos = Math.max(0, 0.6 * tpi3M + 0.4 * tpi5M);
  const normTpi = clamp01(tpiPos / 12);
  const depthBonus = depthM != null && depthM >= minDepth && depthM <= maxDepth ? 1 : 0;
  const contribs = {
    slope: normSlope * weights.slope,
    rough3: normRough * weights.rough3,
    rough5: normRoughW * weights.rough5,
    edge: normEdge * weights.edge,
    curv: normCurv * weights.curv,
    brk: normBreak * weights.brk,
    depth: depthBonus * weights.depth,
    tpi: normTpi * weights.tpi,
  };
  const s =
    contribs.slope +
    contribs.rough3 +
    contribs.rough5 +
    contribs.edge +
    contribs.curv +
    contribs.brk +
    contribs.depth +
    contribs.tpi;
  return { score: Math.round(clamp01(s) * 100), depthBonus, contribs };
}

/** Distancia haversine aproximada en metros entre dos puntos lat/lng. */
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Scoring PROGRESIVO para "Pesca a fondo" — escala 0–100 equilibrada y
 * realista. Sustituye la lógica todo-o-nada por una suma de componentes
 * con techos suaves y penalizaciones moderadas. Objetivo: detectar
 * oportunidades reales y devolver más variedad sin caer en extremos.
 *
 * Componentes (techos):
 *   • Estructura de fondo (rugosidad + curvatura + TPI + tipo relieve)  → 30
 *   • Cambios de profundidad / veril (slope + break + transición/edge)   → 25
 *   • Profundidad adecuada (dentro de rango, cercanía al centro)         → 20
 *   • Influencia SST / CHL / ALT (señales de superficie)                 → 10
 *   • Corrientes activas                                                  → 10
 *   • Calidad de datos (fuente batimetría)                                →  5
 *
 * Penalizaciones suaves (NO bajan automáticamente a "baja"):
 *   • Zona plana (slope<5 m/km y rough<2 m)            : −10
 *   • Demasiado cerca de costa (depth < 15 m)          : −10
 *   • Sin batimetría real / fuente "none"              : −15
 *   • Profundidad extrema fuera del objetivo (>2× max  : −10
 *     o <0.3× min del rango ajustado)
 */
export interface ProgressiveBottomBreakdown {
  score: number; // 0..100
  estructura: number; // 0..30
  veril: number; // 0..25
  profundidad: number; // 0..20
  superficie: number; // 0..10
  corrientes: number; // 0..10
  calidadDatos: number; // 0..5
  penalizaciones: number; // ≤ 0
  detallesPenalizacion: string[];
  /** Vector de factores normalizados 0..1 (para el aprendizaje adaptativo). */
  factors: Record<string, number>;
}

/** Condiciones de fondo + FSLE ya muestreadas para la celda. */
export interface CellEnvInput {
  tempFondo: number | null;
  corrFondo: number | null;
  oxigeno: number | null;
  /** null = el modelo no aporta salinidad en ese punto → NO puntúa. */
  frenteSalino: number | null;
  fsle: number;
  persistencia: number;
}

export function computeBottomScoreProgressive(args: {
  bF: BottomFactors;
  sF: SurfaceFactors;
  depthSource: "emodnet" | "ncei" | "gebco" | "none";
  minDepth: number;
  maxDepth: number;
  env?: CellEnvInput;
  /** "bottom" = pesca de fondo · "squid" = calamar (ignora superficie). */
  target?: "bottom" | "squid";
}): ProgressiveBottomBreakdown {
  const { bF, sF, depthSource, minDepth, maxDepth, env, target = "bottom" } = args;

  // ── 1) Estructura de fondo (hasta 30) ─────────────────────────────────
  // Rugosidad multi-escala + curvatura + TPI; bonus por tipo de relieve.
  const r3 = clamp01(bF.roughnessM / 10);
  const r5 = clamp01(bF.roughness5x5M / 15);
  const curv = clamp01(Math.abs(bF.curvatureMperKm2) / 4);
  const tpiPos = Math.max(0, 0.6 * bF.tpi3M + 0.4 * bF.tpi5M);
  const tpi = clamp01(tpiPos / 12);
  let estructura =
    8 * Math.max(r3, r5) + // hasta 8 — rugosidad dominante
    6 * Math.min(r3, r5) + // hasta 6 — confirmación entre escalas
    8 * curv + // hasta 8 — concavidad/convexidad
    6 * tpi; // hasta 6 — cabezo (TPI positivo)
  if (bF.reliefType === "cañón" || bF.reliefType === "monte") estructura += 2;
  else if (bF.reliefType === "quiebre") estructura += 1.5;
  estructura = Math.min(30, estructura);

  // ── 2) Cambios de profundidad / veril (hasta 25) ──────────────────────
  const slope = clamp01(bF.slopeMperKm / 25); // 25 m/km = veril marcado
  const brk = clamp01(bF.slopeBreakStrength);
  const edge = clamp01(bF.transitionM / 12);
  let veril =
    12 * slope + // pendiente sostenida
    7 * brk + // máximo local
    6 * edge; // corte/transición
  veril = Math.min(25, veril);

  // ── 3) Profundidad adecuada (hasta 20) ────────────────────────────────
  // Pleno (20) en el centro del rango, decae suavemente hacia los bordes
  // y un poco más allá. NO es binario.
  let profundidad = 0;
  if (bF.depthM != null && minDepth < maxDepth) {
    const d = bF.depthM;
    const center = (minDepth + maxDepth) / 2;
    const half = (maxDepth - minDepth) / 2;
    const margen = half * 1.5; // tolerancia: 50% más allá del rango aún suma algo
    const dist = Math.abs(d - center);
    if (dist <= half) {
      // Dentro: 14..20 según cercanía al centro.
      profundidad = 14 + 6 * (1 - dist / half);
    } else if (dist <= margen) {
      // Justo fuera: cae de 14 a 0 progresivo.
      profundidad = 14 * (1 - (dist - half) / (margen - half));
    } else {
      profundidad = 0;
    }
  }
  profundidad = Math.max(0, Math.min(20, profundidad));

  // ── 4) Influencia SST/CHL/ALT (hasta 10 · 0 en calamar) ───────────────
  // Las capas de superficie APOYAN al fondo, no lo dominan. En calamar se
  // ignoran por completo: la potera depende del fondo, no del color del agua.
  const surfaceCap = target === "squid" ? 0 : 4;
  let superficie = 0;
  if (sF.hasSst) superficie += 4 * clamp01(sF.sstGradiente);
  if (sF.hasChl) superficie += 3 * clamp01(sF.chl);
  if (sF.hasAlt) superficie += 3 * clamp01(sF.adt);
  // Coherencia entre capas refuerza un poco más.
  if ((sF.hasSst ? 1 : 0) + (sF.hasChl ? 1 : 0) + (sF.hasAlt ? 1 : 0) >= 2) {
    superficie += 2 * clamp01(sF.coherencia);
  }
  superficie = Math.min(surfaceCap, superficie);

  // ── 5) Corrientes de altimetría (superficie) — techo reducido ─────────
  // Es una señal de superficie: en fondo pesa poco y en calamar nada, ya
  // que el motor usa la corriente REAL del fondo (corrFondo).
  const currentCap = target === "squid" ? 0 : 4;
  let corrientes = 0;
  if (sF.hasAlt) {
    corrientes += 7 * clamp01(sF.corriente);
    // Bonus si la corriente cruza isóbatas sobre veril (compresión topográfica).
    if (sF.currentBathyCross != null && sF.currentBathyCross >= 0.4 && bF.slopeMperKm >= 10) {
      corrientes += 3 * clamp01(sF.currentBathyCross);
    }
  }
  corrientes = Math.min(currentCap, corrientes);

  // ── 6) Calidad de datos (hasta 5) ─────────────────────────────────────
  let calidadDatos = 0;
  if (depthSource === "emodnet") calidadDatos = 5;
  else if (depthSource === "gebco") calidadDatos = 3;
  else calidadDatos = 0;

  // ── 7) Penalizaciones suaves ──────────────────────────────────────────
  let pen = 0;
  const detallesPenalizacion: string[] = [];
  if (bF.slopeMperKm < 5 && bF.roughnessM < 2) {
    pen -= 10;
    detallesPenalizacion.push("zona plana");
  }
  if (bF.depthM != null && bF.depthM < 15) {
    pen -= 10;
    detallesPenalizacion.push("demasiado cerca de costa");
  }
  if (depthSource === "none") {
    pen -= 15;
    detallesPenalizacion.push("batimetría no disponible");
  }
  if (bF.depthM != null) {
    if (bF.depthM > maxDepth * 2 || bF.depthM < minDepth * 0.3) {
      pen -= 10;
      detallesPenalizacion.push("profundidad fuera de objetivo");
    }
  }

  // ── 8) BLOQUE DE FONDO con la TABLA ÚNICA DE PESOS ────────────────────
  // Todo se normaliza a 0..1 y se pondera con `scoring-weights.ts`, que es
  // la única fuente de verdad (y la que el aprendizaje adaptativo ajusta).
  const factors: Record<string, number> = {
    estructura: clamp01(estructura / 30),
    veril: clamp01(veril / 25),
    profundidad: clamp01(profundidad / 20),
  };
  if (env?.tempFondo != null) factors.tempFondo = env.tempFondo;
  if (env?.corrFondo != null) factors.corrFondo = env.corrFondo;
  if (env?.oxigeno != null) factors.oxigeno = env.oxigeno;
  // Sin salinidad real no se inventa un 0: el factor se omite y los pesos
  // se renormalizan sobre las variables realmente disponibles.
  if (env?.frenteSalino != null) factors.frenteSalino = clamp01(env.frenteSalino);

  const bottomWeighted = weightedScore(factors, getWeights("bottom")) * 100;

  // Apoyo de superficie/corrientes de altimetría (bloque secundario) y
  // calidad de datos, que no dependen del vector aprendido.
  // En calamar el soporte es SOLO calidad de datos (superficie = 0).
  const support = superficie + corrientes + calidadDatos; // ≤13 fondo · ≤5 calamar
  // Al recortar el soporte de superficie, el bloque de fondo pesa más para
  // que la escala 0–100 siga siendo comparable entre modos.
  const bottomWeight = target === "squid" ? 0.95 : 0.87;
  const raw = bottomWeighted * bottomWeight + support + pen;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return {
    score,
    estructura: Math.round(estructura),
    veril: Math.round(veril),
    profundidad: Math.round(profundidad),
    superficie: Math.round(superficie),
    corrientes: Math.round(corrientes),
    calidadDatos,
    penalizaciones: pen,
    detallesPenalizacion,
    factors,
  };
}

/** Razones legibles para spots de FONDO (modo "Pesca a fondo"). */
function buildBottomReasonsV2(
  slopeMperKm: number,
  roughnessM: number,
  transitionM: number,
  depthM: number | null,
  inDepthRange: boolean,
  roughness5x5M: number = 0,
  curvatureMperKm2: number = 0,
  slopeBreakStrength: number = 0,
  reliefType: BottomFactors["reliefType"] = "llano",
): { reasons: string[]; main: string } {
  const reasons: string[] = [];
  // Estructura física (lo más relevante para Top 1).
  if (reliefType === "cañón") reasons.push("cabeza/eje de cañón submarino");
  else if (reliefType === "monte") reasons.push("monte/cabezo submarino");
  else if (reliefType === "quiebre") reasons.push("quiebre de pendiente (plataforma→talud)");

  if (slopeBreakStrength >= 0.6) reasons.push("máximo local de pendiente");
  if (slopeMperKm > 18) reasons.push("talud interesante");
  if (slopeMperKm > 15 && transitionM > 5) reasons.push("veril marcado");
  if (roughness5x5M > 8) reasons.push("relieve amplio (cabezos)");
  if (roughnessM > 6) reasons.push("relieve irregular");
  if (Math.abs(curvatureMperKm2) >= 2.5) {
    reasons.push(curvatureMperKm2 > 0 ? "concavidad (cuenco)" : "convexidad (montículo)");
  }
  if (transitionM > 8) reasons.push("transición batimétrica");
  if (inDepthRange && depthM != null) {
    reasons.push(`profundidad favorable (~${Math.round(depthM)} m)`);
  }
  // Dedupe conservando orden
  const seen = new Set<string>();
  const unique = reasons.filter((r) => (seen.has(r) ? false : (seen.add(r), true)));
  // El motivo principal es la primera razón estructural; si no hay, fallback
  const structural = unique.filter((r) => !r.startsWith("profundidad"));
  const main = structural[0] ?? unique[0] ?? "estructura suave de fondo";
  return { reasons: unique, main };
}

/**
 * Score de superficie con renormalización (v4 — túnidos).
 *
 * Pesos base reajustados para dar protagonismo a la COHERENCIA entre
 * capas (SST + CHL + corriente + ADT en el mismo borde oceánico), que es
 * la firma real de las zonas pescables de superficie para túnidos:
 *
 *   SST 25 · CHL 15 · Corriente 15 · ADT 13 · Coherencia 32  (Σ = 100)
 *
 * La coherencia ya no es un extra; es el factor dominante. Las manchas
 * aisladas (un solo factor alto) puntúan poco; las convergencias entre
 * 3-4 capas puntúan mucho.
 */
function computeSurfaceFromFactors(f: SurfaceFactors): number {
  // ─── Score v5 — prioriza estructura oceanográfica REAL ───
  // Cambios respecto a v4:
  //  · Añadido BathyEdge (compresión isóbatas + transición + pendiente)
  //    como factor superficial dominante junto a Coherencia.
  //  · Cross-term multiplicativo: sólo dispara cuando SST × BathyEdge ×
  //    Coherencia COINCIDEN. Una capa fuerte aislada ya no basta.
  //  · La SST cuenta sobre raster pre-suavizado (microgradientes) y se
  //    descuenta si es seam de tile o si cae en mancha homogénea.
  //
  // Pesos del CORE (renormalizados según capas presentes):
  //   SST 22 · CHL 10 · Corriente 14 · ADT 10 · Coherencia 20 · BathyEdge 24
  let totalWeight = 0;
  let weightedSum = 0;
  if (f.hasSst) {
    totalWeight += 0.22;
    weightedSum += f.sstGradiente * 0.22;
  }
  if (f.hasChl) {
    totalWeight += 0.1;
    weightedSum += f.chl * 0.1;
  }
  if (f.hasAlt) {
    totalWeight += 0.14 + 0.1;
    weightedSum += f.corriente * 0.14 + f.adt * 0.1;
  }
  const layersActive = (f.hasSst ? 1 : 0) + (f.hasChl ? 1 : 0) + (f.hasAlt ? 1 : 0);
  if (layersActive >= 2) {
    totalWeight += 0.2;
    weightedSum += f.coherencia * 0.2;
  }
  // BathyEdge entra siempre que tengamos batimetría (bathyEdge > 0).
  if (f.bathyEdge > 0) {
    totalWeight += 0.24;
    weightedSum += f.bathyEdge * 0.24;
  }
  if (totalWeight === 0) return 0;
  const core = weightedSum / totalWeight;

  // Cross-term: requiere coincidencia simultánea de térmico, batimétrico y coherencia.
  // Subimos el suelo de 0.10 → 0.18 para que zonas con señal moderada en las 3
  // dimensiones no se aplasten en valores < 0.3 (que producían "Floja" 20/100
  // incluso con confianza alta y frente térmico real).
  const sstC = Math.max(0.18, f.sstGradiente);
  const bathyC = Math.max(0.18, f.bathyEdge);
  const cohC = Math.max(0.18, layersActive >= 2 ? f.coherencia : 0.3);
  const cross = Math.cbrt(sstC * bathyC * cohC);

  // Penalización por mancha homogénea: solo si SST es claramente plana
  // (gradiente < 0.18) Y la estructura local es muy baja. Antes se disparaba
  // con valores hasta 0.25, que castigaba frentes mediterráneos legítimos.
  const uniformPenalty = f.hasSst && f.localStructure < 0.18 && f.sstGradiente < 0.18 ? 0.1 : 0;

  const s = clamp01(0.62 * core + 0.38 * cross - uniformPenalty);
  return Math.round(s * 100);
}

/**
 * Score EXCLUSIVO para "Pesca a superficie" (Top 1 superficie).
 *
 * Reglas pedidas por el patrón:
 *   - Solo SST, CHL y Altimetría (ADT/SLA + corrientes).
 *   - NO usar el valor plano de cada capa, sino su GRADIENTE local
 *     (cambio marcado alrededor del punto = frente, borde de mancha,
 *     borde de corriente / eddy).
 *   - Pesos: Altimetría 40 % · SST 35 % · CHL 25 %.
 *   - Si una capa no tiene dato, se renormaliza con las disponibles
 *     y baja la confianza.
 *   - Batimetría NO interviene en el score (solo se usa fuera como
 *     filtro básico para evitar tierra / aguas imposibles).
 *
 * `f.sstGradiente` → ∇ SST (frente térmico)
 * `f.chl`          → ∇ CHL (borde de mancha productiva; ya es el
 *                    gradiente, no el valor crudo)
 * `f.corriente`    → ∇ ADT proxy de corriente / borde de eddy
 *                    (Copernicus altimetría)
 */
function computeSurfaceGradientScore(
  f: SurfaceFactors,
  fsleProximity = 0,
  persistence: number | null = null,
): {
  score: number;
  dominant: "alt" | "sst" | "chl" | null;
  layersPresent: number;
  confidence: ConfidenceLevel;
} {
  // Pesos: ALT (corriente+ADT) 40 · SST 35 · CHL 25.
  // Internamente dividimos ALT en corriente (25) y ADT (15) para que cada
  // sub-score sea visible y trazable en el popup.
  const W_CURR = 0.25;
  const W_ADT = 0.15;
  const W_SST = 0.35;
  const W_CHL = 0.25;

  let totalW = 0;
  let weighted = 0;
  const contrib: Partial<Record<"alt" | "sst" | "chl", number>> = {};

  // EXPANSIÓN GAMMA — convierte gradientes mediterráneos (0.1-0.3 típicos)
  // en valores que usan toda la escala 0..1. Sin esto, todos los candidatos
  // colapsaban en 15-25/100 porque el norm ponderado se mantenía < 0.25.
  const currE = f.hasAlt ? expandGradient(f.corriente) : 0;
  const adtE = f.hasAlt ? expandGradient(f.adt) : 0;
  const sstE = f.hasSst ? expandGradient(f.sstGradiente) : 0;
  const chlE = f.hasChl ? expandGradient(f.chl) : 0;

  if (f.hasAlt) {
    totalW += W_CURR + W_ADT;
    weighted += currE * W_CURR + adtE * W_ADT;
    contrib.alt = currE * W_CURR + adtE * W_ADT;
  }
  if (f.hasSst) {
    totalW += W_SST;
    weighted += sstE * W_SST;
    contrib.sst = sstE * W_SST;
  }
  if (f.hasChl) {
    totalW += W_CHL;
    weighted += chlE * W_CHL;
    contrib.chl = chlE * W_CHL;
  }

  const layersPresent = (f.hasAlt ? 1 : 0) + (f.hasSst ? 1 : 0) + (f.hasChl ? 1 : 0);

  if (totalW === 0 || layersPresent === 0) {
    return { score: 0, dominant: null, layersPresent: 0, confidence: "baja" };
  }

  const norm = weighted / totalW;

  // Bonus por COINCIDENCIA: cuántos componentes EXPANDIDOS ≥ 0.5
  // (equivale a un gradiente sin expandir de ~0.25 — frente claro).
  const strong =
    (f.hasAlt && Math.max(currE, adtE) >= 0.5 ? 1 : 0) +
    (f.hasSst && sstE >= 0.5 ? 1 : 0) +
    (f.hasChl && chlE >= 0.5 ? 1 : 0);
  const coincidenceBonus = strong >= 3 ? 0.22 : strong === 2 ? 0.12 : strong === 1 ? 0.04 : 0;

  const raw = clamp01(norm + coincidenceBonus);

  // Penalización por zona PLANA: todos los gradientes presentes muy bajos
  // tras expansión (≡ gradiente bruto < 0.10).
  const allFlat =
    (!f.hasAlt || Math.max(currE, adtE) < 0.3) &&
    (!f.hasSst || sstE < 0.3) &&
    (!f.hasChl || chlE < 0.3);
  const flatPenalty = allFlat ? 0.25 : 0;

  const gradientRaw = clamp01(raw - flatPenalty);
  const fallbackRaw =
    clamp01(f.fallbackSignal ?? 0) *
    (layersPresent === 3 ? 0.36 : layersPresent === 2 ? 0.3 : 0.24);
  let finalRaw = Math.max(gradientRaw, fallbackRaw);

  // ── FSLE (LCS) ──
  // Los frentes lagrangianos ya se calculaban pero no puntuaban. Ahora
  // entran con el peso de la tabla única (15 % en superficie).
  const wFsle = SURFACE_BLOCK_WEIGHTS.fsle;
  const fsleN = clamp01(fsleProximity);
  if (fsleN > 0) {
    finalRaw = clamp01(finalRaw * (1 - wFsle) + fsleN * wFsle + 0.05 * fsleN);
  }

  // ── PERSISTENCIA 2–3 DÍAS ──
  // Premia el frente que se mantiene y penaliza el que aparece un solo día.
  if (persistence != null) {
    const p = clamp01(persistence);
    finalRaw = clamp01(finalRaw * (0.85 + 0.25 * p));
  }

  // Gradiente dominante = el que más aporta al score.
  let dominant: "alt" | "sst" | "chl" | null = f.fallbackDominant ?? null;
  let best = dominant ? 0 : -1;
  (Object.entries(contrib) as Array<["alt" | "sst" | "chl", number]>).forEach(([k, v]) => {
    if (v > best) {
      best = v;
      dominant = k;
    }
  });

  // Confianza por nº de capas presentes (no por la fuerza de la señal).
  const confidence: ConfidenceLevel =
    layersPresent === 3 ? "alta" : layersPresent === 2 ? "media" : "baja";

  return {
    score: Math.round(finalRaw * 100),
    dominant,
    layersPresent,
    confidence,
  };
}

function refreshSurfaceFallbackFromRawValues(f: SurfaceFactors) {
  const raw = f.rawValues ?? {};
  const candidates: Array<["alt" | "sst" | "chl", number]> = [];
  if (raw.adt?.value != null || raw.currentSpeed?.value != null) {
    const altSignal = Math.max(
      raw.adt?.value != null ? clamp01(Math.abs(raw.adt.value) / 0.45) : 0,
      raw.currentSpeed?.value != null ? clamp01(raw.currentSpeed.value / 0.75) : 0,
      0.16,
    );
    candidates.push(["alt", altSignal]);
  }
  if (raw.sst?.value != null) {
    const c = raw.sst.value > 200 ? raw.sst.value - 273.15 : raw.sst.value;
    candidates.push(["sst", Math.max(0.16, clamp01((c - 8) / 22))]);
  }
  if (raw.chl?.value != null) {
    candidates.push(["chl", Math.max(0.16, clamp01(Math.sqrt(Math.max(0, raw.chl.value) / 0.6)))]);
  }
  candidates.sort((a, b) => b[1] - a[1]);
  if (candidates[0] && candidates[0][1] > (f.fallbackSignal ?? 0)) {
    f.fallbackSignal = candidates[0][1];
    f.fallbackDominant = candidates[0][0];
  }
}

function combineScores(
  scoreFondo: number,
  scoreSup: number,
  mode: "surface" | "bottom",
  penalizacion: number,
  hasBathy: boolean,
  surfaceLayersCount: number, // 0..3 (sst/chl/alt)
  surfaceFactors?: SurfaceFactors,
): ScoreBreakdown {
  // Perfiles de ponderación: AMBOS modos usan TODAS las capas disponibles.
  // La diferencia es la prioridad, no qué se enciende/apaga.
  // Superficie → 65% superficie + 35% fondo (la batimetría apoya, no domina)
  // Fondo     → 65% fondo + 35% superficie (la oceanografía refuerza la estructura)
  let wF = MIX_WEIGHTS[mode].fondo;
  let wS = MIX_WEIGHTS[mode].superficie;

  // FALLBACK POR CAPAS: si una familia no tiene datos, su peso pasa a la otra.
  // Así el motor NUNCA se bloquea por una capa ausente.
  if (!hasBathy && surfaceLayersCount > 0) {
    wS = 1;
    wF = 0;
  } else if (hasBathy && surfaceLayersCount === 0) {
    wF = 1;
    wS = 0;
  }

  const base = scoreFondo * wF + scoreSup * wS;

  // Bonus sinergia: AMBOS ≥ 60. Solo aplicable si AMBAS familias tienen datos.
  let bonus = 0;
  if (hasBathy && surfaceLayersCount > 0) {
    if (scoreFondo >= 60 && scoreSup >= 60) {
      const exceso = scoreFondo - 60 + (scoreSup - 60); // 0..80
      bonus = Math.min(15, 5 + exceso * 0.125); // 5..15
    } else if (scoreFondo >= 70 && scoreSup >= 50) {
      bonus = 3;
    } else if (scoreSup >= 70 && scoreFondo >= 50) {
      bonus = 3;
    }
  }

  const finalScore = Math.max(0, Math.min(100, base + bonus - penalizacion));

  let rank: ScoreBreakdown["rank"];
  if (finalScore >= 85) rank = "top";
  else if (finalScore >= 70) rank = "muy_bueno";
  else if (finalScore >= 55) rank = "interesante";
  else if (finalScore >= 40) rank = "flojo";
  else rank = "sin_interes";

  // CONFIANZA DE DATOS — separada de la calidad de pesca.
  //
  // Solo mide DISPONIBILIDAD/FRESCURA de datos reales, NO la fuerza
  // de las señales. Una zona con 4 capas reales pero score bajo tiene
  // confianza "muy alta" (datos sólidos) y calidad "floja" (mala pesca).
  //
  //   muy_alta → 4 capas reales (SST + CHL + ALT + BAT)
  //   alta     → 3 capas reales
  //   media    → 2 capas reales
  //   baja     → 0–1 capa, error de carga, tierra o desactualizado
  const hasSst = !!surfaceFactors?.hasSst;
  const hasChl = !!surfaceFactors?.hasChl;
  const hasAlt = !!surfaceFactors?.hasAlt;
  const confidence: ConfidenceLevel = computeDataConfidence({
    hasSst,
    hasChl,
    hasAlt,
    hasBathy,
  });

  const layersUsed: string[] = [];
  const layersMissing: string[] = [];
  if (hasBathy) layersUsed.push("bathy");
  else layersMissing.push("bathy");
  if (hasSst) layersUsed.push("sst");
  else layersMissing.push("sst");
  if (hasChl) layersUsed.push("chl");
  else layersMissing.push("chl");
  if (hasAlt) layersUsed.push("alt");
  else layersMissing.push("alt");

  return {
    scoreFondo,
    scoreSuperficie: scoreSup,
    scoreTotal: Math.round(finalScore),
    bonusSinergia: Math.round(bonus * 10) / 10,
    penalizacion: Math.round(penalizacion * 10) / 10,
    reasons: [],
    rank,
    confidence,
    layersUsed,
    layersMissing,
  };
}

function buildReasons(
  bF: BottomFactors,
  sF: SurfaceFactors,
  scoreFondo: number,
  scoreSup: number,
  bonus: number,
  mode: "surface" | "bottom" = "surface",
): string[] {
  // Razones detectadas por familia (solo si la capa correspondiente tiene datos)
  const fondoRazones: string[] = [];
  if (bF.hasBathy) {
    if (bF.pendiente >= 0.65) fondoRazones.push("veril marcado");
    else if (bF.pendiente >= 0.4) fondoRazones.push("borde de profundidad");
    if (bF.rugosidad >= 0.6) fondoRazones.push("relieve irregular");
    else if (bF.rugosidad >= 0.35) fondoRazones.push("estructura de fondo");
    if (bF.transicion >= 0.55) fondoRazones.push("corte batimétrico");
    else if (bF.transicion >= 0.35) fondoRazones.push("transición batimétrica");
    if (bF.profundidad >= 0.7) fondoRazones.push("profundidad ideal");
    else if (bF.profundidad >= 0.5) fondoRazones.push("profundidad favorable");
  }

  const superficieRazones: string[] = [];
  if (sF.hasSst) {
    if (sF.sstGradiente >= 0.55) superficieRazones.push("frente térmico");
    else if (sF.sstGradiente >= 0.3) superficieRazones.push("gradiente térmico");
  }
  if (sF.hasChl) {
    if (sF.chl >= 0.5) superficieRazones.push("borde de clorofila");
    else if (sF.chl >= 0.3) superficieRazones.push("apoyo de clorofila");
  }
  if (sF.hasAlt) {
    if (sF.corriente >= 0.45) superficieRazones.push("corriente favorable");
    else if (sF.corriente >= 0.25) superficieRazones.push("dinámica superficial");
    if (sF.adt >= 0.45) superficieRazones.push("estructura de mesoescala");
    else if (sF.adt >= 0.25) superficieRazones.push("apoyo de altimetría");
  }
  if (sF.coherencia >= 0.6) superficieRazones.push("convergencia superficial");

  // Orden según el modo: principales primero, secundarios como "apoyo"
  const r: string[] = [];
  if (mode === "bottom") {
    r.push(...fondoRazones);
    if (superficieRazones.length > 0) {
      const apoyo = superficieRazones.slice(0, 2).join(" + ");
      r.push(`apoyo de superficie: ${apoyo}`);
    }
  } else {
    // MODO SUPERFICIE: solo razones de superficie. NO mezclamos
    // vocabulario de fondo (apoyo batimétrico, relieve irregular,
    // corte batimétrico…) aunque haya batimetría disponible — eso
    // confunde al usuario en modo "Pesca a superficie".
    r.push(...superficieRazones);
  }

  // SINERGIA
  if (bonus >= 8) r.push("sinergia fuerte fondo + superficie");
  else if (bonus >= 3) r.push("apoyo entre fondo y superficie");

  // Avisos por capas faltantes — informativos, no bloqueantes
  if (mode === "bottom" && !bF.hasBathy) {
    r.push("análisis de fondo parcial: batimetría no disponible");
  } else if (mode === "surface" && !sF.hasSst && !sF.hasChl && !sF.hasAlt) {
    r.push("análisis de superficie parcial: sin capas oceanográficas");
  }

  // FALLBACKS narrativos cuando no se ha disparado nada
  if (r.length === 0) {
    if (mode === "bottom") {
      if (!bF.hasBathy) r.push("sin datos batimétricos en este punto");
      else if (scoreFondo < 30) r.push("fondo demasiado homogéneo");
      else r.push("estructura débil sin señales claras");
    } else {
      const noSurf = !sF.hasSst && !sF.hasChl && !sF.hasAlt;
      if (noSurf) r.push("sin capas de superficie cargadas");
      else if (scoreSup < 30) r.push("sin gradientes superficiales claros");
      else r.push("zona oceanográfica plana");
    }
  }

  return r;
}

/**
 * Construye la explicación "POR QUÉ este punto es TOP 1" usando los MISMOS
 * datos reales que generaron el score:
 *   - Valores crudos de SST (°C), CHL (mg/m³), ADT (m), corrientes (m/s)
 *     leídos por GetFeatureInfo en la coordenada exacta.
 *   - Gradientes / coherencias normalizados (0..1) calculados sobre el
 *     ráster pintado en el visor.
 *   - Profundidad confirmada EMODnet/GEBCO + ventana objetivo del modo.
 *
 * Reglas:
 *   - Una señal SOLO se muestra si supera su umbral técnico (no se
 *     inventan razones genéricas).
 *   - El texto cambia entre puntos porque incluye los valores reales.
 *   - Si una capa no tiene dato, ni se menciona — no se rellena.
 *   - Si NINGUNA señal supera umbral, se devuelve un único mensaje
 *     honesto en lugar de bullets vacías.
 */
function buildWhyExplanation(args: {
  bF: BottomFactors;
  sF: SurfaceFactors;
  bottom: { depthM: number | null; slopeMperKm: number; roughnessM: number };
  depthSource: "emodnet" | "ncei" | "gebco" | "none";
  confidence: ConfidenceLevel;
  bonusSinergia: number;
  scoreTotal: number;
  mode: "surface" | "bottom";
  minDepth: number;
  maxDepth: number;
  surfaceGradientMode?: boolean;
  surfaceGradientDominant?: "alt" | "sst" | "chl" | null;
}): string[] {
  const {
    bF,
    sF,
    bottom,
    depthSource,
    confidence,
    bonusSinergia,
    scoreTotal,
    mode,
    minDepth,
    maxDepth,
    surfaceGradientMode,
    surfaceGradientDominant,
  } = args;
  const raw = sF.rawValues ?? {};
  const lines: string[] = [];

  // Helper para formatear con decimales sin "NaN"
  const fmt = (v: number | undefined, dec = 2) =>
    typeof v === "number" && Number.isFinite(v) ? v.toFixed(dec) : null;

  // 0) Mensaje principal del modo SUPERFICIE (gradientes).
  if (mode === "surface" && surfaceGradientMode) {
    lines.push("Top 1 elegido por coincidencia de gradientes de SST, CHL y altimetría");
    if (surfaceGradientDominant) {
      const lbl: Record<"alt" | "sst" | "chl", string> = {
        alt: "altimetría (borde de corriente/eddy)",
        sst: "temperatura (frente térmico)",
        chl: "clorofila (borde de mancha)",
      };
      lines.push(`Gradiente que más pesa: ${lbl[surfaceGradientDominant]}`);
    }
  }

  // 1) SST — valor real + intensidad de frente
  if (sF.hasSst) {
    const sstStr = fmt(raw.sst?.value, 2);
    if (sF.sstGradiente >= 0.65) {
      lines.push(
        `Frente térmico fuerte (SST ${sstStr ?? "OK"} °C, ∇ ${(sF.sstGradiente * 100).toFixed(0)}%)`,
      );
    } else if (sF.sstGradiente >= 0.45) {
      lines.push(
        `Gradiente térmico claro (SST ${sstStr ?? "OK"} °C, ∇ ${(sF.sstGradiente * 100).toFixed(0)}%)`,
      );
    } else if (sF.sstGradiente >= 0.28) {
      lines.push(`Cambio térmico moderado (SST ${sstStr ?? "OK"} °C)`);
    }
  }

  // 2) CHL — valor real + borde
  if (sF.hasChl) {
    const chlStr = fmt(raw.chl?.value, 2);
    if (sF.chl >= 0.55) {
      lines.push(`Borde de clorofila bien definido (CHL ${chlStr ?? "OK"} mg/m³)`);
    } else if (sF.chl >= 0.32) {
      lines.push(`Cambio de color/clorofila (CHL ${chlStr ?? "OK"} mg/m³)`);
    }
  }

  // 3) Corriente de SUPERFICIE — módulo (siempre positivo) + rumbo + cardinal
  if (sF.hasAlt) {
    const spd = raw.currentSpeed?.value;
    const dir = raw.currentDirDeg;
    const spdStr =
      typeof spd === "number" && Number.isFinite(spd) ? formatCurrent(spd, dir) : null;
    const qual = typeof spd === "number" ? currentStrengthLabel(spd) : null;
    if (sF.corriente >= 0.55) {
      lines.push(`Corriente de superficie convergente${spdStr ? ` (${spdStr})` : ""}`);
    } else if (sF.corriente >= 0.32) {
      lines.push(`Borde de corriente de superficie${spdStr ? ` (${spdStr})` : ""}`);
    } else if (spdStr) {
      lines.push(`Corriente de superficie ${qual} (${spdStr})`);
    }
  }

  // 4) ADT — topografía dinámica absoluta (NO es la anomalía SLA)
  if (sF.hasAlt) {
    const adt = raw.adt?.value;
    const adtStr = fmt(adt, 3);
    if (sF.adt >= 0.5) {
      lines.push(
        `Estructura de mesoescala (giro/eddy${adtStr ? `, ADT ${adtStr} m` : ""}) — topografía dinámica absoluta`,
      );
    } else if (sF.adt >= 0.3) {
      lines.push(
        `Gradiente de topografía dinámica (ADT${adtStr ? ` ${adtStr} m` : ""}) — no es anomalía (SLA)`,
      );
    }
  }


  // 5) Coherencia entre capas (solo si ≥2 activas)
  const layersActive = (sF.hasSst ? 1 : 0) + (sF.hasChl ? 1 : 0) + (sF.hasAlt ? 1 : 0);
  if (layersActive >= 2) {
    if (sF.coherencia >= 0.65) lines.push("Coherencia SST + CHL + ALT alta (mismo frente)");
    else if (sF.coherencia >= 0.45) lines.push("Buena coincidencia entre capas");
  }

  // 5b) Termoclina — SOLO se menciona si se ha calculado de verdad a partir
  //     del perfil vertical de temperatura (profundidad + gradiente reales).
  //     Sin gradiente medido no se afirma que exista termoclina ni su fuerza.
  if (
    sF.thermoclineDepth != null &&
    Number.isFinite(sF.thermoclineDepth) &&
    sF.thermoclineGradient != null &&
    Number.isFinite(sF.thermoclineGradient) &&
    sF.thermoclineStrength &&
    sF.thermoclineStrength !== "débil"
  ) {
    const td = Math.round(sF.thermoclineDepth);
    const strengthLabel = `${sF.thermoclineStrength}, ${sF.thermoclineGradient.toFixed(2)} °C/m medidos`;

    if (td >= 15 && td <= 30) {
      lines.push(
        `Termoclina somera ideal (~${td} m, ${strengthLabel}) — concentra bait en superficie`,
      );
    } else if (td >= 10 && td <= 45) {
      lines.push(`Termoclina favorable (~${td} m, ${strengthLabel})`);
    } else if (td > 60) {
      lines.push(`Termoclina profunda (~${td} m) — pelágicos dispersos verticalmente`);
    }
  }

  // 5c) Vorticidad / divergencia / persistencia
  if (sF.currentVorticity != null) {
    const av = Math.abs(sF.currentVorticity);
    if (av >= 3e-5) lines.push("Vorticidad fuerte — eddy/meandro activo");
    else if (av >= 1.5e-5) lines.push("Rotación moderada de la corriente");
  }
  if (sF.currentDivergence != null) {
    if (sF.currentDivergence <= -2e-5)
      lines.push("Convergencia superficial — frontogénesis (acumula bait)");
    else if (sF.currentDivergence <= -1e-5) lines.push("Convergencia leve");
    else if (sF.currentDivergence >= 3e-5)
      lines.push("Divergencia (upwelling) — bait disperso en superficie");
  }
  if (
    sF.currentBathyCross != null &&
    sF.currentBathyCross >= 0.5 &&
    bF.hasBathy &&
    bF.slopeMperKm >= 12 &&
    sF.currentU != null &&
    sF.currentV != null &&
    Math.hypot(sF.currentU, sF.currentV) >= 0.15
  ) {
    lines.push("Corriente cruzando isóbatas sobre veril — compresión topográfica");
  }
  if (sF.sstPersistence != null && sF.hasSst && sF.sstGradiente >= 0.35) {
    if (sF.sstPersistence >= 0.75) lines.push("Frente térmico PERSISTENTE (estable 3 días)");
    else if (sF.sstPersistence < 0.35)
      lines.push("⚠ Frente térmico inestable día a día (posible ruido)");
  }

  // 6) Estructura de fondo
  if (bF.hasBathy) {
    if (bF.pendiente >= 0.6) lines.push(`Veril/talud marcado (${bF.slopeMperKm.toFixed(1)} m/km)`);
    else if (bF.pendiente >= 0.4 && mode === "bottom")
      lines.push(`Borde de profundidad (${bF.slopeMperKm.toFixed(1)} m/km)`);
    if (bF.rugosidad >= 0.55) lines.push(`Relieve irregular (rug. ${bF.roughnessM.toFixed(1)} m)`);
    if (bF.transicion >= 0.55) lines.push("Corte batimétrico cercano");
  }

  // 6b) Temperatura y corriente REALES del fondo (modo Fondo/Calamar).
  //     Datos del modelo físico MEDSEA a la profundidad más cercana al
  //     fondo del punto — no extrapolados desde superficie.
  if (mode === "bottom" && bF.bottomTempC != null && Number.isFinite(bF.bottomTempC)) {
    const t = bF.bottomTempC;
    const z = bF.depthM != null ? ` a ${Math.round(bF.depthM)} m` : "";
    lines.push(`🌡 Temperatura del fondo: ${t.toFixed(1)} °C${z} — favorable para la especie`);
  }
  if (mode === "bottom" && bF.bottomCurrent && Number.isFinite(bF.bottomCurrent.speed)) {
    const c = bF.bottomCurrent;
    const zLbl = currentDepthLabel(c.depth);
    const val = `${formatCurrent(c.speed, c.dirDeg)}, ${zLbl}`;
    // Nunca se presenta una corriente de fondo casi nula como "favorable".
    if (c.speed < 0.03) {
      lines.push(`🌊 Corriente de fondo prácticamente nula (${val}) — no aporta al score`);
    } else if (c.speed < 0.08) {
      lines.push(`🌊 Corriente de fondo muy débil (${val}) — presentación pobre del cebo`);
    } else if (c.speed <= 0.25) {
      lines.push(`🌊 Corriente de fondo suave (${val}) — aumenta el score`);
    } else if (c.speed <= 0.45) {
      lines.push(`🌊 Corriente de fondo moderada (${val})`);
    } else {
      lines.push(`🌊 Corriente de fondo fuerte (${val}) — penaliza el score`);
    }
  }


  // 7) Sinergia cruzada
  if (bonusSinergia >= 8) lines.push("Sinergia fuerte fondo + superficie");
  else if (bonusSinergia >= 3) lines.push("Apoyo cruzado fondo + superficie");

  // 8) Profundidad confirmada + ventana del modo
  if (bottom.depthM != null) {
    const src =
      depthSource === "emodnet" ? "EMODnet" : depthSource === "gebco" ? "GEBCO" : "EMODnet/GEBCO";
    const d = Math.round(bottom.depthM);
    const inWin = d >= minDepth && d <= maxDepth;
    lines.push(
      `Fondo validado por ${src}: ${d} m ${inWin ? `(dentro de ${minDepth}–${maxDepth} m ✓)` : `(fuera de ${minDepth}–${maxDepth} m)`}`,
    );
  }

  // 9) Mar abierto (la celda pasó la máscara de tierra ya en el pipeline)
  lines.push("Punto en mar abierto (máscara Natural Earth)");

  // 10) Calidad de pesca + Confianza de datos (separadas)
  const confLabel: Record<ConfidenceLevel, string> = {
    muy_alta: "Muy alta",
    alta: "Alta",
    media: "Media",
    baja: "Baja",
    parcial: "Parcial",
  };
  const qualityLabel =
    mode === "bottom" ? qualityFromScoreBottom(scoreTotal) : qualityFromScoreSurface(scoreTotal);
  lines.push(
    `Calidad: ${qualityLabel} (${Math.round(scoreTotal)}/100) · Confianza de datos: ${confLabel[confidence]}`,
  );

  // Si todas las viñetas técnicas están vacías (solo quedan profundidad +
  // mar + score), avisamos honestamente.
  const technicalLines = lines.filter((l) =>
    /Frente|Gradiente|Cambio térmico|Borde de clorofila|Cambio de color|Corriente|Estructura|Anomalía|Coherencia|Coincidencia|Veril|Borde de profundidad|Relieve|Corte|Sinergia|Apoyo cruzado/.test(
      l,
    ),
  );
  if (technicalLines.length === 0) {
    lines.unshift("Sin señales fuertes hoy; selección por mejor combinación disponible");
  }

  return lines;
}

// ─────────────────── Caché diaria de TOP spots ───────────────────
//
// Los datos del mapa (SST, CHL, ADT, batimetría) se publican 1 vez al día.
// Por tanto, MISMA zona + MISMO modo + MISMA fecha de datos + MISMOS filtros
// ⇒ resultado idéntico. Cacheamos en localStorage para evitar recálculos
// (que cuestan créditos de cómputo y latencia perceptible).
//
// Solo cacheamos cuando hay searchArea explícita (zona/triángulo dibujado).
// El viewport puro cambia con cada pan/zoom y no es una "zona" estable.

const SPOTS_CACHE_LSKEY = "totymar.spots.dailyCache.v2";
const SPOTS_CACHE_MAX_ENTRIES = 30;
const SPOTS_CACHE_TTL_DAYS = 7;

interface CachedSpotsEntry {
  key: string;
  dateSig: string;
  savedAt: number;
  spots: FishingSpot[];
  summary: Parameters<NonNullable<FishingHotspotsProps["onAnalysisSummary"]>>[0];
}

function loadSpotsCache(): CachedSpotsEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SPOTS_CACHE_LSKEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as CachedSpotsEntry[];
    if (!Array.isArray(arr)) return [];
    const cutoff = Date.now() - SPOTS_CACHE_TTL_DAYS * 86_400_000;
    return arr.filter((e) => e && e.savedAt > cutoff);
  } catch {
    return [];
  }
}

function saveSpotsCache(list: CachedSpotsEntry[]) {
  if (typeof window === "undefined") return;
  try {
    const trimmed = list.slice(-SPOTS_CACHE_MAX_ENTRIES);
    window.localStorage.setItem(SPOTS_CACHE_LSKEY, JSON.stringify(trimmed));
  } catch {
    /* quota / privacy mode → ignorar */
  }
}

function areaSignature(area: SearchArea | null | undefined): string {
  if (!area) return "viewport";
  if (area.kind === "rect") {
    const [a, b] = area.bounds;
    return `rect:${a.lat.toFixed(3)},${a.lng.toFixed(3)},${b.lat.toFixed(3)},${b.lng.toFixed(3)}`;
  }
  if (area.kind === "polygon") {
    return "poly:" + area.points.map((p) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`).join("|");
  }
  return "unknown";
}

function buildSpotsCacheKey(args: {
  area: SearchArea | null | undefined;
  fishingMode: "surface" | "bottom" | "squid" | "drift";
  minDepth: number;
  maxDepth: number;
  minScore: number;
  maxSpots: number;
  hotZoneOnly: boolean;
  hotZoneMode: "precise" | "explore";
  layerTimes?: Partial<Record<LayerType, string>>;
}): { key: string; dateSig: string } {
  const lt = args.layerTimes ?? {};
  // Normalizamos a DÍA: los productos se publican una vez al día, así que una
  // hora distinta en el mismo día NO debe invalidar el resultado (antes sí lo
  // hacía y forzaba un recálculo con datos de red distintos).
  const dateSig =
    (Object.keys(lt) as LayerType[])
      .sort()
      .map((k) => `${k}=${String(lt[k] ?? "").slice(0, 10)}`)
      .filter((p) => !p.endsWith("="))
      .join(";") || `today=${new Date().toISOString().slice(0, 10)}`;
  // La fluixa depende del viento/ola de la hora → la clave incluye la hora
  // UTC. El resto de modos son puramente diarios.
  const hourSig =
    args.fishingMode === "drift" ? `|h=${new Date().toISOString().slice(0, 13)}` : "";
  const key = [
    areaSignature(args.area),
    `mode=${args.fishingMode}`,
    `dz=${args.minDepth}-${args.maxDepth}`,
    `ms=${args.minScore}`,
    `n=${args.maxSpots}`,
    `hz=${args.hotZoneOnly ? args.hotZoneMode : "off"}`,
    `dates=${dateSig}`,
  ].join("|") + hourSig;
  return { key, dateSig };
}

/**
 * Espera a que TODAS las capas de teselas terminen de cargar antes de
 * muestrear píxeles. Sin esto, el mismo análisis repetido leía unas teselas
 * pintadas y otras no, y el Top 1 cambiaba entre ejecuciones.
 */
async function waitForTilesIdle(map: L.Map, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  const stillLoading = () => {
    let loading = false;
    map.eachLayer((l) => {
      const gl = l as unknown as { isLoading?: () => boolean };
      if (typeof gl.isLoading === "function" && gl.isLoading()) loading = true;
    });
    return loading;
  };
  while (stillLoading() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 150));
  }
  // Un frame extra para que el navegador acabe de pintar las últimas teselas.
  await new Promise((r) => setTimeout(r, 120));
}

const tieBreak = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  a.lat !== b.lat ? b.lat - a.lat : b.lng - a.lng;

// ─────────────────── Renderer ───────────────────

function HotspotsRenderer({
  enabled,
  minDepth = 15,
  maxDepth = 600,
  minScore = 0.35,
  maxSpots = 6,
  onSpotsChange,
  recomputeTrigger,
  clearTrigger,
  searchArea,
  debug = false,
  hotZoneOnly = false,
  hotZoneMode = "precise",
  fishingMode: fishingModeRaw = "surface",
  layerTimes,
  onLoadingChange,
  onProgress,
  onAnalysisError,
  onAnalysisSummary,
  onSaveWaypoint,
}: FishingHotspotsProps) {
  // El modo "squid" (calamar) reutiliza la lógica de fondo pero con un rango
  // de profundidades distinto (30-150 m) que ya se aplica vía minDepth/maxDepth
  // desde el contenedor. Mantener "bottom" internamente evita ramificar todo
  // el algoritmo de scoring.
  const fishingMode: "surface" | "bottom" =
    fishingModeRaw === "squid" || fishingModeRaw === "drift" ? "bottom" : fishingModeRaw;
  const isSquid = fishingModeRaw === "squid";
  // Pesca a la deriva (fluixa): motor 100 % independiente (`drift-engine`).
  // Comparte solo el muestreo de batimetría/oceanografía, nunca la fórmula.
  const isDrift = fishingModeRaw === "drift";
  const map = useMap();
  const markersRef = useRef<L.Marker[]>([]);
  const corridorLayersRef = useRef<L.Layer[]>([]);
  const debugLayersRef = useRef<L.Layer[]>([]);
  const debounceRef = useRef<number | null>(null);
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // Ref vivo del callback: evita re-disparar el efecto pesado de análisis
  // cuando el padre re-crea la función, pero permite que los popups (creados
  // dentro de ese efecto) llamen siempre a la última versión.
  const onSaveWaypointRef = useRef(onSaveWaypoint);
  useEffect(() => {
    onSaveWaypointRef.current = onSaveWaypoint;
  }, [onSaveWaypoint]);

  // Carga una sola vez los pesos APRENDIDOS del usuario (si los tiene) para
  // que el Fishing Score de esta sesión ya use su histórico de capturas.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Sin sesión la función protegida devuelve un 401 crudo que rompe la
        // app: comprobamos antes de llamarla.
        const { supabase } = await import("@/integrations/supabase/client");
        const { data: sess } = await supabase.auth.getSession();
        if (cancelled || !sess.session) return;
        const state = await getLearningState();
        if (cancelled) return;
        for (const l of state.learned) setLearnedWeights(l.mode, l.weights, l.nSamples);
      } catch {
        /* sin sesión o sin datos: se usan los pesos base */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const pane = map.getPane(PANE_NAME) ?? map.createPane(PANE_NAME);
    pane.style.zIndex = "1200";
    pane.style.pointerEvents = "auto";
    pane.style.background = "transparent";
  }, [map]);

  const clearAll = () => {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    corridorLayersRef.current.forEach((l) => l.remove());
    corridorLayersRef.current = [];
    debugLayersRef.current.forEach((l) => l.remove());
    debugLayersRef.current = [];
    // Limpieza defensiva: tras hot-reload o cambios de modo puede quedar un
    // Marker antiguo fuera de refs. Si sigue en el pane, el usuario ve un
    // TOP 1 viejo aunque el cálculo nuevo devuelva cero resultados.
    map.eachLayer((layer) => {
      const maybeMarker = layer as L.Marker & { getElement?: () => HTMLElement | undefined };
      const el =
        typeof maybeMarker.getElement === "function" ? maybeMarker.getElement() : undefined;
      if (
        el?.classList.contains("fishing-hotspot-rank") ||
        el?.querySelector(".fishing-hotspot-rank")
      ) {
        map.removeLayer(layer);
      }
    });
  };

  const compute = async () => {
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    const myRun = ++runIdRef.current;
    onLoadingChange?.(true);
    onProgress?.("Buscando mejor zona…");
    try {
      clearAll();
      if (!enabled) {
        onSpotsChange?.([], []);
        return;
      }

      // ── CACHÉ DIARIA ─────────────────────────────────────────────
      // Antes de cualquier cómputo: si tenemos resultado guardado para
      // (zona + modo + fecha de datos + filtros) → reutilizar y salir.
      const cacheInfo = buildSpotsCacheKey({
        area: searchArea,
        fishingMode: fishingModeRaw,
        maxSpots,
        minDepth,
        maxDepth,
        minScore,
        hotZoneOnly,
        hotZoneMode,
        layerTimes,
      });
      // Solo aplicamos caché cuando hay zona explícita (triángulo/polígono/rect).
      // El viewport puro cambia con pan/zoom y no es una "zona" estable.
      if (searchArea) {
        const cached = loadSpotsCache().find(
          (e) => e.key === cacheInfo.key && e.dateSig === cacheInfo.dateSig,
        );
        if (cached) {
          onProgress?.("Usando análisis del día (caché)…");
          onSpotsChange?.(cached.spots, []);
          onAnalysisSummary?.(cached.summary);
          // No marcamos error; salida limpia.
          return;
        }
      }

      onProgress?.("Esperando a que carguen las capas…");
      await waitForTilesIdle(map);
      if (myRun !== runIdRef.current) return;

      onProgress?.("Leyendo datos oceanográficos…");
      // Reset estadísticas de batimetría para esta corrida (logs claros).
      resetBathymetryStats();

      // 1) BBOX a analizar (área dibujada o viewport)
      const mapBounds = map.getBounds();
      let south = mapBounds.getSouth();
      let north = mapBounds.getNorth();
      let west = mapBounds.getWest();
      let east = mapBounds.getEast();

      if (searchArea) {
        if (searchArea.kind === "rect") {
          south = Math.min(searchArea.bounds[0].lat, searchArea.bounds[1].lat);
          north = Math.max(searchArea.bounds[0].lat, searchArea.bounds[1].lat);
          west = Math.min(searchArea.bounds[0].lng, searchArea.bounds[1].lng);
          east = Math.max(searchArea.bounds[0].lng, searchArea.bounds[1].lng);
        } else if (searchArea.kind === "polygon") {
          const lats = searchArea.points.map((p) => p.lat);
          const lngs = searchArea.points.map((p) => p.lng);
          south = Math.min(...lats);
          north = Math.max(...lats);
          west = Math.min(...lngs);
          east = Math.max(...lngs);
        }
      }

      // 2) Grid adaptativo. En modo FONDO con zona dibujada usamos más
      // resolución: los cabezos/veriles de 40–70 m pueden ocupar muy pocas
      // celdas y con una malla 7×7/9×9 se saltan aunque estén dentro del área.
      const areaDeg = (north - south) * (east - west);
      const gridSide =
        fishingMode === "bottom" && !!searchArea
          ? areaDeg > 4
            ? 15
            : 13
          : areaDeg > 20
            ? 8
            : areaDeg > 4
              ? 10
              : areaDeg > 1
                ? 10
                : 9;
      const stepLat = (north - south) / (gridSide - 1);
      const stepLng = (east - west) / (gridSide - 1);

      // 3) Máscara de tierra Natural Earth (verdad geográfica). Si falla la
      //    descarga (offline / red), seguimos con un fallback que NUNCA marca
      //    tierra — preferimos analizar de más a bloquear de más.
      let landMask: LandMask | null = null;
      try {
        landMask = await getLandMask();
      } catch (err) {
        console.warn("FishingHotspots: land mask failed, continuing without it", err);
        landMask = null;
      }
      if (myRun !== runIdRef.current) return;

      onProgress?.("Filtrando tierra y profundidad…");
      // 4) Construcción del grid + clasificación tierra/mar por celda.
      //    Cada celda se evalúa con un MUESTREO 7×7 contra Natural Earth:
      //    waterRatio = fracción de los 49 puntos que caen en agua. Una
      //    celda solo se descarta como tierra si waterRatio < 0.2 (regla
      //    pedida por producto: >20% de agua → analizable).
      //
      //    `isLand` (legacy, se mantiene por compatibilidad con el resto del
      //    pipeline) ahora significa: "esta celda es prácticamente toda
      //    tierra" (waterRatio < 0.2). Las celdas costeras con mar suficiente
      //    pasan como isLand=false y se les pondera por `waterRatio`.
      interface Cell {
        lat: number;
        lng: number;
        depth: number | null;
        /** Fuente real de la lectura (EMODnet > GEBCO > none). */
        depthSource: DepthSource;
        depthAttempts?: { emodnet: "ok" | "fail" | "skipped"; gebco: "ok" | "fail" | "skipped" };
        isLand: boolean;
        /** Fracción 0..1 de agua dentro de la celda (muestreo 7×7). */
        waterRatio: number;
        inArea: boolean;
      }
      const cells: Cell[] = [];
      // Profundidad mínima absoluta. Bajada a 3 m porque ya no es la línea
      // de defensa principal contra tierra (eso lo hace landMask). Sirve
      // solo para evitar puntos en bajos visibles (rompientes).
      const MIN_OCEAN_DEPTH = 3;
      /** Umbral mínimo de agua dentro de una celda para considerarla mar. */
      const MIN_WATER_RATIO = 0.2;
      const halfStepLat = stepLat / 2;
      const halfStepLng = stepLng / 2;
      for (let r = 0; r < gridSide; r++) {
        for (let c = 0; c < gridSide; c++) {
          const lat = south + r * stepLat;
          const lng = west + c * stepLng;
          if (!isValidLatLng(lat, lng)) continue;
          const inArea = !searchArea || isPointInArea(lat, lng, searchArea);
          let waterRatio = 1;
          let isLand = false;
          if (inArea && landMask) {
            waterRatio = landMask.waterRatio(lat, lng, halfStepLat, halfStepLng, 7);
            isLand = waterRatio < MIN_WATER_RATIO;
          }
          cells.push({
            lat,
            lng,
            depth: null,
            depthSource: "none",
            depthAttempts: undefined,
            isLand,
            waterRatio,
            inArea,
          });
        }
      }

      // 5) Muestreo de batimetría numérica REAL — servicio dedicado
      //    getDepthAtLatLng(lat,lng): EMODnet → GEBCO → none.
      //    En modo fondo NO decimamos la grilla: cada candidato necesita su
      //    profundidad real para no interpolar encima de piedras/veriles buenos.
      //    La capa visual del mapa NO participa en este cálculo.
      const isFocusedBottomGrid = fishingMode === "bottom" && !!searchArea;
      const numericGridSide = gridSide;
      const numericStepLat = (north - south) / Math.max(1, numericGridSide - 1);
      const numericStepLng = (east - west) / Math.max(1, numericGridSide - 1);
      const numericMeanLat = (south + north) / 2;
      const depthSampleTargets = isFocusedBottomGrid
        ? Array.from({ length: numericGridSide * numericGridSide }, (_, i) => {
            const r = Math.floor(i / numericGridSide);
            const c = i % numericGridSide;
            return {
              lat: south + r * numericStepLat,
              lng: west + c * numericStepLng,
              inArea:
                !searchArea ||
                isPointInArea(south + r * numericStepLat, west + c * numericStepLng, searchArea),
            };
          }).filter((p) => p.inArea)
        : cells
            .filter((cell) => cell.inArea && !cell.isLand)
            .map((cell) => ({ lat: cell.lat, lng: cell.lng, inArea: true }));

      const depthCellMatchRadiusM = Math.max(
        stepLat * 111000 * 1.6,
        stepLng * Math.max(0.2, Math.cos((numericMeanLat * Math.PI) / 180)) * 111000 * 1.6,
      );

      const nearestDepthSampleFor = (lat: number, lng: number) => {
        let best: Cell | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const cell of cells) {
          if (!cell.inArea || cell.isLand) continue;
          const d = distanceMeters(lat, lng, cell.lat, cell.lng);
          if (d < bestDist) {
            best = cell;
            bestDist = d;
          }
        }
        return bestDist <= depthCellMatchRadiusM ? best : null;
      };

      let sampledDepthValid = 0;
      let sampledEmodnet = 0;
      let sampledGebco = 0;
      let sampledDepthMin = Number.POSITIVE_INFINITY;
      let sampledDepthMax = Number.NEGATIVE_INFINITY;
      let sampledDepthSum = 0;
      const concurrency = 8;
      let cursor = 0;
      const fetchWorker = async () => {
        while (cursor < depthSampleTargets.length) {
          const i = cursor++;
          const target = depthSampleTargets[i];
          if (abortController.signal.aborted || myRun !== runIdRef.current) return;
          const sample = await getDepthAtLatLng(
            target.lat,
            target.lng,
            abortController.signal,
          ).catch(() => ({ depth: null, source: "none" as DepthSource, attempts: undefined }));
          if (abortController.signal.aborted || myRun !== runIdRef.current) return;
          const cell = nearestDepthSampleFor(target.lat, target.lng);
          if (cell) {
            cell.depth = sample.depth;
            cell.depthSource = sample.source;
            cell.depthAttempts = sample.attempts;
          }
          if (sample.depth != null && Number.isFinite(sample.depth)) {
            sampledDepthValid++;
            sampledDepthMin = Math.min(sampledDepthMin, sample.depth);
            sampledDepthMax = Math.max(sampledDepthMax, sample.depth);
            sampledDepthSum += sample.depth;
            if (sample.source === "emodnet") sampledEmodnet++;
            else if (sample.source === "gebco") sampledGebco++;
          }
          if (myRun !== runIdRef.current) return;
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => fetchWorker()));
      if (myRun !== runIdRef.current) return;

      // 5a) Logs de diagnóstico — ¿realmente recibimos profundidad numérica?
      if (debug) {
        const stats = getBathymetryStats();
        const validDepths: number[] = [];
        let nEmo = 0;
        let nGeb = 0;
        let nSea = 0;
        let visualBathymetryLoaded = false;
        const bathyPaneEl = map.getContainer().querySelector<HTMLElement>(".ocean-pane-bathy");
        if (bathyPaneEl?.querySelector("img.leaflet-tile-loaded")) visualBathymetryLoaded = true;
        for (const c of cells) {
          if (!c.inArea || c.isLand) continue;
          nSea++;
          if (c.depth != null && Number.isFinite(c.depth)) {
            validDepths.push(c.depth);
            if (c.depthSource === "emodnet") nEmo++;
            else if (c.depthSource === "gebco") nGeb++;
          }
        }
        const minD = validDepths.length ? Math.min(...validDepths) : null;
        const maxD = validDepths.length ? Math.max(...validDepths) : null;
        const meanD = validDepths.length
          ? validDepths.reduce((a, b) => a + b, 0) / validDepths.length
          : null;
        console.log(
          `[Batimetría] puntos muestreados=${depthSampleTargets.length} | ` +
            `EMODnet OK=${stats.emodnetOk} FAIL=${stats.emodnetFail} | ` +
            `GEBCO OK=${stats.gebcoOk} FAIL=${stats.gebcoFail} | ` +
            `celdas mar=${nSea} con depth=${validDepths.length} (EMO=${nEmo} GEB=${nGeb}) | ` +
            `batimetría visual=${visualBathymetryLoaded ? "cargada" : "no"} | ` +
            `fuente=${nEmo > 0 ? "EMODnet" : nGeb > 0 ? "GEBCO" : "superficie"} | ` +
            (minD != null
              ? `depth min=${minD.toFixed(0)}m max=${maxD!.toFixed(0)}m mean=${meanD!.toFixed(0)}m`
              : "sin profundidad numérica"),
        );
      }

      // 5b) Refinamiento por interpolación bicúbica (Catmull-Rom).
      //     Mejora el análisis de pendiente/rugosidad/transición rellenando
      //     huecos por cobertura/timeout y suavizando saltos artificiales
      //     entre celdas vecinas. NO inventa resolución real, solo produce
      //     un campo coherente y derivable.
      //     Solo aplicamos a celdas marinas dentro del área de búsqueda
      //     para no propagar valores hacia tierra emergida.
      {
        const rawDepths: (number | null)[] = cells.map((cell) =>
          cell.inArea && !cell.isLand ? cell.depth : null,
        );
        // Paso 1: rellenar huecos.
        const filled = bicubicFillGrid(rawDepths, gridSide);
        // Paso 2: suavizado leve (α=0.3) para limpiar ruido.
        const smoothed = bicubicSmoothGrid(filled, gridSide, 0.3);
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i];
          if (!cell.inArea || cell.isLand) continue;
          const v = smoothed[i];
          if (v == null) continue;
          // Si la celda no tenía dato, marcamos la fuente como interpolada
          // tomando la fuente de un vecino válido (heurística simple: si hay
          // mezcla, queda como "mixed"-like; aquí mantenemos la del cell o
          // la heredamos del primer vecino con dato).
          if (cell.depth == null) {
            let inheritedSource: DepthSource = "none";
            outer: for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const rr = Math.floor(i / gridSide) + dr;
                const cc = (i % gridSide) + dc;
                if (rr < 0 || cc < 0 || rr >= gridSide || cc >= gridSide) continue;
                const n = cells[rr * gridSide + cc];
                if (n.depth != null && n.depthSource !== "none") {
                  inheritedSource = n.depthSource;
                  break outer;
                }
              }
            }
            cell.depthSource = inheritedSource;
          }
          cell.depth = v;
        }
      }
      onProgress?.("Calculando gradientes y corrientes…");
      // 4) Rasterizar paneles oceanográficos para superficie.
      //
      // IMPORTANTE: distinguimos tres estados por capa:
      //   (a) PANE AUSENTE          → la capa no está activada en el panel.
      //   (b) PANE PRESENTE SIN TILES → activada pero aún cargando / sin cobertura visual.
      //   (c) PANE CON TILES        → tenemos píxeles que muestrear.
      //
      // Esta separación es la que arregla el bug "la altimetría se ve pero no
      // entra en el cálculo": antes, si el rasterizado del pane fallaba (p.ej.
      // porque las tiles aún no habían terminado de pintarse o porque la opacidad
      // era 0 en el DOM real), tratábamos la capa como inexistente.
      const container = map.getContainer();
      const paneHasContent = (paneClass: string): boolean => {
        const paneEl = container.querySelector<HTMLElement>(`.${paneClass}`);
        if (!paneEl) return false;
        const tiles = paneEl.querySelectorAll<HTMLImageElement>("img.leaflet-tile-loaded");
        return tiles.length > 0;
      };
      const sstPaneActive = paneHasContent("ocean-pane-sst");
      const chlPaneActive = paneHasContent("ocean-pane-chl");
      const altPaneActive = paneHasContent("ocean-pane-alt");

      const sstCanvas = sstPaneActive ? rasterizePane(map, "ocean-pane-sst") : null;
      const chlCanvas = chlPaneActive ? rasterizePane(map, "ocean-pane-chl") : null;
      const altCanvas = altPaneActive ? rasterizePane(map, "ocean-pane-alt") : null;
      const W = map.getSize().x;
      const H = map.getSize().y;
      const readPixels = (c: HTMLCanvasElement | null): Uint8ClampedArray | null => {
        if (!c) return null;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        try {
          return ctx.getImageData(0, 0, W, H).data;
        } catch {
          return null;
        }
      };
      const sstData = readPixels(sstCanvas);
      // Pre-suavizado del raster SST (box-blur r=2 → kernel 5×5). Elimina
      // ruido sub-tile y costuras WMTS antes de calcular gradientes. Los
      // microgradientes mediterráneos (0.1–0.3 °C/km) sobreviven; las
      // discontinuidades artificiales de tile (1–2 px) se diluyen.
      const sstSmoothData = sstData ? boxBlurRgba(sstData, W, H, 2) : null;
      const chlData = readPixels(chlCanvas);
      const altData = readPixels(altCanvas);
      const hasSurfaceData = !!(sstData || chlData || altData);

      if (debug) {
        console.log("[FishingHotspots] Surface panes status:", {
          sst: { paneActive: sstPaneActive, sampled: !!sstData },
          chl: { paneActive: chlPaneActive, sampled: !!chlData },
          alt: { paneActive: altPaneActive, sampled: !!altData },
          viewport: { w: W, h: H },
        });
      }

      // 5) Helpers de geometría
      const meanLat = (south + north) / 2;
      const kmPerLat = 111;
      const kmPerLng = 111 * Math.cos((meanLat * Math.PI) / 180);
      const idxOf = (r: number, c: number) => r * gridSide + c;
      const depthAt = (r: number, c: number): number | null => {
        if (r < 0 || c < 0 || r >= gridSide || c >= gridSide) return null;
        return cells[idxOf(r, c)].depth;
      };

      // 6) Sub-score FONDO por celda. Devuelve factores parciales si no hay
      //    batimetría (hasBathy=false) en lugar de null, para que el motor
      //    pueda continuar con superficie como fallback.
      const computeBottomFactors = (r: number, c: number): BottomFactors => {
        const cell = cells[idxOf(r, c)];
        const z = cell.depth;
        if (z == null || z < 5) {
          return {
            pendiente: 0,
            rugosidad: 0,
            profundidad: 0,
            transicion: 0,
            consistencia: 0,
            slopeMperKm: 0,
            roughnessM: 0,
            transitionM: 0,
            depthM: z,
            hasBathy: false,
            depthDeltaM: 0,
            distToBreakM: null,
            nearIsobaths: [],
            reliefClass: "plano",
            roughness5x5M: 0,
            curvatureMperKm2: 0,
            slopeBreakStrength: 0,
            reliefType: "llano",
            tpi3M: 0,
            tpi5M: 0,
            aspectDeg: null,
          };
        }

        const zN = depthAt(r - 1, c);
        const zS = depthAt(r + 1, c);
        const zE = depthAt(r, c + 1);
        const zW = depthAt(r, c - 1);
        const dzdy =
          zN != null && zS != null
            ? (zS - zN) / (2 * stepLat * kmPerLat)
            : zN != null
              ? (z - zN) / (stepLat * kmPerLat)
              : zS != null
                ? (zS - z) / (stepLat * kmPerLat)
                : 0;
        const dzdx =
          zE != null && zW != null
            ? (zE - zW) / (2 * stepLng * kmPerLng)
            : zE != null
              ? (zE - z) / (stepLng * kmPerLng)
              : zW != null
                ? (z - zW) / (stepLng * kmPerLng)
                : 0;
        const slopeMperKm = Math.sqrt(dzdx * dzdx + dzdy * dzdy);

        const neigh: number[] = [];
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const zn = depthAt(r + dr, c + dc);
            if (zn != null) neigh.push(zn);
          }
        }
        let roughnessM = 0;
        let transitionM = 0;
        let depthDeltaM = 0;
        if (neigh.length >= 3) {
          const mean = neigh.reduce((a, b) => a + b, 0) / neigh.length;
          const variance = neigh.reduce((a, b) => a + (b - mean) ** 2, 0) / neigh.length;
          roughnessM = Math.sqrt(variance);
          const zmax = Math.max(...neigh, z);
          const zmin = Math.min(...neigh, z);
          transitionM = zmax - zmin;
          depthDeltaM = Math.max(...neigh.map((zn) => Math.abs(zn - z)), 0);
        }
        const isobaths = [50, 100, 200, 500];
        const nearIsobaths = isobaths.filter(
          (iso) => Math.abs(z - iso) <= Math.max(10, iso * 0.08),
        );
        const cellSpacingM = Math.max(stepLat * kmPerLat * 1000, stepLng * kmPerLng * 1000);
        const distToBreakM =
          slopeMperKm >= 15 || transitionM >= 8
            ? 0
            : (() => {
                let best = Number.POSITIVE_INFINITY;
                for (let rr = 0; rr < gridSide; rr++) {
                  for (let cc = 0; cc < gridSide; cc++) {
                    if (rr === r && cc === c) continue;
                    const zz = depthAt(rr, cc);
                    if (zz == null) continue;
                    const zc = cells[idxOf(rr, cc)];
                    const dzLocal = Math.abs(zz - z);
                    if (dzLocal < 8) continue;
                    const dist = distanceMeters(cell.lat, cell.lng, zc.lat, zc.lng);
                    if (dist < best) best = dist;
                  }
                }
                return Number.isFinite(best) ? best : cellSpacingM * 2;
              })();
        const reliefClass: BottomFactors["reliefClass"] =
          transitionM >= 12 && slopeMperKm >= 14
            ? "ladera"
            : depthDeltaM >= 10 && roughnessM >= 6
              ? "monte"
              : depthDeltaM >= 8 && z > neigh.reduce((a, b) => a + b, 0) / Math.max(1, neigh.length)
                ? "depresion"
                : "plano";

        // A. Pendiente — atenúa pendientes extremas aisladas (artefactos)
        let pendiente = clamp01(slopeMperKm / 25);
        if (slopeMperKm > 80 && neigh.length < 5) pendiente *= 0.6;

        // B. Rugosidad
        const rugosidad = clamp01(roughnessM / 50);

        // C. Profundidad — gausiana centrada en (min+max)/2, decae fuera
        const zMid = (minDepth + maxDepth) / 2;
        const zHalf = Math.max(1, (maxDepth - minDepth) / 2);
        const zDist = Math.abs(z - zMid) / zHalf;
        const profundidad =
          z >= minDepth && z <= maxDepth
            ? clamp01(1 - zDist * 0.6) // óptimo en el centro
            : clamp01(0.5 - (zDist - 1) * 0.4); // suave, no eliminatorio

        // D. Transición batimétrica
        const transicion = clamp01(transitionM / 120);

        // E. Consistencia espacial — premia que los vecinos también tengan algo
        let consistentNeighbors = 0;
        let totalNeighbors = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const zn = depthAt(r + dr, c + dc);
            if (zn == null || zn < 5) continue;
            totalNeighbors++;
            if (Math.abs(zn - z) > 5) consistentNeighbors++;
          }
        }
        const consistencia = totalNeighbors > 0 ? consistentNeighbors / totalNeighbors : 0;

        // F. Rugosidad 5×5 — std-dev en ventana ampliada. Capta cabezos y
        //    montículos que el 3×3 no resuelve (relieve a escala >1 celda).
        const wide: number[] = [];
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const zn = depthAt(r + dr, c + dc);
            if (zn != null && zn >= 5) wide.push(zn);
          }
        }
        let roughness5x5M = 0;
        if (wide.length >= 8) {
          const mw = wide.reduce((a, b) => a + b, 0) / wide.length;
          roughness5x5M = Math.sqrt(wide.reduce((a, b) => a + (b - mw) ** 2, 0) / wide.length);
        }

        // G. Curvatura — laplaciano discreto del fondo, normalizado por
        //    distancia entre celdas. Positivo = depresión/cuenco (cañón
        //    submarino, cabeza de cañón); Negativo = monte/cabezo.
        //    Unidades: m/km² (segunda derivada).
        const dxKm = stepLng * kmPerLng;
        const dyKm = stepLat * kmPerLat;
        let curvatureMperKm2 = 0;
        if (zN != null && zS != null && zE != null && zW != null && dxKm > 0 && dyKm > 0) {
          const d2x = (zE - 2 * z + zW) / (dxKm * dxKm);
          const d2y = (zN - 2 * z + zS) / (dyKm * dyKm);
          curvatureMperKm2 = d2x + d2y;
        }

        // H. Quiebre de pendiente (break of slope) — la celda es máximo local
        //    de pendiente respecto a sus 8 vecinos. Detecta el cambio brusco
        //    plataforma → talud, que es el "highway" de los demersales.
        let neighSlopeMax = 0;
        let neighSlopeMean = 0;
        let nSlope = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const rr = r + dr;
            const cc = c + dc;
            const zc = depthAt(rr, cc);
            if (zc == null || zc < 5) continue;
            const zNn = depthAt(rr - 1, cc);
            const zSn = depthAt(rr + 1, cc);
            const zEn = depthAt(rr, cc + 1);
            const zWn = depthAt(rr, cc - 1);
            const gx =
              zEn != null && zWn != null
                ? (zEn - zWn) / (2 * dxKm)
                : zEn != null
                  ? (zEn - zc) / dxKm
                  : zWn != null
                    ? (zc - zWn) / dxKm
                    : 0;
            const gy =
              zNn != null && zSn != null
                ? (zSn - zNn) / (2 * dyKm)
                : zNn != null
                  ? (zc - zNn) / dyKm
                  : zSn != null
                    ? (zSn - zc) / dyKm
                    : 0;
            const sn = Math.sqrt(gx * gx + gy * gy);
            neighSlopeMax = Math.max(neighSlopeMax, sn);
            neighSlopeMean += sn;
            nSlope++;
          }
        }
        neighSlopeMean = nSlope > 0 ? neighSlopeMean / nSlope : 0;
        // Strength: cuánto sobresale slope local sobre la media de vecinos.
        // 1 = pico claro de pendiente; 0 = pendiente uniforme/nada.
        const slopeBreakStrength =
          neighSlopeMean > 0
            ? clamp01((slopeMperKm - neighSlopeMean) / Math.max(8, neighSlopeMean))
            : clamp01(slopeMperKm / 30);

        // I. TPI 3×3 — media de los 8 vecinos menos z. Convención: positivo
        //    = celda MÁS SOMERA que el entorno (cabezo, cumbre); negativo
        //    = depresión. Como `z` es profundidad (positivo abajo), debemos
        //    invertir el signo: tpi = mean(neigh) − z.
        let tpi3M = 0;
        if (neigh.length >= 5) {
          const meanN = neigh.reduce((a, b) => a + b, 0) / neigh.length;
          tpi3M = meanN - z;
        }
        // J. TPI 5×5 — misma idea con la ventana ampliada (cabezos extensos,
        //    montes submarinos). Reusa el array `wide` ya calculado arriba.
        let tpi5M = 0;
        if (wide.length >= 12) {
          const meanW = wide.reduce((a, b) => a + b, 0) / wide.length;
          tpi5M = meanW - z;
        }
        // K. Aspect (orientación de la ladera) — derivado del gradiente
        //    batimétrico. atan2(dzdx, dzdy) da la dirección hacia la que
        //    desciende el fondo (downslope). Convertimos a 0–360° (N=0, E=90).
        //    Útil para acoplar con dirección de corriente (lee/sotavento).
        const slopeMag = Math.hypot(dzdx, dzdy);
        const aspectDeg: number | null =
          slopeMag > 0.5 // m/km mínimo para tener orientación significativa
            ? (Math.atan2(dzdx, dzdy) * 180) / Math.PI < 0
              ? (Math.atan2(dzdx, dzdy) * 180) / Math.PI + 360
              : (Math.atan2(dzdx, dzdy) * 180) / Math.PI
            : null;

        // Clasificación física compacta para reasons/popup.
        const reliefType: BottomFactors["reliefType"] =
          curvatureMperKm2 > 1.5 && roughness5x5M >= 4
            ? "cañón"
            : curvatureMperKm2 < -1.5 && roughness5x5M >= 4
              ? "monte"
              : tpi5M >= 8 && roughness5x5M >= 3
                ? "monte"
                : slopeBreakStrength >= 0.55 && slopeMperKm >= 12
                  ? "quiebre"
                  : slopeMperKm >= 8
                    ? "ladera"
                    : "llano";

        return {
          pendiente,
          rugosidad,
          profundidad,
          transicion,
          consistencia,
          slopeMperKm,
          roughnessM,
          transitionM,
          depthM: z,
          hasBathy: true,
          depthDeltaM,
          distToBreakM,
          nearIsobaths,
          reliefClass,
          roughness5x5M,
          curvatureMperKm2,
          slopeBreakStrength,
          reliefType,
          tpi3M,
          tpi5M,
          aspectDeg,
        };
      };

      // 7) Sub-score SUPERFICIE por lat/lng (rasteriza el píxel correspondiente)
      //    Para ADT (y como mejora general) usamos `sampleWithFallback`:
      //    si el píxel exacto no tiene dato (banda transparente entre tiles,
      //    hueco de cobertura), buscamos en anillos concéntricos hasta 32 px.
      //    Así, si la altimetría se ve en pantalla, el motor PUEDE leerla aunque
      //    el centroide caiga en un píxel sin dato exacto.
      const sampleStep = 6;
      const ALT_FALLBACK_RADIUS = 32;
      const SUR_FALLBACK_RADIUS = 16;
      const computeSurfaceFactors = (lat: number, lng: number): SurfaceFactors => {
        const empty: SurfaceFactors = {
          sstGradiente: 0,
          chl: 0,
          corriente: 0,
          adt: 0,
          coherencia: 0,
          fallbackSignal: 0,
          fallbackDominant: null,
          bathyEdge: 0,
          localStructure: 0,
          seamArtifact: false,
          hasSst: false,
          hasChl: false,
          hasAlt: false,
          sstSource: "none",
          chlSource: "none",
          altSource: "none",
          altMissReason: altPaneActive ? "no_data_at_pixel" : "pane_no_tiles",
        };
        if (!hasSurfaceData) return empty;
        const pt = map.latLngToContainerPoint([lat, lng]);
        const px = Math.round(pt.x);
        const py = Math.round(pt.y);
        if (px < 0 || py < 0 || px >= W || py >= H) {
          return { ...empty, altMissReason: "off_screen" };
        }

        let sstGradiente = 0;
        let chl = 0;
        let corriente = 0;
        let adt = 0;
        let hasSst = false;
        let hasChl = false;
        let hasAlt = false;
        let sstSource: Sample["source"] = "none";
        let chlSource: Sample["source"] = "none";
        let altSource: Sample["source"] = "none";
        let altMissReason: SurfaceFactors["altMissReason"] = altPaneActive
          ? "no_data_at_pixel"
          : "pane_no_tiles";
        let seamArtifact = false;
        let localStructure = 0;

        // Vectores gradiente por capa (para coherencia direccional entre frentes).
        let sstGx = 0,
          sstGy = 0;
        let chlGx = 0,
          chlGy = 0;
        let altGx = 0,
          altGy = 0;
        let sstFallbackValue = 0,
          chlFallbackValue = 0,
          altFallbackValue = 0;

        // ─── SST: intensidad REAL de frente sobre raster suavizado ───
        // Usamos `sstSmoothData` (box-blur 5×5) para que microgradientes
        // mediterráneos (0.1–0.3 °C/km) emerjan por encima del ruido del
        // raster, y las costuras WMTS no se confundan con frentes reales.
        // Validamos persistencia direccional con 8 vecinos (±2·step y ±4·step)
        // y descartamos seams axis-aligned puros sobre el raster CRUDO (donde
        // viven, antes del suavizado).
        const sstWorking = sstSmoothData ?? sstData;
        if (sstWorking) {
          const s = sampleWithFallback(sstWorking, W, H, px, py, sampleStep, SUR_FALLBACK_RADIUS);
          if (s.hasData) {
            const mag = Math.hypot(s.gx, s.gy);
            // Vecinos extendidos: 4 a ±2·step + 4 a ±4·step → 8 muestras
            const off2 = sampleStep * 2;
            const off4 = sampleStep * 4;
            const neighRaw = [
              sampleWithFallback(sstWorking, W, H, px, py - off2, sampleStep, SUR_FALLBACK_RADIUS),
              sampleWithFallback(sstWorking, W, H, px, py + off2, sampleStep, SUR_FALLBACK_RADIUS),
              sampleWithFallback(sstWorking, W, H, px + off2, py, sampleStep, SUR_FALLBACK_RADIUS),
              sampleWithFallback(sstWorking, W, H, px - off2, py, sampleStep, SUR_FALLBACK_RADIUS),
              sampleWithFallback(sstWorking, W, H, px, py - off4, sampleStep, SUR_FALLBACK_RADIUS),
              sampleWithFallback(sstWorking, W, H, px, py + off4, sampleStep, SUR_FALLBACK_RADIUS),
              sampleWithFallback(sstWorking, W, H, px + off4, py, sampleStep, SUR_FALLBACK_RADIUS),
              sampleWithFallback(sstWorking, W, H, px - off4, py, sampleStep, SUR_FALLBACK_RADIUS),
            ];
            const neigh = neighRaw.filter((n) => n.hasData);
            let coherence = 0;
            let alignedCount = 0;
            if (neigh.length >= 4 && mag > 1e-4) {
              const cx = s.gx / mag;
              const cy = s.gy / mag;
              let acc = 0;
              let n = 0;
              for (const nn of neigh) {
                const m = Math.hypot(nn.gx, nn.gy);
                if (m < 1e-4) continue;
                const dot = (nn.gx / m) * cx + (nn.gy / m) * cy;
                acc += Math.max(0, dot);
                if (dot >= 0.5) alignedCount++;
                n++;
              }
              if (n > 0) coherence = acc / n;
            }
            // Frente persistente: requiere ≥ 4 vecinos alineados con el centro.
            // Si no, lo tratamos como ruido aislado.
            const persistent = alignedCount >= 4 ? 1 : alignedCount >= 2 ? 0.55 : 0.15;

            // Detección de seam axis-aligned sobre el raster CRUDO (sin
            // suavizar): allí los seams son nítidos. Si seam → casi anulamos.
            if (sstData) {
              seamArtifact = isAxisAlignedSeam(sstData, W, H, px, py, s.gx, s.gy, sampleStep);
            }

            // Micro-gradiente mediterráneo: divisor 0.18 (antes 0.4) + γ 0.7
            const rawMag = clamp01(mag / 0.18);

            // ─── Gradiente MULTIESCALA ───
            // Un frente real puede ser suave (cambio de 0.3-0.6 °C repartido
            // en 10-20 km). El gradiente puntual lo ve plano, pero la
            // diferencia de valor entre muestras alejadas lo revela. Medimos
            // ∆SST en dos escalas adicionales (media y amplia) y normalizamos
            // por la distancia equivalente para obtener una magnitud
            // comparable al gradiente local.
            const off6 = sampleStep * 6;
            const off12 = sampleStep * 12;
            const sN6 = sampleWithFallback(
              sstWorking,
              W,
              H,
              px,
              py - off6,
              sampleStep,
              SUR_FALLBACK_RADIUS,
            );
            const sS6 = sampleWithFallback(
              sstWorking,
              W,
              H,
              px,
              py + off6,
              sampleStep,
              SUR_FALLBACK_RADIUS,
            );
            const sE6 = sampleWithFallback(
              sstWorking,
              W,
              H,
              px + off6,
              py,
              sampleStep,
              SUR_FALLBACK_RADIUS,
            );
            const sW6 = sampleWithFallback(
              sstWorking,
              W,
              H,
              px - off6,
              py,
              sampleStep,
              SUR_FALLBACK_RADIUS,
            );
            const sN12 = sampleWithFallback(
              sstWorking,
              W,
              H,
              px,
              py - off12,
              sampleStep,
              SUR_FALLBACK_RADIUS,
            );
            const sS12 = sampleWithFallback(
              sstWorking,
              W,
              H,
              px,
              py + off12,
              sampleStep,
              SUR_FALLBACK_RADIUS,
            );
            const sE12 = sampleWithFallback(
              sstWorking,
              W,
              H,
              px + off12,
              py,
              sampleStep,
              SUR_FALLBACK_RADIUS,
            );
            const sW12 = sampleWithFallback(
              sstWorking,
              W,
              H,
              px - off12,
              py,
              sampleStep,
              SUR_FALLBACK_RADIUS,
            );

            let mesoMag = 0;
            if (sN6.hasData && sS6.hasData && sE6.hasData && sW6.hasData) {
              const dxM = (sE6.v - sW6.v) / 12; // 2·off6 / sampleStep equiv
              const dyM = (sS6.v - sN6.v) / 12;
              mesoMag = Math.hypot(dxM, dyM);
            }
            let wideMag = 0;
            if (sN12.hasData && sS12.hasData && sE12.hasData && sW12.hasData) {
              const dxW = (sE12.v - sW12.v) / 24;
              const dyW = (sS12.v - sN12.v) / 24;
              wideMag = Math.hypot(dxW, dyW);
            }
            // Normalización por escala: divisores más estrechos en escalas
            // amplias para premiar cambios térmicos suaves pero reales.
            const rawMeso = clamp01(mesoMag / 0.09);
            const rawWide = clamp01(wideMag / 0.06);

            // Fusión multiescala: tomamos el máximo (la escala que mejor
            // detecta el frente manda) y añadimos un pequeño bonus si dos
            // escalas coinciden (frente consistente entre escalas).
            const scaleAgreement =
              rawMeso >= 0.25 && rawWide >= 0.25
                ? 0.1
                : (rawMeso >= 0.25 && rawMag >= 0.25) || (rawWide >= 0.25 && rawMag >= 0.25)
                  ? 0.05
                  : 0;
            const multiscaleMag = clamp01(Math.max(rawMag, rawMeso, rawWide) + scaleAgreement);

            let frontIntensity = clamp01(
              Math.pow(multiscaleMag, 0.7) * (0.45 + 0.55 * coherence) * persistent,
            );
            if (seamArtifact) frontIntensity *= 0.15;
            sstGradiente = frontIntensity;
            sstGx = s.gx;
            sstGy = s.gy;
            sstFallbackValue = clamp01(s.v);
            hasSst = true;
            sstSource = s.source;

            // Estructura local: 1 = mucha variabilidad estructurada; 0 = mancha homogénea.
            // Calculada sobre raster CRUDO (sin sesgo del blur). Normalizamos
            // empíricamente: una varianza ≥ 0.012 ya cuenta como bien estructurada.
            if (sstData) {
              const variance = localValueVariance(sstData, W, H, px, py, 12);
              localStructure = clamp01(variance / 0.012);
            }
          }
        }
        if (chlData) {
          const s = sampleWithFallback(chlData, W, H, px, py, sampleStep, SUR_FALLBACK_RADIUS);
          if (s.hasData) {
            const grad = clamp01(s.grad / 0.4);
            // Penaliza agua "verde sopa" — exceso de clorofila indica agua
            // costera/sucia, no zona pelágica de túnidos.
            const dirty = s.v > 0.85 ? 0.35 : s.v > 0.7 ? 0.18 : 0;
            chl = Math.max(0, grad - dirty);
            chlGx = s.gx;
            chlGy = s.gy;
            chlFallbackValue = clamp01(s.v);
            hasChl = true;
            chlSource = s.source;
          }
        }
        if (altData) {
          const s = sampleWithFallback(altData, W, H, px, py, sampleStep, ALT_FALLBACK_RADIUS);
          if (s.hasData) {
            corriente = clamp01(s.grad / 0.35);
            adt = clamp01((s.grad * 0.7 + s.v * 0.3) / 0.5);
            altGx = s.gx;
            altGy = s.gy;
            altFallbackValue = clamp01(Math.max(s.v, adt));
            hasAlt = true;
            altSource = s.source;
            altMissReason = null;
          } else {
            altMissReason = "no_coverage_nearby";
          }
        }

        // ─── COHERENCIA OCEANOGRÁFICA v2 ───
        const strongVals = [sstGradiente, chl, corriente, adt].filter((v) => v >= 0.35).length;
        const dirVecs: [number, number][] = [];
        if (hasSst) {
          const m = Math.hypot(sstGx, sstGy);
          if (m > 1e-4) dirVecs.push([sstGx / m, sstGy / m]);
        }
        if (hasChl) {
          const m = Math.hypot(chlGx, chlGy);
          if (m > 1e-4) dirVecs.push([chlGx / m, chlGy / m]);
        }
        if (hasAlt) {
          const m = Math.hypot(altGx, altGy);
          if (m > 1e-4) dirVecs.push([altGx / m, altGy / m]);
        }
        let dirAlignment = 0;
        if (dirVecs.length >= 2) {
          let acc = 0;
          let pairs = 0;
          for (let i = 0; i < dirVecs.length; i++) {
            for (let j = i + 1; j < dirVecs.length; j++) {
              acc += Math.abs(dirVecs[i][0] * dirVecs[j][0] + dirVecs[i][1] * dirVecs[j][1]);
              pairs++;
            }
          }
          if (pairs > 0) dirAlignment = clamp01(acc / pairs);
        }
        const baseCoh =
          strongVals >= 3 ? 0.85 : strongVals === 2 ? 0.55 : strongVals === 1 ? 0.2 : 0;
        const convergenceBonus = strongVals >= 3 && dirAlignment >= 0.6 ? 0.15 : 0;
        const coherencia = clamp01(baseCoh * 0.6 + dirAlignment * 0.4 + convergenceBonus);

        const fallbackCandidates: Array<["alt" | "sst" | "chl", number]> = [];
        if (hasAlt)
          fallbackCandidates.push(["alt", clamp01(Math.max(adt, corriente, altFallbackValue))]);
        if (hasSst)
          fallbackCandidates.push(["sst", clamp01(Math.max(sstGradiente, sstFallbackValue))]);
        if (hasChl) fallbackCandidates.push(["chl", clamp01(Math.max(chl, chlFallbackValue))]);
        fallbackCandidates.sort((a, b) => b[1] - a[1]);

        return {
          sstGradiente,
          chl,
          corriente,
          adt,
          coherencia,
          fallbackSignal: fallbackCandidates[0]?.[1] ?? 0,
          fallbackDominant: fallbackCandidates[0]?.[0] ?? null,
          bathyEdge: 0, // se rellena en el loop principal a partir de bF
          localStructure,
          seamArtifact,
          hasSst,
          hasChl,
          hasAlt,
          sstSource,
          chlSource,
          altSource,
          altMissReason,
        };
      };

      // 8) Score por celda + recolección
      interface Scored {
        r: number;
        c: number;
        lat: number;
        lng: number;
        bottom: BottomFactors;
        surface: SurfaceFactors;
        breakdown: ScoreBreakdown;
        depthSource: DepthSource;
        /** Solo para modo bottom v2 */
        bottomV2?: {
          score: number;
          depthBonus: number;
          reasons: string[];
          main: string;
          inDepthRange: boolean;
        };
      }
      const scored: Scored[] = [];
      // Celdas puntuadas del modo deriva → se usan para extraer los frentes.
      const driftCells: DriftCorridorCell[] = [];
      let cellsAnalyzed = 0;
      let cellsWithDepth = 0;
      let cellsLand = 0; // GEBCO marca tierra emergida (elev ≥ 0)
      let cellsTooShallow = 0; // mar pero < MIN_OCEAN_DEPTH
      let cellsCoastal = 0; // mar válido pero pegado a tierra (buffer 500 m)
      let cellsNoData = 0; // GEBCO falló — NO asumir tierra
      const cellsDeadBottom = 0; // bottom-mode: descartadas por fondo plano
      let totalSlope = 0;
      let maxSlopeDetected = 0;
      let totalSstGrad = 0;
      // Cobertura REAL de capas — cuántas celdas marinas válidas devolvieron
      // un valor numérico para cada capa. Esto es lo que se reporta al usuario
      // como "SST OK / sin dato", no la mera presencia visual del pane.
      let cellsWithSst = 0;
      let cellsWithChl = 0;
      let cellsWithAlt = 0;

      // ─── Filtro costero: descartar puntos a < 500 m de tierra ───
      // Usamos la grilla landMask: si en un radio aproximado a la celda hay
      // tierra emergida (waterRatio bajo en celdas vecinas) consideramos que
      // el punto está pegado a costa. Esto evita marcar spots en la línea de
      // playa donde el análisis pierde sentido.
      const COAST_BUFFER_M = 500;
      const isCoastTooClose = (cellLat: number, cellLng: number): boolean => {
        if (!landMask) return false;
        // 6 muestras alrededor (a 500 m en N/S/E/O y diagonales) — si CUALQUIERA
        // cae en tierra, el punto es coastal.
        const dLat = COAST_BUFFER_M / 111000;
        const dLng = COAST_BUFFER_M / (111000 * Math.max(0.2, Math.cos((cellLat * Math.PI) / 180)));
        const probes: [number, number][] = [
          [cellLat + dLat, cellLng],
          [cellLat - dLat, cellLng],
          [cellLat, cellLng + dLng],
          [cellLat, cellLng - dLng],
          [cellLat + dLat * 0.7, cellLng + dLng * 0.7],
          [cellLat - dLat * 0.7, cellLng - dLng * 0.7],
        ];
        for (const [la, lo] of probes) {
          // waterRatio < 0.5 en la sonda → la sonda toca tierra
          const wr = landMask.waterRatio(la, lo, dLat * 0.5, dLng * 0.5, 5);
          if (wr < 0.5) return true;
        }
        return false;
      };

      // ─── MÁSCARA MARINA (versión robusta v6) ───
      // La verdad de tierra/mar viene de Natural Earth (cell.isLand y
      // cell.waterRatio), NO de GEBCO. Una celda es candidato si:
      //   1) waterRatio >= MIN_WATER_RATIO (al menos 20% mar)
      //   2) Si tiene profundidad GEBCO, debe ser >= MIN_OCEAN_DEPTH
      //      (si no hay dato GEBCO, NO se descarta — sigue con superficie)
      //   3) No bloqueamos por vecinos costeros: una celda con suficiente
      //      mar es analizable aunque la celda contigua sea isla.
      const isOceanCell = (r: number, c: number): boolean => {
        const cell = cells[idxOf(r, c)];
        if (cell.isLand) return false;
        if (cell.depth != null && cell.depth < MIN_OCEAN_DEPTH) return false;
        return true;
      };
      void isOceanCell; // se mantiene por si helpers downstream lo usan

      // ─── PERFIL DE PESOS DE FONDO + AJUSTE ESTACIONAL ───
      // Solo aplica en modo "bottom". Se decide UNA vez por análisis a partir
      // de la profundidad media del área marina (no por celda) para que el
      // Top 1 use un set de pesos coherente con el contexto batimétrico
      // dominante (plataforma costera / talud / abisal). El rango objetivo
      // de profundidad se modula por estación (verano más profundo, invierno
      // más somero) sin tocar los pesos estructurales.
      let bottomProfile: BottomProfile = "talud";
      let bottomWeights: BottomWeights = BOTTOM_PROFILE_WEIGHTS.talud;
      let seasonalRange: {
        minDepth: number;
        maxDepth: number;
        season: "verano" | "invierno" | "intermedia";
        factor: number;
      } = { minDepth, maxDepth, season: "intermedia", factor: 1 };
      if (fishingMode === "bottom") {
        let depthSum = 0;
        let depthN = 0;
        for (const cell of cells) {
          if (!cell.inArea || cell.isLand) continue;
          if (cell.depth != null && Number.isFinite(cell.depth) && cell.depth >= MIN_OCEAN_DEPTH) {
            depthSum += cell.depth;
            depthN++;
          }
        }
        const meanDepth = depthN > 0 ? depthSum / depthN : (minDepth + maxDepth) / 2;
        bottomProfile = pickBottomProfile(meanDepth);
        bottomWeights = BOTTOM_PROFILE_WEIGHTS[bottomProfile];
        seasonalRange = seasonalDepthRange(minDepth, maxDepth);
        if (debug) {
          console.log(
            `[BottomProfile] meanDepth=${meanDepth.toFixed(0)}m → perfil=${bottomProfile} ` +
              `weights=${JSON.stringify(bottomWeights)} ` +
              `season=${seasonalRange.season} (×${seasonalRange.factor}) ` +
              `range=${seasonalRange.minDepth}-${seasonalRange.maxDepth}m`,
          );
        }
      }

      // ─────────────────────────────────────────────────────────────────
      //  CAMPOS GLOBALES DE FONDO + FSLE + PERSISTENCIA
      // ─────────────────────────────────────────────────────────────────
      // Antes la temperatura y la corriente de fondo solo se consultaban
      // para los candidatos finales, así que el ranking podía descartar
      // zonas excelentes antes de conocerlas. Ahora se muestrea una malla
      // gruesa (8×8) de MEDSEA sobre TODA el área y se interpola por celda,
      // de modo que esas variables entran en la puntuación desde el principio.
      onProgress?.("Muestreando fondo (T, corriente, O₂, salinidad)…");
      const analysisTime = (
        layerTimes?.sst_nrt ??
        layerTimes?.sst_analysed ??
        new Date().toISOString().slice(0, 10)
      ).slice(0, 10);
      const analysisDate = new Date(`${analysisTime}T12:00:00Z`);
      // Zoom de muestreo DERIVADO del área, no del zoom actual del mapa: así
      // el mismo triángulo pide siempre el mismo píxel de Copernicus aunque el
      // usuario haya hecho zoom entre dos análisis.
      const spanDeg = Math.max(north - south, east - west);
      const fieldZoom = spanDeg > 2 ? 6 : spanDeg > 1 ? 7 : spanDeg > 0.5 ? 8 : spanDeg > 0.25 ? 9 : 10;

      const depthAtLatLng = (lat: number, lng: number): number | null => {
        const r = Math.round((lat - south) / (stepLat || 1));
        const c = Math.round((lng - west) / (stepLng || 1));
        const rr = Math.max(0, Math.min(gridSide - 1, r));
        const cc = Math.max(0, Math.min(gridSide - 1, c));
        return cells[idxOf(rr, cc)]?.depth ?? null;
      };

      let bottomFieldData: BottomField | null = null;
      let fsleFieldToday = emptyFsleField();
      let fsleFieldPrev = emptyFsleField();
      try {
        const prevDate = new Date(analysisDate.getTime() - 2 * 86400000).toISOString().slice(0, 10);
        const [bf, f1, f2] = await Promise.all([
          buildBottomField({
            south,
            west,
            north,
            east,
            zoom: fieldZoom,
            time: analysisTime,
            depthAt: depthAtLatLng,
            side: 8,
            signal: abortController.signal,
          }).catch(() => null),
          buildFsleField({
            south,
            west,
            north,
            east,
            date: analysisTime,
            signal: abortController.signal,
          }).catch(() => emptyFsleField()),
          buildFsleField({
            south,
            west,
            north,
            east,
            date: prevDate,
            signal: abortController.signal,
          }).catch(() => emptyFsleField()),
        ]);
        bottomFieldData = bf;
        fsleFieldToday = f1;
        fsleFieldPrev = f2;
      } catch {
        /* opcional: sin estos campos el motor sigue funcionando */
      }
      if (myRun !== runIdRef.current) return;

      interface CellEnv {
        tempC: number | null;
        speed: number | null;
        o2: number | null;
        salinity: number | null;
        tempFondo: number | null;
        corrFondo: number | null;
        oxigeno: number | null;
        frenteSalino: number | null;
        fsle: number;
        persistencia: number;
      }

      const envAt = (lat: number, lng: number): CellEnv => {
        const p = bottomFieldData?.sample(lat, lng) ?? null;
        const fsleNow = fsleFieldToday.proximity(lat, lng);
        const fslePrev = fsleFieldPrev.proximity(lat, lng);
        // Persistencia: el frente puntúa alto solo si TAMBIÉN estaba hace 2 días.
        const persistencia =
          fsleNow <= 0 && fslePrev <= 0 ? 0 : Math.min(fsleNow, fslePrev) * 0.7 + fsleNow * 0.3;
        return {
          tempC: p?.tempC ?? null,
          speed: p?.speed ?? null,
          o2: p?.o2 ?? null,
          salinity: p?.salinity ?? null,
          tempFondo: bottomTempFactor(p?.tempC ?? null, isSquid ? 14.5 : 15.5),
          corrFondo: bottomCurrentFactor(p?.speed ?? null),
          oxigeno: oxygenFactor(p?.o2 ?? null),
          frenteSalino:
            p?.salinity != null && bottomFieldData
              ? bottomFieldData.salinityFront(lat, lng)
              : null,
          fsle: fsleNow,
          persistencia: clamp01(persistencia),
        };
      };

      // ── Datos para el motor de DERIVA (fluixa) ──
      // Viento, ola y corriente superficial del área (una sola petición) +
      // geometría de costa cacheada a ~1 km para no repetir sondeos.
      let marine: MarineConditions = EMPTY_MARINE;
      if (isDrift) {
        onProgress?.("Leyendo viento, ola y corriente…");
        marine = await fetchMarineConditions(
          (south + north) / 2,
          (west + east) / 2,
          abortController.signal,
        ).catch(() => EMPTY_MARINE);
        if (myRun !== runIdRef.current) return;
      }
      const coastCache = new Map<string, CoastGeometry>();
      const coastAt = (lat: number, lng: number): CoastGeometry => {
        const k = `${lat.toFixed(2)}|${lng.toFixed(2)}`;
        const hit = coastCache.get(k);
        if (hit) return hit;
        const g = computeCoastGeometry(landMask, lat, lng, 6, 0.5);
        coastCache.set(k, g);
        return g;
      };

      onProgress?.("Puntuando celdas…");

      for (let r = 0; r < gridSide; r++) {
        for (let c = 0; c < gridSide; c++) {
          const cell = cells[idxOf(r, c)];
          if (!cell.inArea) continue;
          cellsAnalyzed++;

          // ─── BLOQUEO POR TIERRA / COSTA ───
          if (cell.isLand) {
            cellsLand++;
            continue;
          }
          // Filtro 500 m a costa solo en FONDO. En superficie no debe bloquear
          // el Top 1 si la celda ya tiene mar válido por la máscara principal.
          if (fishingMode === "bottom" && !isDrift && isCoastTooClose(cell.lat, cell.lng)) {
            cellsCoastal++;
            continue;
          }
          // Filtro estricto de profundidad: 0, NaN o positivos (tierra emergida)
          // ya están descartados por isLand; aquí solo someras < MIN_OCEAN_DEPTH.
          if (
            cell.depth != null &&
            (!Number.isFinite(cell.depth) || cell.depth < MIN_OCEAN_DEPTH)
          ) {
            cellsTooShallow++;
            continue;
          }
          if (cell.depth == null) {
            cellsNoData++;
          }

          const bF = computeBottomFactors(r, c);
          if (bF.hasBathy) {
            cellsWithDepth++;
            totalSlope += bF.slopeMperKm;
            maxSlopeDetected = Math.max(maxSlopeDetected, bF.slopeMperKm);
          }

          const sF = computeSurfaceFactors(cell.lat, cell.lng);
          // BathyEdge: compresión de isóbatas + transición + rugosidad,
          // derivado de la batimetría real de esta celda. Es el factor que
          // ancla el Top 1 a estructura física (talud, veril, cambios
          // rápidos de profundidad), no a artefactos del raster SST.
          sF.bathyEdge = bF.hasBathy
            ? clamp01(0.5 * bF.pendiente + 0.35 * bF.transicion + 0.15 * bF.rugosidad)
            : 0;
          totalSstGrad += sF.sstGradiente;
          if (sF.hasSst) cellsWithSst++;
          if (sF.hasChl) cellsWithChl++;
          if (sF.hasAlt) cellsWithAlt++;
          const surfaceLayersCount =
            (sF.hasSst ? 1 : 0) + (sF.hasChl ? 1 : 0) + (sF.hasAlt ? 1 : 0);

          // ──────────────────────────────────────────────────────────────
          //  RAMA "PESCA A FONDO" (V2, EMODnet real)
          // ──────────────────────────────────────────────────────────────
          // Pipeline dedicado: solo batimetría, ignora capas oceanográficas
          // de superficie. Devuelve estructura propia que luego se renderiza
          // con popup específico de fondo.
          if (fishingMode === "bottom") {
            if (!bF.hasBathy) continue;

            // Rango objetivo ajustado por estación (verano + profundo, invierno + somero).
            const adjMinDepth = seasonalRange.minDepth;
            const adjMaxDepth = seasonalRange.maxDepth;
            const inDepthRange =
              bF.depthM != null && bF.depthM >= adjMinDepth && bF.depthM <= adjMaxDepth;

            // Condiciones de fondo (T, corriente, O₂, salinidad) + FSLE +
            // persistencia, ya muestreadas para TODA la cuadrícula.
            const env = envAt(cell.lat, cell.lng);

            // Scoring PROGRESIVO (0–100, escala equilibrada) — sustituye el
            // todo-o-nada anterior. Las zonas planas reciben penalización
            // suave (−10) en lugar de ser descartadas, así devolvemos más
            // variedad y dejamos que las señales parciales buenas suban.
            const prog = computeBottomScoreProgressive({
              bF,
              sF,
              depthSource: cell.depthSource,
              minDepth: adjMinDepth,
              maxDepth: adjMaxDepth,
              env,
              target: isSquid ? "squid" : "bottom",
            });

            // ── MOTOR ESPECÍFICO DE CALAMAR ──
            // No reutiliza el motor de fondo: pondera T de fondo, corriente
            // moderada, fondo mixto arena–roca, luz lunar y crepúsculo.
            let squid: SquidBreakdown | null = null;
            if (isSquid) {
              squid = computeSquidScore({
                lat: cell.lat,
                lng: cell.lng,
                when: analysisDate,
                depthM: bF.depthM,
                bottomTempC: env.tempC,
                bottomSpeed: env.speed,
                roughnessM: bF.roughnessM,
                roughness5x5M: bF.roughness5x5M,
                slopeMperKm: bF.slopeMperKm,
                fsleProximity: env.fsle,
              });
              // El score de calamar manda; el de fondo entra solo como
              // soporte estructural (20 %).
              prog.score = Math.round(0.8 * squid.score + 0.2 * prog.score);
            }

            // ── MOTOR DE PESCA A LA DERIVA (FLUIXA) ──
            // Independiente por completo: sustituye el score, no lo mezcla.
            let drift: DriftBreakdown | null = null;
            if (isDrift) {
              const coast = coastAt(cell.lat, cell.lng);
              drift = computeDriftScore({
                lat: cell.lat,
                lng: cell.lng,
                depthM: bF.depthM,
                slopeMperKm: bF.slopeMperKm,
                roughnessM: bF.roughnessM,
                roughness5x5M: bF.roughness5x5M,
                curvatureMperKm2: bF.curvatureMperKm2,
                slopeBreakStrength: bF.slopeBreakStrength,
                sstGrad: sF.sstGradiente,
                chl: sF.chl,
                alt: sF.adt,
                fsleProximity: env.fsle,
                persistencia: env.persistencia,
                coast,
                marine,
                depthSource: cell.depthSource,
                surfaceLayers: surfaceLayersCount,
              });
              prog.score = drift.score;
            }

            // Métricas auxiliares aún se calculan con V2 para conservar
            // el desglose `contribs` que usa el popup técnico.
            const v2 = computeBottomScoreV2(
              bF.slopeMperKm,
              bF.roughnessM,
              bF.transitionM,
              bF.depthM,
              adjMinDepth,
              adjMaxDepth,
              bF.roughness5x5M,
              bF.curvatureMperKm2,
              bF.slopeBreakStrength,
              bottomWeights,
              bF.tpi3M,
              bF.tpi5M,
            );
            // Sobrescribimos el score de V2 con el progresivo (es el que
            // determina ranking, etiqueta de calidad y popup).
            v2.score = prog.score;

            const { reasons: baseReasons, main: baseMain } = buildBottomReasonsV2(
              bF.slopeMperKm,
              bF.roughnessM,
              bF.transitionM,
              bF.depthM,
              inDepthRange,
              bF.roughness5x5M,
              bF.curvatureMperKm2,
              bF.slopeBreakStrength,
              bF.reliefType,
            );
            // En calamar las razones del motor específico van primero.
            const engine = squid ?? drift;
            const reasons = engine
              ? [
                  ...engine.reasons.map((t) => t.charAt(0).toUpperCase() + t.slice(1)),
                  ...baseReasons,
                ]
              : baseReasons;
            const main = engine ? engine.main : baseMain;
            // Razones de condiciones de fondo comunes a fondo y calamar.
            if (!engine) {
              if (env.tempC != null)
                reasons.push(`T fondo ${env.tempC.toFixed(1)} °C en toda la celda`);
              if (env.speed != null)
                reasons.push(`Corriente de fondo ${(env.speed * 1.94384).toFixed(1)} kn`);
              if (env.o2 != null) reasons.push(`Oxígeno disuelto ${Math.round(env.o2)} mmol/m³`);
              if (env.frenteSalino != null && env.frenteSalino >= 0.5)
                reasons.push("Frente salino de fondo detectado");
              if (env.frenteSalino == null)
                reasons.push("Frente salino: sin datos de salinidad en este punto");
              if (env.persistencia >= 0.6) reasons.push("Frente persistente 2–3 días");
            }

            // Confianza de datos en modo Fondo (solo batimetría real):
            //   EMODnet (alta resolución, real) → "alta"
            //   GEBCO   (interpolada / global)  → "media"
            //   none    (sin dato)              → "baja"
            let confidence: ConfidenceLevel = "alta";
            if (cell.depthSource === "gebco") confidence = "media";
            else if (cell.depthSource === "none") confidence = "baja";

            // Buckets equilibrados (alineados con qualityFromScoreBottom):
            //   80–100 muy_alta · 65–79 alta · 50–64 media · 35–49 aceptable · <35 baja
            // Mantengo los nombres internos del enum existente para no romper
            // la UI, pero con umbrales más realistas.
            const rank: ScoreBreakdown["rank"] =
              prog.score >= 80
                ? "top"
                : prog.score >= 65
                  ? "muy_bueno"
                  : prog.score >= 50
                    ? "interesante"
                    : prog.score >= 35
                      ? "flojo"
                      : "sin_interes";

            const breakdown: ScoreBreakdown = {
              scoreFondo: prog.score,
              scoreSuperficie: 0,
              scoreTotal: prog.score,
              bonusSinergia: 0,
              penalizacion: Math.abs(prog.penalizaciones),
              reasons,
              rank,
              confidence,
              layersUsed: ["bathy"],
              layersMissing: [],
              componentScores: (() => {
                const base = computeComponentScores(sF, bF);
                const pct = (v?: number) =>
                  typeof v === "number" && Number.isFinite(v)
                    ? Math.max(0, Math.min(100, Math.round(v * 100)))
                    : undefined;
                const f = engine ? { ...prog.factors, ...engine.factors } : prog.factors;
                return {
                  ...base,
                  estructura: Math.round((prog.estructura / 30) * 100),
                  veril: Math.round((prog.veril / 25) * 100),
                  profundidadOk: Math.round((prog.profundidad / 20) * 100),
                  tempFondo: pct(f.tempFondo),
                  corrFondo: pct(f.corrFondo),
                  oxigeno: pct(f.oxigeno),
                  frenteSalino: pct(f.frenteSalino),
                  fsle: pct(f.fsle),
                  luna: pct(f.luna),
                  calidadDatos: drift
                    ? pct(f.calidadDatos)
                    : Math.round((prog.calidadDatos / 5) * 100),
                  ...(drift
                    ? {
                        deriva: pct(f.deriva),
                        abrigo: pct(f.abrigo),
                        oleaje: pct(f.oleaje),
                        punta: pct(f.punta),
                        canal: pct(f.canal),
                        distCosta: pct(f.distCosta),
                        persistencia: pct(f.persistencia),
                        sst: pct(f.sst),
                        chl: pct(f.chl),
                        alt: pct(f.altCorriente),
                        estructura: pct(f.estructura),
                        veril: pct(f.veril),
                        profundidadOk: pct(f.profundidad),
                      }
                    : {}),
                };
              })(),

              factorsSnapshot: engine ? engine.factors : prog.factors,
            };

            scored.push({
              r,
              c,
              lat: cell.lat,
              lng: cell.lng,
              bottom: bF,
              surface: sF,
              breakdown,
              depthSource: cell.depthSource,
              bottomV2: { ...v2, reasons, main, inDepthRange },
            });

            if (isDrift) {
              // La geometría del frente de deriva la manda FSLE. Las demás
              // variables solo puntúan qué tramo es el mejor; no crean otra línea.
              const driftFsleSnap = fsleFieldToday.nearestPoint(cell.lat, cell.lng);
              if (driftFsleSnap && driftFsleSnap.distanceNm <= 6) {
                driftCells.push({
                  row: r,
                  col: c,
                  lat: driftFsleSnap.lat,
                  lng: driftFsleSnap.lng,
                  score: prog.score,
                  depthM: bF.depthM,
                  sstGrad: clamp01(sF.sstGradiente),
                  chl: clamp01(sF.chl),
                  fsle: clamp01(
                    fsleFieldToday.proximity(driftFsleSnap.lat, driftFsleSnap.lng),
                  ),
                });
              }
            }

            if (debug) {
              console.log(
                `[BottomProg ${cell.lat.toFixed(3)},${cell.lng.toFixed(3)}] ` +
                  `depth=${bF.depthM?.toFixed(0)}m slope=${bF.slopeMperKm.toFixed(1)} ` +
                  `rough3=${bF.roughnessM.toFixed(1)} rough5=${bF.roughness5x5M.toFixed(1)} ` +
                  `type=${bF.reliefType} → score=${prog.score} ` +
                  `[est=${prog.estructura} ver=${prog.veril} prof=${prog.profundidad} ` +
                  `sup=${prog.superficie} cor=${prog.corrientes} dat=${prog.calidadDatos} ` +
                  `pen=${prog.penalizaciones}${prog.detallesPenalizacion.length ? ` (${prog.detallesPenalizacion.join(", ")})` : ""}] (${main})`,
              );
            }
            continue;
          }

          // ──────────────────────────────────────────────────────────────
          //  RAMA "PESCA A SUPERFICIE" (motor túnidos v4)
          // ──────────────────────────────────────────────────────────────
          // En superficie NO dejamos el array vacío por falta de gradiente/capa:
          // si hay mar válido, se crea candidato con baja confianza y luego la
          // validación puntual intenta rescatar SST/CHL/ALT por GetFeatureInfo.

          // ─── PESCA A SUPERFICIE — Top 1 por COINCIDENCIA DE GRADIENTES ───
          // Reglas del usuario:
          //  · Solo SST, CHL y Altimetría (ADT/SLA + corrientes geostróficas).
          //  · Se usa el GRADIENTE de cada capa, no el valor plano.
          //  · Pesos: ALT 40 % · SST 35 % · CHL 25 %.
          //  · Batimetría NO entra en el score. Solo se usa como filtro
          //    básico (tierra / agua imposible), que ya está aplicado
          //    arriba (isLand + isCoastTooClose + MIN_OCEAN_DEPTH).
          //  · Top 1 superficie ≠ Top 1 fondo (rama totalmente independiente).
          // Top 1 de superficie debe quedar sobre la MISMA cresta FSLE que
          // se dibuja en el mapa. Proyectamos cada candidato a la línea real;
          // si no hay FSLE en el área, no inventamos un punto.
          const fsleSnap = fsleFieldToday.nearestPoint(cell.lat, cell.lng);
          if (!fsleSnap || fsleSnap.distanceNm > 6) continue;
          const surfaceLat = fsleSnap.lat;
          const surfaceLng = fsleSnap.lng;
          const envS = envAt(surfaceLat, surfaceLng);
          const grad = computeSurfaceGradientScore(sF, envS.fsle, envS.persistencia);

          // Filtro batimétrico BÁSICO (no decide ranking, solo descarta
          // zonas imposibles para pesca de superficie real).
          let pen = 0;
          if (bF.hasBathy && bF.depthM != null) {
            if (bF.depthM < 30)
              pen += 25; // playa / orilla
            else if (bF.depthM > 3500) pen += 4; // muy abisal
          }
          // Seam de tile WMTS: el "gradiente" SST sería artefacto.
          if (sF.seamArtifact) pen += 12;
          // Mancha homogénea anti-falsos positivos (refuerzo del flatPenalty
          // interno: si SST plana y sin estructura local, no es frente).
          if (sF.hasSst && sF.localStructure < 0.2 && sF.sstGradiente < 0.2) {
            pen += 10;
          }
          pen = Math.max(0, Math.min(35, pen));

          // MEZCLA ÚNICA fondo/superficie (MIX_WEIGHTS.surface = 30/70).
          // El bloque de fondo aporta estructura + condiciones de fondo reales
          // (T, corriente, O₂) muestreadas en TODA la cuadrícula.
          const bottomBlockS = bF.hasBathy
            ? computeBottomScoreProgressive({
                bF,
                sF,
                depthSource: cell.depthSource,
                minDepth: seasonalRange.minDepth,
                maxDepth: seasonalRange.maxDepth,
                env: envS,
              }).score
            : null;
          const mixS = MIX_WEIGHTS.surface;
          const mixedSurface =
            bottomBlockS == null
              ? grad.score
              : grad.score * mixS.superficie + bottomBlockS * mixS.fondo;

          const finalScore = Math.max(0, Math.min(100, mixedSurface - pen));

          const rank: ScoreBreakdown["rank"] =
            finalScore >= 80
              ? "top"
              : finalScore >= 65
                ? "muy_bueno"
                : finalScore >= 50
                  ? "interesante"
                  : finalScore >= 35
                    ? "flojo"
                    : "sin_interes";

          // Confianza: si falta alguna capa, baja un escalón.
          let confidence = grad.confidence;
          if (grad.layersPresent < 3) {
            // Si hay batimetría y solo faltan 1 capa de superficie, dejamos
            // "media"; si faltan 2, baja a "baja".
            confidence = grad.layersPresent === 2 ? "media" : "baja";
          }

          const layersUsed: string[] = [];
          const layersMissing: string[] = [];
          if (bF.hasBathy) layersUsed.push("bathy");
          else layersMissing.push("bathy");
          if (sF.hasSst) layersUsed.push("sst");
          else layersMissing.push("sst");
          if (sF.hasChl) layersUsed.push("chl");
          else layersMissing.push("chl");
          if (sF.hasAlt) layersUsed.push("alt");
          else layersMissing.push("alt");

          const breakdown: ScoreBreakdown = {
            scoreFondo: 0,
            scoreSuperficie: grad.score,
            scoreTotal: Math.round(finalScore),
            bonusSinergia: 0,
            penalizacion: pen,
            reasons: [],
            rank,
            confidence,
            layersUsed,
            layersMissing,
            surfaceGradientMode: true,
            surfaceGradientDominant: grad.dominant,
            componentScores: computeComponentScores(sF, bF),
            factorsSnapshot: {
              sst: sF.hasSst ? clamp01(sF.sstGradiente) : 0,
              chl: sF.hasChl ? clamp01(sF.chl) : 0,
              alt: sF.hasAlt ? clamp01(Math.max(sF.adt, sF.corriente)) : 0,
              fsle: clamp01(envS.fsle),
            },
          };

          // Razones del Top 1 superficie: SIEMPRE explicación de gradientes.
          const dominantLabel: Record<"alt" | "sst" | "chl", string> = {
            alt: "altimetría",
            sst: "temperatura",
            chl: "clorofila",
          };
          const reasons: string[] = [
            "Top 1 ajustado sobre una cresta FSLE visible",
            "Top 1 elegido por coincidencia de gradientes de SST, CHL y altimetría",
          ];
          if (grad.score < 35 && sF.fallbackSignal > 0) {
            reasons.push("Fallback aplicado por señal disponible de SST, clorofila o altimetría");
          }
          if (grad.dominant) {
            reasons.push(`Gradiente dominante: ${dominantLabel[grad.dominant]}`);
          }
          if (sF.hasSst && sF.sstGradiente >= 0.35) reasons.push("∇ térmico marcado (frente SST)");
          if (sF.hasChl && sF.chl >= 0.35) reasons.push("borde de mancha de clorofila");
          if (sF.hasAlt && sF.corriente >= 0.35)
            reasons.push("borde de corriente / eddy (∇ altimetría)");
          if (grad.layersPresent < 3) {
            reasons.push(`Confianza reducida: ${grad.layersPresent}/3 capas disponibles`);
          }
          breakdown.reasons = reasons;

          scored.push({
            r,
            c,
            lat: surfaceLat,
            lng: surfaceLng,
            bottom: bF,
            surface: sF,
            breakdown,
            depthSource: cell.depthSource,
          });

          if (debug) {
            const fmt = (v: number, has: boolean) => (has ? v.toFixed(3) : "null");
            const altReasonLabel: Record<NonNullable<SurfaceFactors["altMissReason"]>, string> = {
              pane_no_tiles: "pane sin tiles cargados",
              off_screen: "punto fuera de viewport",
              no_coverage_nearby: "sin cobertura ADT en 32px",
              no_data_at_pixel: "sin dato exacto y sin pane sampleable",
            };

            console.log(
              `[Spot ${cell.lat.toFixed(3)},${cell.lng.toFixed(3)}] ` +
                `SST=${fmt(sF.sstGradiente, sF.hasSst)}(${sF.sstSource}) ` +
                `CHL=${fmt(sF.chl, sF.hasChl)}(${sF.chlSource}) ` +
                `ADT=${fmt(sF.adt, sF.hasAlt)}(${sF.altSource})` +
                (sF.hasAlt
                  ? ""
                  : ` [ADT miss: ${sF.altMissReason ? altReasonLabel[sF.altMissReason] : "desconocido"}]`),
            );
          }
        }
      }

      if (myRun !== runIdRef.current) return;

      onProgress?.("Seleccionando Top 1…");
      scored.forEach((s) => {
        s.breakdown.scoreTotal = safeScore100(s.breakdown.scoreTotal);
        s.breakdown.scoreSuperficie = safeScore100(s.breakdown.scoreSuperficie);
        s.breakdown.scoreFondo = safeScore100(s.breakdown.scoreFondo);
      });
      // 9) Ranking final + dedup espacial
      scored.sort((a, b) => {
        const byScore = b.breakdown.scoreTotal - a.breakdown.scoreTotal;
        if (byScore !== 0) return byScore;
        if (fishingMode !== "surface") return tieBreak(a, b);
        const rankDepth = (s: Scored) => {
          const d = s.bottom.depthM;
          if (d == null) return 3;
          if (d >= 50 && d <= 2000) return 0;
          if (d >= 30 && d < 50) return 1;
          return 2;
        };
        const byDepth = rankDepth(a) - rankDepth(b);
        return byDepth !== 0 ? byDepth : tieBreak(a, b);
      });

      // ─── CALIBRACIÓN: recall@5 vs catálogo de spots conocidos ───
      // Cuando debug=true en modo fondo, comparamos el Top 5 de candidatos
      // contra el catálogo manual de spots conocidos contenidos en el bbox
      // analizado. Si el área no contiene spots conocidos no imprimimos nada.
      if (debug && fishingMode === "bottom" && scored.length > 0) {
        try {
          const lats = scored.map((s) => s.lat);
          const lngs = scored.map((s) => s.lng);
          const bbox = {
            minLat: Math.min(...lats),
            maxLat: Math.max(...lats),
            minLng: Math.min(...lngs),
            maxLng: Math.max(...lngs),
          };
          const known = getKnownSpotsInBounds(bbox);
          if (known.length > 0) {
            const top5 = scored.slice(0, 5).map((s) => ({ lat: s.lat, lng: s.lng }));
            const r5 = evaluateRecallAtK(top5, known, 5, 5000);

            console.log(
              `[Calibración perfil=${bottomProfile} season=${seasonalRange.season}] ` +
                `Top5 vs ${known.length} spots conocidos en zona → ` +
                `recall@5=${(r5.recall * 100).toFixed(0)}% (${r5.matched}/${r5.total}) ` +
                `MRR=${r5.mrr.toFixed(2)}`,
            );
            if (r5.matches.length > 0) {
              console.log(
                "[Calibración matches]",
                r5.matches.map(
                  (m) => `${m.spot.name} → rank #${m.rank} (${(m.distM / 1000).toFixed(1)} km)`,
                ),
              );
            }
            const missed = known.filter((k) => !r5.matches.find((m) => m.spot.id === k.id));
            if (missed.length > 0) {
              console.log(
                "[Calibración missed]",
                missed.map((s) => `${s.name} (${s.structure}, ${s.depthMin}-${s.depthMax}m)`),
              );
            }
          }
        } catch (e) {
          console.warn("[Calibración] error evaluando recall@5:", e);
        }
      }

      // En modo fondo, máximo 5 spots y separación por DISTANCIA real (250 m).
      // En modo superficie mantenemos límites previos por celda.
      const limit =
        fishingMode === "bottom"
          ? 5
          : hotZoneOnly
            ? hotZoneMode === "explore"
              ? 5
              : 3
            : Math.min(maxSpots, 6);

      const minScorePct = Math.round(minScore * 100);
      const minSepCells = gridSide >= 12 ? 2 : 1;
      const MIN_SPOT_SEP_M = 250; // 200–300 m pedido por producto

      // En SUPERFICIE no hay mínimo duro: si hay mar válido debe salir Top 1,
      // aunque los gradientes sean débiles y se marque como baja confianza.
      const HARD_MIN_SURFACE = 25;
      // En SUPERFICIE: pool amplio y sin corte por profundidad/score.
      // Si hay mar válido, debe salir Top 1; la batimetría solo informa el popup.
      const preLimit = fishingMode === "surface" ? 60 : limit;
      const picked: Scored[] = [];

      // ─── SUPERFICIE: #2..#N agrupados con el Top 1 ─────────────────────
      // Tras escoger Top 1 (mejor scoreTotal), re-ordenamos los demás
      // candidatos con un "afinidad de cruce" que premia:
      //   · cercanía geográfica al Top 1 (decae con la distancia)
      //   · misma firma de gradientes (SST + coherencia + corriente/ADT)
      //   · mismo gradiente dominante
      // Así los puntos secundarios caen cerca del Top 1 sobre la misma
      // estructura oceanográfica, en lugar de dispersarse por todo el área.
      if (fishingMode === "surface" && scored.length > 0) {
        const top1 = scored.find((s) => isValidLatLng(s.lat, s.lng));
        if (top1) {
          picked.push(top1);
          const rest = scored.filter((s) => s !== top1 && isValidLatLng(s.lat, s.lng));
          // Ventana de proximidad: ~6 km (frente local), decae a 0 a 18 km.
          const NEAR_M = 6000;
          const FAR_M = 18000;
          const t1Dom = top1.breakdown.surfaceGradientDominant ?? null;
          const affinity = (s: Scored): number => {
            const distM = distanceMeters(top1.lat, top1.lng, s.lat, s.lng);
            const proxim =
              distM <= NEAR_M ? 1 : distM >= FAR_M ? 0 : 1 - (distM - NEAR_M) / (FAR_M - NEAR_M);
            // Coincidencia de cruce: SST + coherencia + (corriente o ADT).
            const sF = s.surface;
            const crossHit =
              (sF.hasSst ? Math.max(0, sF.sstGradiente - 0.2) : 0) +
              (sF.hasAlt ? Math.max(0, Math.max(sF.corriente, sF.adt) - 0.2) : 0) +
              (sF.hasSst && sF.hasAlt ? Math.max(0, sF.coherencia - 0.2) : 0);
            // Mismo gradiente dominante que Top 1 → pequeño extra.
            const domBonus = t1Dom && s.breakdown.surfaceGradientDominant === t1Dom ? 4 : 0;
            // Peso final: scoreTotal base + hasta +25 por proximidad·cruce + dom.
            return s.breakdown.scoreTotal + proxim * 18 + Math.min(10, crossHit * 12) + domBonus;
          };
          rest.sort((a, b) => affinity(b) - affinity(a));
          for (const s of rest) {
            let tooClose = false;
            for (const p of picked) {
              if (
                (p.r === s.r && p.c === s.c) ||
                distanceMeters(p.lat, p.lng, s.lat, s.lng) < 500
              ) {
                tooClose = true;
                break;
              }
            }
            if (tooClose) continue;
            picked.push(s);
            if (picked.length >= preLimit) break;
          }
        }
      } else {
        for (const s of scored) {
          if (!isValidLatLng(s.lat, s.lng)) {
            continue;
          }
          // En modo fondo mantenemos el filtro por minScorePct.
          if (fishingMode === "bottom" && s.breakdown.scoreTotal < minScorePct && picked.length > 0)
            continue;
          let tooClose = false;
          if (fishingMode === "bottom") {
            for (const p of picked) {
              if (distanceMeters(p.lat, p.lng, s.lat, s.lng) < MIN_SPOT_SEP_M) {
                tooClose = true;
                break;
              }
            }
          } else {
            for (const p of picked) {
              if (Math.abs(p.r - s.r) === 0 && Math.abs(p.c - s.c) === 0) {
                tooClose = true;
                break;
              }
            }
          }
          if (tooClose) continue;
          picked.push(s);
          if (picked.length >= preLimit) break;
        }
      }

      // Fallback HONESTO pre-validación: solo rescatamos `scored[0]` en modo
      // FONDO (donde el peor caso es un score modesto pero la zona sigue
      // teniendo estructura). En SUPERFICIE no rescatamos nada — un punto
      // somero (<50 m) o sin gradientes no es un TOP 1 útil; mejor que el
      // motor diga "sin zona clara" que llevar al usuario a arena.
      if (picked.length === 0 && scored.length > 0 && fishingMode === "bottom") {
        picked.push(scored[0]);
      }

      if (myRun !== runIdRef.current) return;

      // 9b) VALIDACIÓN UNIFICADA del candidato top — misma fuente que el popup.
      //
      // Para cada spot pre-seleccionado:
      //   1. Re-consulta SST/CHL/ALT vía GetFeatureInfo (el mismo endpoint que
      //      usa el popup del mapa). Si una capa tenía "sin dato" por raster
      //      (tile no pintada, opacidad 0, máscara) y GetFeatureInfo SÍ
      //      devuelve valor → la marcamos como disponible y rebajamos la
      //      penalización por "ALT ausente". Esto elimina la incongruencia
      //      "popup OK pero análisis dice sin dato".
      //   2. Re-consulta profundidad real EMODnet/GEBCO. Si en modo
      //      superficie la profundidad confirmada cae fuera de 800–2000 m,
      //      descartamos el spot — así un valor interpolado bicúbico de
      //      ~115 m no puede colarse junto a la isóbata de 1000 m.
      //
      // Solo validamos los TOP candidatos (≤ limit), no toda la grilla, para
      // mantener el coste a < 12 fetches por análisis.
      // Determinista: mismo área ⇒ mismo zoom de consulta (ver `fieldZoom`).
      const map_zoom = fieldZoom;
      const sstCfg = LAYER_CONFIGS.sst_nrt;
      const chlCfg = LAYER_CONFIGS.chl;
      const altCfg = LAYER_CONFIGS.alt_adt;
      // (la corriente de superficie ya no usa una capa escalar: se pide como
      //  vector uo/vo mediante fetchCopernicusCurrentVector)

      const sstTime = layerTimes?.sst_nrt ?? layerTimes?.sst_analysed;
      const chlTime = layerTimes?.chl ?? layerTimes?.chl_hc;
      const altTime = layerTimes?.alt_adt ?? layerTimes?.alt_combined ?? layerTimes?.alt_currents;
      const curTime = layerTimes?.alt_currents ?? altTime;

      const validatedPicked: Scored[] = [];
      const MAX_VALIDATIONS = fishingMode === "surface" ? 40 : picked.length;
      let validationsRun = 0;

      // En SUPERFICIE: pre-validación batimétrica solo informativa. No filtra:
      // si hay mar válido, Top 1 debe salir aunque falte profundidad numérica.
      let surfaceCandidates = picked;
      if (fishingMode === "surface" && picked.length > 0) {
        await Promise.all(
          picked.slice(0, 50).map(async (s) => {
            const d = await getDepthAtLatLng(s.lat, s.lng, abortController.signal);
            if (d.depth != null && Number.isFinite(d.depth)) {
              s.bottom.depthM = d.depth;
              s.bottom.hasBathy = true;
            }
          }),
        );
        surfaceCandidates = picked.filter((s) => isValidLatLng(s.lat, s.lng));
        // Re-ordenar por score para procesar primero los mejores.
        surfaceCandidates.sort((a, b) => b.breakdown.scoreTotal - a.breakdown.scoreTotal || tieBreak(a, b));

        console.log(
          `[FishingHotspots/surface] PRE-VALIDACIÓN: ${surfaceCandidates.length}/${Math.min(picked.length, 50)} candidatos con lat/lng válidos`,
        );
      }

      if (myRun !== runIdRef.current) return;

      for (const s of surfaceCandidates) {
        if (validationsRun >= MAX_VALIDATIONS) break;
        // Si en superficie ya tenemos `limit` candidatos validados, paramos.
        if (fishingMode === "surface" && validatedPicked.length >= limit) break;
        validationsRun++;
        // a) Lectura REAL por GetFeatureInfo de los 4 canales en la coordenada
        //    exacta del spot. Estos valores alimentan el popup ("por qué" +
        //    debug). Se hace SIEMPRE, no solo cuando la capa fallaba: así el
        //    texto del popup es específico de cada punto.
        s.surface.rawValues = s.surface.rawValues ?? {};
        const tasks: Promise<void>[] = [];
        if (sstCfg) {
          tasks.push(
            fetchCopernicusValue(
              sstCfg.wmtsLayer,
              sstCfg.style,
              s.lat,
              s.lng,
              map_zoom,
              sstTime,
              abortController.signal,
            ).then((r) => {
              if (r.value != null) {
                // Copernicus SST viene en °C — si llega en K (>200), lo pasamos.
                const v = r.value > 200 ? r.value - 273.15 : r.value;
                s.surface.rawValues!.sst = { value: v, units: "°C" };
                if (!s.surface.hasSst) {
                  s.surface.hasSst = true;
                  s.surface.sstSource = "exact";
                }
              }
            }),
          );
        }
        if (chlCfg) {
          tasks.push(
            fetchCopernicusValue(
              chlCfg.wmtsLayer,
              chlCfg.style,
              s.lat,
              s.lng,
              map_zoom,
              chlTime,
              abortController.signal,
            ).then((r) => {
              if (r.value != null) {
                s.surface.rawValues!.chl = { value: r.value, units: r.units ?? "mg/m³" };
                if (!s.surface.hasChl) {
                  s.surface.hasChl = true;
                  s.surface.chlSource = "exact";
                }
              }
            }),
          );
        }
        if (altCfg) {
          tasks.push(
            fetchCopernicusValue(
              altCfg.wmtsLayer,
              altCfg.style,
              s.lat,
              s.lng,
              map_zoom,
              altTime,
              abortController.signal,
            ).then((r) => {
              if (r.value != null) {
                s.surface.rawValues!.adt = { value: r.value, units: r.units ?? "m" };
                if (!s.surface.hasAlt) {
                  s.surface.hasAlt = true;
                  s.surface.altSource = "exact";
                  s.surface.altMissReason = null;
                }
              }
            }),
          );
        }
        // CORRIENTE DE SUPERFICIE — se calcula como MÓDULO √(uo²+vo²) a
        // partir de las componentes vectoriales reales, nunca leyendo un
        // canal escalar con signo (antes se leía `adt`, lo que producía
        // "velocidades" negativas y en realidad era altimetría, no corriente).
        {
          tasks.push(
            fetchCopernicusCurrentVector({
              lat: s.lat,
              lng: s.lng,
              zoom: map_zoom,
              time: curTime,
              depth: "surface",
              signal: abortController.signal,
            })
              .then((cv) => {
                if (cv && Number.isFinite(cv.speed)) {
                  s.surface.rawValues!.currentSpeed = {
                    value: Math.abs(cv.speed),
                    units: "m/s",
                  };
                  s.surface.rawValues!.currentDirDeg = cv.dirDeg;
                  if (!s.surface.hasAlt) {
                    s.surface.hasAlt = true;
                    s.surface.altSource = "exact";
                    s.surface.altMissReason = null;
                  }
                }
              })
              .catch(() => {
                /* silencioso: la corriente de superficie es opcional */
              }),
          );
        }

        // b) Re-validación de profundidad numérica REAL (EMODnet → GEBCO).
        tasks.push(
          getDepthAtLatLng(s.lat, s.lng, abortController.signal).then((d) => {
            if (d.depth != null && Number.isFinite(d.depth)) {
              s.bottom.depthM = d.depth;
              s.bottom.hasBathy = true;
            }
          }),
        );
        // b2) TERMOCLINA — solo para los 3 mejores candidatos en superficie.
        //     Cada llamada hace ~6 fetches (perfil vertical thetao), así que
        //     limitamos a top 3 para mantener el coste total acotado
        //     (≤18 fetches extra por análisis). Cacheado a granularidad ~5 km.
        if (fishingMode === "surface" && validatedPicked.length < 3) {
          tasks.push(
            fetchThermocline(s.lat, s.lng, sstTime, abortController.signal)
              .then((t) => {
                s.surface.thermoclineDepth = t.depth;
                s.surface.thermoclineGradient = t.gradient;
                s.surface.thermoclineStrength = t.strength;
              })
              .catch(() => {
                /* silencioso: la termoclina es opcional */
              }),
          );
        }
        // b2-bis) TERMOCLINA en modo FONDO — para los TOP candidatos también.
        //     En pesca de fondo el acoplamiento termoclina ↔ profundidad del
        //     fondo es clave: cuando la termoclina toca el fondo (típico en
        //     plataforma <150 m en verano), la concentración de O₂ y picnoclina
        //     activa al bentos demersal. La aplicamos como bonus post-fetch
        //     sobre `bottomV2.score`.
        if (
          fishingMode === "bottom" &&
          validatedPicked.length < 5 &&
          s.bottom.hasBathy &&
          s.bottom.depthM != null
        ) {
          tasks.push(
            fetchThermocline(s.lat, s.lng, sstTime, abortController.signal)
              .then((t) => {
                s.surface.thermoclineDepth = t.depth;
                s.surface.thermoclineGradient = t.gradient;
                s.surface.thermoclineStrength = t.strength;
              })
              .catch(() => {
                /* silencioso: la termoclina es opcional */
              }),
          );
        }
        // b2-ter) TEMPERATURA DE FONDO — para los TOP candidatos en modo Fondo.
        //     Consulta puntual al perfil thetao a la profundidad REAL del spot
        //     (ELEVATION = -depthM). 1 fetch extra por candidato. Se usa para
        //     bonificar el score (máx +15) cuando T encaja en la ventana
        //     biológica de la especie demersal típica del perfil batimétrico.
        if (
          fishingMode === "bottom" &&
          validatedPicked.length < 5 &&
          s.bottom.hasBathy &&
          s.bottom.depthM != null
        ) {
          const z = s.bottom.depthM;
          tasks.push(
            fetchTempAtDepth(s.lat, s.lng, z, sstTime, abortController.signal)
              .then((t) => {
                s.bottom.bottomTempC = t;
              })
              .catch(() => {
                /* silencioso: temp de fondo es opcional */
              }),
          );
        }
        // b2-quater) CORRIENTE DEL FONDO — para los TOP candidatos en modo
        //     Fondo/Calamar. Consulta puntual uo/vo del MEDSEA (4 km) a la
        //     profundidad más cercana al fondo real del spot. Alimenta el
        //     score (corrientes suaves suman, fuertes penalizan) y el popup.
        if (
          fishingMode === "bottom" &&
          validatedPicked.length < 5 &&
          s.bottom.hasBathy &&
          s.bottom.depthM != null
        ) {
          const z = s.bottom.depthM;
          tasks.push(
            fetchCopernicusCurrentVector({
              lat: s.lat,
              lng: s.lng,
              zoom: map_zoom,
              time: curTime,
              depth: "bottom",
              seafloorDepthM: z,
              signal: abortController.signal,
            })
              .then((cv) => {
                s.bottom.bottomCurrent = cv;
              })
              .catch(() => {
                /* silencioso: corriente de fondo es opcional */
              }),
          );
        }
        // b3) COMPONENTES VECTORIALES uo/vo + VORTICIDAD/DIVERGENCIA + PERSISTENCIA
        //     SST temporal — solo para los 3 mejores candidatos.
        //     Coste: 3 puntos × 2 componentes (u,v) = 6 fetches + 2 SST de
        //     días previos = 8 fetches extra por candidato (max 24 totales).
        if (fishingMode === "surface" && validatedPicked.length < 3) {
          const ugosCfg = LAYER_CONFIGS.alt_ugos;
          const vgosCfg = LAYER_CONFIGS.alt_vgos;
          const STEP_DEG = 0.06; // ~6.6 km, escala consistente con altimetría 1/8°
          const dx = STEP_DEG * 111320 * Math.cos((s.lat * Math.PI) / 180);
          const dy = STEP_DEG * 110540;
          const fetchUV = (lat: number, lng: number) =>
            Promise.all([
              fetchCopernicusValue(
                ugosCfg.wmtsLayer,
                ugosCfg.style,
                lat,
                lng,
                map_zoom,
                curTime,
                abortController.signal,
              ),
              fetchCopernicusValue(
                vgosCfg.wmtsLayer,
                vgosCfg.style,
                lat,
                lng,
                map_zoom,
                curTime,
                abortController.signal,
              ),
            ]).then(([u, v]) => ({ u: u.value, v: v.value }));
          tasks.push(
            (async () => {
              try {
                const [c, e, n] = await Promise.all([
                  fetchUV(s.lat, s.lng),
                  fetchUV(s.lat, s.lng + STEP_DEG),
                  fetchUV(s.lat + STEP_DEG, s.lng),
                ]);
                s.surface.currentU = c.u;
                s.surface.currentV = c.v;
                if (
                  c.u != null &&
                  c.v != null &&
                  e.u != null &&
                  e.v != null &&
                  n.u != null &&
                  n.v != null
                ) {
                  const dudx = (e.u - c.u) / dx;
                  const dvdx = (e.v - c.v) / dx;
                  const dudy = (n.u - c.u) / dy;
                  const dvdy = (n.v - c.v) / dy;
                  s.surface.currentVorticity = dvdx - dudy;
                  s.surface.currentDivergence = dudx + dvdy;
                  // Alineación corriente vs gradiente batimétrico:
                  // |cos θ| = 1 → corriente paralela al veril (poca interacción)
                  // |cos θ| = 0 → corriente cruza isóbatas (compresión, frente)
                  // Usamos slope vector aproximado por bF (no tenemos componentes
                  // cartesianos directos, derivamos uno simple a partir de la
                  // pendiente y orientación local del talud).
                  if (s.bottom.hasBathy && s.bottom.slopeMperKm > 0) {
                    const speed = Math.hypot(c.u, c.v);
                    if (speed > 1e-3) {
                      // Aproximamos dirección del gradiente batimétrico con el
                      // mismo offset N/E: diferencia de profundidad. Sin acceso
                      // directo aquí, usamos la magnitud relativa de slope para
                      // ponderar — si slope alto y speed alto, asumimos cruce.
                      // Cálculo conservador: cross factor proporcional a la
                      // descorrelación entre dirección dominante y eje N–S.
                      const ang = Math.atan2(c.v, c.u);
                      // Si el eje principal de la pendiente es desconocido,
                      // usamos sin² del ángulo respecto al eje E como proxy:
                      // valor neutro 0.5; lo dejamos como factor leve.
                      s.surface.currentBathyCross = clamp01(Math.abs(Math.sin(ang)));
                      void speed;
                    } else {
                      s.surface.currentBathyCross = 0;
                    }
                  }
                }
              } catch {
                /* silencioso */
              }
            })(),
          );
          // Persistencia temporal SST: muestreamos D-1 y D-3 en el centro.
          if (sstCfg && sstTime) {
            const shiftDay = (iso: string, days: number) => {
              const base = new Date(iso.slice(0, 10) + "T00:00:00Z");
              base.setUTCDate(base.getUTCDate() + days);
              return base.toISOString().slice(0, 10);
            };
            const d1 = shiftDay(sstTime, -1);
            const d3 = shiftDay(sstTime, -3);
            tasks.push(
              (async () => {
                try {
                  const [r1, r3] = await Promise.all([
                    fetchCopernicusValue(
                      sstCfg.wmtsLayer,
                      sstCfg.style,
                      s.lat,
                      s.lng,
                      map_zoom,
                      d1,
                      abortController.signal,
                    ),
                    fetchCopernicusValue(
                      sstCfg.wmtsLayer,
                      sstCfg.style,
                      s.lat,
                      s.lng,
                      map_zoom,
                      d3,
                      abortController.signal,
                    ),
                  ]);
                  const today = s.surface.rawValues?.sst?.value;
                  const toCelsius = (x: number | null) =>
                    x == null ? null : x > 200 ? x - 273.15 : x;
                  const v1 = toCelsius(r1.value);
                  const v3 = toCelsius(r3.value);
                  if (today != null && v1 != null && v3 != null) {
                    // Desviación máxima vs el valor actual — si el frente es
                    // real, el valor en este punto se mantiene parecido día a
                    // día (±0.5 °C). Si oscila >1.5 °C, era ruido / nube.
                    const dev = Math.max(Math.abs(today - v1), Math.abs(today - v3));
                    s.surface.sstPersistence = clamp01(1 - dev / 1.5);
                  }
                } catch {
                  /* silencioso */
                }
              })(),
            );
          }
        }
        await Promise.all(tasks);

        if (myRun !== runIdRef.current) return;
        if (fishingMode === "surface") refreshSurfaceFallbackFromRawValues(s.surface);

        // ─── ACOPLAMIENTO TERMOCLINA ↔ FONDO (modo "Pesca a fondo") ───
        // Bonus físico: cuando la base de la termoclina queda cerca del fondo,
        // se forma una capa de mezcla activa con O₂ y zooplancton acumulado
        // sobre el sustrato → demersales en alimentación. Solo aplica si:
        //   - tenemos profundidad real (s.bottom.depthM)
        //   - tenemos termoclina confirmada y NO débil
        //   - estamos en plataforma o veril (z ≤ 250 m); en abisal la
        //     termoclina no llega al fondo (irrelevante).
        if (
          fishingMode === "bottom" &&
          s.bottom.hasBathy &&
          s.bottom.depthM != null &&
          s.surface.thermoclineDepth != null &&
          s.surface.thermoclineStrength &&
          s.surface.thermoclineStrength !== "débil" &&
          s.bottomV2
        ) {
          const z = s.bottom.depthM;
          const td = s.surface.thermoclineDepth;
          let bonus = 0;
          let why = "";
          if (z <= 250) {
            const gap = z - td; // m de columna entre base termoclina y fondo
            if (gap >= -10 && gap <= 30) {
              bonus = 8; // termoclina prácticamente sobre el fondo → ideal
              why = `termoclina pegada al fondo (gap ${gap.toFixed(0)} m)`;
            } else if (gap > 30 && gap <= 60) {
              bonus = 4; // capa intermedia razonable
              why = `termoclina próxima al fondo (gap ${gap.toFixed(0)} m)`;
            } else if (gap < -10 && gap >= -40) {
              // termoclina más profunda que el fondo (columna mezclada)
              bonus = 2;
              why = "columna mezclada hasta el fondo";
            }
          } else if (z <= 600) {
            // Veril: si la termoclina está en zona alta (15–45 m) y el fondo
            // está a ~200–500 m, se forma la "capa de dispersión profunda"
            // sobre el quiebre → buena pesca de demersales de talud.
            if (td >= 15 && td <= 45) {
              bonus = 3;
              why = `termoclina somera sobre veril (TD ${td.toFixed(0)} m)`;
            }
          }
          if (bonus > 0) {
            const newScore = Math.min(100, s.bottomV2.score + bonus);
            s.bottomV2.score = newScore;
            s.breakdown.scoreFondo = newScore;
            s.breakdown.scoreTotal = newScore;
            s.bottomV2.reasons = [why, ...s.bottomV2.reasons];
            // Recalcular rank tras el bonus
            s.breakdown.rank =
              newScore >= 85
                ? "top"
                : newScore >= 70
                  ? "muy_bueno"
                  : newScore >= 55
                    ? "interesante"
                    : newScore >= 40
                      ? "flojo"
                      : "sin_interes";
            if (debug) {
              console.log(
                `[BottomV2 thermo-coupling ${s.lat.toFixed(3)},${s.lng.toFixed(3)}] ` +
                  `z=${z.toFixed(0)}m TD=${td.toFixed(0)}m strength=${s.surface.thermoclineStrength} ` +
                  `+${bonus} → score=${newScore} (${why})`,
              );
            }
          }
        }

        // ─── BONUS POR TEMPERATURA DE FONDO (modo "Pesca a fondo") ───
        // Premio máximo +15 puntos cuando la temperatura del agua a la
        // profundidad real del spot encaja en la ventana biológica típica
        // de la especie demersal del perfil:
        //   - plataforma (<200 m): ~15 °C ideal (espáridos, jureles).
        //   - talud (200–800 m): ~13 °C (besugo, pageles, brótolas).
        //   - abisal (>800 m): Med ≈ 13 °C constante; ventana muy estrecha.
        // Curva continua tipo "tienda" centrada en el óptimo, capada al peso
        // máximo configurado (15 puntos = 15 % del score total).
        if (
          fishingMode === "bottom" &&
          s.bottom.hasBathy &&
          s.bottom.depthM != null &&
          s.bottom.bottomTempC != null &&
          s.bottomV2
        ) {
          const z = s.bottom.depthM;
          const tC = s.bottom.bottomTempC;
          // Calamar (Loligo): más sensible a T de fondo — mayor peso, ventana
          // biológica ~14 °C. Fondo genérico: pesos por perfil batimétrico.
          const MAX_BONUS = isSquid ? 22 : 15;
          let optC = 13,
            halfIdeal = 1.5,
            halfOk = 3.5;
          if (isSquid) {
            optC = 14;
            halfIdeal = 1.2;
            halfOk = 3;
          } else if (z < 200) {
            optC = 15;
            halfIdeal = 2;
            halfOk = 4;
          } else if (z < 800) {
            optC = 13;
            halfIdeal = 1.5;
            halfOk = 3.5;
          } else {
            optC = 13;
            halfIdeal = 0.8;
            halfOk = 2;
          }
          const dev = Math.abs(tC - optC);
          let factor = 0;
          if (dev <= halfIdeal) factor = 1;
          else if (dev <= halfOk) factor = 1 - (dev - halfIdeal) / (halfOk - halfIdeal);
          const tempBonus = Math.round(MAX_BONUS * factor);
          if (tempBonus > 0) {
            const newScore = Math.min(100, s.bottomV2.score + tempBonus);
            s.bottomV2.score = newScore;
            s.breakdown.scoreFondo = newScore;
            s.breakdown.scoreTotal = newScore;
            const why =
              factor >= 0.95
                ? `T fondo ideal (${tC.toFixed(1)} °C a ${z.toFixed(0)} m)`
                : `T fondo favorable (${tC.toFixed(1)} °C a ${z.toFixed(0)} m)`;
            s.bottomV2.reasons = [why, ...s.bottomV2.reasons];
            s.breakdown.reasons = [why, ...s.breakdown.reasons];
            s.breakdown.rank =
              newScore >= 85
                ? "top"
                : newScore >= 70
                  ? "muy_bueno"
                  : newScore >= 55
                    ? "interesante"
                    : newScore >= 40
                      ? "flojo"
                      : "sin_interes";
            if (debug) {
              console.log(
                `[BottomV2 bottom-temp ${s.lat.toFixed(3)},${s.lng.toFixed(3)}] ` +
                  `z=${z.toFixed(0)}m T=${tC.toFixed(2)}°C opt=${optC}±${halfIdeal}/${halfOk} ` +
                  `+${tempBonus} → score=${newScore}`,
              );
            }
          } else if (debug) {
            console.log(
              `[BottomV2 bottom-temp ${s.lat.toFixed(3)},${s.lng.toFixed(3)}] ` +
                `z=${z.toFixed(0)}m T=${tC.toFixed(2)}°C fuera de ventana (opt=${optC}±${halfOk}) — sin bonus`,
            );
          }
        }

        // ─── AJUSTE POR CORRIENTE DEL FONDO (modo Fondo / Calamar) ───
        // Datos REALES del modelo físico MEDSEA (uo/vo) a la profundidad
        // más cercana al fondo del punto. No se extrapola desde superficie.
        //   - Corriente suave (0.05–0.25 m/s): bonus (pesca cómoda, cebo
        //     natural sobre el veril).
        //   - Moderada (0.25–0.45 m/s): neutro.
        //   - Fuerte (>0.6 m/s): penalización (dificulta plomada / calar).
        // El calamar (isSquid) es más sensible: mismos rangos con pesos +50%
        // porque la corriente del fondo condiciona directamente su caza y
        // la presentación de la potera.
        if (
          fishingMode === "bottom" &&
          s.bottom.bottomCurrent != null &&
          Number.isFinite(s.bottom.bottomCurrent.speed) &&
          s.bottomV2
        ) {
          const spd = s.bottom.bottomCurrent.speed;
          const dirDeg = s.bottom.bottomCurrent.dirDeg;
          const usedDepth = s.bottom.bottomCurrent.depth;
          let delta = 0;
          let why = "";
          const w = isSquid ? 1.5 : 1;
          const cur = formatCurrent(spd, dirDeg);
          if (spd < 0.03) {
            delta = Math.round(-6 * w);
            why = `Corriente de fondo prácticamente nula (${cur}) — agua parada, presentación pobre`;
          } else if (spd < 0.08) {
            delta = Math.round(-3 * w);
            why = `Corriente de fondo muy débil (${cur}) — apenas mueve el cebo`;
          } else if (spd <= 0.25) {
            delta = Math.round(10 * w);
            why = `Corriente de fondo suave (${cur}) — óptima`;
          } else if (spd <= 0.45) {
            delta = Math.round(4 * w);
            why = `Corriente de fondo moderada (${cur})`;
          } else if (spd <= 0.6) {
            delta = Math.round(-4 * w);
            why = `Corriente de fondo fuerte (${cur}) — dificulta plomada`;
          } else {
            delta = Math.round(-10 * w);
            why = `Corriente de fondo muy fuerte (${cur}) — impracticable`;
          }

          if (delta !== 0) {
            const newScore = Math.max(0, Math.min(100, s.bottomV2.score + delta));
            s.bottomV2.score = newScore;
            s.breakdown.scoreFondo = newScore;
            s.breakdown.scoreTotal = newScore;
            const label = `${why} (${currentDepthLabel(usedDepth)})`;
            s.bottomV2.reasons = [label, ...s.bottomV2.reasons];
            s.breakdown.reasons = [label, ...s.breakdown.reasons];
            s.breakdown.rank =
              newScore >= 85
                ? "top"
                : newScore >= 70
                  ? "muy_bueno"
                  : newScore >= 55
                    ? "interesante"
                    : newScore >= 40
                      ? "flojo"
                      : "sin_interes";
            if (debug) {
              console.log(
                `[BottomV2 bottom-current ${s.lat.toFixed(3)},${s.lng.toFixed(3)}] ` +
                  `spd=${spd.toFixed(2)}m/s dir=${dirDeg.toFixed(0)}° depth=${currentDepthLabel(usedDepth)} ` +
                  `Δ=${delta} → score=${newScore}`,
              );
            }
          }
        }

        // c) En modo FONDO conservamos el scoring progresivo ya calculado.
        // El bloque siguiente recalcula con la fórmula antigua de superficie+
        // fondo y podía degradar un cabezo/veril bueno o favorecer un punto
        // pobre tras la validación puntual.
        if (fishingMode === "bottom") {
          const depthLo = isSquid ? minDepth * 0.5 : minDepth;
          const depthHi = isSquid ? maxDepth * 1.5 : maxDepth;
          const minScoreOk = isSquid || isDrift ? 15 : 25;
          const depthOk =
            s.bottom.hasBathy &&
            s.bottom.depthM != null &&
            s.bottom.depthM >= depthLo &&
            s.bottom.depthM <= depthHi;
          if (depthOk && s.breakdown.scoreTotal >= minScoreOk) {
            validatedPicked.push(s);
          }
          continue;
        }

        if (!isValidLatLng(s.lat, s.lng)) {
          console.warn("[FishingHotspots/Top1] candidato descartado por lat/lng inválido", s);
          continue;
        }

        // d) Recalcular score con las capas confirmadas por GetFeatureInfo.
        //    Solo tocamos hasSst/hasChl/hasAlt: los gradientes locales no
        //    cambian (siguen viniendo del raster). Si una capa antes daba
        //    "sin dato" y ahora hay valor confirmado, eliminamos su
        //    penalización y subimos surfaceLayersCount → el score sube
        //    proporcionalmente.
        const newSurfaceLayersCount =
          (s.surface.hasSst ? 1 : 0) + (s.surface.hasChl ? 1 : 0) + (s.surface.hasAlt ? 1 : 0);

        // ─── SUPERFICIE: recálculo con motor de gradientes ───
        if (fishingMode === "surface") {
          const fsleNow = fsleFieldToday.proximity(s.lat, s.lng);
          const fslePrev = fsleFieldPrev.proximity(s.lat, s.lng);
          const fslePersistence =
            fsleNow <= 0 && fslePrev <= 0
              ? 0
              : Math.min(fsleNow, fslePrev) * 0.7 + fsleNow * 0.3;
          const grad2 = computeSurfaceGradientScore(s.surface, fsleNow, fslePersistence);
          let pen2 = 0;
          if (s.bottom.hasBathy && s.bottom.depthM != null) {
            if (s.bottom.depthM < 30) pen2 += 25;
            else if (s.bottom.depthM > 3500) pen2 += 4;
          }
          if (s.surface.seamArtifact) pen2 += 12;
          if (s.surface.hasSst && s.surface.localStructure < 0.2 && s.surface.sstGradiente < 0.2) {
            pen2 += 10;
          }
          pen2 = Math.max(0, Math.min(35, pen2));

          const finalScore2 = Math.max(0, Math.min(100, grad2.score - pen2));
          const rank2: ScoreBreakdown["rank"] =
            finalScore2 >= 80
              ? "top"
              : finalScore2 >= 65
                ? "muy_bueno"
                : finalScore2 >= 50
                  ? "interesante"
                  : finalScore2 >= 35
                    ? "flojo"
                    : "sin_interes";

          let confidence2 = grad2.confidence;
          if (grad2.layersPresent < 3) {
            confidence2 = grad2.layersPresent === 2 ? "media" : "baja";
          }

          const layersUsed2: string[] = [];
          const layersMissing2: string[] = [];
          if (s.bottom.hasBathy) layersUsed2.push("bathy");
          else layersMissing2.push("bathy");
          if (s.surface.hasSst) layersUsed2.push("sst");
          else layersMissing2.push("sst");
          if (s.surface.hasChl) layersUsed2.push("chl");
          else layersMissing2.push("chl");
          if (s.surface.hasAlt) layersUsed2.push("alt");
          else layersMissing2.push("alt");

          const dominantLabel2: Record<"alt" | "sst" | "chl", string> = {
            alt: "altimetría",
            sst: "temperatura",
            chl: "clorofila",
          };
          const reasons2: string[] = [
            "Top 1 confirmado sobre una cresta FSLE visible",
            "Top 1 elegido por coincidencia de gradientes de SST, CHL y altimetría",
          ];
          if (grad2.score < 35 && s.surface.fallbackSignal > 0) {
            reasons2.push("Fallback aplicado por señal disponible de SST, clorofila o altimetría");
          }
          if (grad2.dominant)
            reasons2.push(`Gradiente dominante: ${dominantLabel2[grad2.dominant]}`);
          if (s.surface.hasSst && s.surface.sstGradiente >= 0.35)
            reasons2.push("∇ térmico marcado (frente SST)");
          if (s.surface.hasChl && s.surface.chl >= 0.35)
            reasons2.push("borde de mancha de clorofila");
          if (s.surface.hasAlt && s.surface.corriente >= 0.35)
            reasons2.push("borde de corriente / eddy (∇ altimetría)");
          if (grad2.layersPresent < 3) {
            reasons2.push(`Confianza reducida: ${grad2.layersPresent}/3 capas disponibles`);
          }

          s.breakdown = {
            scoreFondo: 0,
            scoreSuperficie: grad2.score,
            scoreTotal: Math.round(finalScore2),
            bonusSinergia: 0,
            penalizacion: pen2,
            reasons: reasons2,
            rank: rank2,
            confidence: confidence2,
            layersUsed: layersUsed2,
            layersMissing: layersMissing2,
            surfaceGradientMode: true,
            surfaceGradientDominant: grad2.dominant,
            componentScores: computeComponentScores(s.surface, s.bottom),
          };
        } else {
          const scoreSup2 = computeSurfaceFromFactors(s.surface);
          const scoreFondo2 = computeBottomFromFactors(s.bottom);
          let pen2 = 0;
          const hasAnyGrad =
            s.surface.sstGradiente >= 0.2 || s.surface.chl >= 0.2 || s.surface.corriente >= 0.2;
          if (newSurfaceLayersCount >= 1 && !hasAnyGrad) pen2 += 8;
          if (s.surface.hasSst && s.surface.sstGradiente < 0.15) pen2 += 6;
          if (s.surface.hasAlt && s.surface.corriente < 0.15) pen2 += 5;
          if (s.surface.hasChl && s.surface.chl < 0.1) pen2 += 5;
          if (newSurfaceLayersCount >= 2 && s.surface.coherencia < 0.2) pen2 += 4;
          if (s.bottom.hasBathy) {
            if (s.bottom.depthM != null && s.bottom.depthM < 8) pen2 += 8;
            if (s.bottom.consistencia < 0.15 && s.bottom.pendiente > 0.7) pen2 += 5;
          }
          pen2 = Math.max(-22, Math.min(40, pen2));

          const breakdown2 = combineScores(
            scoreFondo2,
            scoreSup2,
            fishingMode,
            pen2,
            s.bottom.hasBathy,
            newSurfaceLayersCount,
            s.surface,
          );
          if (!s.surface.hasSst) breakdown2.layersMissing.push("sst");
          else breakdown2.layersUsed.push("sst");
          if (!s.surface.hasChl) breakdown2.layersMissing.push("chl");
          else breakdown2.layersUsed.push("chl");
          if (!s.surface.hasAlt) breakdown2.layersMissing.push("alt");
          else breakdown2.layersUsed.push("alt");
          breakdown2.reasons = buildReasons(
            s.bottom,
            s.surface,
            breakdown2.scoreFondo,
            breakdown2.scoreSuperficie,
            breakdown2.bonusSinergia,
            fishingMode,
          );
          breakdown2.componentScores = computeComponentScores(s.surface, s.bottom);
          s.breakdown = breakdown2;
        }

        // e) Top 1 de superficie solo es válido con datos oceanográficos
        // suficientes y a ≤500 m de la cresta FSLE. Las capas se activan
        // automáticamente; si sus datos no llegan, se muestra "sin zona clara".
        if (fishingMode === "surface") {
          const fsleDistanceNm = fsleFieldToday.distanceNm(s.lat, s.lng);
          const fsleDistanceM = fsleDistanceNm == null ? null : fsleDistanceNm * 1852;
          if (
            newSurfaceLayersCount < 2 ||
            fsleDistanceM == null ||
            fsleDistanceM > 500 ||
            s.breakdown.scoreTotal < HARD_MIN_SURFACE
          ) {
            continue;
          }
        }
        validatedPicked.push(s);
      }

      validatedPicked.forEach((s) => {
        s.breakdown.scoreTotal = safeScore100(s.breakdown.scoreTotal);
        s.breakdown.scoreSuperficie = safeScore100(s.breakdown.scoreSuperficie);
        s.breakdown.scoreFondo = safeScore100(s.breakdown.scoreFondo);
      });
      // Re-ordenar por el score post-validación (puede haber cambiado).
      validatedPicked.sort((a, b) => b.breakdown.scoreTotal - a.breakdown.scoreTotal || tieBreak(a, b));
      // Recortar al `limit` final tras haber ampliado el pool en superficie.
      if (validatedPicked.length > limit) validatedPicked.length = limit;

      // Diagnóstico SIEMPRE activo en superficie (para entender por qué no sale TOP 1).
      if (fishingMode === "surface") {
        const scoredDepths = scored.slice(0, 30).map((s) => ({
          score: s.breakdown.scoreTotal,
          depth: s.bottom.depthM,
          hasBathy: s.bottom.hasBathy,
        }));
        const deepCount = scored.filter(
          (s) =>
            s.bottom.hasBathy &&
            s.bottom.depthM != null &&
            s.bottom.depthM >= 50 &&
            s.bottom.depthM <= 2000,
        ).length;
        const unknownDepth = scored.filter(
          (s) => !s.bottom.hasBathy || s.bottom.depthM == null,
        ).length;

        console.log(
          `[FishingHotspots/surface] scored=${scored.length} pickedPool=${picked.length} validated=${validatedPicked.length} ` +
            `inRange50-2000=${deepCount} unknownDepth=${unknownDepth} HARD_MIN=${HARD_MIN_SURFACE}`,
        );

        console.log(`[FishingHotspots/surface] top30 scored:`, scoredDepths);
      }
      // Fallback HONESTO: si la validación post-fetch descartó todos los
      // candidatos, NO inventamos un TOP 1. Mejor mostrar "sin zona clara"
      // que llevar al usuario a un punto somero/sin estructura con score 0.
      // En modo fondo, solo rescatamos un candidato si CUMPLE el rango de
      // profundidad y tiene score mínimo (>= 25); en superficie, jamás.
      if (validatedPicked.length === 0 && fishingMode === "bottom") {
        const pool = picked.length > 0 ? picked : scored;
        const depthLo = isSquid ? minDepth * 0.5 : minDepth;
        const depthHi = isSquid ? maxDepth * 1.5 : maxDepth;
        const minScoreOk = isSquid || isDrift ? 15 : 25;
        let rescue = pool.find(
          (s) =>
            s.bottom.hasBathy &&
            s.bottom.depthM != null &&
            s.bottom.depthM >= depthLo &&
            s.bottom.depthM <= depthHi &&
            s.breakdown.scoreTotal >= minScoreOk,
        );
        // Calamar: red de seguridad final — preferimos mostrar el mejor
        // candidato disponible (aunque caiga fuera del rango ideal) antes
        // que dejar al usuario sin TOP 1 cuando ha definido una zona.
        if (!rescue && isSquid) {
          rescue = pool.find((s) => isValidLatLng(s.lat, s.lng));
        }
        if (rescue) validatedPicked.push(rescue);
      }
      const finalMinScore = isSquid || isDrift ? 0 : 25;
      const finalPicked = validatedPicked.filter((s) =>
        fishingMode === "surface"
          ? isValidLatLng(s.lat, s.lng)
          : s.breakdown.scoreTotal >= finalMinScore && isValidLatLng(s.lat, s.lng),
      );
      picked.length = 0;
      picked.push(...finalPicked);

      if (myRun !== runIdRef.current) return;
      clearAll();

      // ── MODO DERIVA: el resultado es un CORREDOR, no un punto ──
      // Extraemos los 3 mejores tramos continuos de frente y los pintamos
      // como líneas con inicio/fin, flechas de deriva y ficha completa.
      if (isDrift) {
        const corridors: DriftCorridor[] = buildDriftCorridors(driftCells, {
          env: {
            currentSpeedMs: marine.currentSpeedMs,
            currentDirDeg: marine.currentDirDeg,
            windKn: marine.windKn,
            windFromDeg: marine.windFromDeg,
          },
          // FRENTE 1 debe recorrer exactamente una cresta FSLE visible.
          // Corriente + viento siguen mandando solo la dirección de deriva.
          snapToFront: (point) => {
            const snap = fsleFieldToday.nearestPoint(point.lat, point.lng);
            return snap && snap.distanceNm <= 6 ? { lat: snap.lat, lng: snap.lng } : null;
          },
          max: 3,
        });
        // Valores reales (T superficie y clorofila) en el centro de cada frente.
        await Promise.all(
          corridors.map(async (co) => {
            try {
              const [sstR, chlR] = await Promise.all([
                sstCfg
                  ? fetchCopernicusValue(
                      sstCfg.wmtsLayer,
                      sstCfg.style,
                      co.center.lat,
                      co.center.lng,
                      map_zoom,
                      sstTime,
                      abortController.signal,
                    )
                  : Promise.resolve(null),
                chlCfg
                  ? fetchCopernicusValue(
                      chlCfg.wmtsLayer,
                      chlCfg.style,
                      co.center.lat,
                      co.center.lng,
                      map_zoom,
                      chlTime,
                      abortController.signal,
                    )
                  : Promise.resolve(null),
              ]);
              if (sstR?.value != null && Number.isFinite(sstR.value)) {
                co.sstC = sstR.value > 200 ? sstR.value - 273.15 : sstR.value;
              }
              if (chlR?.value != null && Number.isFinite(chlR.value)) co.chlMg = chlR.value;
            } catch {
              /* sin dato puntual: el popup muestra el índice normalizado */
            }
          }),
        );
        if (myRun !== runIdRef.current) return;
        corridorLayersRef.current = renderDriftCorridors(map, corridors, {
          paneName: PANE_NAME,
          windKn: marine.windKn,
          gustKn: marine.gustKn,
          windFromDeg: marine.windFromDeg,
          currentSpeedMs: marine.currentSpeedMs,
          currentDirDeg: marine.currentDirDeg,
          onSaveWaypoint: (lat, lng, score, depth, reason, name) =>
            onSaveWaypointRef.current?.(lat, lng, score, depth, reason, name),
        });
      }

      picked.forEach((s, i) => {
        // En deriva el resultado visible es la línea del frente, no el punto.
        if (isDrift) return;
        const rank = i + 1;
        const score = s.breakdown.scoreTotal;
        const sizePx = i === 0 ? 44 : 34;

        // Color por clase de ranking
        const colorByRank: Record<ScoreBreakdown["rank"], string> = {
          top: "#16a34a",
          muy_bueno: "#0ea5e9",
          interesante: "#f59e0b",
          flojo: "#94a3b8",
          sin_interes: "#64748b",
        };
        const accent = i === 0 ? "#f59e0b" : colorByRank[s.breakdown.rank];
        const halo = i === 0 ? "rgba(245,158,11,0.30)" : "rgba(56,189,248,0.20)";

        const html = `
        <div style="position:relative;width:${sizePx}px;height:${sizePx}px;display:flex;align-items:center;justify-content:center;">
          <div style="position:absolute;inset:0;border-radius:9999px;background:radial-gradient(circle,${halo} 0%, transparent 72%);"></div>
          <div style="position:absolute;top:-8px;left:50%;transform:translateX(-50%);padding:1px 6px;border-radius:9999px;background:${accent};color:#fff;font:700 10px/1 ui-sans-serif,system-ui;box-shadow:0 2px 8px rgba(0,0,0,0.35);white-space:nowrap;">${i === 0 ? "TOP 1" : `#${rank}`}</div>
          <div style="position:relative;width:${Math.round(sizePx * 0.62)}px;height:${Math.round(sizePx * 0.62)}px;border-radius:9999px;background:${accent};border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:${i === 0 ? 12 : 11}px;">${score}</div>
        </div>`;
        const icon = L.divIcon({
          className: `fishing-hotspot-rank fishing-hotspot-rank-${rank}`,
          html,
          iconSize: [sizePx, sizePx],
          iconAnchor: [sizePx / 2, sizePx / 2],
        });
        const marker = L.marker([s.lat, s.lng], {
          icon,
          pane: PANE_NAME,
          zIndexOffset: 1000 - i * 50,
        }).addTo(map);

        const dmsLat = _toDMS(s.lat, "lat");
        const dmsLng = _toDMS(s.lng, "lng");

        // Ventana objetivo según modo
        const winMin = fishingMode === "surface" ? 50 : minDepth;
        const winMax = fishingMode === "surface" ? 2000 : maxDepth;
        const raw = s.surface.rawValues ?? {};

        // Formateadores que replican el popup de doble click del mapa
        // (Temp / Clor / Nivel / Corr) → mismas unidades y precisión.
        const fmtTemp = (v?: { value: number; units?: string }) => {
          if (!v || !Number.isFinite(v.value)) return null;
          const c = v.units === "kelvin" || v.value > 200 ? v.value - 273.15 : v.value;
          return `${c.toFixed(2)} °C`;
        };
        const fmtChl = (v?: { value: number; units?: string }) =>
          v && Number.isFinite(v.value) ? `${v.value.toFixed(4)} mg/m³` : null;
        // ADT = topografía dinámica ABSOLUTA (m). No es la anomalía (SLA).
        const fmtAdt = (v?: { value: number; units?: string }) =>
          v && Number.isFinite(v.value)
            ? `${v.value.toFixed(3).replace(".", ",")} m`
            : null;
        // Corriente: SIEMPRE módulo positivo + rumbo + punto cardinal.
        const fmtCurr = (v?: { value: number; units?: string }, dir?: number | null) =>
          v && Number.isFinite(v.value) ? formatCurrent(v.value, dir) : null;

        const tempStr = fmtTemp(raw.sst);
        const chlStr = fmtChl(raw.chl);
        const altStr = fmtAdt(raw.adt);
        const currStr = fmtCurr(raw.currentSpeed, raw.currentDirDeg);
        const currQual =
          raw.currentSpeed && Number.isFinite(raw.currentSpeed.value)
            ? currentStrengthLabel(raw.currentSpeed.value)
            : null;

        // Datos REALES del fondo (solo modo Fondo/Calamar): temperatura y
        // corriente a la profundidad más cercana al fondo. No extrapolados.
        const bTempC = s.bottom.bottomTempC;
        const bCurr = s.bottom.bottomCurrent;
        const bTempStr =
          fishingMode === "bottom" && typeof bTempC === "number" && Number.isFinite(bTempC)
            ? `${bTempC.toFixed(1)} °C`
            : null;
        const bCurrStr =
          fishingMode === "bottom" && bCurr && Number.isFinite(bCurr.speed)
            ? `${formatCurrent(bCurr.speed, bCurr.dirDeg)} · ${currentStrengthLabel(bCurr.speed)} (${currentDepthLabel(bCurr.depth)})`
            : null;
        // (el frente salino se muestra en el desglose de scores, con
        //  "Sin datos" explícito cuando el modelo no aporta salinidad)



        const row2 = (label: string, value: string) =>
          `<div style="display:flex;justify-content:space-between;gap:4px;font-size:10px;"><span style="color:var(--muted-foreground);">${label}</span><span style="font-weight:600;color:var(--foreground);">${value}</span></div>`;

        const rowsHtml = [
          tempStr ? row2("Temp.", tempStr) : "",
          chlStr ? row2("Clor.", chlStr) : "",
          altStr ? row2("ADT (topografía dinámica)", altStr) : "",
          currStr ? row2("Corr. superficie", `${currStr} · ${currQual}`) : "",
          bTempStr ? row2("🌡 T fondo", bTempStr) : "",
          bCurrStr ? row2("🌊 Corr. fondo", bCurrStr) : "",
          "",
        ].join("");


        // 🕒 Edad del dato — calcula horas desde la fecha más antigua usada.
        // Avisa si el dato Copernicus tiene >48 h (el frente puede haberse
        // desplazado varias millas) o si SST viene sin valor (posible nube).
        const layerDates = [
          layerTimes?.sst_analysed ?? layerTimes?.sst_nrt,
          layerTimes?.chl ?? layerTimes?.chl_hc,
          layerTimes?.alt_combined ?? layerTimes?.alt_adt ?? layerTimes?.alt_currents,
        ].filter((d): d is string => !!d);
        let ageHtml = "";
        if (layerDates.length > 0) {
          const oldestMs = Math.min(
            ...layerDates.map((d) => {
              const iso = d.includes("T") ? d : `${d.slice(0, 10)}T12:00:00Z`;
              const t = Date.parse(iso);
              return Number.isFinite(t) ? t : Date.now();
            }),
          );
          const hours = Math.max(0, Math.round((Date.now() - oldestMs) / 3600000));
          const stale = hours > 48;
          const veryStale = hours > 96;
          const ageLabel = hours < 36 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} días`;
          const ageColor = veryStale ? "#dc2626" : stale ? "#f59e0b" : "var(--muted-foreground)";
          const warn = stale
            ? `<div style="margin-top:3px;font-size:9px;color:${ageColor};font-weight:600;">⚠ Frente puede haberse desplazado · usa sonda al llegar</div>`
            : "";
          ageHtml = `<div style="margin-top:4px;display:flex;justify-content:space-between;gap:4px;font-size:9px;"><span style="color:var(--muted-foreground);">Dato Copernicus</span><span style="font-weight:700;color:${ageColor};">${ageLabel}</span></div>${warn}`;
        }
        // ☁ Aviso de posible nube si TOP 1 no tiene SST cruda.
        const cloudHtml =
          i === 0 && !tempStr
            ? `<div style="margin-top:3px;font-size:9px;color:#f59e0b;font-weight:600;">☁ Sin SST en este punto (posible nube) · confianza reducida</div>`
            : "";

        const bodyHtml =
          (rowsHtml ||
            `<div style="font-size:10px;color:var(--muted-foreground);">Sin datos</div>`) +
          ageHtml +
          cloudHtml;

        // Etiqueta superior: "TOP 1" para el #1, "#N" para el resto, con score.
        const headerLabel = i === 0 ? "TOP 1" : `#${rank}`;

        // Sección extra exclusiva del TOP 1: "Por qué es TOP 1"
        let whyHtml = "";
        if (i === 0) {
          const whyLines = buildWhyExplanation({
            bF: s.bottom,
            sF: s.surface,
            bottom: {
              depthM: s.bottom.depthM,
              slopeMperKm: s.bottom.slopeMperKm,
              roughnessM: s.bottom.roughnessM,
            },
            depthSource: s.depthSource,
            confidence: s.breakdown.confidence,
            bonusSinergia: s.breakdown.bonusSinergia,
            scoreTotal: s.breakdown.scoreTotal,
            mode: fishingMode === "bottom" ? "bottom" : "surface",
            minDepth: winMin,
            maxDepth: winMax,
            surfaceGradientMode: s.breakdown.surfaceGradientMode,
            surfaceGradientDominant: s.breakdown.surfaceGradientDominant,
          });
          if (whyLines.length > 0) {
            whyHtml = `<div style="margin-top:5px;border-top:1px solid var(--border);padding-top:4px;">
              <div style="margin-bottom:3px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);">Por qué es TOP 1</div>
              <div style="font-size:10px;line-height:1.3;color:var(--foreground);">${whyLines.map((l) => `• ${l}`).join("<br/>")}</div>
            </div>`;
          }
        }

        // Desglose de sub-scores por capa (siempre visible cuando hay datos).
        // Sirve para diagnosticar qué variable limita la puntuación final.
        const cs = s.breakdown.componentScores;
        let scoresHtml = "";
        if (cs) {
          const colorFor = (v: number) =>
            v >= 70 ? "#16a34a" : v >= 50 ? "#0ea5e9" : v >= 30 ? "#f59e0b" : "#94a3b8";
          const row = (label: string, v?: number) =>
            typeof v === "number"
              ? `<div style="display:flex;justify-content:space-between;gap:4px;font-size:10px;"><span style="color:var(--muted-foreground);">${label}</span><span style="font-weight:700;color:${colorFor(v)};">${v}/100</span></div>`
              : "";
          const isBottomLike =
            !isDrift && (fishingMode === "bottom" || fishingModeRaw === "squid");
          const rows = (
            isDrift
              ? [
                  row("Veril costero", cs.veril),
                  row("Estructura", cs.estructura),
                  row("Profundidad", cs.profundidadOk),
                  row("Punta / cabo", cs.punta),
                  row("Canal / depresión", cs.canal),
                  row("Deriva", cs.deriva),
                  row("Abrigo del viento", cs.abrigo),
                  row("Oleaje", cs.oleaje),
                  row("FSLE", cs.fsle),
                  row("SST", cs.sst),
                  row("Clorofila", cs.chl),
                  row("Corriente sup.", cs.alt),
                  row("Distancia a costa", cs.distCosta),
                  row("Persistencia", cs.persistencia),
                  row("Calidad datos", cs.calidadDatos),
                ]
              : isBottomLike
              ? [
                  row("Estructura", cs.estructura),
                  row("Veril/pendiente", cs.veril),
                  row("Profundidad", cs.profundidadOk),
                  row("T fondo", cs.tempFondo),
                  row("Corr. fondo", cs.corrFondo),
                  row("Oxígeno", cs.oxigeno),
                  typeof cs.frenteSalino === "number"
                    ? row("Frente salino", cs.frenteSalino)
                    : `<div style="display:flex;justify-content:space-between;gap:4px;font-size:10px;"><span style="color:var(--muted-foreground);">Frente salino</span><span style="font-weight:600;color:var(--muted-foreground);">Sin datos</span></div>`,

                  row("FSLE", cs.fsle),
                  row("Luna", cs.luna),
                  row("Batimetría", cs.bathy),
                  row("Calidad datos", cs.calidadDatos),
                ]
              : [
                  row("SST", cs.sst),
                  row("Clorofila", cs.chl),
                  row("Altimetría", cs.alt),
                  row("Corriente", cs.current),
                  row("Batimetría", cs.bathy),
                ]
          )
            .filter(Boolean)
            .join("");

          if (rows) {
            scoresHtml = `<div style="margin-top:5px;border-top:1px solid var(--border);padding-top:4px;">
              <div style="margin-bottom:3px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);">Desglose de scores</div>
              <div style="display:flex;flex-direction:column;gap:2px;">${rows}</div>
              <div style="display:flex;justify-content:space-between;margin-top:4px;border-top:1px dashed var(--border);padding-top:3px;font-size:10px;"><span style="font-weight:700;color:var(--foreground);">Score final</span><span style="font-weight:800;color:var(--foreground);">${score}/100</span></div>
            </div>`;
          }
        }

        marker.bindPopup(
          `<div class="font-body" style="min-width:150px;max-width:220px;font-size:10px;line-height:1.2;">
          <div style="margin-bottom:4px;display:flex;align-items:baseline;justify-content:space-between;gap:6px;">
            <span style="font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);">${headerLabel}</span>
            <span style="font-size:10px;font-weight:700;color:var(--foreground);">${score}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px;">${bodyHtml}</div>
          ${scoresHtml}
          <div style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px;font-family:ui-monospace,monospace;font-size:9px;line-height:1.2;color:var(--muted-foreground);">
            <div>${dmsLat}</div>
            <div>${dmsLng}</div>
          </div>
          ${whyHtml}
          ${
            i === 0
              ? `<div style="margin-top:5px;border-top:1px solid var(--border);padding-top:4px;font-size:9px;line-height:1.3;color:var(--muted-foreground);">Zona estimada por modelos oceanográficos; comprueba las condiciones reales en el mar.</div>`
              : ""
          }

          <button data-save-wp="1" style="margin-top:6px;width:100%;padding:5px;font-size:10px;font-weight:700;border:1px solid #dc2626;background:#fee2e2;color:#dc2626;border-radius:4px;cursor:pointer;">📌 Guardar como waypoint</button>
          <div style="margin-top:6px;border-top:1px solid var(--border);padding-top:5px;">
            <div style="margin-bottom:3px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);">¿Qué tal fue?</div>
            <div style="display:flex;gap:4px;">
              <button data-catch="good" style="flex:1;padding:5px;font-size:10px;font-weight:700;border:1px solid #16a34a;background:#dcfce7;color:#166534;border-radius:4px;cursor:pointer;">🎣 Buena captura</button>
              <button data-catch="bad" style="flex:1;padding:5px;font-size:10px;font-weight:700;border:1px solid #94a3b8;background:#f1f5f9;color:#475569;border-radius:4px;cursor:pointer;">✖ Sin resultado</button>
            </div>
            <div data-catch-msg style="margin-top:3px;font-size:9px;color:var(--muted-foreground);"></div>
          </div>
        </div>`,
          { maxWidth: 220, minWidth: 150, className: "compact-popup", autoPan: false },
        );
        // Wire del botón "Guardar waypoint" — usa el ref para llamar a la
        // versión más reciente del callback sin re-disparar el análisis.
        const spotLat = s.lat;
        const spotLng = s.lng;
        const spotScore = s.breakdown.scoreTotal / 100;
        const spotDepth = s.bottom.depthM;
        const spotReason = s.breakdown.reasons.join(" · ");
        const defaultName = i === 0 ? "Top 1" : `Spot #${rank}`;
        const spotFactors = s.breakdown.factorsSnapshot ?? {};
        const modeKey: FishingModeKey =
          fishingModeRaw === "squid" ? "squid" : isDrift ? "drift" : fishingMode;
        marker.on("popupopen", (ev) => {
          const el = (ev as L.PopupEvent).popup.getElement();
          const btn = el?.querySelector<HTMLButtonElement>("[data-save-wp]");
          if (btn) {
            btn.onclick = () => {
              onSaveWaypointRef.current?.(
                spotLat,
                spotLng,
                spotScore,
                spotDepth,
                spotReason,
                defaultName,
              );
              btn.textContent = "✅ Waypoint guardado";
              btn.disabled = true;
              btn.style.opacity = "0.6";
              btn.style.cursor = "default";
            };
          }

          // ── Aprendizaje adaptativo: informe de captura ──
          const msg = el?.querySelector<HTMLDivElement>("[data-catch-msg]");
          el?.querySelectorAll<HTMLButtonElement>("[data-catch]").forEach((b) => {
            b.onclick = async () => {
              const outcome = b.dataset.catch === "good" ? "good" : "bad";
              b.disabled = true;
              if (msg) msg.textContent = "Guardando…";
              try {
                const { supabase } = await import("@/integrations/supabase/client");
                const { data: sess } = await supabase.auth.getSession();
                if (!sess.session) {
                  if (msg)
                    msg.textContent = "Inicia sesión para que la app aprenda de tus capturas.";
                  b.disabled = false;
                  return;
                }
                await saveCatchReport({
                  data: {
                    lat: spotLat,
                    lng: spotLng,
                    mode: modeKey,
                    outcome,
                    scoreSnapshot: s.breakdown.scoreTotal,
                    factors: spotFactors,
                  },
                });
                const res = await recomputeLearnedWeights({ data: { mode: modeKey } });
                setLearnedWeights(modeKey, res.trained ? res.weights : null, res.nSamples);
                if (msg) {
                  msg.textContent = res.trained
                    ? `Aprendido con ${res.nSamples} informes ✔`
                    : `Registrado (${res.nSamples}/8 informes para empezar a aprender)`;
                }
              } catch {
                if (msg) msg.textContent = "Inicia sesión para que la app aprenda de tus capturas.";
                b.disabled = false;
              }
            };
          });
        });
        markersRef.current.push(marker);
      });

      // 11) DEBUG grid
      if (debug) {
        for (const s of scored) {
          const lat = s.lat;
          const lng = s.lng;
          const halfLat = stepLat / 2;
          const halfLng = stepLng / 2;
          const sc = s.breakdown.scoreTotal / 100;
          const hue = Math.round((1 - sc) * 240);
          const rect = L.rectangle(
            L.latLngBounds([lat - halfLat, lng - halfLng], [lat + halfLat, lng + halfLng]),
            {
              pane: PANE_NAME,
              color: `hsl(${hue},90%,50%)`,
              weight: 0.4,
              opacity: 0.5,
              fillColor: `hsl(${hue},90%,50%)`,
              fillOpacity: Math.min(0.45, sc * 0.5),
              interactive: false,
            },
          ).addTo(map);
          debugLayersRef.current.push(rect);
        }
      }

      // 12) Output — RANKING FINAL cruzando las 4 capas (SST, CHL, ALT, BAT).
      // `picked` ya viene ordenado por scoreTotal desc en el paso de selección.
      // Aquí asignamos rank 1..N para que la UI pueda destacar Top 1/2/3.
      const orderedPicked = picked
        .slice()
        .sort((a, b) => b.breakdown.scoreTotal - a.breakdown.scoreTotal || tieBreak(a, b));
      const cleanSpots: FishingSpot[] = orderedPicked.map((s, i) => {
        const raw = s.surface.rawValues ?? {};
        const curMs = raw.currentSpeed?.value;
        return {
          id: `spot-${i}-${s.lat.toFixed(4)}-${s.lng.toFixed(4)}`,
          lat: s.lat,
          lng: s.lng,
          score: s.breakdown.scoreTotal / 100,
          depth: s.bottom.depthM,
          reason: s.breakdown.reasons.join(" · "),
          rank: i + 1,
          sstC: raw.sst?.value ?? null,
          chlMgM3: raw.chl?.value ?? null,
          adtM: raw.adt?.value ?? null,
          currentKn:
            curMs != null && Number.isFinite(curMs) ? curMs * 1.94384 : null,
          bottomTempC: s.bottom.bottomTempC ?? null,
        };
      });

      onSpotsChange?.(cleanSpots, []);

      // 13) Mensaje contextual — INFORMATIVO, no bloqueante.
      //     Solo se considera "sin resultado útil" si realmente NO hay
      //     ninguna fuente de datos. En cualquier otro caso describimos
      //     qué se usó y qué faltó.
      let noResultReason: string | undefined;
      const best = picked[0];
      const totalCellsInArea = cells.filter((c) => c.inArea).length;
      const bathyCoverage = totalCellsInArea > 0 ? cellsWithDepth / totalCellsInArea : 0;
      const avgSlope = cellsWithDepth > 0 ? totalSlope / cellsWithDepth : 0;
      const avgSst = cellsAnalyzed > 0 ? totalSstGrad / cellsAnalyzed : 0;

      // ─── Mensajería específica de "Pesca a fondo" ───
      // En modo fondo NO usamos vocabulario de superficie (zona caliente,
      // sin clorofila, sin anomalía térmica…). Solo hablamos de estructura.
      //
      // FUENTE de batimetría — orden de prioridad EMODnet → GEBCO → ninguna.
      // El análisis NUNCA se bloquea por falta de EMODnet: si hay GEBCO se
      // usa con resolución limitada; si no hay nada numérico, seguimos con
      // superficie y avisamos suavemente.
      let nEmoCells = 0;
      let nGebCells = 0;
      for (const c of cells) {
        if (!c.inArea || c.depth == null) continue;
        if (c.depthSource === "emodnet") nEmoCells++;
        else if (c.depthSource === "gebco") nGebCells++;
      }
      const visualBathymetryLoaded = !!map
        .getContainer()
        .querySelector(".ocean-pane-bathy img.leaflet-tile-loaded");
      const numericDepthAvailable = sampledDepthValid >= 3 || cellsWithDepth >= 3;
      const hasEmo = sampledEmodnet >= 3 || nEmoCells >= 3;
      const hasGeb = !hasEmo && (sampledGebco >= 3 || nGebCells >= 3);
      const bathyTag = hasEmo
        ? "batimetría fina EMODnet"
        : hasGeb
          ? "batimetría global GEBCO (resolución limitada)"
          : numericDepthAvailable
            ? "batimetría parcial"
            : visualBathymetryLoaded
              ? "batimetría visual cargada, sin profundidad numérica"
              : "sin batimetría numérica";

      if (fishingMode === "bottom") {
        const landRatio = cellsAnalyzed > 0 ? cellsLand / cellsAnalyzed : 0;
        const shallowRatio = cellsAnalyzed > 0 ? cellsTooShallow / cellsAnalyzed : 0;
        if (best) {
          // Mensaje positivo — reflejando la fuente REAL usada.
          if (hasEmo) {
            noResultReason = "Zona de fondo interesante detectada con EMODnet";
          } else if (hasGeb) {
            noResultReason =
              "Zona de fondo interesante detectada con batimetría global GEBCO (resolución limitada)";
          } else if (numericDepthAvailable) {
            noResultReason = "Zona de fondo detectada con batimetría parcial";
          } else {
            noResultReason = "Análisis parcial: batimetría visual, resolución limitada";
          }
        } else if (cellsAnalyzed > 0 && landRatio >= 0.9) {
          noResultReason =
            "La zona seleccionada es prácticamente toda tierra; desplaza la búsqueda a mar abierto";
        } else if (cellsAnalyzed > 0 && landRatio >= 0.6) {
          noResultReason = "Más de la mitad del polígono es tierra — desplázalo hacia mar abierto";
        } else if (cellsAnalyzed > 0 && shallowRatio >= 0.8) {
          noResultReason = "Aguas muy someras — prueba a mover el polígono hacia mar más profundo";
        } else if (cellsDeadBottom > 0 && scored.length === 0) {
          // Hay batimetría (la que sea) pero el fondo es plano y sin relieve.
          noResultReason = `Sin estructura clara de fondo en esta área (${bathyTag})`;
        } else if (!numericDepthAvailable && !hasSurfaceData) {
          // Ni batimetría numérica ni superficie — único caso realmente "ciego".
          // (la capa visual de batimetría puede estar pintada en el mapa,
          // pero NO sirve para el cálculo numérico de slope/rugosidad).
          noResultReason = visualBathymetryLoaded
            ? "Análisis parcial: batimetría visual, resolución limitada"
            : "Sin profundidad numérica EMODnet/GEBCO en esta zona; análisis basado solo en superficie";
        } else if (!numericDepthAvailable) {
          noResultReason = hasGeb
            ? "Análisis con batimetría global / resolución limitada"
            : visualBathymetryLoaded
              ? "Análisis parcial: batimetría visual, resolución limitada"
              : "Análisis parcial: sin batimetría numérica suficiente; usando superficie";
        } else {
          noResultReason = `Sin estructura clara de fondo en esta área (${bathyTag})`;
        }
      } else if (!best) {
        const landRatio = cellsAnalyzed > 0 ? cellsLand / cellsAnalyzed : 0;
        const shallowRatio = cellsAnalyzed > 0 ? cellsTooShallow / cellsAnalyzed : 0;
        const noDataRatio = cellsAnalyzed > 0 ? cellsNoData / cellsAnalyzed : 0;
        void cellsCoastal; // ya no se usa para clasificar (legacy v5)

        // Caso "candidatos descartados por umbral mínimo": hubo celdas
        // analizadas y con datos, pero ninguna superó el corte (25/100 en
        // superficie). Mensaje honesto en vez de un TOP 1 engañoso.
        const hadCandidates = scored.length > 0;
        if (fishingMode === "surface" && hadCandidates && cellsAnalyzed > 0 && landRatio < 0.6) {
          noResultReason = "Sin zona clara hoy en la ventana 50–2000 m";
        } else if (cellsAnalyzed > 0 && landRatio >= 0.9) {
          noResultReason =
            "sin punto válido — la zona seleccionada es prácticamente toda tierra; desplaza la búsqueda a mar abierto";
        } else if (cellsAnalyzed > 0 && landRatio >= 0.6) {
          noResultReason =
            "más de la mitad del polígono es tierra — desplázalo hacia mar abierto para mejorar el análisis";
        } else if (cellsAnalyzed > 0 && shallowRatio >= 0.8 && landRatio < 0.3) {
          noResultReason =
            "zona de aguas muy someras — análisis parcial, prueba a mover el polígono hacia mar más profundo";
        } else if (noDataRatio >= 0.9 && cellsWithDepth === 0 && !hasSurfaceData) {
          noResultReason =
            "sin datos de superficie ni batimetría numérica en esta zona; prueba otra área";
        } else if (cellsWithDepth < 3 && !hasSurfaceData) {
          noResultReason = "sin datos de superficie en esta zona; activa SST o clorofila";
        } else if (cellsWithDepth < 3) {
          // En superficie esto NO es bloqueante — la batimetría visible del
          // mapa sigue ahí, solo nos falta el dato numérico para el bonus.
          noResultReason = hasGeb
            ? "análisis con SST/clorofila + batimetría global GEBCO"
            : "análisis basado en superficie (la batimetría visible es solo referencia visual)";
        } else if (!hasSurfaceData) {
          noResultReason =
            "resultado calculado solo con batimetría; activa SST/clorofila/altimetría para enriquecer";
        } else {
          noResultReason = "señales muy débiles en toda el área marina";
        }
      } else if (best.breakdown.scoreTotal < 40) {
        const conf = best.breakdown.confidence;
        // Construir un detalle EXPLÍCITO por capa: SST OK · CHL sin dato …
        // Esto sustituye el antiguo "resultado parcial con sst+chl" que
        // confundía al usuario porque no decía qué faltaba realmente.
        const layerDetail =
          `SST ${cellsWithSst > 0 ? "OK" : "sin dato"} · ` +
          `CHL ${cellsWithChl > 0 ? "OK" : "sin dato"} · ` +
          `ALT ${cellsWithAlt > 0 ? "OK" : "sin dato"} · ` +
          `BAT ${numericDepthAvailable ? (hasEmo ? "EMODnet" : hasGeb ? "GEBCO" : "OK") : "sin dato"}`;
        if (avgSlope < 3 && avgSst < 0.05) {
          noResultReason = `fondo homogéneo y gradientes débiles · ${layerDetail}`;
        } else if (best.breakdown.scoreFondo >= 50 && best.breakdown.scoreSuperficie < 30) {
          noResultReason = `estructura correcta, apoyo oceanográfico débil · ${layerDetail}`;
        } else if (best.breakdown.scoreSuperficie >= 50 && best.breakdown.scoreFondo < 30) {
          noResultReason = `señal de superficie sin estructura de fondo · ${layerDetail}`;
        } else {
          noResultReason = `confianza ${conf} · ${layerDetail}`;
        }
      } else if (best.breakdown.confidence === "parcial" || best.breakdown.confidence === "baja") {
        const layerDetail =
          `SST ${cellsWithSst > 0 ? "OK" : "sin dato"} · ` +
          `CHL ${cellsWithChl > 0 ? "OK" : "sin dato"} · ` +
          `ALT ${cellsWithAlt > 0 ? "OK" : "sin dato"} · ` +
          `BAT ${numericDepthAvailable ? (hasEmo ? "EMODnet" : hasGeb ? "GEBCO" : "OK") : "sin dato"}`;
        noResultReason = `confianza ${best.breakdown.confidence} · ${layerDetail}`;
      }
      // Mantenemos bathyCoverage por si se quiere usar más adelante
      void bathyCoverage;

      // Resumen de fuentes de batimetría usadas en esta corrida (para el
      // indicador UI). Solo cuentan celdas que respondieron con depth real.
      const bathySources = cells
        .filter((c) => c.inArea && c.depth != null)
        .map((c) => ({ source: c.depthSource }));
      const numericSourcesSummary = summarizeSources(bathySources);
      const sourcesSummary = numericDepthAvailable
        ? numericSourcesSummary
        : visualBathymetryLoaded
          ? {
              label: "análisis parcial: batimetría visual, resolución limitada",
              source: "none" as const,
            }
          : numericSourcesSummary;
      if (debug) {
        console.log(
          `[BottomAnalysis] muestreados=${depthSampleTargets.length} válidos=${cellsWithDepth} ` +
            `fuente=${sourcesSummary.source} ` +
            `depthValidSamples=${sampledDepthValid} ` +
            (sampledDepthValid > 0
              ? `depthMin=${sampledDepthMin.toFixed(0)}m depthMax=${sampledDepthMax.toFixed(0)}m depthMean=${(sampledDepthSum / sampledDepthValid).toFixed(0)}m `
              : "") +
            `slopeMax=${maxSlopeDetected.toFixed(1)} m/km`,
        );
      }

      const summaryPayload = {
        cellsAnalyzed: cells.filter((c) => c.inArea).length,
        maxScore: best ? best.breakdown.scoreTotal / 100 : 0,
        bestCluster: best
          ? {
              lat: best.lat,
              lng: best.lng,
              score: best.breakdown.scoreTotal / 100,
              cells: 1,
            }
          : null,
        insideArea: !!searchArea,
        mode: fishingMode,
        noResultReason,
        bathymetrySource: sourcesSummary.source,
        bathymetryLabel: sourcesSummary.label,
        layerStatus: {
          sst: (cellsWithSst > 0 ? "ok" : "sin dato") as "ok" | "sin dato",
          chl: (cellsWithChl > 0 ? "ok" : "sin dato") as "ok" | "sin dato",
          alt: (cellsWithAlt > 0 ? "ok" : "sin dato") as "ok" | "sin dato",
          bat: (numericDepthAvailable ? "ok" : "sin dato") as "ok" | "sin dato",
        },
      };
      onAnalysisSummary?.(summaryPayload);

      // Guardar en caché diaria (solo si hay zona explícita y resultado real).
      // Guardamos SIEMPRE (incluido resultado vacío): si no, un análisis sin
      // spots se recalculaba desde cero y podía devolver otro Top 1.
      if (searchArea) {
        const list = loadSpotsCache().filter((e) => !(e.key === cacheInfo.key));
        list.push({
          key: cacheInfo.key,
          dateSig: cacheInfo.dateSig,
          savedAt: Date.now(),
          spots: cleanSpots,
          summary: summaryPayload,
        });
        saveSpotsCache(list);
      }
    } catch (err) {
      if (myRun === runIdRef.current) {
        const msg = err instanceof Error ? err.message : String(err);

        console.error("[FishingHotspots] análisis falló:", err);
        onAnalysisError?.(`Error durante el análisis: ${msg}`);
      }
    } finally {
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
      if (myRun === runIdRef.current) {
        onLoadingChange?.(false);
        onProgress?.(null);
      }
    }
  };

  const schedule = () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void compute();
    }, RECOMPUTE_DEBOUNCE_MS);
  };

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      runIdRef.current += 1;
      clearAll();
      onSpotsChange?.([], []);
      onLoadingChange?.(false);
      return;
    }
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    recomputeTrigger,
    fishingMode,
    minDepth,
    maxDepth,
    minScore,
    hotZoneOnly,
    hotZoneMode,
    searchArea,
    layerTimes,
  ]);

  useEffect(() => {
    runIdRef.current += 1;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    clearAll();
    onSpotsChange?.([], []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearTrigger]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      clearAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

export function FishingHotspots(props: FishingHotspotsProps) {
  return <HotspotsRenderer {...props} />;
}

export function useStableSpotsKey(spots: FishingSpot[]): string {
  return useMemo(() => spots.map((s) => s.id).join("|"), [spots]);
}

export type { FishingHotspotsProps };

