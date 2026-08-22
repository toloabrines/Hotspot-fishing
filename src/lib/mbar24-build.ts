/**
 * Conversión en el navegador de una hoja MBAR24 (GeoTIFF) a las teselas Int16
 * que consume `/api/dem`. Reproduce exactamente lo que hace
 * `scripts/mbar24-prepare.mjs` con GDAL, pero sin necesidad de instalar nada:
 *
 *  1. Lee el GeoTIFF (banda 1 = elevación) con geotiff.js.
 *  2. Calcula el bbox en EPSG:4326 y una rejilla regular al paso nativo (16 m).
 *  3. Remuestrea bilinealmente desde el ráster original (EPSG:3395 o 4326).
 *  4. Trocea en teselas de 256×256 Int16 en decímetros (NODATA = -32768).
 *
 * El fichero original nunca sale del dispositivo: solo se suben las teselas.
 */

import { fromBlob } from "geotiff";

import { MBAR24_NODATA, MBAR24_SCALE, MBAR24_TILE_SIZE } from "./mbar24";

const A = 6378137;
const E = 0.081819190842621;
const NATIVE_RES_M = 16;

/** EPSG:4326 → EPSG:3395 (Mercator elipsoidal WGS84). */
function toMercator(lat: number, lng: number): [number, number] {
  const phi = (lat * Math.PI) / 180;
  const s = Math.sin(phi);
  const y = A * Math.log(Math.tan(Math.PI / 4 + phi / 2) * Math.pow((1 - E * s) / (1 + E * s), E / 2));
  return [(A * lng * Math.PI) / 180, y];
}

/** EPSG:3395 → EPSG:4326 (inversa iterativa). */
function fromMercator(x: number, y: number): [number, number] {
  const lng = ((x / A) * 180) / Math.PI;
  const t = Math.exp(-y / A);
  let phi = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 8; i++) {
    const s = Math.sin(phi);
    phi = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - E * s) / (1 + E * s), E / 2));
  }
  return [(phi * 180) / Math.PI, lng];
}

export interface Mbar24BuiltTile {
  x: number;
  y: number;
  /** 256×256 Int16 little-endian. */
  data: Uint8Array;
}

export interface Mbar24BuildResult {
  sheet: string;
  south: number;
  west: number;
  north: number;
  east: number;
  cols: number;
  rows: number;
  dLat: number;
  dLng: number;
  tilesX: number;
  tilesY: number;
  tiles: Mbar24BuiltTile[];
  minElev: number;
  maxElev: number;
  srcWidth: number;
  srcHeight: number;
  srcEpsg: number;
}

export interface BuildProgress {
  phase: "validate" | "read" | "grid" | "tiles";
  pct: number;
  detail: string;
}

/** Resultado de las comprobaciones previas del fichero antes de procesarlo. */
export interface Mbar24Inspection {
  ok: boolean;
  errors: string[];
  warnings: string[];
  info: {
    fileSizeMB: number;
    width: number;
    height: number;
    epsg: number;
    isGeographic: boolean;
    resM: number;
    bbox: { south: number; west: number; north: number; east: number };
    coverageKm2: number;
    validPct: number;
    minElev: number;
    maxElev: number;
    estTiles: number;
  } | null;
}

const MAX_FILE_MB = 600;
const MIN_VALID_PCT = 2;

/**
 * Comprobaciones previas: formato, sistema de referencia, resolución, cobertura,
 * nodata y tamaño. Devuelve errores legibles antes de arrancar el proceso largo.
 */
