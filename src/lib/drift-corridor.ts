/**
 * CORREDORES DE DERIVA (FLUIXA)
 * =============================
 *
 * La pesca a la deriva nunca se hace sobre un punto: se sigue un FRENTE
 * (línea de convergencia, borde térmico, borde de clorofila, línea FSLE).
 * Este módulo convierte la rejilla de celdas puntuadas por `drift-engine`
 * en TRAMOS CONTINUOS (corredores) orientados según el frente real.
 *
 * Pipeline:
 *   1. Umbral adaptativo sobre el score de la rejilla.
 *   2. Componentes conexas 8-vecinos → candidatos a frente.
 *   3. Eje principal (PCA ponderada por score) de cada componente.
 *   4. Traza: se bincea a lo largo del eje y en cada bin se toma el
 *      centroide ponderado → la línea sigue la curvatura real del frente.
 *   5. Métricas: longitud, rumbo, profundidad media, estabilidad, confianza.
 */

import type { LatLng } from "./geo-area";

const KM_PER_DEG_LAT = 111.32;

export interface DriftCorridorCell {
  row: number;
  col: number;
  lat: number;
  lng: number;
  /** Score de deriva 0..100. */
  score: number;
  depthM: number | null;
  /** Índices normalizados 0..1. */
  sstGrad: number;
  chl: number;
  fsle: number;
}

export interface DriftCorridorEnv {
  /** Corriente superficial m/s y dirección HACIA la que va (grados). */
  currentSpeedMs: number | null;
  currentDirDeg: number | null;
  /** Viento medio en nudos y dirección DE DONDE viene. */
  windKn: number | null;
  windFromDeg: number | null;
}

