/**
 * Sondas propias del usuario (ecosonda / multihaz).
 *
 * Los datos públicos (EMODnet ~115 m, GEBCO ~450 m) no pueden resolver una
 * piedra de 50 m: están por debajo del tamaño de celda. La única forma real de
 * verla es usar tus propios sondeos. Aquí se importan, se guardan en el
 * dispositivo y se fusionan con prioridad absoluta sobre la batimetría pública.
 *
 * Formatos aceptados: CSV / TXT / XYZ (lat, lon, profundidad en cualquier
 * orden razonable) y GPX (wpt/trkpt con profundidad en <ele>, <depth>, nombre
 * o descripción).
 */

export interface Sounding {
  lat: number;
  lng: number;
  /** Profundidad positiva en metros. */
  depthM: number;
  /** Marca de tiempo (ms) si procede de una grabación en navegación. */
  t?: number;
  /** Calidad del fix GPS (0 sin fix, 1 GPS, 2 DGPS/RTK) o precisión relativa. */
  q?: number;
}

export interface SonarDataset {
  id: string;
  name: string;
  createdAt: number;
  points: Sounding[];
  bounds: { south: number; west: number; north: number; east: number };
  /** Separación media estimada entre sondas (m). */
  spacingM: number;
  /** Origen: archivo importado o grabación automática en navegación. */
  kind?: "import" | "auto";
  /** Grabación en curso (se sigue ampliando). */
  recording?: boolean;
  startedAt?: number;
  endedAt?: number;
  /** Id de la sesión sincronizada en la nube, si existe. */
  cloudId?: string | null;
}

const STORE_KEY = "hf.sonar.datasets.v1";
const MAX_POINTS_TOTAL = 90000;

// ───────────────────────── Parseo ─────────────────────────

function pushValid(out: Sounding[], lat: number, lng: number, depth: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(depth)) return;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
  const d = Math.abs(depth);
  if (d < 0.2 || d > 6000) return;
  out.push({ lat, lng, depthM: Math.round(d * 100) / 100 });
}

/** CSV / TXT / XYZ con separador coma, punto y coma, tabulador o espacios. */
export function parseSoundingsCsv(text: string): Sounding[] {
  const out: Sounding[] = [];
  const lines = text.split(/\r?\n/);
  let idx: { lat: number; lng: number; depth: number } | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cells = line.split(/[,;\t]+|\s{1,}/).filter((c) => c !== "");
    if (cells.length < 3) continue;

    // Cabecera: detectar columnas por nombre.
    if (!idx && /[a-z]{3}/i.test(line) && !/^-?\d/.test(cells[0])) {
      const lower = cells.map((c) => c.toLowerCase().replace(/["']/g, ""));
      const find = (...keys: string[]) =>
        lower.findIndex((h) => keys.some((k) => h.includes(k)));
      const lat = find("lat", "latitud");
      const lng = find("lon", "lng", "longitud");
      const depth = find("depth", "prof", "sonda", "z", "ele");
      if (lat >= 0 && lng >= 0 && depth >= 0) {
        idx = { lat, lng, depth };
        continue;
      }
      continue; // cabecera no reconocida: se ignora la línea
    }

    const nums = cells.map((c) => parseFloat(c.replace(",", ".")));
    if (idx) {
      pushValid(out, nums[idx.lat], nums[idx.lng], nums[idx.depth]);
      continue;
    }
    // Sin cabecera: heurística. XYZ suele ser lon lat z; CSV suele ser lat lon z.
    const [a, b, c] = nums;
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) continue;
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180 && Math.abs(b) > 90) pushValid(out, a, b, c);
    else if (Math.abs(b) <= 90 && Math.abs(a) <= 180 && Math.abs(a) > 90) pushValid(out, b, a, c);
    else pushValid(out, a, b, c); // ambos plausibles → lat, lon
  }
  return out;
}

/** GPX/KML sencillo con profundidad en ele/depth/nombre/descripción. */
export function parseSoundingsGpx(text: string): Sounding[] {
  const out: Sounding[] = [];
  const re = /<(?:wpt|trkpt|rtept)[^>]*lat=["']([-\d.]+)["'][^>]*lon=["']([-\d.]+)["'][^>]*>([\s\S]*?)<\/(?:wpt|trkpt|rtept)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    const body = m[3];
    const dTag = /<(?:depth|ele)>\s*([-\d.]+)\s*<\//i.exec(body);
    let depth = dTag ? parseFloat(dTag[1]) : NaN;
    if (!Number.isFinite(depth) || depth === 0) {
      const txt = /<(?:name|desc|cmt)>([\s\S]*?)<\//i.exec(body)?.[1] ?? "";
      const num = /(-?\d+(?:[.,]\d+)?)\s*m?/i.exec(txt);
      if (num) depth = parseFloat(num[1].replace(",", "."));
    }
    pushValid(out, lat, lng, depth);
  }
  return out;
}

export function parseSoundingsFile(name: string, text: string): Sounding[] {
  const lower = name.toLowerCase();
  if (lower.endsWith(".gpx") || lower.endsWith(".kml") || text.trimStart().startsWith("<")) {
    const pts = parseSoundingsGpx(text);
    if (pts.length) return pts;
  }
  return parseSoundingsCsv(text);
}

// ───────────────────────── Estadística / muestreo ─────────────────────────

const LAT_M = 110540;
const LNG_M = 111320;

