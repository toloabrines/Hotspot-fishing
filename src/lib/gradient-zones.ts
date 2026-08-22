/**
 * Algoritmo de detección de "Frentes Productivos".
 *
 * Pipeline:
 *   1) Grilla regular N×N sobre el bbox visible.
 *   2) Para cada celda, lectura rápida de píxel sobre tiles WMTS cacheables
 *      de SST / CHL / ALT, evitando barridos lentos con GetFeatureInfo.
 *   3) Normalización P5–P95 por variable (similar a ViewportAdaptiveContrast).
 *   4) Gradiente Sobel por celda; máscara binaria por percentil P85.
 *   5) Fusión inteligente: una celda es "frente" si tiene gradiente fuerte en
 *      ≥2 variables, o si una sola variable supera P95.
 *   6) Etiquetado de componentes conexas (8-vecinos, flood fill iterativo).
 *   7) Para cada componente: outline (boundary tracing sobre la malla),
 *      área (suma de áreas de celda con geo aproximada), eje principal por
 *      PCA y longitud frontal en millas náuticas.
 *
 * 100% client-side; no requiere endpoints nuevos. Las celdas que no
 * obtuvieron dato (mar abierto fuera del producto, nubes) se descartan.
 */

import { fetchDepth, type DepthSample } from "./bathymetry";
import { getLandMask } from "./land-mask";
import type { LatLng } from "./geo-area";
import type {
  GradientCell,
  GradientVariable,
  GradientZone,
  GradientZonesResult,
} from "./gradient-zones.types";

export interface SampledLayer {
  variable: GradientVariable;
  wmtsLayer: string;
  style: string;
  time?: string;
}

export interface GradientZonesOptions {
  bbox: { south: number; west: number; north: number; east: number };
  /** Capas a muestrear (1..3). */
  layers: SampledLayer[];
  /** Zoom WMTS para la consulta GetFeatureInfo. */
  zoom: number;
  /** Resolución de la grilla por lado (default 18). */
  gridSize?: number;
  /** Concurrencia máxima de fetches. Default 8. */
  concurrency?: number;
  /** Cancelación. */
  signal?: AbortSignal;
  /** Callback de progreso 0..1. */
  onProgress?: (frac: number) => void;
}

const NM_PER_KM = 0.539957;
const COPERNICUS_WMTS = "https://wmts.marine.copernicus.eu/teroWmts";

// ───────────── Velocidad (corrientes) para Convergencia + FSLE proxy ─────────────

const VEL_GLOBAL =
  "SEALEVEL_GLO_PHY_L4_NRT_008_046/cmems_obs-sl_glo_phy-ssh_nrt_allsat-l4-duacs-0.125deg_P1D_202506";
const VEL_GLOBAL_STYLE = "cmap:RdBu_r,vmin:-1.2,vmax:1.2";
const VEL_MED = "MEDSEA_ANALYSISFORECAST_PHY_006_013/cmems_mod_med_phy-cur_anfc_4.2km_P1D-m_202511";
const VEL_MED_STYLE = "cmap:RdBu_r,vmin:-1,vmax:1";
const MED_BBOX = { west: -17, east: 36, south: 30.5, north: 45.8 };

const velCache = new Map<string, number | null>();

async function sampleVelocity(
  variable: "u" | "v",
  lat: number,
  lon: number,
  time: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const inMed =
    lat >= MED_BBOX.south - 1 &&
    lat <= MED_BBOX.north + 1 &&
    lon >= MED_BBOX.west - 1 &&
    lon <= MED_BBOX.east + 1;
  const dataset = inMed ? VEL_MED : VEL_GLOBAL;
  const style = inMed ? VEL_MED_STYLE : VEL_GLOBAL_STYLE;
  const varName = inMed ? (variable === "u" ? "uo" : "vo") : variable === "u" ? "ugos" : "vgos";
  const z = 5;
  const day = time.slice(0, 10);
  const cacheKey = `${day}|${varName}|${lat.toFixed(3)}|${lon.toFixed(3)}|${dataset}`;
  if (velCache.has(cacheKey)) return velCache.get(cacheKey) ?? null;
  const n = 2 ** z;
  const x = Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const latRad = (lat * Math.PI) / 180;
  const y = Math.min(
    n - 1,
    Math.max(
      0,
      Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
    ),
  );
  const lonLeft = (x / n) * 360 - 180;
  const lonRight = ((x + 1) / n) * 360 - 180;
  const latTop = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const latBot = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  const i = Math.min(255, Math.max(0, Math.round(((lon - lonLeft) / (lonRight - lonLeft)) * 256)));
  const j = Math.min(255, Math.max(0, Math.round(((latTop - lat) / (latTop - latBot)) * 256)));
  const params = new URLSearchParams({
    SERVICE: "WMTS",
    REQUEST: "GetFeatureInfo",
    VERSION: "1.0.0",
    LAYER: `${dataset}/${varName}`,
    STYLE: style,
    FORMAT: "image/png",
    TILEMATRIXSET: "EPSG:3857",
    TILEMATRIX: String(z),
    TILEROW: String(y),
    TILECOL: String(x),
    INFOFORMAT: "application/json",
    I: String(i),
    J: String(j),
    TIME: `${day}T00:00:00.000Z`,
  });
  const url = `/api/tile-proxy?url=${encodeURIComponent(`${COPERNICUS_WMTS}?${params.toString()}`)}`;
  try {
    const res = await fetch(url, { signal, cache: "no-store" });
    if (!res.ok) {
      velCache.set(cacheKey, null);
      return null;
    }
    const json = (await res.json()) as {
      features?: Array<{ properties?: { value?: number | null } }>;
    };
    const v = json.features?.[0]?.properties?.value;
    const out = typeof v === "number" && Number.isFinite(v) ? v : null;
    velCache.set(cacheKey, out);
    if (velCache.size > 1500) {
      const first = velCache.keys().next().value;
      if (first) velCache.delete(first);
    }
    return out;
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") throw e;
    return null;
  }
}

