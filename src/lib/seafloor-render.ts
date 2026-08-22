import type { DemGrid } from "./dem";
import type { SeafloorSettings } from "./seafloor.types";

/**
 * Render del DEM a una imagen RGBA (una muestra por celda de la rejilla):
 * paleta de profundidad + hillshade + mapa de pendientes + rugosidad.
 */

type RGB = [number, number, number];

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function ramp(stops: { d: number; c: RGB }[], depth: number): RGB {
  if (depth <= stops[0].d) return stops[0].c;
  const last = stops[stops.length - 1];
  if (depth >= last.d) return last.c;
  for (let i = 1; i < stops.length; i++) {
    if (depth <= stops[i].d) {
      const a = stops[i - 1];
      const b = stops[i];
      const t = (depth - a.d) / Math.max(1e-6, b.d - a.d);
      return [lerp(a.c[0], b.c[0], t), lerp(a.c[1], b.c[1], t), lerp(a.c[2], b.c[2], t)];
    }
  }
  return last.c;
}

/**
 * Paleta "pesca": azul oscuro → azul medio → turquesa, sin blancos.
 * Los tonos claros sólo aparecen en el veril somero (arena suave).
 */
const PALETTE_FISHING: { d: number; c: RGB }[] = [
  { d: 0, c: [150, 198, 190] },
  { d: 5, c: [120, 186, 186] },
  { d: 10, c: [92, 172, 182] },
  { d: 15, c: [70, 154, 178] },
  { d: 20, c: [56, 136, 170] },
  { d: 30, c: [44, 118, 158] },
  { d: 50, c: [34, 100, 144] },
  { d: 80, c: [27, 84, 128] },
  { d: 120, c: [21, 68, 110] },
  { d: 200, c: [16, 53, 92] },
  { d: 400, c: [11, 38, 71] },
  { d: 800, c: [7, 25, 50] },
  { d: 2000, c: [4, 14, 32] },
];


const PALETTE_CLASSIC: { d: number; c: RGB }[] = [
  { d: 0, c: [186, 224, 245] },
  { d: 10, c: [150, 205, 236] },
  { d: 20, c: [120, 186, 227] },
  { d: 60, c: [78, 152, 208] },
  { d: 150, c: [50, 118, 182] },
  { d: 400, c: [30, 82, 146] },
  { d: 1000, c: [18, 48, 104] },
  { d: 2500, c: [8, 22, 58] },
];

/** Verde (llano) → amarillo (media) → rojo (veril fuerte). */
function slopeColor(slopeDeg: number): RGB {
  const stops: { d: number; c: RGB }[] = [
    { d: 0, c: [40, 160, 90] },
    { d: 3, c: [120, 200, 70] },
    { d: 8, c: [240, 214, 60] },
    { d: 16, c: [244, 148, 40] },
    { d: 28, c: [214, 45, 40] },
  ];
  return ramp(stops, slopeDeg);
}

/** Rugosidad: transparente sobre arena, magenta/naranja sobre roca. */
function roughnessAlpha(rough01: number): number {
  return Math.max(0, Math.min(0.85, (rough01 - 0.18) * 1.4));
}

/**
 * Suavizado separable (media ponderada 1-2-1) del campo de elevación.
 * Sólo se usa para el sombreado y el color: el dato real nunca se altera.
 */
function smoothField(src: Float32Array | number[], cols: number, rows: number, passes: number) {
  let cur = Float32Array.from(src as ArrayLike<number>);
  const tmp = new Float32Array(cur.length);
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const v = cur[i];
        if (!Number.isFinite(v)) {
          tmp[i] = v;
          continue;
        }
        const a = c > 0 && Number.isFinite(cur[i - 1]) ? cur[i - 1] : v;
        const b = c < cols - 1 && Number.isFinite(cur[i + 1]) ? cur[i + 1] : v;
        tmp[i] = (a + 2 * v + b) / 4;
      }
    }
    // vertical
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const v = tmp[i];
        if (!Number.isFinite(v)) {
          cur[i] = v;
          continue;
        }
        const a = r > 0 && Number.isFinite(tmp[i - cols]) ? tmp[i - cols] : v;
        const b = r < rows - 1 && Number.isFinite(tmp[i + cols]) ? tmp[i + cols] : v;
        cur[i] = (a + 2 * v + b) / 4;
      }
    }
  }
  return cur;
}