export async function inspectMbar24File(file: File): Promise<Mbar24Inspection> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fileSizeMB = file.size / 1048576;

  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isTiff =
    (head[0] === 0x49 && head[1] === 0x49 && (head[2] === 0x2a || head[2] === 0x2b)) ||
    (head[0] === 0x4d && head[1] === 0x4d && (head[3] === 0x2a || head[3] === 0x2b));
  const isHdf5 = head[0] === 0x89 && head[1] === 0x48 && head[2] === 0x44 && head[3] === 0x46;
  if (isHdf5) {
    return {
      ok: false,
      errors: [
        "El fichero es un .bag (HDF5), que el navegador no puede leer. Descarga del IHM la variante «GeoTiff 16 M» de la misma hoja.",
      ],
      warnings,
      info: null,
    };
  }
  if (!isTiff) {
    return {
      ok: false,
      errors: ["El fichero no es un GeoTIFF válido (cabecera TIFF no reconocida)."],
      warnings,
      info: null,
    };
  }
  if (fileSizeMB > MAX_FILE_MB) {
    return {
      ok: false,
      errors: [
        `El fichero pesa ${fileSizeMB.toFixed(0)} MB y supera el máximo procesable en el navegador (${MAX_FILE_MB} MB).`,
      ],
      warnings,
      info: null,
    };
  }

  let image: Awaited<ReturnType<Awaited<ReturnType<typeof fromBlob>>["getImage"]>>;
  try {
    const tiff = await fromBlob(file);
    image = await tiff.getImage();
  } catch (e) {
    return {
      ok: false,
      errors: [
        `No se ha podido abrir el GeoTIFF: ${e instanceof Error ? e.message : "formato no soportado"}.`,
      ],
      warnings,
      info: null,
    };
  }

  const width = image.getWidth();
  const height = image.getHeight();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const keys = (image.getGeoKeys() ?? {}) as Record<string, number>;
  const epsg = Number(keys["ProjectedCSTypeGeoKey"] ?? keys["GeographicTypeGeoKey"] ?? 0);
  const isGeographic = epsg === 4326 || (!keys["ProjectedCSTypeGeoKey"] && Math.abs(ox) <= 180);

  if (!rx || !ry || !Number.isFinite(ox) || !Number.isFinite(oy)) {
    errors.push("El GeoTIFF no lleva georreferenciación (falta origen o resolución).");
  }
  if (epsg && epsg !== 3395 && epsg !== 4326) {
    errors.push(
      `Sistema de referencia EPSG:${epsg} no soportado. Descarga la hoja en EPSG:3395 (o EPSG:4326).`,
    );
  }
  if (!epsg) warnings.push("El fichero no declara EPSG; se asumirá EPSG:3395 (Mercator WGS84).");

  // Bbox geográfico.
  const x1 = ox + width * rx;
  const y1 = oy + height * ry;
  let south: number, north: number, west: number, east: number;
  if (isGeographic) {
    west = Math.min(ox, x1);
    east = Math.max(ox, x1);
    south = Math.min(oy, y1);
    north = Math.max(oy, y1);
  } else {
    const [latA, lngA] = fromMercator(Math.min(ox, x1), Math.min(oy, y1));
    const [latB, lngB] = fromMercator(Math.max(ox, x1), Math.max(oy, y1));
    south = Math.min(latA, latB);
    north = Math.max(latA, latB);
    west = Math.min(lngA, lngB);
    east = Math.max(lngA, lngB);
  }

  const resM = isGeographic ? Math.abs(rx) * 111320 * Math.cos(((south + north) / 2) * (Math.PI / 180)) : Math.abs(rx);
  if (resM > 40) {
    errors.push(
      `La resolución del ráster es de ~${resM.toFixed(0)} m: esta pantalla espera la serie de 16 m (MBAR24 «16 M»).`,
    );
  } else if (resM > 20 || resM < 12) {
    warnings.push(`Resolución detectada ~${resM.toFixed(1)} m (lo habitual en MBAR24 es 16 m).`);
  }

  if (
    !Number.isFinite(south) ||
    Math.abs(south) > 90 ||
    Math.abs(north) > 90 ||
    Math.abs(west) > 180 ||
    Math.abs(east) > 180 ||
    north <= south ||
    east <= west
  ) {
    errors.push("La cobertura geográfica del fichero no es válida tras reproyectar.");
  }

  const latKm = (north - south) * 110.54;
  const lngKm = (east - west) * 111.32 * Math.cos(((south + north) / 2) * (Math.PI / 180));
  const coverageKm2 = Math.max(0, latKm * lngKm);

  // Muestreo ligero para nodata y rango de elevación.
  let validPct = 0;
  let minElev = Infinity;
  let maxElev = -Infinity;
  try {
    const sw = Math.min(width, 384);
    const sh = Math.max(1, Math.round((sw / width) * height));
    const sample = (await image.readRasters({
      samples: [0],
      interleave: true,
      width: sw,
      height: sh,
    })) as unknown as ArrayLike<number>;
    let valid = 0;
    for (let i = 0; i < sample.length; i++) {
      const v = sample[i] as number;
      if (!Number.isFinite(v) || v <= -9000 || v > 100 || v >= 1e6) continue;
      valid++;
      if (v < minElev) minElev = v;
      if (v > maxElev) maxElev = v;
    }
    validPct = sample.length ? (valid / sample.length) * 100 : 0;
  } catch (e) {
    errors.push(
      `No se ha podido leer la banda de elevación: ${e instanceof Error ? e.message : "banda ilegible"}.`,
    );
  }

  if (!Number.isFinite(minElev)) {
    errors.push("La banda no contiene ninguna profundidad válida (todo nodata).");
    minElev = 0;
    maxElev = 0;
  } else if (validPct < MIN_VALID_PCT) {
    errors.push(
      `Solo un ${validPct.toFixed(1)}% de las celdas tienen dato (el resto es nodata): la hoja no aporta relieve utilizable.`,
    );
  } else if (validPct < 25) {
    warnings.push(`Cobertura de datos baja: ${validPct.toFixed(0)}% de celdas con dato.`);
  }

  const dLat = NATIVE_RES_M / 110540;
  const dLng = NATIVE_RES_M / (111320 * Math.cos(((south + north) / 2) * Math.PI) / 180 || 1);
  const cols = Math.max(1, Math.floor((east - west) / (NATIVE_RES_M / (111320 * Math.cos((((south + north) / 2) * Math.PI) / 180)))));
  const rows = Math.max(1, Math.floor((north - south) / dLat));
  const estTiles = Math.ceil(cols / MBAR24_TILE_SIZE) * Math.ceil(rows / MBAR24_TILE_SIZE);
  void dLng;
  if (estTiles > 4000) {
    warnings.push(
      `La hoja generará ~${estTiles} teselas: el proceso puede tardar varios minutos y consumir mucha memoria.`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    info: {
      fileSizeMB,
      width,
      height,
      epsg,
      isGeographic,
      resM,
      bbox: { south, west, north, east },
      coverageKm2,
      validPct,
      minElev,
      maxElev,
      estTiles,
    },
  };
}


