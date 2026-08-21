/**
 * Interpolación bicúbica para grillas de profundidad (batimetría).
 *
 * Motivación
 * ──────────
 * Las muestras puntuales de EMODnet/GEBCO viven en una rejilla discreta. Los
 * cálculos de pendiente, rugosidad y transición son MUY sensibles a:
 *   - huecos (celdas sin lectura por timeout o sin cobertura),
 *   - ruido de baja resolución (saltos artificiales entre celdas vecinas).
 *
 * La interpolación bicúbica (kernel Catmull-Rom) suaviza el campo y rellena
 * huecos usando los 4×4 vecinos más cercanos con pesos cúbicos. No inventa
 * resolución real, pero produce un campo coherente, sin escalones, que
 * mejora notablemente los gradientes derivados.
 *
 * API
 * ───
 * - `bicubicFillGrid(grid, side)` → devuelve una nueva grilla del mismo
 *   tamaño con huecos rellenos por interpolación bicúbica de los valores
 *   válidos cercanos. Las celdas con valor original se conservan tal cual.
 *
 * - `bicubicSmoothGrid(grid, side, alpha=0.35)` → suaviza la grilla
 *   completa mezclando cada celda con su valor bicúbico:
 *   `out = (1-α)·orig + α·bicubic`. Solo donde hay original; preserva
 *   huecos null que `bicubicFillGrid` debe haber rellenado antes.
 *
 * Ambas funciones son puras: no mutan la entrada.
 */

/** Kernel Catmull-Rom (a = -0.5). t ∈ [0,1]. */
function catmullRom(t: number): number {
  const a = -0.5;
  const t2 = t * t;
  const t3 = t2 * t;
  if (t < 1) return (a + 2) * t3 - (a + 3) * t2 + 1;
  if (t < 2) return a * t3 - 5 * a * t2 + 8 * a * t - 4 * a;
  return 0;
}

/** Lectura segura de la grilla (devuelve null si fuera de rango). */
function get(grid: (number | null)[], side: number, r: number, c: number): number | null {
  if (r < 0 || c < 0 || r >= side || c >= side) return null;
  return grid[r * side + c];
}

/**
 * Interpolación bicúbica en (rf, cf) — coordenadas continuas en la grilla.
 * Tolera huecos: ignora vecinos null y renormaliza los pesos. Si no hay
 * suficientes vecinos válidos en el patch 4×4, devuelve null.
 */
function bicubicAt(grid: (number | null)[], side: number, rf: number, cf: number): number | null {
  const r0 = Math.floor(rf);
  const c0 = Math.floor(cf);
  const dr = rf - r0;
  const dc = cf - c0;

  let sum = 0;
  let wsum = 0;
  let validCount = 0;

  for (let i = -1; i <= 2; i++) {
    const wy = catmullRom(Math.abs(i - dr));
    if (wy === 0) continue;
    for (let j = -1; j <= 2; j++) {
      const wx = catmullRom(Math.abs(j - dc));
      if (wx === 0) continue;
      const v = get(grid, side, r0 + i, c0 + j);
      if (v == null) continue;
      const w = wx * wy;
      sum += v * w;
      wsum += w;
      validCount++;
    }
  }

  // Necesitamos al menos 4 vecinos válidos para una estimación razonable.
  if (validCount < 4 || wsum <= 0) return null;
  return sum / wsum;
}

/**
 * Rellena huecos (null) por interpolación bicúbica de los valores existentes.
 * Las celdas con valor original se conservan sin tocar.
 *
 * Si una celda no puede interpolarse (vecindario insuficiente), se deja en
 * null — el motor de scoring decidirá qué hacer (usualmente, la descarta).
 */
export function bicubicFillGrid(grid: (number | null)[], side: number): (number | null)[] {
  const out = grid.slice();
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      const idx = r * side + c;
      if (out[idx] != null) continue;
      const v = bicubicAt(grid, side, r, c);
      if (v != null) out[idx] = v;
    }
  }
  return out;
}

/**
 * Suaviza la grilla mezclando cada celda con su estimación bicúbica.
 * `alpha` controla el peso del suavizado (0 = sin tocar, 1 = todo bicúbica).
 * Recomendado: 0.25-0.4 para limpiar ruido sin perder detalle real.
 */
export function bicubicSmoothGrid(
  grid: (number | null)[],
  side: number,
  alpha = 0.3,
): (number | null)[] {
  const a = Math.max(0, Math.min(1, alpha));
  const out = grid.slice();
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      const idx = r * side + c;
      const orig = out[idx];
      if (orig == null) continue;
      const v = bicubicAt(grid, side, r, c);
      if (v == null) continue;
      out[idx] = (1 - a) * orig + a * v;
    }
  }
  return out;
}