export function renderDemImage(grid: DemGrid, s: SeafloorSettings): ImageData {
  const { cols, rows } = grid;
  const img = new ImageData(cols, rows);
  const px = img.data;
  const stops = s.palette === "clasica" ? PALETTE_CLASSIC : PALETTE_FISHING;

  const az = ((360 - s.sunAzimuth + 90) * Math.PI) / 180;
  const alt = (s.sunAltitude * Math.PI) / 180;
  const boost = Math.max(1, Math.min(4, s.reliefBoost ?? 1));
  const zFactor = 1.6 * boost; // exageración vertical del relieve (suavizada)
  const dx = Math.max(1, Math.abs(grid.cellX));
  const dy = Math.max(1, Math.abs(grid.cellY));
  // Contraste ajustable: sólo afecta a la representación (color y sombreado),
  // nunca al dato de profundidad.
  const contrast = Math.max(0.5, Math.min(2.2, s.contrast ?? 1));
  const intensity = Math.max(0, Math.min(1.5, s.hillshadeIntensity * contrast * 0.85));
  /** Curva de contraste suave alrededor del gris medio, sin quemar luces. */
  const applyContrast = (v: number) => {
    const k = 1 + (contrast - 1) * 0.5;
    return Math.max(0, Math.min(235, 118 + (v - 118) * k));
  };

  // Campo suavizado: redondea piedras y montículos y elimina el escalonado
  // pixelado y las rayas horizontales del dato original.
  const passes = Math.max(0, Math.min(2, Math.floor(s.smoothingPasses ?? (boost > 1 ? 2 : 1))));
  const zs = smoothField(grid.elev as unknown as number[], cols, rows, passes);
  const at = (r: number, c: number) => {
    if (r < 0 || c < 0 || r >= rows || c >= cols) return NaN;
    return zs[r * cols + c];
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const o = i * 4;
      const zRaw = grid.elev[i];
      if (!Number.isFinite(zRaw) || zRaw >= 0) {
        px[o + 3] = 0; // tierra o sin dato → transparente
        continue;
      }
      const z = Number.isFinite(zs[i]) ? zs[i] : zRaw;
      const depth = -z;
      let [rr, gg, bb] = ramp(stops, depth);

      if (s.slope) {
        const sl = grid.slope[i];
        if (Number.isFinite(sl)) {
          const sc = slopeColor(sl);
          const w = 0.78;
          rr = lerp(rr, sc[0], w);
          gg = lerp(gg, sc[1], w);
          bb = lerp(bb, sc[2], w);
        }
      }

      if (s.roughness) {
        const rgh = grid.rough[i];
        if (Number.isFinite(rgh)) {
          const rough01 = Math.max(0, Math.min(1, rgh / (2 + depth * 0.02)));
          const w = roughnessAlpha(rough01);
          if (w > 0) {
            // roca: marrón oscuro; grietas fuertes: naranja
            const rc: RGB = rough01 > 0.6 ? [232, 128, 40] : [104, 74, 52];
            rr = lerp(rr, rc[0], w);
            gg = lerp(gg, rc[1], w);
            bb = lerp(bb, rc[2], w);
          }
        }
      }

      if (s.hillshade) {
        const zL = Number.isFinite(at(r, c - 1)) ? at(r, c - 1) : z;
        const zR = Number.isFinite(at(r, c + 1)) ? at(r, c + 1) : z;
        const zN = Number.isFinite(at(r - 1, c)) ? at(r - 1, c) : z;
        const zS = Number.isFinite(at(r + 1, c)) ? at(r + 1, c) : z;
        const gx = ((zR - zL) / (2 * dx)) * zFactor;
        const gy = ((zN - zS) / (2 * dy)) * zFactor;
        const slopeR = Math.atan(Math.hypot(gx, gy));
        const aspectR = Math.atan2(gy, -gx);
        // Iluminación multidireccional suave: una luz principal y dos de
        // relleno a ±70°. Marca todas las orientaciones del relieve sin
        // generar franjas ni sombras planas en un solo eje.
        const lights: { az: number; w: number; alt: number }[] = [
          { az, w: 0.55, alt },
          { az: az - (70 * Math.PI) / 180, w: 0.25, alt: alt * 0.9 },
          { az: az + (70 * Math.PI) / 180, w: 0.2, alt: alt * 1.1 },
        ];
        let hs = 0;
        for (const li of lights) {
          const v =
            Math.cos(li.alt) * Math.sin(slopeR) * Math.cos(li.az - aspectR) +
            Math.sin(li.alt) * Math.cos(slopeR);
          hs += li.w * Math.max(0, Math.min(1, v));
        }
        hs = Math.max(0, Math.min(1, hs));
        // mezcla: 1 = sin sombra, factor <1 oscurece, >1 ilumina (poco)
        let f = 1 + (hs - 0.62) * 1.1 * intensity;
        if (boost > 1) {
          // Realce local suave (unsharp sobre el campo redondeado): marca
          // piedras y cantos reales sin crear rayas ni brillos duros.
          const mean = (zL + zR + zN + zS) / 4;
          const detail = z - mean; // + = resalte, - = hoyo
          const amp = Math.max(-0.28, Math.min(0.22, detail * 0.45 * boost));
          f += amp;
        }

        // Sombras profundas permitidas, luces contenidas: nada de blancos.
        f = Math.max(0.45, Math.min(1.22, f));
        rr = Math.max(0, Math.min(235, rr * f));
        gg = Math.max(0, Math.min(240, gg * f));
        bb = Math.max(0, Math.min(248, bb * f));
      }

      if (contrast !== 1) {
        rr = applyContrast(rr);
        gg = applyContrast(gg);
        bb = applyContrast(bb);
      }

      // Tinte marino: cualquier zona que tienda al blanco vuelve al azul/turquesa.
      const lum = (rr + gg + bb) / 3;
      if (lum > 150) {
        const t = Math.min(0.75, (lum - 150) / 110);
        rr = lerp(rr, 74, t);
        gg = lerp(gg, 150, t);
        bb = lerp(bb, 176, t);
      }

      px[o] = rr;
      px[o + 1] = gg;
      px[o + 2] = bb;
      px[o + 3] = 255;
    }
  }
  return img;
}



