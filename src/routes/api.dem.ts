import { createFileRoute } from "@tanstack/react-router";
import UPNG from "upng-js";
import { parseTiffGrid } from "../lib/dem-tiff";
import { DEM_SOURCE_LICENSES, isCommerciallyUsable } from "../lib/dem-provenance";
import {
  MBAR24_NODATA,
  MBAR24_SCALE,
  MBAR24_TILE_SIZE,
  mbar24Base,
  sheetIntersects,
  expectedMbar24Sheet,
  type Mbar24Index,
  type Mbar24SheetIndex,
  type Mbar24Status,
} from "../lib/mbar24";



/**
 * DEM (rejilla de profundidad) por bbox — FUSIÓN MULTI-FUENTE.
 *
 *   GET /api/dem?s=39.4&w=2.4&n=39.7&e=2.8&size=220
 *
 * Estrategia: no dependemos de un único dataset. Para cada zona se consultan
 * en paralelo todas las fuentes disponibles y se combinan celda a celda,
 * dando prioridad SIEMPRE a la de mayor resolución con dato válido:
 *
 *  1. EMODnet Bathymetry DTM HR (~115 m; agrega multihaz, monohaz, LiDAR
 *     costero y cartas de los servicios hidrográficos europeos).
 *  2. EMODnet "mean" (capa base del mismo servicio, cobertura más completa).
 *  3. NOAA NCEI DEM mosaic (multihaz + LiDAR costero, muy alta resolución
 *     donde existe: EE. UU., Caribe, Pacífico y campañas globales).
 *  4. Teselas globales "terrarium" (GEBCO/SRTM) como red de seguridad.
 *
 * Al mezclar, cada fuente secundaria se corrige con el desplazamiento
 * (mediana de diferencias en las celdas solapadas) respecto a la fuente
 * principal, para que no aparezcan escalones artificiales en las costuras.
 *
 * Respuesta JSON:
 *   { cols, rows, south, west, north, east, source, sources[], coverage,
 *     resolutionM, elev: (number|null)[] }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface Grid {
  width: number;
  height: number;
  data: Float32Array; // fila 0 = norte
}

interface SourceResult {
  id: string;
  label: string;
  /** Resolución nativa aproximada en metros (menor = mejor). */
  resM: number;
  grid: Grid | null;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function validRatio(grid: Grid): number {
  let valid = 0;
  for (let i = 0; i < grid.data.length; i++) if (Number.isFinite(grid.data[i])) valid++;
  return valid / Math.max(1, grid.data.length);
}

// ───────── EMODnet (WCS GeoTIFF Float32) ─────────

async function fetchEmodnetCoverage(
  coverage: string,
  s: number,
  w: number,
  n: number,
  e: number,
  cols: number,
  rows: number,
): Promise<Grid | null> {
  const url =
    `https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=1.0.0&request=GetCoverage` +
    `&coverage=${encodeURIComponent(coverage)}&CRS=EPSG:4326&BBOX=${w},${s},${e},${n}` +
    `&WIDTH=${cols}&HEIGHT=${rows}&FORMAT=GeoTIFF`;
  const res = await fetchWithTimeout(url, 12000);
  if (!res) return null;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("tif")) return null;
  try {
    const grid = parseTiffGrid(await res.arrayBuffer());
    if (validRatio(grid) < 0.02) return null;
    return grid;
  } catch {
    return null;
  }
}

// ───────── NOAA NCEI (ArcGIS ImageServer, multihaz + LiDAR) ─────────

async function fetchNcei(
  s: number,
  w: number,
  n: number,
  e: number,
  cols: number,
  rows: number,
): Promise<Grid | null> {
  const url =
    `https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_all/ImageServer/exportImage` +
    `?bbox=${w},${s},${e},${n}&bboxSR=4326&imageSR=4326&size=${cols},${rows}` +
    `&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image`;
  const res = await fetchWithTimeout(url, 12000);
  if (!res) return null;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("tif")) return null;
  try {
    const grid = parseTiffGrid(await res.arrayBuffer());
    // El mosaico devuelve valores centinela muy negativos fuera de cobertura.
    for (let i = 0; i < grid.data.length; i++) {
      const v = grid.data[i];
      if (!Number.isFinite(v) || v < -11500 || v > 9000) grid.data[i] = NaN;
    }
    if (validRatio(grid) < 0.02) return null;
    return grid;
  } catch {
    return null;
  }
}