export interface DriftCorridor {
  id: string;
  rank: number;
  points: LatLng[];
  start: LatLng;
  end: LatLng;
  center: LatLng;
  /** Score medio del tramo 0..100. */
  score: number;
  /** Longitud del frente en km. */
  lengthKm: number;
  /** Rumbo del frente (0..359, orientación de la línea). */
  bearingDeg: number;
  /** Rumbo recomendado de la deriva (hacia dónde te lleva el agua+viento). */
  driftDirDeg: number | null;
  /** Velocidad de deriva estimada en nudos. */
  driftKn: number | null;
  /** Minutos estimados en recorrer el frente a la deriva. */
  etaMin: number | null;
  meanDepthM: number | null;
  /** Índices medios 0..1. */
  sstGrad: number;
  chlIndex: number;
  fsle: number;
  /** Confianza 0..100 (tamaño del tramo, homogeneidad y capas presentes). */
  confidence: number;
  cellCount: number;
  /** Valores reales opcionales (rellenados tras GetFeatureInfo). */
  sstC?: number | null;
  chlMg?: number | null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function corridorColor(score: number): string {
  if (score >= 75) return "#16a34a"; // excelente
  if (score >= 60) return "#eab308"; // buena
  if (score >= 45) return "#f97316"; // aceptable
  return "#ef4444"; // baja
}

export function corridorQualityLabel(score: number): string {
  if (score >= 75) return "Excelente";
  if (score >= 60) return "Buena";
  if (score >= 45) return "Aceptable";
  return "Baja";
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * KM_PER_DEG_LAT;
  const dLng = (b.lng - a.lng) * KM_PER_DEG_LAT * Math.cos(((a.lat + b.lat) / 2 / 180) * Math.PI);
  return Math.hypot(dLat, dLng);
}

export function bearingDeg(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * KM_PER_DEG_LAT;
  const dLng = (b.lng - a.lng) * KM_PER_DEG_LAT * Math.cos(((a.lat + b.lat) / 2 / 180) * Math.PI);
  const deg = (Math.atan2(dLng, dLat) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Deriva resultante: corriente + 3 % del viento (regla clásica de fluixa). */
export function driftVector(env: DriftCorridorEnv): { dirDeg: number; kn: number } | null {
  let x = 0; // este
  let y = 0; // norte
  let any = false;
  if (env.currentSpeedMs != null && env.currentDirDeg != null) {
    const r = (env.currentDirDeg * Math.PI) / 180;
    x += env.currentSpeedMs * Math.sin(r);
    y += env.currentSpeedMs * Math.cos(r);
    any = true;
  }
  if (env.windKn != null && env.windFromDeg != null) {
    const toDeg = (env.windFromDeg + 180) % 360;
    const r = (toDeg * Math.PI) / 180;
    const ms = (env.windKn / 1.94384) * 0.03;
    x += ms * Math.sin(r);
    y += ms * Math.cos(r);
    any = true;
  }
  if (!any) return null;
  const ms = Math.hypot(x, y);
  if (ms < 1e-6) return { dirDeg: 0, kn: 0 };
  const dirDeg = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
  return { dirDeg, kn: ms * 1.94384 };
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const arr = values.slice().sort((a, b) => a - b);
  const idx = q * (arr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? arr[lo] : arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

function components(cells: DriftCorridorCell[]): DriftCorridorCell[][] {
  const map = new Map<string, DriftCorridorCell>();
  for (const c of cells) map.set(`${c.row}_${c.col}`, c);
  const seen = new Set<string>();
  const out: DriftCorridorCell[][] = [];
  for (const c of cells) {
    const key = `${c.row}_${c.col}`;
    if (seen.has(key)) continue;
    const stack = [c];
    seen.add(key);
    const group: DriftCorridorCell[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      group.push(cur);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const k = `${cur.row + dr}_${cur.col + dc}`;
          if (seen.has(k)) continue;
          const nb = map.get(k);
          if (!nb) continue;
          seen.add(k);
          stack.push(nb);
        }
      }
    }
    out.push(group);
  }
  return out;
}

interface TraceResult {
  points: LatLng[];
  lengthKm: number;
}

/** Traza la línea del frente siguiendo el eje principal ponderado. */
function traceFront(
  group: DriftCorridorCell[],
  fallbackDirDeg: number | null,
  minKm: number,
): TraceResult {
  const lat0 = group.reduce((s, c) => s + c.lat, 0) / group.length;
  const kx = KM_PER_DEG_LAT * Math.cos((lat0 / 180) * Math.PI);
  const w = (c: DriftCorridorCell) => Math.pow(Math.max(0.01, c.score / 100), 2);
  const wSum = group.reduce((s, c) => s + w(c), 0);
  const cx = group.reduce((s, c) => s + w(c) * c.lng * kx, 0) / wSum;
  const cy = group.reduce((s, c) => s + w(c) * c.lat * KM_PER_DEG_LAT, 0) / wSum;

  // PCA 2×2 ponderada.
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const c of group) {
    const dx = c.lng * kx - cx;
    const dy = c.lat * KM_PER_DEG_LAT - cy;
    const ww = w(c);
    sxx += ww * dx * dx;
    syy += ww * dy * dy;
    sxy += ww * dx * dy;
  }
  sxx /= wSum;
  syy /= wSum;
  sxy /= wSum;

  let ux: number;
  let uy: number;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.max(0, (tr * tr) / 4 - det);
  const l1 = tr / 2 + Math.sqrt(disc);
  if (Math.abs(sxy) > 1e-9) {
    ux = l1 - syy;
    uy = sxy;
  } else if (sxx >= syy) {
    ux = 1;
    uy = 0;
  } else {
    ux = 0;
    uy = 1;
  }
  let norm = Math.hypot(ux, uy);
  if (!Number.isFinite(norm) || norm < 1e-9) {
    // Sin eje claro: orientamos con la dirección de la corriente.
    const d = ((fallbackDirDeg ?? 0) * Math.PI) / 180;
    ux = Math.sin(d);
    uy = Math.cos(d);
    norm = 1;
  }
  ux /= norm;
  uy /= norm;

  // Proyección sobre el eje.
  const proj = group.map((c) => {
    const dx = c.lng * kx - cx;
    const dy = c.lat * KM_PER_DEG_LAT - cy;
    return { c, t: dx * ux + dy * uy, n: -dx * uy + dy * ux };
  });
  proj.sort((a, b) => a.t - b.t);
  const tMin = proj[0].t;
  const tMax = proj[proj.length - 1].t;
  const span = Math.max(tMax - tMin, 0);

  const toLatLng = (x: number, y: number): LatLng => ({
    lat: (cy + y) / KM_PER_DEG_LAT,
    lng: (cx + x) / kx,
  });

  if (span < minKm) {
    // Tramo demasiado corto: lo extendemos a la longitud mínima manteniendo
    // la orientación del frente y su centro.
    const half = minKm / 2;
    return {
      points: [toLatLng(-half * ux, -half * uy), toLatLng(half * ux, half * uy)],
      lengthKm: minKm,
    };
  }

  const bins = Math.max(2, Math.min(24, Math.round(span / Math.max(0.4, span / 12))));
  const step = span / bins;
  const pts: LatLng[] = [];
  for (let i = 0; i <= bins; i++) {
    const t0 = tMin + i * step - step * 0.6;
    const t1 = tMin + i * step + step * 0.6;
    const inBin = proj.filter((p) => p.t >= t0 && p.t <= t1);
    if (inBin.length === 0) continue;
    const bw = inBin.reduce((s, p) => s + w(p.c), 0);
    const t = inBin.reduce((s, p) => s + w(p.c) * p.t, 0) / bw;
    const n = inBin.reduce((s, p) => s + w(p.c) * p.n, 0) / bw;
    pts.push(toLatLng(t * ux - n * uy, t * uy + n * ux));
  }
  if (pts.length < 2) {
    const half = Math.max(minKm, span) / 2;
    return {
      points: [toLatLng(-half * ux, -half * uy), toLatLng(half * ux, half * uy)],
      lengthKm: Math.max(minKm, span),
    };
  }
  let lengthKm = 0;
  for (let i = 1; i < pts.length; i++) lengthKm += haversineKm(pts[i - 1], pts[i]);
  return { points: pts, lengthKm };
}

export interface BuildCorridorsOptions {
  env: DriftCorridorEnv;
  /** Máximo de corredores devueltos (por defecto 3). */
  max?: number;
  /** Longitud mínima del corredor en km (por defecto 0.5). */
  minLengthKm?: number;
}

export function buildDriftCorridors(
  cells: DriftCorridorCell[],
  opts: BuildCorridorsOptions,
): DriftCorridor[] {
  const valid = cells.filter(
    (c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && Number.isFinite(c.score),
  );
  if (valid.length === 0) return [];

  const max = opts.max ?? 3;
  const minKm = opts.minLengthKm ?? 0.5;
  const scores = valid.map((c) => c.score);
  const best = Math.max(...scores);
  // Umbral adaptativo: nunca por encima del 88 % del mejor, nunca por debajo
  // de 30 (celdas realmente flojas no forman frente).
  const cut = Math.min(best * 0.88, Math.max(30, quantile(scores, 0.72)));
  let strong = valid.filter((c) => c.score >= cut);
  if (strong.length < 2) strong = valid.slice().sort((a, b) => b.score - a.score).slice(0, 3);

  const drift = driftVector(opts.env);
  const groups = components(strong).filter((g) => g.length >= 1);

  const built = groups.map((group) => {
    const sorted = group.slice().sort((a, b) => b.score - a.score);
    const topSlice = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.7)));
    const score = Math.round(topSlice.reduce((s, c) => s + c.score, 0) / topSlice.length);
    const { points, lengthKm } = traceFront(group, drift?.dirDeg ?? null, minKm);
    const start = points[0];
    const end = points[points.length - 1];
    const center = points[Math.floor(points.length / 2)];
    const depths = group.map((c) => c.depthM).filter((d): d is number => d != null);
    const meanDepthM = depths.length ? depths.reduce((s, d) => s + d, 0) / depths.length : null;
    const mean = (f: (c: DriftCorridorCell) => number) =>
      clamp01(group.reduce((s, c) => s + (Number.isFinite(f(c)) ? f(c) : 0), 0) / group.length);
    const sstGrad = mean((c) => c.sstGrad);
    const chlIndex = mean((c) => c.chl);
    const fsle = mean((c) => c.fsle);

    // Homogeneidad del tramo (poca dispersión = frente limpio).
    const avg = group.reduce((s, c) => s + c.score, 0) / group.length;
    const sd = Math.sqrt(
      group.reduce((s, c) => s + (c.score - avg) * (c.score - avg), 0) / group.length,
    );
    const layers = (sstGrad > 0.15 ? 1 : 0) + (chlIndex > 0.15 ? 1 : 0) + (fsle > 0.1 ? 1 : 0);
    const confidence = Math.round(
      100 *
        clamp01(
          0.35 * clamp01(lengthKm / 4) +
            0.2 * clamp01(group.length / 8) +
            0.2 * clamp01(1 - sd / 25) +
            0.15 * (layers / 3) +
            0.1 * (meanDepthM != null ? 1 : 0),
        ),
    );

    const etaMin =
      drift && drift.kn > 0.03 ? Math.round((lengthKm / 1.852 / drift.kn) * 60) : null;

    return {
      id: `${center.lat.toFixed(4)}_${center.lng.toFixed(4)}`,
      rank: 0,
      points,
      start,
      end,
      center,
      score,
      lengthKm,
      bearingDeg: Math.round(bearingDeg(start, end)),
      driftDirDeg: drift ? Math.round(drift.dirDeg) : null,
      driftKn: drift ? drift.kn : null,
      etaMin,
      meanDepthM,
      sstGrad,
      chlIndex,
      fsle,
      confidence,
      cellCount: group.length,
    } satisfies DriftCorridor;
  });

  built.sort(
    (a, b) =>
      b.score * (1 + Math.min(0.15, b.lengthKm / 40)) -
      a.score * (1 + Math.min(0.15, a.lengthKm / 40)),
  );
  return built.slice(0, max).map((c, i) => ({ ...c, rank: i + 1 }));
}

