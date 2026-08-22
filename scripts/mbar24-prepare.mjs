#!/usr/bin/env node
/**
 * Preprocesa una hoja MBAR24 del IHM (.bag / .tif) a teselas ligeras para el
 * visor 3D de Hotspot Fishing.
 *
 *   node scripts/mbar24-prepare.mjs MBAR2024_16_ES400425_EPSG3395.bag
 *
 * Requiere GDAL en el equipo (gdalwarp + gdalinfo). En macOS: `brew install gdal`.
 *
 * Qué hace:
 *   1. Reproyecta la hoja a EPSG:4326 con paso equivalente a su resolución
 *      nativa (16 m) — sin remuestrear a peor, sin inventar detalle.
 *   2. Convierte a teselas Int16 (decímetros) de 256×256, fila 0 = norte.
 *   3. Escribe `public/mbar24/<HOJA>/<x>/<y>.bin` + `public/mbar24/index.json`
 *      con procedencia, licencia y resolución real.
 *
 * El .bag original (33 MB) NO se sube al repo ni se envía al cliente: solo
 * viajan las teselas del bbox visible (~128 KB cada una).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TILE = 256;
const NODATA = -32768;
const SCALE = 0.1; // decímetros
const NATIVE_RES_M = 16;

const SHEET_META = {
  ES400425: {
    sheet: "ES400425",
    product: "MBAR24 — Aproches de Alcudia (ES400425), 16 m",
    provider: "Instituto Hidrográfico de la Marina (IHM), Armada Española",
    license: "CC-BY-NC 4.0",
    attribution: "MBAR24 2024 CC-BY-NC 4.0 ihm.es — Instituto Hidrográfico de la Marina",
    expect: {
      srcWidth: 4159,
      srcHeight: 2951,
      srcEpsg: 3395,
      bbox: [3.06835755, 39.70660848, 3.66613247, 40.03343406],
      minElev: -1061.07,
      maxElev: 0.42,
    },
  },
};

const src = process.argv[2];
// Nombre legible opcional: node scripts/mbar24-prepare.mjs <fichero> "Bahía de Palma"
const sheetName = process.argv[3];
if (!src || !fs.existsSync(src)) {
  console.error(
    'Uso: node scripts/mbar24-prepare.mjs <ruta al .bag o .tif de MBAR24> ["Nombre de la hoja"]',
  );
  process.exit(1);
}

const sheetId = (path.basename(src).match(/ES\d{6}/) ?? [null])[0];
if (!sheetId) {
  console.error("No se pudo deducir el identificador de hoja (ESxxxxxx) del nombre del fichero.");
  process.exit(1);
}
// Hojas nuevas (p. ej. Bahía de Palma): metadatos genéricos derivados del propio
// fichero; sólo las hojas verificadas traen comprobaciones fijas en SHEET_META.
const meta = SHEET_META[sheetId] ?? {
  sheet: sheetId,
  product: `MBAR24 — ${sheetName ?? sheetId} (${sheetId}), 16 m`,
  provider: "Instituto Hidrográfico de la Marina (IHM), Armada Española",
  license: "CC-BY-NC 4.0",
  attribution: "MBAR24 2024 CC-BY-NC 4.0 ihm.es — Instituto Hidrográfico de la Marina",
  expect: {},
};


function gdal(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

// ───── 1. Metadatos del original y verificación ─────
const info = JSON.parse(gdal("gdalinfo", ["-json", src]));
const [sw, sh] = info.size;
const epsg = Number(info.coordinateSystem?.wkt?.match(/ID\["EPSG",(\d+)\]\s*\]?\s*$/)?.[1] ?? 0);
console.log(`Origen: ${sw}×${sh} px, EPSG:${epsg || "?"}`);
const exp = meta.expect;
if (exp.srcWidth && (sw !== exp.srcWidth || sh !== exp.srcHeight)) {
  console.warn(
    `AVISO: dimensiones ${sw}×${sh} distintas de las verificadas ${exp.srcWidth}×${exp.srcHeight}.`,
  );
}

// ───── 2. Reproyección a EPSG:4326 al paso nativo ─────
const extent = info.wgs84Extent?.coordinates?.[0] ?? null;
const extLats = extent ? extent.map((c) => c[1]) : null;
const latMid = exp.bbox
  ? (exp.bbox[1] + exp.bbox[3]) / 2
  : extLats
    ? (Math.min(...extLats) + Math.max(...extLats)) / 2
    : 39.6;
const dLat = NATIVE_RES_M / 110540;
const dLng = NATIVE_RES_M / (111320 * Math.cos((latMid * Math.PI) / 180));
const tmp = path.join(os.tmpdir(), `mbar24_${sheetId}.tif`);
console.log("Reproyectando a EPSG:4326 (bilineal, paso nativo 16 m)…");
gdal("gdalwarp", [
  "-overwrite",
  // El BAG trae 2 bandas (elevation + uncertainty): SOLO la de elevación.
  // Sin esto el ENVI resultante entrelaza bandas y las teselas salen corruptas.
  "-b", "1",
  "-srcnodata", "1000000",
  "-t_srs", "EPSG:4326",
  "-tr", String(dLng), String(dLat),
  "-r", "bilinear",
  "-dstnodata", "-9999",
  "-of", "GTiff",
  "-co", "TILED=NO",
  "-co", "COMPRESS=NONE",
  "-ot", "Float32",
  src,
  tmp,
]);

const wInfo = JSON.parse(gdal("gdalinfo", ["-json", "-stats", tmp]));
const [cols, rows] = wInfo.size;
const gt = wInfo.geoTransform; // [originX, pxW, 0, originY, 0, -pxH]
const west = gt[0];
const north = gt[3];
const east = west + cols * gt[1];
const south = north + rows * gt[5];
const band = wInfo.bands[0];
console.log(
  `Rejilla 4326: ${cols}×${rows} · bbox ${west.toFixed(6)},${south.toFixed(6)} → ` +
    `${east.toFixed(6)},${north.toFixed(6)} · elev ${band.minimum} … ${band.maximum}`,
);

const near = (a, b, tol) => Math.abs(a - b) <= tol;
if (
  exp.bbox &&
  (!near(west, exp.bbox[0], 0.01) ||
    !near(south, exp.bbox[1], 0.01) ||
    !near(east, exp.bbox[2], 0.01) ||
    !near(north, exp.bbox[3], 0.01))
) {
  console.warn("AVISO: el bbox no coincide con el verificado. Revisa la hoja antes de publicar.");
}
if (exp.minElev && !near(band.minimum, exp.minElev, 5)) {
  console.warn(`AVISO: mínimo ${band.minimum} vs verificado ${exp.minElev}.`);
}

// ───── 3. Lectura cruda y teselado ─────
const rawPath = path.join(os.tmpdir(), `mbar24_${sheetId}.bin`);
gdal("gdal_translate", [
  "-of", "ENVI",
  "-b", "1",
  "-ot", "Float32",
  "-co", "INTERLEAVE=BSQ",
  tmp,
  rawPath,
]);
const raw = fs.readFileSync(rawPath);
const values = new Float32Array(raw.buffer, raw.byteOffset, cols * rows);

const outDir = path.join("public", "mbar24", sheetId);
fs.rmSync(outDir, { recursive: true, force: true });
const tilesX = Math.ceil(cols / TILE);
const tilesY = Math.ceil(rows / TILE);
let written = 0;

for (let ty = 0; ty < tilesY; ty++) {
  for (let tx = 0; tx < tilesX; tx++) {
    const tile = new Int16Array(TILE * TILE).fill(NODATA);
    let valid = 0;
    for (let y = 0; y < TILE; y++) {
      const sy = ty * TILE + y;
      if (sy >= rows) break;
      for (let x = 0; x < TILE; x++) {
        const sx = tx * TILE + x;
        if (sx >= cols) break;
        const v = values[sy * cols + sx];
        if (!Number.isFinite(v) || v <= -9000 || v > 100) continue;
        const dm = Math.round(v / SCALE);
        if (dm <= NODATA || dm > 32767) continue;
        tile[y * TILE + x] = dm;
        valid++;
      }
    }
    if (valid === 0) continue; // tesela vacía: no se publica
    const dir = path.join(outDir, String(tx));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${ty}.bin`), Buffer.from(tile.buffer));
    written++;
  }
}

// ───── 4. Índice con procedencia ─────
const indexPath = path.join("public", "mbar24", "index.json");
let index = { version: 1, generatedAt: new Date().toISOString(), sheets: [] };
if (fs.existsSync(indexPath)) {
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    /* índice corrupto: se regenera */
  }
}
index.generatedAt = new Date().toISOString();
index.sheets = (index.sheets ?? []).filter((s) => s.sheet !== sheetId);
index.sheets.push({
  sheet: sheetId,
  product: meta.product,
  provider: meta.provider,
  license: meta.license,
  attribution: meta.attribution,
  nativeResM: NATIVE_RES_M,
  south,
  west,
  north,
  east,
  cols,
  rows,
  dLat: Math.abs(gt[5]),
  dLng: gt[1],
  tileSize: TILE,
  tilesX,
  tilesY,
  checks: {
    srcWidth: sw,
    srcHeight: sh,
    srcEpsg: epsg || exp.srcEpsg,
    minElev: band.minimum,
    maxElev: band.maximum,
  },
});
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

console.log(`OK · ${written} teselas escritas en ${outDir} · índice: ${indexPath}`);

