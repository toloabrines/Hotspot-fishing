/**
 * MBAR24 (IHM) — batimetría de alta resolución preprocesada a teselas propias.
 *
 * El .bag/GeoTIFF original (33 MB por hoja, HDF5/BAG o GeoTIFF Float32) NUNCA se
 * envía al cliente. `scripts/mbar24-prepare.mjs` lo convierte a una pirámide de
 * teselas Int16 en EPSG:4326 (decímetros) + un `index.json` con la procedencia.
 * El Worker (`/api/dem`) lee solo las teselas que caen en el bbox pedido y las
 * fusiona con EMODnet/GEBCO, así que el iPhone recibe siempre la misma malla
 * ligera de siempre, pero con el dato real de 16 m donde existe.
 *
 * Formato de tesela: Int16 little-endian, 256×256, fila 0 = norte,
 * valor = profundidad/elevación en decímetros (NODATA = -32768).
 */

export const MBAR24_TILE_SIZE = 256;
export const MBAR24_NODATA = -32768;
/** Los valores van en decímetros para caber en Int16 sin perder detalle útil. */
export const MBAR24_SCALE = 0.1;

export interface Mbar24SheetIndex {
  /** Identificador de hoja, p. ej. "ES400425". */
  sheet: string;
  product: string;
  provider: string;
  license: string;
  attribution: string;
  /** Resolución nativa del producto original (m). */
  nativeResM: number;
  /** Rejilla regular en grados. */
  south: number;
  west: number;
  north: number;
  east: number;
  cols: number;
  rows: number;
  dLat: number;
  dLng: number;
  tileSize: number;
  tilesX: number;
  tilesY: number;
  /** true → las teselas viven en el bucket privado `mbar24` (subidas desde la app). */
  storage?: boolean;

  /** Comprobaciones del fichero original, para validar la conversión. */
  checks?: {
    srcWidth?: number;
    srcHeight?: number;
    srcEpsg?: number;
    minElev?: number;
    maxElev?: number;
  };
}

export interface Mbar24Index {
  version: 1;
  generatedAt: string;
  sheets: Mbar24SheetIndex[];
}

/** Base pública de las teselas (mismo origen por defecto). */
export function mbar24Base(origin: string): string {
  const env =
    typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {};
  const configured = env["MBAR24_TILES_URL"];
  if (configured && /^https?:\/\//.test(configured)) return configured.replace(/\/$/, "");
  return `${origin.replace(/\/$/, "")}/mbar24`;
}

export function sheetIntersects(
  sheet: { south: number; west: number; north: number; east: number },
  s: number,
  w: number,
  n: number,
  e: number,
): boolean {
  return !(sheet.north <= s || sheet.south >= n || sheet.east <= w || sheet.west >= e);
}

/**
 * Cobertura oficial declarada de las hojas MBAR24 que la app sabe usar.
 * Sirve para saber si en un bbox DEBERÍA haber 16 m, aunque las teselas no
 * estén generadas todavía: así el HUD puede avisar en vez de fingir 16 m.
 */
export const MBAR24_KNOWN_SHEETS: {
  sheet: string;
  name: string;
  nativeResM: number;
  south: number;
  west: number;
  north: number;
  east: number;
}[] = [
  {
    sheet: "ES400425",
    name: "Aproches de Alcudia",
    nativeResM: 16,
    south: 39.70660848,
    west: 3.06835755,
    north: 40.03343406,
    east: 3.66613247,
  },
  {
    sheet: "ES400421",
    name: "Bahía de Palma",
    nativeResM: 16,
    south: 39.29578826637817,
    west: 2.199003950301859,
    north: 39.633353870304134,
    east: 2.8166136744397123,
  },
];

export interface Mbar24Coverage {
  sheet: string;
  name: string;
  nativeResM: number;
  south: number;
  west: number;
  north: number;
  east: number;
}

let coverageCache: Mbar24Coverage[] | null = null;

/**
 * Cobertura real publicada: se lee de `/mbar24/index.json`, de modo que en
 * cuanto se generan las teselas de una hoja nueva (p. ej. la Bahía de Palma)
 * el mapa 2D la usa sin tocar código. Si el índice no está disponible se
 * usa la lista estática de hojas conocidas.
 */
export async function fetchMbar24Coverage(signal?: AbortSignal): Promise<Mbar24Coverage[]> {
  if (coverageCache) return coverageCache;
  try {
    const res = await fetch("/api/mbar24-index", { signal });
    if (res.ok) {

      const json = (await res.json()) as Mbar24Index;
      if (Array.isArray(json?.sheets) && json.sheets.length > 0) {
        coverageCache = json.sheets.map((s) => ({
          sheet: s.sheet,
          name: s.product ?? s.sheet,
          nativeResM: s.nativeResM ?? 16,
          south: s.south,
          west: s.west,
          north: s.north,
          east: s.east,
        }));
        return coverageCache;
      }
    }
  } catch {
    /* sin índice: fallback estático */
  }
  coverageCache = MBAR24_KNOWN_SHEETS.map((s) => ({ ...s }));
  return coverageCache;
}

/** Hoja oficial cuya cobertura solapa el bbox pedido (o null). */
export function expectedMbar24Sheet(s: number, w: number, n: number, e: number) {
  return MBAR24_KNOWN_SHEETS.find((sh) => sheetIntersects(sh, s, w, n, e)) ?? null;
}


/** Estado de MBAR24 para un bbox, tal y como se devuelve en /api/dem. */
export interface Mbar24Status {
  /** El bbox cae dentro de una hoja oficial conocida. */
  expected: boolean;
  /** Hoja esperada (identificador). */
  sheet: string | null;
  /** Las teselas se han cargado y han aportado dato real. */
  loaded: boolean;
  /** Celdas de la malla servidas realmente por MBAR24. */
  cells: number;
  /** Motivo legible cuando expected && !loaded. */
  reason: string | null;
}


