import { DemGrid } from "./dem";

/**
 * Sobremuestreo bicúbico (Catmull-Rom) de una malla DEM.
 *
 * Es SÓLO visual: no añade información nueva, únicamente reconstruye el campo
 * de forma continua entre las muestras reales del GeoTIFF, de manera que:
 *   - desaparece el patrón de píxeles y el escalonado de los contornos,
 *   - las isóbatas salen redondeadas en lugar de dentadas,
 *   - las posiciones se conservan (el kernel es interpolante: en las muestras
 *     originales devuelve exactamente el valor original).
 */

function catmullRom(t: number): number {
  const a = -0.5;
  const t2 = t * t;
  const t3 = t2 * t;
  if (t < 1) return (a + 2) * t3 - (a + 3) * t2 + 1;
  if (t < 2) return a * t3 - 5 * a * t2 + 8 * a * t - 4 * a;
  return 0;
}

function sampleBicubic(
  src: Float32Array,
  cols: number,
  rows: number,
  rf: number,
  cf: number,
): number {
  const r0 = Math.floor(rf);
  const c0 = Math.floor(cf);
  const dr = rf - r0;
  const dc = cf - c0;
  let sum = 0;
  let wsum = 0;
  let valid = 0;
  for (let i = -1; i <= 2; i++) {
    const wy = catmullRom(Math.abs(i - dr));
    if (wy === 0) continue;
    const rr = Math.min(rows - 1, Math.max(0, r0 + i));
    for (let j = -1; j <= 2; j++) {
      const wx = catmullRom(Math.abs(j - dc));
      if (wx === 0) continue;
      const cc = Math.min(cols - 1, Math.max(0, c0 + j));
      const v = src[rr * cols + cc];
      if (!Number.isFinite(v)) continue;
      const w = wx * wy;
      sum += v * w;
      wsum += w;
      valid++;
    }
  }
  if (valid < 4 || wsum === 0) return NaN;
  return sum / wsum;
}

/**
 * Devuelve una nueva `DemGrid` con `factor`× más muestras por eje, interpoladas
 * bicúbicamente. `factor <= 1` devuelve la malla original.
 */
export function upsampleDemGrid(grid: DemGrid, factor: number, maxCells = 4_000_000): DemGrid {
  const f = Math.floor(factor);
  if (f <= 1) return grid;
  const cols = grid.cols * f;
  const rows = grid.rows * f;
  if (cols * rows > maxCells) return grid;

  const out: (number | null)[] = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    // Centro de la subcelda expresado en coordenadas de la malla original.
    const rf = (r + 0.5) / f - 0.5;
    for (let c = 0; c < cols; c++) {
      const cf = (c + 0.5) / f - 0.5;
      const v = sampleBicubic(grid.elev, grid.cols, grid.rows, rf, cf);
      out[r * cols + c] = Number.isFinite(v) ? v : null;
    }
  }

  return new DemGrid({
    cols,
    rows,
    south: grid.south,
    west: grid.west,
    north: grid.north,
    east: grid.east,
    source: grid.source,
    sources: grid.sources,
    resolutionM: grid.resolutionM ?? undefined,
    coverage: grid.coverage ?? undefined,
    mbar24: grid.mbar24,
    elev: out,
  });
}