function estimateSpacing(points: Sounding[]): number {
  if (points.length < 4) return 50;
  const sample = points.slice(0, 400);
  const midLat = (sample[0].lat * Math.PI) / 180;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < sample.length; i++) {
    const dx = (sample[i].lng - sample[i - 1].lng) * LNG_M * Math.cos(midLat);
    const dy = (sample[i].lat - sample[i - 1].lat) * LAT_M;
    const d = Math.hypot(dx, dy);
    if (d > 0.2 && d < 500) {
      sum += d;
      n++;
    }
  }
  return n ? Math.max(1, Math.round(sum / n)) : 25;
}

function boundsOf(points: Sounding[]) {
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const p of points) {
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
    if (p.lng < west) west = p.lng;
    if (p.lng > east) east = p.lng;
  }
  return { south, west, north, east };
}

function downsample(points: Sounding[], max: number): Sounding[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out: Sounding[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[Math.floor(i)]);
  return out;
}

export function makeDataset(name: string, points: Sounding[]): SonarDataset | null {
  const pts = downsample(points, MAX_POINTS_TOTAL);
  if (!pts.length) return null;
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    createdAt: Date.now(),
    points: pts,
    bounds: boundsOf(pts),
    spacingM: estimateSpacing(pts),
  };
}

// ───────────────────────── Persistencia local ─────────────────────────

export function loadSonarDatasets(): SonarDataset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SonarDataset[];
    return Array.isArray(parsed) ? parsed.filter((d) => d?.points?.length) : [];
  } catch {
    return [];
  }
}

export function saveSonarDatasets(list: SonarDataset[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────── Fusión con el DEM público ─────────────────────────

export interface SonarFusionResult {
  /** Elevaciones fusionadas (misma malla), NaN donde no hay dato. */
  elev: Float32Array;
  /** Celdas sustituidas por sondas propias. */
  cells: number;
  /** Resolución efectiva de la parte propia (m). */
  resM: number;
}

/**
 * Sustituye las celdas de la malla por las sondas propias (media ponderada por
 * distancia inversa dentro de un radio de búsqueda). Prioridad absoluta: donde
 * hay sonda propia, se ignora la batimetría pública.
 */
export function fuseSoundingsIntoGrid(
  base: {
    cols: number;
    rows: number;
    south: number;
    west: number;
    north: number;
    east: number;
    elev: Float32Array;
  },
  datasets: SonarDataset[],
): SonarFusionResult | null {
  if (!datasets.length) return null;
  const { cols, rows, south, west, north, east } = base;
  const dLat = (north - south) / rows;
  const dLng = (east - west) / cols;
  const midLat = (((north + south) / 2) * Math.PI) / 180;
  const cellM = Math.max(
    1,
    Math.min(dLat * LAT_M, Math.abs(dLng) * LNG_M * Math.cos(midLat)),
  );

  const sum = new Float64Array(cols * rows);
  const wsum = new Float64Array(cols * rows);
  let spacing = 50;
  let used = 0;

  for (const ds of datasets) {
    if (ds.bounds.north < south || ds.bounds.south > north) continue;
    if (ds.bounds.east < west || ds.bounds.west > east) continue;
    spacing = Math.min(spacing, Math.max(2, ds.spacingM));
    // Radio de influencia: cubre el hueco entre sondas sin inventar relieve lejos.
    const radiusM = Math.max(cellM * 0.9, ds.spacingM * 1.2, 6);
    const radLat = radiusM / LAT_M;
    const radLng = radiusM / (LNG_M * Math.max(0.2, Math.cos(midLat)));
    const rSpan = Math.max(1, Math.ceil(radLat / dLat));
    const cSpan = Math.max(1, Math.ceil(radLng / Math.abs(dLng)));

    for (const p of ds.points) {
      if (p.lat < south || p.lat > north || p.lng < west || p.lng > east) continue;
      const cr = Math.round((north - p.lat) / dLat - 0.5);
      const cc = Math.round((p.lng - west) / dLng - 0.5);
      for (let r = cr - rSpan; r <= cr + rSpan; r++) {
        if (r < 0 || r >= rows) continue;
        const clat = north - (r + 0.5) * dLat;
        const dy = (clat - p.lat) * LAT_M;
        for (let c = cc - cSpan; c <= cc + cSpan; c++) {
          if (c < 0 || c >= cols) continue;
          const clng = west + (c + 0.5) * dLng;
          const dx = (clng - p.lng) * LNG_M * Math.cos(midLat);
          const dist = Math.hypot(dx, dy);
          if (dist > radiusM) continue;
          const w = 1 / (0.5 + dist * dist);
          const i = r * cols + c;
          sum[i] += -p.depthM * w;
          wsum[i] += w;
        }
      }
    }
  }

  const elev = Float32Array.from(base.elev);
  for (let i = 0; i < elev.length; i++) {
    if (wsum[i] > 0) {
      elev[i] = sum[i] / wsum[i];
      used++;
    }
  }
  if (!used) return null;
  return { elev, cells: used, resM: Math.round(spacing) };
}

// ───────────────────────── Store reactivo simple ─────────────────────────

let cache: SonarDataset[] | null = null;
const listeners = new Set<() => void>();

export function getSonarDatasets(): SonarDataset[] {
  if (cache == null) cache = loadSonarDatasets();
  return cache;
}

export function setSonarDatasets(list: SonarDataset[]): boolean {
  cache = list;
  const ok = saveSonarDatasets(list);
  listeners.forEach((fn) => fn());
  return ok;
}

export function subscribeSonarDatasets(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Nº total de sondas guardadas. */
export function sonarPointCount(): number {
  return getSonarDatasets().reduce((n, d) => n + d.points.length, 0);
}