export async function buildMbar24Tiles(
  file: File,
  sheetId: string,
  onProgress: (p: BuildProgress) => void,
): Promise<Mbar24BuildResult> {
  onProgress({ phase: "read", pct: 2, detail: "Abriendo GeoTIFF…" });
  const tiff = await fromBlob(file);
  const image = await tiff.getImage();
  const srcWidth = image.getWidth();
  const srcHeight = image.getHeight();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const keys = (image.getGeoKeys() ?? {}) as Record<string, number>;
  const srcEpsg = Number(keys["ProjectedCSTypeGeoKey"] ?? keys["GeographicTypeGeoKey"] ?? 0);
  const isGeographic = srcEpsg === 4326 || (!keys["ProjectedCSTypeGeoKey"] && Math.abs(ox) <= 180);

  onProgress({
    phase: "read",
    pct: 8,
    detail: `Leyendo banda de elevación (${srcWidth}×${srcHeight}, EPSG:${srcEpsg || "?"})…`,
  });
  const rasters = await image.readRasters({ samples: [0], interleave: true });
  const src = rasters as unknown as Float32Array | Int16Array | Int32Array | Float64Array;

  // Bbox del ráster en coordenadas nativas → geográficas.
  const x0 = ox;
  const y0 = oy;
  const x1 = ox + srcWidth * rx;
  const y1 = oy + srcHeight * ry;
  let north: number, south: number, west: number, east: number;
  if (isGeographic) {
    west = Math.min(x0, x1);
    east = Math.max(x0, x1);
    south = Math.min(y0, y1);
    north = Math.max(y0, y1);
  } else {
    const [latA, lngA] = fromMercator(Math.min(x0, x1), Math.min(y0, y1));
    const [latB, lngB] = fromMercator(Math.max(x0, x1), Math.max(y0, y1));
    south = Math.min(latA, latB);
    north = Math.max(latA, latB);
    west = Math.min(lngA, lngB);
    east = Math.max(lngA, lngB);
  }

  const latMid = (south + north) / 2;
  const dLat = NATIVE_RES_M / 110540;
  const dLng = NATIVE_RES_M / (111320 * Math.cos((latMid * Math.PI) / 180));
  const cols = Math.max(1, Math.floor((east - west) / dLng));
  const rows = Math.max(1, Math.floor((north - south) / dLat));
  const gridEast = west + cols * dLng;
  const gridSouth = north - rows * dLat;

  onProgress({
    phase: "grid",
    pct: 15,
    detail: `Remuestreando a EPSG:4326 · ${cols}×${rows} celdas (16 m)…`,
  });

  const grid = new Int16Array(cols * rows).fill(MBAR24_NODATA);
  let minElev = Infinity;
  let maxElev = -Infinity;

  const sample = (px: number, py: number): number => {
    // Bilineal sobre el ráster original, descartando NODATA.
    const fx = Math.floor(px);
    const fy = Math.floor(py);
    if (fx < 0 || fy < 0 || fx >= srcWidth - 1 || fy >= srcHeight - 1) return NaN;
    const tx = px - fx;
    const ty = py - fy;
    let sum = 0;
    let wsum = 0;
    for (let j = 0; j <= 1; j++) {
      for (let i = 0; i <= 1; i++) {
        const v = src[(fy + j) * srcWidth + (fx + i)] as number;
        if (!Number.isFinite(v) || v <= -9000 || v > 100 || v >= 1e6) continue;
        const wgt = (i ? tx : 1 - tx) * (j ? ty : 1 - ty);
        sum += v * wgt;
        wsum += wgt;
      }
    }
    return wsum > 0.35 ? sum / wsum : NaN;
  };

  for (let r = 0; r < rows; r++) {
    const lat = north - (r + 0.5) * dLat;
    for (let c = 0; c < cols; c++) {
      const lng = west + (c + 0.5) * dLng;
      let px: number, py: number;
      if (isGeographic) {
        px = (lng - x0) / rx;
        py = (lat - y0) / ry;
      } else {
        const [mx, my] = toMercator(lat, lng);
        px = (mx - x0) / rx;
        py = (my - y0) / ry;
      }
      const v = sample(px, py);
      if (!Number.isFinite(v)) continue;
      const dm = Math.round(v / MBAR24_SCALE);
      if (dm <= MBAR24_NODATA || dm > 32767) continue;
      grid[r * cols + c] = dm;
      if (v < minElev) minElev = v;
      if (v > maxElev) maxElev = v;
    }
    if (r % 128 === 0) {
      onProgress({
        phase: "grid",
        pct: 15 + Math.round((r / rows) * 55),
        detail: `Remuestreando fila ${r}/${rows}…`,
      });
      // Cede el hilo para que la UI siga respondiendo.
      await new Promise((res) => setTimeout(res, 0));
    }
  }

  if (!Number.isFinite(minElev)) {
    throw new Error(
      "El fichero no contiene valores de elevación válidos (¿es un BAG en vez de GeoTIFF?).",
    );
  }

  const TS = MBAR24_TILE_SIZE;
  const tilesX = Math.ceil(cols / TS);
  const tilesY = Math.ceil(rows / TS);
  const tiles: Mbar24BuiltTile[] = [];
  onProgress({ phase: "tiles", pct: 72, detail: `Generando ${tilesX * tilesY} teselas…` });

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const tile = new Int16Array(TS * TS).fill(MBAR24_NODATA);
      let valid = 0;
      for (let y = 0; y < TS; y++) {
        const sy = ty * TS + y;
        if (sy >= rows) break;
        for (let x = 0; x < TS; x++) {
          const sx = tx * TS + x;
          if (sx >= cols) break;
          const v = grid[sy * cols + sx];
          if (v === MBAR24_NODATA) continue;
          tile[y * TS + x] = v;
          valid++;
        }
      }
      if (valid === 0) continue; // tesela vacía: no se publica
      tiles.push({ x: tx, y: ty, data: new Uint8Array(tile.buffer.slice(0)) });
    }
    onProgress({
      phase: "tiles",
      pct: 72 + Math.round(((ty + 1) / tilesY) * 20),
      detail: `Teselas ${tiles.length} generadas…`,
    });
    await new Promise((res) => setTimeout(res, 0));
  }

  return {
    sheet: sheetId,
    south: gridSouth,
    west,
    north,
    east: gridEast,
    cols,
    rows,
    dLat,
    dLng,
    tilesX,
    tilesY,
    tiles,
    minElev,
    maxElev,
    srcWidth,
    srcHeight,
    srcEpsg,
  };
}

/** Uint8Array → base64 (por trozos, para no reventar la pila). */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