// ───────────────────────── helpers numéricos ─────────────────────────

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const arr = values.slice().sort((a, b) => a - b);
  const idx = (p / 100) * (arr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

function normalize(matrix: (number | null)[][], rows: number, cols: number): (number | null)[][] {
  const vals: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const v = matrix[r][c];
      if (v != null && Number.isFinite(v)) vals.push(v);
    }
  if (vals.length === 0) return matrix;
  const lo = percentile(vals, 5);
  const hi = percentile(vals, 95);
  const span = hi - lo || 1;
  const out: (number | null)[][] = matrix.map((row) =>
    row.map((v) => (v == null ? null : Math.max(0, Math.min(1, (v - lo) / span)))),
  );
  return out;
}

/**
 * Filtro de suavizado 3×3 (gaussiano aproximado) sobre la matriz normalizada.
 * Elimina los escalones cuadrados visibles del raster WMTS antes de calcular
 * el gradiente, de modo que el Sobel responda a transiciones oceanográficas
 * reales y no a los bordes nítidos entre píxeles/tiles.
 */
function smoothMatrix(
  matrix: (number | null)[][],
  rows: number,
  cols: number,
  iterations = 2,
): (number | null)[][] {
  // Pesos tipo gaussiano (centro=4, lados=2, esquinas=1) — separable, barato.
  const W = [
    [1, 2, 1],
    [2, 4, 2],
    [1, 2, 1],
  ];
  let src = matrix;
  for (let it = 0; it < iterations; it++) {
    const out: (number | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (src[r][c] == null) continue;
        let acc = 0;
        let wsum = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
            const v = src[rr][cc];
            if (v == null) continue;
            const w = W[dr + 1][dc + 1];
            acc += v * w;
            wsum += w;
          }
        }
        out[r][c] = wsum > 0 ? acc / wsum : src[r][c];
      }
    }
    src = out;
  }
  return src;
}

function sobel(matrix: (number | null)[][], rows: number, cols: number): (number | null)[][] {
  const out: (number | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null));
  const get = (r: number, c: number) => {
    if (r < 0 || c < 0 || r >= rows || c >= cols) return null;
    return matrix[r][c];
  };
  // Kernel Sobel completo (3×3) — promedia direcciones y atenúa ruido de
  // píxel individual frente a la diferencia central simple.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const center = matrix[r][c];
      if (center == null) continue;
      const nw = get(r - 1, c - 1) ?? center;
      const n = get(r - 1, c) ?? center;
      const ne = get(r - 1, c + 1) ?? center;
      const w = get(r, c - 1) ?? center;
      const e = get(r, c + 1) ?? center;
      const sw = get(r + 1, c - 1) ?? center;
      const s = get(r + 1, c) ?? center;
      const se = get(r + 1, c + 1) ?? center;
      const gx = ne + 2 * e + se - (nw + 2 * w + sw);
      const gy = sw + 2 * s + se - (nw + 2 * n + ne);
      out[r][c] = Math.sqrt(gx * gx + gy * gy) / 4;
    }
  }
  return out;
}

type Matrix = (number | null)[][];

const VAR_WEIGHTS: Record<GradientVariable, number> = { sst: 0.42, chl: 0.34, alt: 0.24 };

interface TileSampler {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

type TilePixelSample = { available: true; value: number | null } | { available: false };

const TILE_SAMPLE_CACHE = new Map<string, Promise<TileSampler | null>>();

function latLngToTilePixel(lat: number, lng: number, zoom: number, tileSize = 256) {
  const n = Math.pow(2, zoom);
  const xTile = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yTile = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return {
    tileX: Math.floor(xTile),
    tileY: Math.floor(yTile),
    i: Math.max(0, Math.min(tileSize - 1, Math.floor((xTile - Math.floor(xTile)) * tileSize))),
    j: Math.max(0, Math.min(tileSize - 1, Math.floor((yTile - Math.floor(yTile)) * tileSize))),
  };
}

function rgbHue01(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d <= 1e-6) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60 + 360) % 360) / 360;
}

function pixelSignal(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  variable: GradientVariable,
): number | null {
  const idx = (Math.max(0, Math.min(width - 1, x)) + Math.max(0, y) * width) * 4;
  const a = data[idx + 3];
  if (a < 12) return null;
  const r = data[idx] / 255;
  const g = data[idx + 1] / 255;
  const b = data[idx + 2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max <= 1e-6 ? 0 : (max - min) / max;
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const hue = rgbHue01(r, g, b);
  if (max < 0.015 || (sat < 0.025 && luma > 0.96)) return null;
  if (variable === "chl") {
    const greenDominance = Math.max(0, g - Math.min(r, b));
    return Math.max(0, Math.min(1, 0.42 * luma + 0.33 * sat + 0.25 * greenDominance));
  }
  return Math.max(0, Math.min(1, 0.5 * hue + 0.34 * luma + 0.16 * sat));
}

function buildTileUrl(layer: SampledLayer, tileX: number, tileY: number, zoom: number): string {
  const normalizedTime = layer.time
    ? layer.time.includes("T")
      ? layer.time
      : `${layer.time.slice(0, 10)}T00:00:00.000Z`
    : undefined;
  const timeParam = normalizedTime ? `&TIME=${encodeURIComponent(normalizedTime)}` : "";
  const upstream =
    `${COPERNICUS_WMTS}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${encodeURIComponent(layer.wmtsLayer)}` +
    `&STYLE=${encodeURIComponent(layer.style)}` +
    `&FORMAT=image%2Fpng&TILEMATRIXSET=EPSG%3A3857` +
    `&TILEMATRIX=${zoom}&TILEROW=${tileY}&TILECOL=${tileX}${timeParam}`;
  return `/api/tile-proxy?url=${encodeURIComponent(upstream)}`;
}

async function blobToSampler(blob: Blob): Promise<TileSampler | null> {
  if (typeof document === "undefined" || blob.size < 16) return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
  } else {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("tile image decode failed"));
        image.src = url;
      });
      canvas.width = img.naturalWidth || 256;
      canvas.height = img.naturalHeight || 256;
      ctx.drawImage(img, 0, 0);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: image.data };
}