// ───────── Fallback global: teselas terrarium (GEBCO/SRTM) ─────────

const TILE = 256;

function lngToTileX(lng: number, z: number) {
  return ((lng + 180) / 360) * Math.pow(2, z);
}
function latToTileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
}

// ───────── MBAR24 (IHM) — teselas propias de 16 m ─────────

/**
 * Caché del índice por origen. El resultado negativo se recuerda solo 60 s para
 * que en cuanto se publiquen las teselas el visor pase a 16 m sin reiniciar.
 */
const mbarIndexCache = new Map<string, { at: number; index: Mbar24Index | null }>();

async function loadMbar24Index(origin: string): Promise<Mbar24Index | null> {
  const now = Date.now();
  const hit = mbarIndexCache.get(origin);
  if (hit) {
    const ttl = hit.index ? 10 * 60 * 1000 : 60 * 1000;
    if (now - hit.at < ttl) return hit.index;
  }
  const res = await fetchWithTimeout(`${mbar24Base(origin)}/index.json`, 6000);
  let index: Mbar24Index | null = null;
  if (res && res.ok) {
    // El dev-server devuelve index.html (200) para rutas inexistentes: hay que
    // validar que realmente sea el índice y no el HTML de la SPA.
    try {
      const text = await res.text();
      if (text.trim().startsWith("{")) {
        const json = JSON.parse(text) as Mbar24Index;
        if (json && Array.isArray(json.sheets) && json.sheets.length > 0) index = json;
      }
    } catch {
      index = null;
    }
  }
  // Hojas subidas desde la pantalla de administración (bucket privado).
  try {
    const { readCloudIndex } = await import("@/lib/mbar24-storage.server");
    const cloud = await readCloudIndex();
    if (cloud && cloud.sheets.length > 0) {
      const sheets = [...(index?.sheets ?? [])];
      for (const s of cloud.sheets) {
        const i = sheets.findIndex((x) => x.sheet === s.sheet);
        const withFlag = { ...s, storage: true };
        if (i >= 0) sheets[i] = withFlag;
        else sheets.push(withFlag);
      }
      index = { version: 1, generatedAt: new Date().toISOString(), sheets };
    }
  } catch {
    /* sin bucket disponible */
  }
  mbarIndexCache.set(origin, { at: now, index });
  return index;
}


/**
 * Muestrea las teselas MBAR24 que cubren el bbox. Solo se descargan las teselas
 * necesarias (128 KB cada una), nunca la hoja completa.
 */
// Evita que una vista amplia dispare cientos de descargas y bloquee el móvil.
// A esa escala el detalle de 16 m no es perceptible y EMODnet es suficiente.
const MBAR24_MAX_TILES = 64;
/** Caché caliente del Worker: evita volver a bajar la misma tesela de 128 KB. */
const mbarTileCache = new Map<string, Promise<Int16Array | null>>();
const MBAR24_TILE_CACHE_LIMIT = 128;

type Mbar24Result =
  | { grid: Grid; sheet: Mbar24SheetIndex; cells: number; reason: null }
  | { grid: null; sheet: Mbar24SheetIndex | null; cells: 0; reason: string };

