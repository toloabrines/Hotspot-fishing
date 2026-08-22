/**
 * DEM del fondo marino: descarga, caché, muestreo y derivadas morfométricas
 * (pendiente, orientación, rugosidad y curvatura).
 *
 * Todo se calcula en cliente sobre la rejilla que sirve `/api/dem`.
 */

import { describeDemQuality, type DemQuality } from "./dem-provenance";
import { readDemCache, withDemSlot, writeDemCache } from "./dem-perf";
import type { Mbar24Status } from "./mbar24";




export interface DemBBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface DemSourceInfo {
  id: string;
  label: string;
  /** Resolución nativa aproximada en metros. */
  resM: number;
  /** Nº de celdas aportadas por esta fuente. */
  cells: number;
  /** Organismo responsable del dato. */
  provider?: string | null;
  /** Licencia declarada por el proveedor. */
  license?: string | null;
  /** ¿Permite uso comercial? */
  commercialUse?: boolean | null;
  /** Texto de atribución obligatorio. */
  attribution?: string | null;
  url?: string | null;
}


export type LandformKind =
  | "llano"
  | "veril"
  | "bajo"
  | "cima"
  | "canon"
  | "meseta"
  | "agujero"
  | "ladera"
  | "tierra"
  | "desconocido";

export interface DemPointInfo {
  /** Profundidad en metros (positiva). null en tierra o sin dato. */
  depthM: number | null;
  /** Elevación en metros (negativa bajo el mar). */
  elevM: number | null;
  /** Pendiente en grados. */
  slopeDeg: number | null;
  /** Orientación de la ladera (0 = norte, sentido horario). */
  aspectDeg: number | null;
  /** Rugosidad local (TRI, metros de variación media respecto a vecinos). */
  roughnessM: number | null;
  /** Rugosidad normalizada 0–1 (relativa a la profundidad). */
  roughness01: number | null;
  /** Curvatura (>0 cima/loma, <0 hoyo/canal). */
  curvature: number | null;
  /** Etiqueta de forma del terreno. */
  landform: LandformKind;
}

const EARTH_LAT_M = 110540;
const EARTH_LNG_M = 111320;

export class DemGrid {
  readonly cols: number;
  readonly rows: number;
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
  readonly source: string;
  /** Fuentes realmente fusionadas, de mejor a peor resolución. */
  readonly sources: DemSourceInfo[];
  /** Resolución efectiva estimada (m). */
  readonly resolutionM: number | null;
  /** Fracción de celdas con dato (0–1). */
  readonly coverage: number | null;
  /** Estado real de MBAR24 (16 m) en este bbox: esperado / cargado / motivo. */
  readonly mbar24: Mbar24Status | null;
  /** Elevación (m, negativa bajo el mar). NaN = sin dato. Fila 0 = norte. */
  readonly elev: Float32Array;
  readonly slope: Float32Array;
  readonly aspect: Float32Array;
  readonly rough: Float32Array;
  readonly curv: Float32Array;

  /** Tamaño de celda en metros. */
  readonly cellX: number;
  readonly cellY: number;

  constructor(raw: {
    cols: number;
    rows: number;
    south: number;
    west: number;
    north: number;
    east: number;
    source?: string;
    sources?: DemSourceInfo[];
    resolutionM?: number;
    coverage?: number;
    mbar24?: Mbar24Status | null;
    elev: (number | null)[];
  }) {
    this.cols = raw.cols;
    this.rows = raw.rows;
    this.south = raw.south;
    this.west = raw.west;
    this.north = raw.north;
    this.east = raw.east;
    this.source = raw.source ?? "dem";
    this.sources = raw.sources ?? [];
    this.resolutionM = raw.resolutionM ?? null;
    this.coverage = raw.coverage ?? null;
    this.mbar24 = raw.mbar24 ?? null;


    this.elev = new Float32Array(raw.cols * raw.rows);
    for (let i = 0; i < this.elev.length; i++) {
      const v = raw.elev[i];
      this.elev[i] = v == null ? NaN : v;
    }
    const midLat = ((this.north + this.south) / 2) * (Math.PI / 180);
    this.cellY = ((this.north - this.south) / this.rows) * EARTH_LAT_M;
    this.cellX = ((this.east - this.west) / this.cols) * EARTH_LNG_M * Math.cos(midLat);

    this.slope = new Float32Array(this.elev.length).fill(NaN);
    this.aspect = new Float32Array(this.elev.length).fill(NaN);
    this.rough = new Float32Array(this.elev.length).fill(NaN);
    this.curv = new Float32Array(this.elev.length).fill(NaN);
    this.computeDerivatives();
  }