async function getTileSampler(
  layer: SampledLayer,
  tileX: number,
  tileY: number,
  zoom: number,
  signal?: AbortSignal,
): Promise<TileSampler | null> {
  const day = (layer.time ?? "latest").slice(0, 10);
  const key = `${layer.wmtsLayer}|${layer.style}|${day}|${zoom}|${tileX}|${tileY}`;
  let promise = TILE_SAMPLE_CACHE.get(key);
  if (!promise) {
    promise = fetch(buildTileUrl(layer, tileX, tileY, zoom), {
      signal,
      cache: "force-cache",
      headers: { accept: "image/png,image/*" },
    })
      .then(async (res) => {
        if (!res.ok || res.status === 204) return null;
        return blobToSampler(await res.blob());
      })
      .catch(() => null);
    TILE_SAMPLE_CACHE.set(key, promise);
  }
  const sampler = await promise;
  if (!sampler) TILE_SAMPLE_CACHE.delete(key);
  while (TILE_SAMPLE_CACHE.size > 240) {
    const first = TILE_SAMPLE_CACHE.keys().next().value;
    if (!first) break;
    TILE_SAMPLE_CACHE.delete(first);
  }
  return sampler;
}

async function sampleTilePixel(
  layer: SampledLayer,
  pt: SamplePoint,
  zoom: number,
  signal?: AbortSignal,
): Promise<TilePixelSample> {
  if (typeof document === "undefined") return { available: false };
  const { tileX, tileY, i, j } = latLngToTilePixel(pt.lat, pt.lng, zoom);
  const sampler = await getTileSampler(layer, tileX, tileY, zoom, signal);
  if (!sampler) return { available: false };
  return {
    available: true,
    value: pixelSignal(
      sampler.data,
      sampler.width,
      Math.min(i, sampler.width - 1),
      Math.min(j, sampler.height - 1),
      layer.variable,
    ),
  };
}

function sampleMatrix(matrix: Matrix | undefined, row: number, col: number): number | null {
  if (!matrix || matrix.length === 0) return null;
  const rows = matrix.length;
  const cols = matrix[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return null;
  const r = Math.max(0, Math.min(rows - 1, row));
  const c = Math.max(0, Math.min(cols - 1, col));
  const r0 = Math.floor(r);
  const c0 = Math.floor(c);
  const r1 = Math.min(rows - 1, r0 + 1);
  const c1 = Math.min(cols - 1, c0 + 1);
  const tr = r - r0;
  const tc = c - c0;
  const v00 = matrix[r0][c0];
  const v01 = matrix[r0][c1];
  const v10 = matrix[r1][c0];
  const v11 = matrix[r1][c1];
  const vals = [v00, v01, v10, v11].filter((v): v is number => v != null && Number.isFinite(v));
  if (vals.length === 0) return null;
  const fill = vals.reduce((sum, v) => sum + v, 0) / vals.length;
  const a = (v00 ?? fill) * (1 - tc) + (v01 ?? fill) * tc;
  const b = (v10 ?? fill) * (1 - tc) + (v11 ?? fill) * tc;
  return a * (1 - tr) + b * tr;
}

function fusedGradientAt(
  grad: Partial<Record<GradientVariable, Matrix>>,
  sampledVars: GradientVariable[],
  row: number,
  col: number,
): number {
  let weighted = 0;
  let totalWeight = 0;
  let max = 0;
  let contributing = 0;
  for (const v of sampledVars) {
    const g = sampleMatrix(grad[v], row, col);
    if (g == null) continue;
    const clamped = Math.max(0, Math.min(1, g));
    weighted += clamped * VAR_WEIGHTS[v];
    totalWeight += VAR_WEIGHTS[v];
    max = Math.max(max, clamped);
    if (clamped >= 0.12) contributing += 1;
  }
  const fused = totalWeight > 0 ? weighted / totalWeight : 0;
  const bonus = contributing >= 2 ? 0.08 : 0;
  return Math.max(0, Math.min(1, Math.max(max, fused + bonus)));
}

function ridgeAt(
  pt: SamplePoint,
  norm: Partial<Record<GradientVariable, Matrix>>,
  grad: Partial<Record<GradientVariable, Matrix>>,
  sampledVars: GradientVariable[],
): GradientCell["ridge"] | undefined {
  let dx = 0;
  let dy = 0;
  for (const v of sampledVars) {
    const matrix = norm[v];
    const center = sampleMatrix(matrix, pt.row, pt.col);
    if (center == null) continue;
    const west = sampleMatrix(matrix, pt.row, pt.col - 1) ?? center;
    const east = sampleMatrix(matrix, pt.row, pt.col + 1) ?? center;
    const south = sampleMatrix(matrix, pt.row - 1, pt.col) ?? center;
    const north = sampleMatrix(matrix, pt.row + 1, pt.col) ?? center;
    const gx = east - west;
    const gy = north - south;
    const mag = Math.hypot(gx, gy);
    if (mag <= 1e-6) continue;
    const w = VAR_WEIGHTS[v] * Math.max(0.2, mag);
    dx += gx * w;
    dy += gy * w;
  }
  const n = Math.hypot(dx, dy);
  if (n <= 1e-6) return undefined;

  const normal = { lat: dy / n, lng: dx / n };
  const tangent = { lat: -normal.lng, lng: normal.lat };
  const centerStrength = fusedGradientAt(grad, sampledVars, pt.row, pt.col);
  const sideStep = 0.75;
  const left = fusedGradientAt(
    grad,
    sampledVars,
    pt.row - normal.lat * sideStep,
    pt.col - normal.lng * sideStep,
  );
  const right = fusedGradientAt(
    grad,
    sampledVars,
    pt.row + normal.lat * sideStep,
    pt.col + normal.lng * sideStep,
  );
  const denom = left - 2 * centerStrength + right;
  let offsetCells = 0;
  if (denom < -1e-6) {
    offsetCells = Math.max(-0.45, Math.min(0.45, 0.5 * ((left - right) / denom) * sideStep));
  } else if (right > centerStrength * 1.08) {
    offsetCells = 0.45;
  } else if (left > centerStrength * 1.08) {
    offsetCells = -0.45;
  }

  const [sw, ne] = pt.bounds;
  const stepLat = ne.lat - sw.lat;
  const stepLng = ne.lng - sw.lng;
  return {
    point: {
      lat: pt.lat + normal.lat * stepLat * offsetCells,
      lng: pt.lng + normal.lng * stepLng * offsetCells,
    },
    tangent,
    normal,
    strength: centerStrength,
    localContrast: Math.max(0, centerStrength - (left + right) / 2),
  };
}

// ───────────────────────── geo ─────────────────────────

function cellAreaKm2(south: number, north: number, west: number, east: number): number {
  const R = 6371; // km
  const dLat = ((north - south) * Math.PI) / 180;
  const dLng = ((east - west) * Math.PI) / 180;
  const meanLat = (((north + south) / 2) * Math.PI) / 180;
  const h = R * dLat;
  const w = R * dLng * Math.cos(meanLat);
  return Math.abs(h * w);
}

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ───────────────────────── concurrencia ─────────────────────────

async function pMap<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  concurrency: number,
  onEach?: () => void,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      onEach?.();
    }
  });
  await Promise.all(workers);
  return out;
}