async function fetchMbar24(
  origin: string,
  s: number,
  w: number,
  n: number,
  e: number,
  cols: number,
  rows: number,
): Promise<Mbar24Result> {
  const index = await loadMbar24Index(origin);
  if (!index) {
    return {
      grid: null,
      sheet: null,
      cells: 0,
      reason: "No hay public/mbar24/index.json: las teselas MBAR24 no están publicadas.",
    };
  }
  const sheet = index.sheets.find((sh) => sheetIntersects(sh, s, w, n, e));
  if (!sheet) {
    return { grid: null, sheet: null, cells: 0, reason: "El bbox no solapa ninguna hoja MBAR24." };
  }

  const ts = sheet.tileSize || MBAR24_TILE_SIZE;
  const colOf = (lng: number) => Math.floor((lng - sheet.west) / sheet.dLng);
  const rowOf = (lat: number) => Math.floor((sheet.north - lat) / sheet.dLat);

  // El rango de teselas depende solo del bbox. Antes se recorrían cientos de
  // miles de celdas únicamente para descubrir estos pocos identificadores.
  const clipW = Math.max(w, sheet.west);
  const clipE = Math.min(e, sheet.east);
  const clipN = Math.min(n, sheet.north);
  const clipS = Math.max(s, sheet.south);
  const firstCol = Math.max(0, Math.min(sheet.cols - 1, colOf(clipW)));
  const lastCol = Math.max(
    0,
    Math.min(sheet.cols - 1, colOf(clipE - Math.abs(sheet.dLng) * 1e-6)),
  );
  const firstRow = Math.max(
    0,
    Math.min(sheet.rows - 1, rowOf(clipN - Math.abs(sheet.dLat) * 1e-6)),
  );
  const lastRow = Math.max(
    0,
    Math.min(sheet.rows - 1, rowOf(clipS + Math.abs(sheet.dLat) * 1e-6)),
  );

  const need = new Set<string>();
  if (clipE > clipW && clipN > clipS && lastCol >= firstCol && lastRow >= firstRow) {
    for (let ty = Math.floor(firstRow / ts); ty <= Math.floor(lastRow / ts); ty++) {
      for (let tx = Math.floor(firstCol / ts); tx <= Math.floor(lastCol / ts); tx++) {
        need.add(`${tx}/${ty}`);
      }
    }
  }
  if (need.size === 0) {
    return { grid: null, sheet, cells: 0, reason: "Ninguna celda del bbox cae dentro de la hoja." };
  }
  if (need.size > MBAR24_MAX_TILES) {
    // Vista tan amplia que a 16 m no aporta detalle visible: no se descarga
    // parcialmente (daría una malla a trozos), se cede a EMODnet.
    return {
      grid: null,
      sheet,
      cells: 0,
      reason: `Vista demasiado amplia (${need.size} teselas): a esta escala MBAR24 no aporta detalle.`,
    };
  }

  const base = mbar24Base(origin);
  const cloudTile = sheet.storage
    ? (await import("@/lib/mbar24-storage.server")).downloadCloudTile
    : null;
  const loadTile = (key: string): Promise<Int16Array | null> => {
    const cacheKey = `${sheet.storage ? "cloud" : base}|${sheet.sheet}|${key}`;
    const cached = mbarTileCache.get(cacheKey);
    if (cached) return cached;

    const pending = (async () => {
      let buf: ArrayBuffer | null = null;
      if (cloudTile) {
        buf = await cloudTile(sheet.sheet, key);
      } else {
        const res = await fetchWithTimeout(`${base}/${sheet.sheet}/${key}.bin`, 8000);
        if (!res || !res.ok) return null;
        try {
          buf = await res.arrayBuffer();
        } catch {
          buf = null;
        }
      }
      if (!buf || buf.byteLength < ts * ts * 2) return null;
      return new Int16Array(buf, 0, ts * ts);
    })();

    mbarTileCache.set(cacheKey, pending);
    void pending.then((tile) => {
      if (!tile) mbarTileCache.delete(cacheKey);
      while (mbarTileCache.size > MBAR24_TILE_CACHE_LIMIT) {
        const oldest = mbarTileCache.keys().next().value;
        if (oldest) mbarTileCache.delete(oldest);
        else break;
      }
    });
    return pending;
  };

  const tiles = new Map<string, Int16Array>();
  await Promise.all(
    Array.from(need).map(async (key) => {
      const tile = await loadTile(key);
      if (tile) tiles.set(key, tile);
    }),
  );

  if (tiles.size === 0) {
    return {
      grid: null,
      sheet,
      cells: 0,
      reason: "El índice existe pero no se pudo leer ninguna tesela .bin de la hoja.",
    };
  }

  const data = new Float32Array(cols * rows);
  data.fill(NaN);
  let valid = 0;
  for (let r = 0; r < rows; r++) {
    const lat = n - ((n - s) * (r + 0.5)) / rows;
    const sr = rowOf(lat);
    if (sr < 0 || sr >= sheet.rows) continue;
    for (let c = 0; c < cols; c++) {
      const lng = w + ((e - w) * (c + 0.5)) / cols;
      const sc = colOf(lng);
      if (sc < 0 || sc >= sheet.cols) continue;
      const tile = tiles.get(`${Math.floor(sc / ts)}/${Math.floor(sr / ts)}`);
      if (!tile) continue;
      const v = tile[(sr % ts) * ts + (sc % ts)];
      if (v === MBAR24_NODATA) continue;
      data[r * cols + c] = v * MBAR24_SCALE;
      valid++;
    }
  }
  if (valid === 0) {
    return { grid: null, sheet, cells: 0, reason: "Las teselas de la zona solo contienen NODATA." };
  }
  return { grid: { width: cols, height: rows, data }, sheet, cells: valid, reason: null };
}