  at(r: number, c: number): number {
    if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) return NaN;
    return this.elev[r * this.cols + c];
  }

  private computeDerivatives() {
    const dx = Math.max(1, Math.abs(this.cellX));
    const dy = Math.max(1, Math.abs(this.cellY));
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const z = this.at(r, c);
        const i = r * this.cols + c;
        if (!Number.isFinite(z)) continue;
        const zL = Number.isFinite(this.at(r, c - 1)) ? this.at(r, c - 1) : z;
        const zR = Number.isFinite(this.at(r, c + 1)) ? this.at(r, c + 1) : z;
        // fila 0 = norte → r+1 es hacia el sur
        const zN = Number.isFinite(this.at(r - 1, c)) ? this.at(r - 1, c) : z;
        const zS = Number.isFinite(this.at(r + 1, c)) ? this.at(r + 1, c) : z;

        const gx = (zR - zL) / (2 * dx);
        const gy = (zN - zS) / (2 * dy);
        this.slope[i] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
        let a = (Math.atan2(gx, gy) * 180) / Math.PI;
        if (a < 0) a += 360;
        this.aspect[i] = a;

        // Rugosidad TRI: media de |dz| con los 8 vecinos.
        let sum = 0;
        let cnt = 0;
        for (let rr = -1; rr <= 1; rr++) {
          for (let cc = -1; cc <= 1; cc++) {
            if (!rr && !cc) continue;
            const v = this.at(r + rr, c + cc);
            if (!Number.isFinite(v)) continue;
            sum += Math.abs(v - z);
            cnt++;
          }
        }
        this.rough[i] = cnt ? sum / cnt : NaN;

        // Curvatura (laplaciano): >0 convexo (cima/loma), <0 cóncavo.
        this.curv[i] = zL + zR + zN + zS - 4 * z;
      }
    }
  }

  contains(lat: number, lng: number) {
    return lat >= this.south && lat <= this.north && lng >= this.west && lng <= this.east;
  }

  private frac(lat: number, lng: number) {
    const fc = ((lng - this.west) / (this.east - this.west)) * this.cols - 0.5;
    const fr = ((this.north - lat) / (this.north - this.south)) * this.rows - 0.5;
    return { fr, fc };
  }

  bilinear(arr: Float32Array, lat: number, lng: number): number | null {
    const { fr, fc } = this.frac(lat, lng);
    const r0 = Math.floor(fr);
    const c0 = Math.floor(fc);
    const tr = fr - r0;
    const tc = fc - c0;
    let sum = 0;
    let wsum = 0;
    const add = (r: number, c: number, w: number) => {
      if (r < 0 || c < 0 || r >= this.rows || c >= this.cols || w <= 0) return;
      const v = arr[r * this.cols + c];
      if (!Number.isFinite(v)) return;
      sum += v * w;
      wsum += w;
    };
    add(r0, c0, (1 - tr) * (1 - tc));
    add(r0, c0 + 1, (1 - tr) * tc);
    add(r0 + 1, c0, tr * (1 - tc));
    add(r0 + 1, c0 + 1, tr * tc);
    return wsum > 0.05 ? sum / wsum : null;
  }

  elevAt(lat: number, lng: number): number | null {
    return this.bilinear(this.elev, lat, lng);
  }

  depthAt(lat: number, lng: number): number | null {
    const e = this.elevAt(lat, lng);
    if (e == null) return null;
    return e < 0 ? -e : null;
  }

  info(lat: number, lng: number): DemPointInfo {
    const elevM = this.elevAt(lat, lng);
    const slopeDeg = this.bilinear(this.slope, lat, lng);
    const aspectDeg = this.bilinear(this.aspect, lat, lng);
    const roughnessM = this.bilinear(this.rough, lat, lng);
    const curvature = this.bilinear(this.curv, lat, lng);
    const depthM = elevM != null && elevM < 0 ? -elevM : null;
    const roughness01 =
      roughnessM == null || depthM == null
        ? null
        : Math.max(0, Math.min(1, roughnessM / (2 + depthM * 0.02)));
    return {
      elevM,
      depthM,
      slopeDeg,
      aspectDeg,
      roughnessM,
      roughness01,
      curvature,
      landform: classifyLandform({ elevM, depthM, slopeDeg, roughnessM, curvature }),
    };
  }

  /** Perfil de profundidad entre dos puntos (n muestras). */
  profile(
    a: { lat: number; lng: number },
    b: { lat: number; lng: number },
    n = 160,
  ): { distM: number; depthM: number | null; lat: number; lng: number }[] {
    const out: { distM: number; depthM: number | null; lat: number; lng: number }[] = [];
    const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
    const dxM = (b.lng - a.lng) * EARTH_LNG_M * Math.cos(midLat);
    const dyM = (b.lat - a.lat) * EARTH_LAT_M;
    const total = Math.hypot(dxM, dyM);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const lat = a.lat + (b.lat - a.lat) * t;
      const lng = a.lng + (b.lng - a.lng) * t;
      out.push({ distM: total * t, depthM: this.depthAt(lat, lng), lat, lng });
    }
    return out;
  }

  /** Estadísticas de profundidad de la rejilla (para paletas adaptativas). */
  depthRange(): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.elev.length; i++) {
      const v = this.elev[i];
      if (!Number.isFinite(v) || v >= 0) continue;
      const d = -v;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    if (!Number.isFinite(min)) return { min: 0, max: 100 };
    return { min, max: Math.max(max, min + 10) };
  }

  /**
   * Calidad y procedencia real del dato de esta malla. El visor 3D la usa para
   * no representar relieve que la resolución no puede sostener.
   */
  quality(): DemQuality {
    return describeDemQuality({
      resolutionM: this.resolutionM,
      sources: this.sources,
      coverage: this.coverage,
    });
  }
}