// ───────────────────────── muestreo ─────────────────────────

interface SamplePoint {
  row: number;
  col: number;
  lat: number;
  lng: number;
  bounds: [LatLng, LatLng];
}

function buildGrid(opts: GradientZonesOptions): {
  points: SamplePoint[];
  rows: number;
  cols: number;
} {
  const N = opts.gridSize ?? 18;
  const { south, west, north, east } = opts.bbox;
  const rows = N;
  const cols = N;
  const stepLat = (north - south) / rows;
  const stepLng = (east - west) / cols;
  const points: SamplePoint[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = south + stepLat * r;
      const n = south + stepLat * (r + 1);
      const w = west + stepLng * c;
      const e = west + stepLng * (c + 1);
      points.push({
        row: r,
        col: c,
        lat: (s + n) / 2,
        lng: (w + e) / 2,
        bounds: [
          { lat: s, lng: w },
          { lat: n, lng: e },
        ],
      });
    }
  }
  return { points, rows, cols };
}

// ───────────────────────── componentes conexas ─────────────────────────

function connectedComponents(mask: boolean[][], rows: number, cols: number): number[][] {
  const labels: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  let nextLabel = 1;
  const NB = [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, -1],
    [0, 1],
    [1, -1],
    [1, 0],
    [1, 1],
  ];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!mask[r][c] || labels[r][c] !== 0) continue;
      const lbl = nextLabel++;
      const stack: [number, number][] = [[r, c]];
      while (stack.length) {
        const [cr, cc] = stack.pop()!;
        if (cr < 0 || cc < 0 || cr >= rows || cc >= cols) continue;
        if (!mask[cr][cc] || labels[cr][cc] !== 0) continue;
        labels[cr][cc] = lbl;
        for (const [dr, dc] of NB) stack.push([cr + dr, cc + dc]);
      }
    }
  }
  return labels;
}

// ───────────────────────── outline (boundary tracing) ─────────────────
//
// Idea: cada celda activa es un rectángulo geográfico. La frontera exterior
// de la unión está formada por los lados de celda donde el vecino NO está
// activo. Recopilamos esos segmentos y los encadenamos en un anillo cerrado
// usando un grafo cuyas claves son las esquinas (puntos). Para zonas no
// convexas o con agujeros se obtiene un ciclo válido aunque no esté
// simplificado: es suficiente para visualización y exportación KML/GPX.

interface Segment {
  a: LatLng;
  b: LatLng;
}

function cellEdges(cell: GradientCell): {
  N: Segment;
  S: Segment;
  E: Segment;
  W: Segment;
} {
  const [sw, ne] = cell.bounds;
  const nw = { lat: ne.lat, lng: sw.lng };
  const se = { lat: sw.lat, lng: ne.lng };
  return {
    N: { a: nw, b: ne },
    S: { a: sw, b: se },
    E: { a: se, b: ne },
    W: { a: sw, b: nw },
  };
}

function keyPt(p: LatLng): string {
  return `${p.lat.toFixed(6)}|${p.lng.toFixed(6)}`;
}