/**
 * Niveles de isóbatas según el tramo de profundidad:
 * 5 m (0–50), 10 m (50–100), 25 m (100–300), 50 m (>300).
 */
export function contourLevels(minDepth: number, maxDepth: number): number[] {
  const levels: number[] = [];
  const push = (from: number, to: number, step: number) => {
    const start = Math.ceil(Math.max(from, minDepth) / step) * step;
    for (let d = start; d <= Math.min(to, maxDepth); d += step) {
      if (d > 0) levels.push(d);
    }
  };
  push(0, 50, 5);
  push(50, 100, 10);
  push(100, 300, 25);
  push(300, Math.max(300, maxDepth), 50);
  return Array.from(new Set(levels)).sort((a, b) => a - b);
}

export function isMasterLevel(depth: number): boolean {
  if (depth <= 50) return depth % 10 === 0;
  if (depth <= 100) return depth % 50 === 0;
  if (depth <= 300) return depth % 100 === 0;
  return depth % 250 === 0;
}

export interface ContourSegment {
  a: { lat: number; lng: number };
  b: { lat: number; lng: number };
}

/** Marching squares sobre la rejilla de profundidad. */
export function contourSegments(grid: DemGrid, depth: number): ContourSegment[] {
  const level = -depth; // elevación objetivo
  const segs: ContourSegment[] = [];
  const dLat = (grid.north - grid.south) / grid.rows;
  const dLng = (grid.east - grid.west) / grid.cols;
  const latOf = (r: number) => grid.north - (r + 0.5) * dLat;
  const lngOf = (c: number) => grid.west + (c + 0.5) * dLng;

  const interp = (
    v1: number,
    v2: number,
    p1: { lat: number; lng: number },
    p2: { lat: number; lng: number },
  ) => {
    const t = (level - v1) / (v2 - v1 || 1e-6);
    return { lat: p1.lat + (p2.lat - p1.lat) * t, lng: p1.lng + (p2.lng - p1.lng) * t };
  };

  for (let r = 0; r < grid.rows - 1; r++) {
    for (let c = 0; c < grid.cols - 1; c++) {
      const v00 = grid.at(r, c);
      const v01 = grid.at(r, c + 1);
      const v11 = grid.at(r + 1, c + 1);
      const v10 = grid.at(r + 1, c);
      if (![v00, v01, v11, v10].every(Number.isFinite)) continue;
      const p00 = { lat: latOf(r), lng: lngOf(c) };
      const p01 = { lat: latOf(r), lng: lngOf(c + 1) };
      const p11 = { lat: latOf(r + 1), lng: lngOf(c + 1) };
      const p10 = { lat: latOf(r + 1), lng: lngOf(c) };

      const idx =
        (v00 > level ? 8 : 0) | (v01 > level ? 4 : 0) | (v11 > level ? 2 : 0) | (v10 > level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;

      const top = () => interp(v00, v01, p00, p01);
      const right = () => interp(v01, v11, p01, p11);
      const bottom = () => interp(v10, v11, p10, p11);
      const left = () => interp(v00, v10, p00, p10);

      switch (idx) {
        case 1:
        case 14:
          segs.push({ a: left(), b: bottom() });
          break;
        case 2:
        case 13:
          segs.push({ a: bottom(), b: right() });
          break;
        case 3:
        case 12:
          segs.push({ a: left(), b: right() });
          break;
        case 4:
        case 11:
          segs.push({ a: top(), b: right() });
          break;
        case 6:
        case 9:
          segs.push({ a: top(), b: bottom() });
          break;
        case 7:
        case 8:
          segs.push({ a: left(), b: top() });
          break;
        case 5:
          segs.push({ a: left(), b: top() });
          segs.push({ a: bottom(), b: right() });
          break;
        case 10:
          segs.push({ a: top(), b: right() });
          segs.push({ a: left(), b: bottom() });
          break;
        default:
          break;
      }
    }
  }
  return segs;
}