export function classifyLandform(p: {
  elevM: number | null;
  depthM: number | null;
  slopeDeg: number | null;
  roughnessM: number | null;
  curvature: number | null;
}): LandformKind {
  if (p.elevM == null) return "desconocido";
  if (p.elevM >= 0 || p.depthM == null) return "tierra";
  const slope = p.slopeDeg ?? 0;
  const curv = p.curvature ?? 0;
  const rough = p.roughnessM ?? 0;
  const depth = p.depthM;

  if (slope >= 18) return curv < -1 ? "canon" : "veril";
  if (slope >= 8) {
    if (curv > 1) return depth < 60 ? "bajo" : "cima";
    if (curv < -1) return "canon";
    return "ladera";
  }
  if (curv > 1.5) return depth < 60 ? "bajo" : "cima";
  if (curv < -1.5) return "agujero";
  if (slope < 1.5 && rough < 1.5) return depth > 120 ? "meseta" : "llano";
  return "llano";
}

export const LANDFORM_LABEL: Record<LandformKind, string> = {
  llano: "Fondo llano",
  veril: "Veril",
  bajo: "Bajo",
  cima: "Cima / montaña submarina",
  canon: "Cañón / canal",
  meseta: "Meseta",
  agujero: "Agujero / depresión",
  ladera: "Ladera",
  tierra: "Tierra",
  desconocido: "Sin datos",
};

// ───────────────────────── Descarga + caché ─────────────────────────

const memCache = new Map<string, DemGrid>();
const inflight = new Map<string, Promise<DemGrid | null>>();
// Nunca permitir que una tesela deje el Top 1 esperando indefinidamente.
const DEM_REQUEST_TIMEOUT_MS = 6500;