function traceOutline(cells: GradientCell[], cellMap: Map<string, GradientCell>): LatLng[] {
  // Para cada celda activa, añadir aristas hacia vecinos no activos.
  const segs: Segment[] = [];
  for (const c of cells) {
    const e = cellEdges(c);
    if (!cellMap.has(`${c.row + 1}_${c.col}`)) segs.push(e.N);
    if (!cellMap.has(`${c.row - 1}_${c.col}`)) segs.push(e.S);
    if (!cellMap.has(`${c.row}_${c.col + 1}`)) segs.push(e.E);
    if (!cellMap.has(`${c.row}_${c.col - 1}`)) segs.push(e.W);
  }
  if (segs.length === 0) return [];

  // Encadenar segmentos por puntos compartidos.
  const adj = new Map<string, { pt: LatLng; partners: { key: string; pt: LatLng }[] }>();
  const add = (a: LatLng, b: LatLng) => {
    const ka = keyPt(a);
    const kb = keyPt(b);
    if (!adj.has(ka)) adj.set(ka, { pt: a, partners: [] });
    if (!adj.has(kb)) adj.set(kb, { pt: b, partners: [] });
    adj.get(ka)!.partners.push({ key: kb, pt: b });
    adj.get(kb)!.partners.push({ key: ka, pt: a });
  };
  for (const s of segs) add(s.a, s.b);

  // Empezar en el punto con menor lat,lng (esquina SW) para resultado estable.
  let startKey = "";
  let startPt: LatLng | null = null;
  for (const [k, v] of adj) {
    if (
      !startPt ||
      v.pt.lat < startPt.lat ||
      (v.pt.lat === startPt.lat && v.pt.lng < startPt.lng)
    ) {
      startKey = k;
      startPt = v.pt;
    }
  }
  if (!startPt) return [];

  const ring: LatLng[] = [startPt];
  const used = new Set<string>();
  let cur = startKey;
  let prev = "";
  // Caminar siguiendo siempre un partner no usado.
  for (let i = 0; i < segs.length * 2 + 5; i++) {
    const node = adj.get(cur);
    if (!node) break;
    const candidates = node.partners.filter((p) => {
      const edgeKey = cur < p.key ? `${cur}->${p.key}` : `${p.key}->${cur}`;
      return p.key !== prev && !used.has(edgeKey);
    });
    if (candidates.length === 0) break;
    const next = candidates[0];
    const edgeKey = cur < next.key ? `${cur}->${next.key}` : `${next.key}->${cur}`;
    used.add(edgeKey);
    if (next.key === startKey) {
      ring.push(node.pt); // cerrar implícitamente
      break;
    }
    ring.push(next.pt);
    prev = cur;
    cur = next.key;
  }
  return ring;
}

// ───────────────────────── PCA (eje principal) ─────────────────────────

function principalAxis(cells: GradientCell[]): {
  centroid: LatLng;
  dir: LatLng;
  extent: number; // km a lo largo del eje
} {
  const n = cells.length;
  if (n === 0) return { centroid: { lat: 0, lng: 0 }, dir: { lat: 1, lng: 0 }, extent: 0 };

  let mLat = 0,
    mLng = 0;
  for (const c of cells) {
    mLat += c.center.lat;
    mLng += c.center.lng;
  }
  mLat /= n;
  mLng /= n;

  // Trabajamos en aproximación local (km respecto al centroide).
  const cosLat = Math.cos((mLat * Math.PI) / 180);
  const KM_PER_DEG_LAT = 111;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const c of cells) {
    xs.push((c.center.lng - mLng) * KM_PER_DEG_LAT * cosLat);
    ys.push((c.center.lat - mLat) * KM_PER_DEG_LAT);
  }

  let sxx = 0,
    syy = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += xs[i] * xs[i];
    syy += ys[i] * ys[i];
    sxy += xs[i] * ys[i];
  }
  sxx /= n;
  syy /= n;
  sxy /= n;

  // Autovector dominante de la matriz [[sxx,sxy],[sxy,syy]]
  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, (trace * trace) / 4 - det);
  const lambda1 = trace / 2 + Math.sqrt(disc);
  let vx = 1,
    vy = 0;
  if (Math.abs(sxy) > 1e-9) {
    vx = lambda1 - syy;
    vy = sxy;
  } else if (syy > sxx) {
    vx = 0;
    vy = 1;
  }
  const norm = Math.hypot(vx, vy) || 1;
  vx /= norm;
  vy /= norm;

  // Extensión proyectada
  let minProj = Infinity;
  let maxProj = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = xs[i] * vx + ys[i] * vy;
    if (p < minProj) minProj = p;
    if (p > maxProj) maxProj = p;
  }
  const extent = Math.max(0, maxProj - minProj);

  return {
    centroid: { lat: mLat, lng: mLng },
    // dir como delta lat/lng unitario aproximado
    dir: { lat: vy / KM_PER_DEG_LAT, lng: vx / (KM_PER_DEG_LAT * cosLat) },
    extent,
  };
}

// ───────────────────────── pipeline principal ─────────────────────────