async function fetchTerrarium(

  s: number,
  w: number,
  n: number,
  e: number,
  cols: number,
  rows: number,
): Promise<Grid | null> {
  let z = 13;
  while (z > 2) {
    const dx = lngToTileX(e, z) - lngToTileX(w, z);
    const dy = latToTileY(s, z) - latToTileY(n, z);
    if (Math.max(dx, dy) <= 3) break;
    z--;
  }
  const x0 = Math.floor(lngToTileX(w, z));
  const x1 = Math.floor(lngToTileX(e, z));
  const y0 = Math.floor(latToTileY(n, z));
  const y1 = Math.floor(latToTileY(s, z));
  const tiles: { x: number; y: number; rgba: Uint8Array }[] = [];
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1 && x <= x0 + 3; x++) {
    for (let y = y0; y <= y1 && y <= y0 + 3; y++) {
      jobs.push(
        (async () => {
          const res = await fetchWithTimeout(
            `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
            10000,
          );
          if (!res) return;
          try {
            const bytes = new Uint8Array(await res.arrayBuffer());
            const img = UPNG.decode(
              bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ) as ArrayBuffer,
            );
            const rgba = new Uint8Array(UPNG.toRGBA8(img)[0]);
            tiles.push({ x, y, rgba });
          } catch {
            /* tesela corrupta */
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);
  if (tiles.length === 0) return null;

  const byKey = new Map(tiles.map((t) => [`${t.x}/${t.y}`, t.rgba]));
  const data = new Float32Array(cols * rows);
  data.fill(NaN);

  for (let r = 0; r < rows; r++) {
    const lat = n - ((n - s) * (r + 0.5)) / rows;
    const fy = latToTileY(lat, z);
    const ty = Math.floor(fy);
    const py = Math.min(TILE - 1, Math.floor((fy - ty) * TILE));
    for (let c = 0; c < cols; c++) {
      const lng = w + ((e - w) * (c + 0.5)) / cols;
      const fx = lngToTileX(lng, z);
      const tx = Math.floor(fx);
      const px = Math.min(TILE - 1, Math.floor((fx - tx) * TILE));
      const rgba = byKey.get(`${tx}/${ty}`);
      if (!rgba) continue;
      const i = (py * TILE + px) * 4;
      const elev = rgba[i] * 256 + rgba[i + 1] + rgba[i + 2] / 256 - 32768;
      data[r * cols + c] = Number.isFinite(elev) ? elev : NaN;
    }
  }
  return { width: cols, height: rows, data };
}

// ───────── Utilidades de fusión ─────────

function resample(grid: Grid, cols: number, rows: number): Float32Array {
  if (grid.width === cols && grid.height === rows) return grid.data;
  const out = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const sy = Math.min(grid.height - 1, Math.floor(((r + 0.5) / rows) * grid.height));
    for (let c = 0; c < cols; c++) {
      const sx = Math.min(grid.width - 1, Math.floor(((c + 0.5) / cols) * grid.width));
      out[r * cols + c] = grid.data[sy * grid.width + sx];
    }
  }
  return out;
}

/** Mediana de la diferencia (base − candidata) en las celdas comunes. */
function medianOffset(base: Float32Array, cand: Float32Array): number {
  const diffs: number[] = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[i];
    const b = cand[i];
    if (Number.isFinite(a) && Number.isFinite(b)) diffs.push(a - b);
    if (diffs.length > 6000) break;
  }
  if (diffs.length < 30) return 0;
  diffs.sort((x, y) => x - y);
  const m = diffs[Math.floor(diffs.length / 2)];
  return Math.abs(m) < 400 ? m : 0;
}

/** Rellena huecos pequeños con la media de vecinos válidos (2 pasadas). */
function fillGaps(data: Float32Array, cols: number, rows: number, passes = 2): void {
  for (let p = 0; p < passes; p++) {
    const copy = Float32Array.from(data);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (Number.isFinite(copy[i])) continue;
        let sum = 0;
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
            const v = copy[rr * cols + cc];
            if (Number.isFinite(v)) {
              sum += v;
              n++;
            }
          }
        }
        if (n >= 3) data[i] = sum / n;
      }
    }
  }
}

export const Route = createFileRoute("/api/dem")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const s = parseFloat(url.searchParams.get("s") ?? "");
        const w = parseFloat(url.searchParams.get("w") ?? "");
        const n = parseFloat(url.searchParams.get("n") ?? "");
        const e = parseFloat(url.searchParams.get("e") ?? "");
        const size = Math.max(
          32,
          Math.min(1280, parseInt(url.searchParams.get("size") ?? "200", 10)),
        );

        if (![s, w, n, e].every(Number.isFinite) || n <= s || e <= w) {
          return new Response(JSON.stringify({ error: "bad-bbox" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const aspect = (e - w) / Math.max(1e-6, n - s);
        const cols = Math.max(32, Math.min(1280, Math.round(aspect >= 1 ? size : size * aspect)));
        const rows = Math.max(32, Math.min(1280, Math.round(aspect >= 1 ? size / aspect : size)));

        // Vía rápida exclusiva para la capa 2D MBAR24. Esa capa ya recorta el
        // bbox a la hoja IHM, por lo que no debe esperar fuentes externas.
        if (url.searchParams.get("source") === "mbar24") {
          const expectedSheet = expectedMbar24Sheet(s, w, n, e);
          const mbar = await fetchMbar24(url.origin, s, w, n, e, cols, rows).catch(
            (err): Mbar24Result => ({
              grid: null,
              sheet: null,
              cells: 0,
              reason: `Error leyendo teselas MBAR24: ${String(err)}`,
            }),
          );
          const sheet = mbar.sheet;
          const mbarStatus: Mbar24Status = {
            expected: expectedSheet != null,
            sheet: sheet?.sheet ?? expectedSheet?.sheet ?? null,
            loaded: mbar.grid != null && mbar.cells > 0,
            cells: mbar.cells,
            reason:
              mbar.grid != null && mbar.cells > 0
                ? null
                : (mbar.reason ?? "No se pudo cargar la cobertura MBAR24."),
          };

          if (!mbar.grid || !sheet || mbar.cells <= 0) {
            return new Response(JSON.stringify({ error: "mbar24-unavailable", mbar24: mbarStatus }), {
              status: 503,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
              },
            });
          }

          const merged = resample(mbar.grid, cols, rows);
          const elev = new Array<number | null>(merged.length);
          let valid = 0;
          for (let i = 0; i < merged.length; i++) {
            const value = merged[i];
            if (Number.isFinite(value)) {
              elev[i] = Math.round(value * 10) / 10;
              valid++;
            } else {
              elev[i] = null;
            }
          }

          const nativeResM = sheet.nativeResM ?? 16;
          const cellM = ((n - s) * 110540) / rows;
          const license = DEM_SOURCE_LICENSES.mbar24;
          const label = `MBAR24 IHM ${sheet.sheet} (${nativeResM} m)`;
          const sourceInfo = {
            id: "mbar24",
            label,
            resM: nativeResM,
            cells: valid,
            provider: license?.provider ?? sheet.provider ?? null,
            license: license?.license ?? sheet.license ?? null,
            commercialUse: license?.commercialUse ?? null,
            attribution: license?.attribution ?? sheet.attribution ?? label,
            url: license?.url ?? null,
          };

          return new Response(
            JSON.stringify({
              cols,
              rows,
              south: s,
              west: w,
              north: n,
              east: e,
              source: "mbar24",
              sources: [sourceInfo],
              attribution: sourceInfo.attribution,
              coverage: Math.round((valid / Math.max(1, merged.length)) * 100) / 100,
              resolutionM: Math.max(nativeResM, Math.round(cellM)),
              mbar24: { ...mbarStatus, cells: valid, loaded: valid > 0 },
              elev,
            }),
            {
              status: 200,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
              },
            },
          );
        }

        // Todas las fuentes en paralelo — luego se combinan por prioridad.
        const [mbar, emodMean, emodPrev, ncei, terra] = await Promise.all([
          fetchMbar24(url.origin, s, w, n, e, cols, rows).catch(
            (err): Mbar24Result => ({
              grid: null,
              sheet: null,
              cells: 0,
              reason: `Error leyendo teselas MBAR24: ${String(err)}`,
            }),
          ),
          fetchEmodnetCoverage("emodnet:mean", s, w, n, e, cols, rows).catch(() => null),
          fetchEmodnetCoverage("emodnet:mean_2022", s, w, n, e, cols, rows).catch(() => null),
          fetchNcei(s, w, n, e, cols, rows).catch(() => null),
          fetchTerrarium(s, w, n, e, cols, rows).catch(() => null),
        ]);

        const expectedSheet = expectedMbar24Sheet(s, w, n, e);
        const mbarSheet = mbar.sheet;

        const candidates: SourceResult[] = [
          // MBAR24 (IHM, 16 m) manda dentro de su hoja; fuera cae a EMODnet/GEBCO.
          {
            id: "mbar24",
            label: mbarSheet
              ? `MBAR24 IHM ${mbarSheet.sheet} (${mbarSheet.nativeResM} m)`
              : "MBAR24",
            resM: mbarSheet?.nativeResM ?? expectedSheet?.nativeResM ?? 16,
            grid: mbar.grid,
          },

          { id: "emodnet", label: "EMODnet DTM 2024 (~115 m)", resM: 115, grid: emodMean },
          { id: "ncei", label: "NOAA NCEI multihaz/LiDAR", resM: 120, grid: ncei },
          { id: "emodnet_2022", label: "EMODnet DTM 2022", resM: 130, grid: emodPrev },
          { id: "gebco", label: "GEBCO/SRTM global", resM: 450, grid: terra },
        ]
          // Salvaguarda legal: solo fuentes con uso comercial autorizado.
          .filter((c) => c.grid != null && isCommerciallyUsable(c.id))
          .sort((a, b) => a.resM - b.resM);



        if (candidates.length === 0) {
          return new Response(JSON.stringify({ error: "no-data" }), {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const merged = Float32Array.from(resample(candidates[0].grid!, cols, rows));
        const used: { id: string; label: string; resM: number; cells: number }[] = [];
        let filled = 0;
        for (let i = 0; i < merged.length; i++) if (Number.isFinite(merged[i])) filled++;
        used.push({
          id: candidates[0].id,
          label: candidates[0].label,
          resM: candidates[0].resM,
          cells: filled,
        });


        for (let k = 1; k < candidates.length; k++) {
          if (filled >= merged.length) break;
          const cand = resample(candidates[k].grid!, cols, rows);
          const off = medianOffset(merged, cand);
          let added = 0;
          for (let i = 0; i < merged.length; i++) {
            if (Number.isFinite(merged[i])) continue;
            const v = cand[i];
            if (!Number.isFinite(v)) continue;
            merged[i] = v + off;
            added++;
          }
          if (added > 0) {
            filled += added;
            used.push({
              id: candidates[k].id,
              label: candidates[k].label,
              resM: candidates[k].resM,
              cells: added,
            });
          }
        }

        fillGaps(merged, cols, rows);

        const elev = new Array<number | null>(merged.length);
        let ok = 0;
        for (let i = 0; i < merged.length; i++) {
          const v = merged[i];
          if (Number.isFinite(v)) {
            elev[i] = Math.round(v * 10) / 10;
            ok++;
          } else elev[i] = null;
        }

        const cellM = ((n - s) * 110540) / rows;
        const bestRes = Math.max(used[0].resM, Math.round(cellM));

        const usedWithLicense = used.map((u) => {
          const lic = DEM_SOURCE_LICENSES[u.id];
          return {
            ...u,
            provider: lic?.provider ?? null,
            license: lic?.license ?? null,
            commercialUse: lic?.commercialUse ?? null,
            attribution: lic?.attribution ?? u.label,
            url: lic?.url ?? null,
          };
        });

        const mbarCells = used.find((u) => u.id === "mbar24")?.cells ?? 0;
        const mbar24Status: Mbar24Status = {
          expected: expectedSheet != null,
          sheet: mbarSheet?.sheet ?? expectedSheet?.sheet ?? null,
          loaded: mbarCells > 0,
          cells: mbarCells,
          reason:
            mbarCells > 0
              ? null
              : (mbar.reason ??
                (expectedSheet
                  ? "Teselas MBAR24 no publicadas en public/mbar24/."
                  : "Fuera de cobertura MBAR24.")),
        };

        return new Response(
          JSON.stringify({

            cols,
            rows,
            south: s,
            west: w,
            north: n,
            east: e,
            source: used.map((u) => u.id).join("+"),
            sources: usedWithLicense,
            attribution: usedWithLicense
              .map((u) => u.attribution)
              .filter((v, i, a) => a.indexOf(v) === i)
              .join(" · "),
            coverage: Math.round((ok / merged.length) * 100) / 100,
            resolutionM: bestRes,
            mbar24: mbar24Status,
            elev,

          }),

          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=86400",
            },
          },
        );
      },
    },
  },
});