function keyFor(b: DemBBox, size: number) {
  return [b.south.toFixed(3), b.west.toFixed(3), b.north.toFixed(3), b.east.toFixed(3), size].join(
    "|",
  );
}

export async function fetchDemGrid(
  bbox: DemBBox,
  size = 160,
  signal?: AbortSignal,
): Promise<DemGrid | null> {
  const key = keyFor(bbox, size);
  const hit = memCache.get(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    try {
      const url =
        `/api/dem?s=${bbox.south.toFixed(4)}&w=${bbox.west.toFixed(4)}` +
        `&n=${bbox.north.toFixed(4)}&e=${bbox.east.toFixed(4)}&size=${size}`;

      type DemResponse = {
        cols: number;
        rows: number;
        south: number;
        west: number;
        north: number;
        east: number;
        source?: string;
        sources?: DemSourceInfo[];
        resolutionM?: number;
        coverage?: number;
        mbar24?: Mbar24Status | null;
        elev: (number | null)[];
      };

      // 1. Caché persistente: una tesela ya descargada no se vuelve a pedir.
      const cached = (await readDemCache(url)) as DemResponse | null;
      let json = cached && cached.elev?.length ? cached : null;

      // 2. Red, con límite de peticiones simultáneas (clave en Android).
      if (!json) {
        json = await withDemSlot(async () => {
          if (signal?.aborted) return null;
          const ctrl = new AbortController();
          const relayAbort = () => ctrl.abort();
          signal?.addEventListener("abort", relayAbort, { once: true });
          const timer = setTimeout(() => ctrl.abort(), DEM_REQUEST_TIMEOUT_MS);
          try {
            const res = await fetch(url, { signal: ctrl.signal });
            if (!res.ok) return null;
            const body = (await res.json()) as DemResponse;
            if (!body?.elev?.length) return null;
            void writeDemCache(url, body);
            return body;
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", relayAbort);
          }
        });
      }

      if (!json?.elev?.length) return null;
      const grid = new DemGrid(json);
      memCache.set(key, grid);
      if (memCache.size > 24) {
        const first = memCache.keys().next().value;
        if (first) memCache.delete(first);
      }
      return grid;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

/** Redondea la bbox a una rejilla estable para maximizar los aciertos de caché. */
export function snapBBox(b: DemBBox, step = 0.02): DemBBox {
  const f = (v: number, dir: 1 | -1) =>
    dir > 0 ? Math.ceil(v / step) * step : Math.floor(v / step) * step;
  return {
    south: f(b.south, -1),
    west: f(b.west, -1),
    north: f(b.north, 1),
    east: f(b.east, 1),
  };
}

// ───────────── Fusión con sondas propias (máxima resolución real) ─────────────

import { fuseSoundingsIntoGrid, type SonarDataset } from "./sonar-data";

/**
 * Devuelve una malla nueva en la que las celdas cubiertas por sondas propias
 * sustituyen a la batimetría pública. Si no hay solape, devuelve la original.
 */
export function applySoundingsToGrid(grid: DemGrid, datasets: SonarDataset[]): DemGrid {
  const fused = fuseSoundingsIntoGrid(grid, datasets);
  if (!fused) return grid;
  const elev = new Array<number | null>(fused.elev.length);
  for (let i = 0; i < elev.length; i++) {
    const v = fused.elev[i];
    elev[i] = Number.isFinite(v) ? v : null;
  }
  return new DemGrid({
    cols: grid.cols,
    rows: grid.rows,
    south: grid.south,
    west: grid.west,
    north: grid.north,
    east: grid.east,
    source: `sonda+${grid.source}`,
    sources: [
      {
        id: "sonda",
        label: `Sonda propia (~${fused.resM} m)`,
        resM: fused.resM,
        cells: fused.cells,
      },
      ...grid.sources,
    ],
    resolutionM: Math.min(fused.resM, grid.resolutionM ?? fused.resM),
    coverage: grid.coverage ?? undefined,
    mbar24: grid.mbar24,
    elev,
  });
}