export async function detectGradientZones(
  opts: GradientZonesOptions,
): Promise<GradientZonesResult> {
  const { points: allPoints, rows, cols } = buildGrid(opts);
  // Filtrar celdas en tierra firme para no gastar fetches ni pintar
  // corredores sobre rocas / islas.
  let points = allPoints;
  try {
    const land = await getLandMask();
    points = allPoints.filter((pt) => {
      const [sw, ne] = pt.bounds;
      const halfLat = (ne.lat - sw.lat) / 2;
      const halfLng = (ne.lng - sw.lng) / 2;
      return land.waterRatio(pt.lat, pt.lng, halfLat, halfLng, 3) > 0.35;
    });
  } catch {
    /* sin máscara: continuar con toda la grilla */
  }
  const concurrency = opts.concurrency ?? 8;
  const total = points.length * opts.layers.length;
  let done = 0;
  const tickProgress = () => {
    done++;
    if (opts.onProgress && done % 4 === 0) opts.onProgress(done / total);
  };

  // Inicializar matrices por variable
  const raw: Record<GradientVariable, (number | null)[][]> = {} as Record<
    GradientVariable,
    (number | null)[][]
  >;
  for (const l of opts.layers) {
    raw[l.variable] = Array.from({ length: rows }, () => Array<number | null>(cols).fill(null));
  }

  // Muestreo por tiles ya renderizables: descarga cada tile una vez y lee
  // píxeles locales. Evita cientos de GetFeatureInfo y los 429 que dejaban
  // el análisis sin ningún gradiente.
  for (const layer of opts.layers) {
    if (opts.signal?.aborted) throw new Error("aborted");
    await pMap(
      points,
      async (pt) => {
        const sample = await sampleTilePixel(layer, pt, opts.zoom, opts.signal);
        raw[layer.variable][pt.row][pt.col] = sample.available ? sample.value : null;
      },
      concurrency,
      tickProgress,
    );
  }
  opts.onProgress?.(1);

  // Normalizar y gradiente por variable. Aumentamos las pasadas del
  // filtro suavizador a 3 para eliminar por completo los escalones de
  // píxel/tile WMTS: el Sobel sólo debe reaccionar ante transiciones
  // oceanográficas continuas, nunca ante el borde de un cuadrado raster.
  const grad: Record<GradientVariable, (number | null)[][]> = {} as Record<
    GradientVariable,
    (number | null)[][]
  >;
  const norm: Partial<Record<GradientVariable, Matrix>> = {};
  const sampledVars: GradientVariable[] = [];
  for (const layer of opts.layers) {
    sampledVars.push(layer.variable);
    const normalized = normalize(raw[layer.variable], rows, cols);
    const smoothed = smoothMatrix(normalized, rows, cols, 3);
    norm[layer.variable] = smoothed;
    grad[layer.variable] = sobel(smoothed, rows, cols);
  }

  // Percentiles P70/P85/P95 por variable
  const thresholds: Record<GradientVariable, { p70: number; p85: number; p95: number }> =
    {} as Record<GradientVariable, { p70: number; p85: number; p95: number }>;
  for (const v of sampledVars) {
    const flat: number[] = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const g = grad[v][r][c];
        if (g != null && Number.isFinite(g)) flat.push(g);
      }
    thresholds[v] = {
      p70: percentile(flat, 70),
      p85: percentile(flat, 85),
      p95: percentile(flat, 95),
    };
  }

  // ── Umbral físico SST: ≥0.3 °C en <5 km ─────────────────────────────
  // El tile WMTS está coloreado dentro de una rampa cuyo rango total en
  // el Mediterráneo en verano es ≈8 °C. Tras normalizar P5–P95, una
  // diferencia de 0.3 °C equivale a ≈0.04 unidades normalizadas. Lo
  // escalamos al tamaño real de la celda para exigir el ritmo "por 5 km"
  // y descartamos cualquier candidato que no llegue a esa pendiente.
  const SST_DEG_RANGE_C = 8;
  const SST_MIN_DELTA_C = 0.2; // relajado: 0.2 °C en <5 km
  const SST_MIN_DISTANCE_KM = 5;
  const meanLat = (opts.bbox.south + opts.bbox.north) / 2;
  const cellKm = Math.max(
    0.5,
    haversineKm(
      { lat: meanLat, lng: opts.bbox.west },
      { lat: meanLat, lng: opts.bbox.west + (opts.bbox.east - opts.bbox.west) / cols },
    ),
  );
  const sstPhysicalMinPerCell =
    (SST_MIN_DELTA_C / SST_DEG_RANGE_C) * (cellKm / SST_MIN_DISTANCE_KM);

  // Diferencia máxima en la SST suavizada entre el centro y sus 8 vecinos
  // (en unidades normalizadas, ≈ Δ°C / SST_DEG_RANGE_C por celda).
  const sstNeighborDelta = (r: number, c: number): number => {
    const m = norm.sst;
    if (!m) return 0;
    const center = m[r]?.[c];
    if (center == null) return 0;
    let max = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const v = m[r + dr]?.[c + dc];
        if (v == null) continue;
        const d = Math.abs(v - center);
        if (d > max) max = d;
      }
    }
    return max;
  };

  // Fusión orientada a frentes reales pero permisiva para no quedar vacíos:
  //   • SST con confirmación (CHL/ALT) → P75 + umbral físico relajado.
  //   • Sólo SST → P85 + umbral físico estándar.
  //   • Sin SST → ≥2 variables P75.
  const hasSst = sampledVars.includes("sst");
  const hasConfirmation = sampledVars.some((v) => v === "chl" || v === "alt");
  const mask: boolean[][] = Array.from({ length: rows }, () => Array(cols).fill(false));
  const cells: GradientCell[] = [];
  const cellMap = new Map<string, GradientCell>();
  for (const pt of points) {
    const contributing: GradientVariable[] = [];
    const gradByVar: Partial<Record<GradientVariable, number>> = {};
    let maxG = 0;
    for (const v of sampledVars) {
      const g = grad[v][pt.row][pt.col];
      if (g == null) continue;
      gradByVar[v] = g;
      if (g > thresholds[v].p70) contributing.push(v);
      if (g > maxG) maxG = g;
    }

    let accept = false;
    if (hasSst && hasConfirmation) {
      const sstG = gradByVar.sst ?? 0;
      const sstPhysOk =
        sstG > thresholds.sst.p70 && sstNeighborDelta(pt.row, pt.col) >= sstPhysicalMinPerCell;
      const confirmed = contributing.some((v) => v === "chl" || v === "alt");
      accept = sstPhysOk && confirmed;
    } else if (hasSst) {
      const sstG = gradByVar.sst ?? 0;
      accept =
        sstG > thresholds.sst.p85 && sstNeighborDelta(pt.row, pt.col) >= sstPhysicalMinPerCell;
    } else {
      accept = contributing.length >= 2 && maxG > thresholds[sampledVars[0]].p70;
    }
    if (!accept) continue;

    mask[pt.row][pt.col] = true;
    const cell: GradientCell = {
      center: { lat: pt.lat, lng: pt.lng },
      bounds: pt.bounds,
      grad: gradByVar,
      vars: contributing.length > 0 ? contributing : sampledVars,
      score: Math.min(1, maxG),
      ridge: ridgeAt(pt, norm, grad, sampledVars),
      col: pt.col,
      row: pt.row,
    };
    cells.push(cell);
    cellMap.set(`${pt.row}_${pt.col}`, cell);
  }

  // Componentes conexas
  const labels = connectedComponents(mask, rows, cols);
  const buckets = new Map<number, GradientCell[]>();
  for (const c of cells) {
    const l = labels[c.row][c.col];
    if (!buckets.has(l)) buckets.set(l, []);
    buckets.get(l)!.push(c);
  }

  // Construir zonas con outline + métricas
  const zones: GradientZone[] = [];
  for (const [lbl, comp] of buckets) {
    if (comp.length < 2) continue;
    if (sampledVars.length >= 2) {
      const multi = comp.filter((c) => c.vars.length >= 2).length / comp.length;
      if (multi < 0.25) continue;
    }
    const localMap = new Map<string, GradientCell>();
    for (const c of comp) localMap.set(`${c.row}_${c.col}`, c);
    const outline = traceOutline(comp, localMap);

    // Área (suma de áreas de celda) — sólo informativa, no afecta al ranking.
    let areaKm2 = 0;
    for (const c of comp) {
      const [sw, ne] = c.bounds;
      areaKm2 += cellAreaKm2(sw.lat, ne.lat, sw.lng, ne.lng);
    }

    const { centroid, dir, extent } = principalAxis(comp);
    const lengthNm = extent * NM_PER_KM;

    // Variables predominantes: las que aparecen en >40% de celdas
    const varCount: Record<string, number> = {};
    for (const c of comp) for (const v of c.vars) varCount[v] = (varCount[v] ?? 0) + 1;
    const predominantVars = (Object.keys(varCount) as GradientVariable[]).filter(
      (v) => varCount[v] / comp.length >= 0.4,
    );

    const meanScore = comp.reduce((s, c) => s + c.score, 0) / comp.length;

    // Gradiente medio por variable dentro de la zona (0..1)
    const gradMeans: Partial<Record<GradientVariable, number>> = {};
    for (const v of sampledVars) {
      let sum = 0;
      let n = 0;
      for (const c of comp) {
        const g = c.grad[v];
        if (g != null && Number.isFinite(g)) {
          sum += g;
          n += 1;
        }
      }
      if (n > 0) gradMeans[v] = sum / n;
    }

    const presentVars = (Object.keys(gradMeans) as GradientVariable[]).filter(
      (v) => (gradMeans[v] ?? 0) > 0.08,
    );
    const multiLayer = sampledVars.length > 0 ? presentVars.length / sampledVars.length : 0;

    // Pesos (suma máx 90, +10 reservado para batimetría)
    const sstG = gradMeans.sst ?? 0;
    const chlG = gradMeans.chl ?? 0;
    const altG = gradMeans.alt ?? 0;
    const base = sstG * 35 + chlG * 25 + altG * 15 + multiLayer * 15;
    // Penalización por bajo contraste oceanográfico (aunque sea extensa)
    const contrastPenalty = meanScore < 0.3 ? (0.3 - meanScore) * 60 : 0;
    const confidence = Math.max(0, Math.min(90, base - contrastPenalty));

    const parts: string[] = [];
    if (sstG > 0.18) parts.push(`SST ${(sstG * 100).toFixed(0)}%`);
    if (chlG > 0.18) parts.push(`CHL ${(chlG * 100).toFixed(0)}%`);
    if (altG > 0.18) parts.push(`ALT ${(altG * 100).toFixed(0)}%`);
    if (presentVars.length >= 2) parts.push(`${presentVars.length} capas coinciden`);
    const reason = parts.join(" · ") || "Gradiente débil";

    zones.push({
      id: `gz_${lbl}_${comp[0].row}_${comp[0].col}`,
      cells: comp,
      outline,
      areaKm2,
      lengthNm,
      vars: predominantVars.length > 0 ? predominantVars : sampledVars,
      meanScore,
      axis: { centroid, dir },
      gradMeans,
      multiLayer,
      confidence,
      reason,
    });
  }

  // Muestreo batimétrico para top zonas — añade bono por proximidad a talud/veril.
  const topForDepth = zones
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6);
  await pMap(
    topForDepth,
    async (z) => {
      if (opts.signal?.aborted) return;
      const c = z.axis.centroid;
      const kmToLat = 1 / 111;
      const cosLat = Math.cos((c.lat * Math.PI) / 180) || 1;
      const kmToLng = 1 / (111 * cosLat);
      const SPAN_KM = 2.5;
      const offs: [number, number][] = [
        [0, 0],
        [SPAN_KM, 0],
        [-SPAN_KM, 0],
        [0, SPAN_KM],
        [0, -SPAN_KM],
      ];
      try {
        const samples: (DepthSample | null)[] = await Promise.all(
          offs.map(([dx, dy]) =>
            fetchDepth(c.lat + dy * kmToLat, c.lng + dx * kmToLng, opts.signal).catch(() => null),
          ),
        );
        const depths: number[] = samples
          .map((s) => s?.depth ?? null)
          .filter((d): d is number => d != null && Number.isFinite(d) && d > 0);
        if (depths.length >= 2) {
          const maxD = Math.max(...depths);
          const minD = Math.min(...depths);
          const slope = (maxD - minD) / (SPAN_KM * 2); // m/km
          z.depthSlope = slope;
          z.meanDepthM = depths.reduce((s, d) => s + d, 0) / depths.length;
          // Estimación de distancia al veril: si la pendiente es alta, el veril está cerca.
          z.nearestVerilKm = slope > 5 ? Math.max(0.2, 50 / slope) : undefined;
          // Bono 0..10 (>=100 m/km → talud claro)
          const slopeBonus = Math.min(10, slope / 10);
          z.confidence = Math.min(100, z.confidence + slopeBonus);
          const r = z.reason;
          z.reason =
            r === "Gradiente débil"
              ? `Talud ${slope.toFixed(0)} m/km`
              : `${r} · Talud ${slope.toFixed(0)} m/km`;
        }
      } catch {
        /* ignore */
      }
    },
    6,
  );

  // ───────── Muestreo u/v sobre las mejores candidatas: convergencia + FSLE proxy
  // Se hace al final para no alargar el análisis si Copernicus está saturado.
  // Sólo top 8 zonas → máx ~80 peticiones GetFeatureInfo con caché.
  const topForVel = zones
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);
  const velTime = (opts.layers[0]?.time ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  const SPAN_DEG = 0.05; // ≈ 5 km (suficiente para gradiente local u/v)
  await pMap(
    topForVel,
    async (z) => {
      if (opts.signal?.aborted) return;
      const c = z.axis.centroid;
      const stencil: Array<[number, number]> = [
        [c.lat, c.lng],
        [c.lat, c.lng - SPAN_DEG],
        [c.lat, c.lng + SPAN_DEG],
        [c.lat - SPAN_DEG, c.lng],
        [c.lat + SPAN_DEG, c.lng],
      ];
      try {
        const us = await Promise.all(
          stencil.map(([la, lo]) =>
            sampleVelocity("u", la, lo, velTime, opts.signal).catch(() => null),
          ),
        );
        const vs = await Promise.all(
          stencil.map(([la, lo]) =>
            sampleVelocity("v", la, lo, velTime, opts.signal).catch(() => null),
          ),
        );
        const [, uW, uE, uS, uN] = us;
        const [, vW, vE, vS, vN] = vs;
        if (uW == null || uE == null || uN == null || uS == null) return;
        if (vW == null || vE == null || vN == null || vS == null) return;
        const dLng = SPAN_DEG * 2;
        const dLat = SPAN_DEG * 2;
        const dudx = (uE - uW) / dLng;
        const dudy = (uN - uS) / dLat;
        const dvdx = (vE - vW) / dLng;
        const dvdy = (vN - vS) / dLat;
        const convergence = -(dudx + dvdy);
        const sn = dudx - dvdy;
        const ss = dvdx + dudy;
        const strain = Math.sqrt(sn * sn + ss * ss);
        // Normalización empírica: (m/s)/deg ≈ 1.2e-5 s⁻¹ por unidad a 40°N.
        // Un frente fuerte ~ 1e-5 s⁻¹ ≈ 0.8 unidades. Dividimos por 1.8 y
        // recortamos a [0,1] para tener una escala perceptual estable.
        z.convergence = Math.max(0, Math.min(1, convergence / 1.8));
        z.fsleStrain = Math.max(0, Math.min(1, strain / 1.8));
      } catch {
        /* sin u/v: la zona conserva sus métricas previas */
      }
    },
    4,
  );

  // ───────── Recalcular confianza con los 5 factores + batimetría
  for (const z of zones) {
    const sst = z.gradMeans.sst ?? 0;
    const chl = z.gradMeans.chl ?? 0;
    const alt = z.gradMeans.alt ?? 0;
    const conv = z.convergence ?? 0;
    const fsle = z.fsleStrain ?? 0;
    const slopeNorm = Math.min(1, (z.depthSlope ?? 0) / 100);
    const base =
      sst * 22 + chl * 18 + alt * 10 + conv * 18 + fsle * 16 + z.multiLayer * 8 + slopeNorm * 8;
    const contrastPenalty = z.meanScore < 0.3 ? (0.3 - z.meanScore) * 60 : 0;
    z.confidence = Math.max(0, Math.min(100, base - contrastPenalty));

    const PASS = 0.3;
    let passCount = 0;
    if (sst >= PASS) passCount++;
    if (chl >= PASS) passCount++;
    if (alt >= PASS) passCount++;
    if (conv >= PASS) passCount++;
    if (fsle >= PASS) passCount++;
    z.passCount = passCount;
    z.factors = { sst, chl, alt, conv, fsle, depth: slopeNorm };

    // Razón legible recompuesta con las 5 capas
    const parts: string[] = [];
    if (sst >= PASS) parts.push(`SST ${Math.round(sst * 100)}%`);
    if (chl >= PASS) parts.push(`CHL ${Math.round(chl * 100)}%`);
    if (conv >= PASS) parts.push(`Conv ${Math.round(conv * 100)}%`);
    if (fsle >= PASS) parts.push(`FSLE ${Math.round(fsle * 100)}%`);
    if (alt >= PASS) parts.push(`ALT ${Math.round(alt * 100)}%`);
    if (slopeNorm >= 0.3 && z.depthSlope != null)
      parts.push(`Talud ${z.depthSlope.toFixed(0)} m/km`);
    if (parts.length) z.reason = parts.join(" · ");
  }

  // Orden por CONFIANZA descendente (calidad oceanográfica, no superficie)
  zones.sort((a, b) => b.confidence - a.confidence);

  return {
    zones,
    bbox: opts.bbox,
    sampledVars,
    grid: { rows, cols },
  };
}

export { haversineKm };

