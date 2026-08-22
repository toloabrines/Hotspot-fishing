/**
 * IsolineLayer — isolíneas vectoriales tipo carta oceanográfica.
 *
 * Pipeline:
 *  1. Rasterizamos el pane WMTS (SST / CHL / ALT) a un canvas oculto.
 *  2. Convertimos a luminancia y suavizamos con un box-blur 3×3 dos veces
 *     para eliminar los escalones de la rejilla de tiles.
 *  3. Marching squares por banda → polilíneas vectoriales.
 *  4. Filtramos polilíneas cortas (ruido) y simplificamos (RDP ligero).
 *  5. Chaikin ×2 para curvas suaves sin esquinas pixeladas.
 *  6. Dibujamos en blanco puro #FFFFFF, 70% opacidad, 1.5 px normales y
 *     2.5 px las líneas principales (cada N bandas).
 *  7. Detectamos convergencia: en celdas donde varias líneas se cruzan
 *     marcamos un halo cálido suave (zona de frente / interés pesca).
 *
 * Bandas:
 *   - density 1..5 controla cuántas bandas se muestrean en el rango visible
 *     (5..14). Pocas líneas pero significativas.
 *   - Cada 3ª banda se considera "principal" → trazo más grueso.
 *
 * Sólo activo a partir de zoom MIN_ZOOM_ISOLINES.
 */

import { useCallback, useEffect, useRef } from "react";
import L from "leaflet";
import { useMap, useMapEvents } from "react-leaflet";

import type { MultiLayerState } from "./MultiLayerPanel";

const PANE_NAME = "ocean-isoline-pane";
const CANVAS_CLASS = "ocean-isoline-canvas";
const RENDER_SCALE = 0.55;
const RECOMPUTE_DELAY_MS = 380;
const MIN_ZOOM_ISOLINES = 7;
const MIN_SEGMENT_PIXELS = 28; // descarta polilíneas más cortas (ruido)

type IsoGroup = "sst" | "chlorophyll" | "altimetry";

const PANE_CLASS_BY_GROUP: Record<IsoGroup, string> = {
  sst: "ocean-pane-sst",
  chlorophyll: "ocean-pane-chl",
  altimetry: "ocean-pane-alt",
};

function ensureCanvas(map: L.Map) {
  let pane = map.getPane(PANE_NAME);
  if (!pane) {
    pane = map.createPane(PANE_NAME);
    pane.classList.add("leaflet-copernicus-pane", PANE_NAME);
    pane.style.zIndex = "362";
    pane.style.pointerEvents = "none";
    pane.style.background = "transparent";
  }

  let canvas = pane.querySelector<HTMLCanvasElement>(`canvas.${CANVAS_CLASS}`);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = CANVAS_CLASS;
    pane.appendChild(canvas);
  }

  const size = map.getSize();
  // Backing buffer escalado pero el canvas se muestra a tamaño real (CSS),
  // así que aprovechamos suavizado nativo del navegador.
  const w = Math.max(1, Math.round(size.x * RENDER_SCALE));
  const h = Math.max(1, Math.round(size.y * RENDER_SCALE));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.style.width = `${size.x}px`;
  canvas.style.height = `${size.y}px`;
  const topLeft = map.containerPointToLayerPoint([0, 0]);
  canvas.style.transform = `translate3d(${Math.round(topLeft.x)}px, ${Math.round(topLeft.y)}px, 0)`;
  return canvas;
}

/** Rasteriza un pane WMTS a un buffer escalar de luminancia + máscara. */
function rasterizePaneLuminance(
  map: L.Map,
  paneClass: string,
  w: number,
  h: number,
): { lum: Float32Array; valid: Uint8Array } | null {
  const container = map.getContainer();
  const paneEl = container.querySelector<HTMLElement>(`.${paneClass}`);
  if (!paneEl) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const rect = container.getBoundingClientRect();
  let drawn = 0;
  paneEl.querySelectorAll<HTMLImageElement>("img.leaflet-tile-loaded").forEach((img) => {
    if (!img.complete || img.naturalWidth === 0) return;
    const r = img.getBoundingClientRect();
    try {
      ctx.drawImage(
        img,
        (r.left - rect.left) * RENDER_SCALE,
        (r.top - rect.top) * RENDER_SCALE,
        r.width * RENDER_SCALE,
        r.height * RENDER_SCALE,
      );
      drawn += 1;
    } catch {
      /* tile sin CORS */
    }
  });
  if (!drawn) return null;
  let img: ImageData;
  try {
    img = ctx.getImageData(0, 0, w, h);
  } catch {
    return null;
  }
  const lum = new Float32Array(w * h);
  const valid = new Uint8Array(w * h);
  const d = img.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p += 1) {
    if (d[i + 3] < 28) continue;
    lum[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    valid[p] = 1;
  }
  return { lum, valid };
}

/** Box-blur 3×3 respetando máscara de validez. In-place sobre `out`. */
function blurField(lum: Float32Array, valid: Uint8Array, w: number, h: number, passes: number) {
  const tmp = new Float32Array(lum.length);
  for (let pass = 0; pass < passes; pass += 1) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = y * w + x;
        if (!valid[p]) continue;
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (!valid[q]) continue;
            s += lum[q];
            n += 1;
          }
        }
        tmp[p] = n ? s / n : lum[p];
      }
    }
    lum.set(tmp);
  }
}

type Pt = [number, number];

/**
 * Marching squares simplificado para un umbral concreto.
 * Devuelve segmentos sueltos [(x1,y1),(x2,y2)] que luego encadenamos.
 */
function marchingSquaresSegments(
  field: Float32Array,
  valid: Uint8Array,
  w: number,
  h: number,
  threshold: number,
): Pt[][] {
  const segs: Pt[][] = [];
  const interp = (a: number, b: number, va: number, vb: number) => {
    const t = (threshold - va) / (vb - va || 1e-6);
    return a + (b - a) * t;
  };
  for (let y = 0; y < h - 1; y += 1) {
    for (let x = 0; x < w - 1; x += 1) {
      const i0 = y * w + x;
      const i1 = i0 + 1;
      const i2 = i0 + w;
      const i3 = i2 + 1;
      if (!valid[i0] || !valid[i1] || !valid[i2] || !valid[i3]) continue;
      const v0 = field[i0];
      const v1 = field[i1];
      const v2 = field[i2];
      const v3 = field[i3];
      let code = 0;
      if (v0 > threshold) code |= 1;
      if (v1 > threshold) code |= 2;
      if (v3 > threshold) code |= 4;
      if (v2 > threshold) code |= 8;
      if (code === 0 || code === 15) continue;
      const top: Pt = [interp(x, x + 1, v0, v1), y];
      const right: Pt = [x + 1, interp(y, y + 1, v1, v3)];
      const bottom: Pt = [interp(x, x + 1, v2, v3), y + 1];
      const left: Pt = [x, interp(y, y + 1, v0, v2)];
      switch (code) {
        case 1:
        case 14:
          segs.push([left, top]);
          break;
        case 2:
        case 13:
          segs.push([top, right]);
          break;
        case 3:
        case 12:
          segs.push([left, right]);
          break;
        case 4:
        case 11:
          segs.push([bottom, right]);
          break;
        case 5:
          segs.push([left, top]);
          segs.push([bottom, right]);
          break;
        case 6:
        case 9:
          segs.push([top, bottom]);
          break;
        case 7:
        case 8:
          segs.push([left, bottom]);
          break;
        case 10:
          segs.push([left, bottom]);
          segs.push([top, right]);
          break;
        default:
          break;
      }
    }
  }
  return segs;
}

/** Encadena segmentos en polilíneas siguiendo extremos coincidentes. */
function chainSegments(segs: Pt[][]): Pt[][] {
  const key = (p: Pt) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const endpoints = new Map<string, number[]>();
  segs.forEach((s, idx) => {
    for (const p of s) {
      const k = key(p);
      const arr = endpoints.get(k) ?? [];
      arr.push(idx);
      endpoints.set(k, arr);
    }
  });
  const used = new Uint8Array(segs.length);
  const lines: Pt[][] = [];
  for (let i = 0; i < segs.length; i += 1) {
    if (used[i]) continue;
    used[i] = 1;
    const line: Pt[] = [segs[i][0], segs[i][1]];
    // extender hacia delante
    let grew = true;
    while (grew) {
      grew = false;
      const end = line[line.length - 1];
      const ids = endpoints.get(key(end)) ?? [];
      for (const id of ids) {
        if (used[id]) continue;
        const s = segs[id];
        if (key(s[0]) === key(end)) {
          line.push(s[1]);
          used[id] = 1;
          grew = true;
          break;
        }
        if (key(s[1]) === key(end)) {
          line.push(s[0]);
          used[id] = 1;
          grew = true;
          break;
        }
      }
    }
    // extender hacia atrás
    grew = true;
    while (grew) {
      grew = false;
      const start = line[0];
      const ids = endpoints.get(key(start)) ?? [];
      for (const id of ids) {
        if (used[id]) continue;
        const s = segs[id];
        if (key(s[0]) === key(start)) {
          line.unshift(s[1]);
          used[id] = 1;
          grew = true;
          break;
        }
        if (key(s[1]) === key(start)) {
          line.unshift(s[0]);
          used[id] = 1;
          grew = true;
          break;
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Suavizado de Chaikin (preserva curvatura). */
function chaikin(line: Pt[], iterations: number): Pt[] {
  let pts = line;
  for (let it = 0; it < iterations; it += 1) {
    if (pts.length < 3) return pts;
    const out: Pt[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i += 1) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      out.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25]);
      out.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

/** Longitud aproximada en píxeles (buffer escalado). */
function lineLength(line: Pt[]): number {
  let l = 0;
  for (let i = 1; i < line.length; i += 1) {
    const dx = line[i][0] - line[i - 1][0];
    const dy = line[i][1] - line[i - 1][1];
    l += Math.hypot(dx, dy);
  }
  return l;
}

export { DEFAULT_ISOLINES, type IsolineSettings } from "./IsolineLayer.types";
import type { IsolineSettings } from "./IsolineLayer.types";

interface Props {
  isolines: IsolineSettings;
  multiLayer?: MultiLayerState;
  disabled?: boolean;
}

export function IsolineLayer({ isolines, multiLayer, disabled }: Props) {
  const map = useMap();
  const timerRef = useRef<number | null>(null);
  const seqRef = useRef(0);

  const recompute = useCallback(() => {
    const canvas = ensureCanvas(map);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (disabled || !isolines.enabled) return;
    if (map.getZoom() < MIN_ZOOM_ISOLINES) return;

    const groups: IsoGroup[] = [];
    if (multiLayer) {
      if (isolines.sst && multiLayer.sst.enabled && multiLayer.sst.opacity > 0.05)
        groups.push("sst");
      if (
        isolines.chlorophyll &&
        multiLayer.chlorophyll.enabled &&
        multiLayer.chlorophyll.opacity > 0.05
      )
        groups.push("chlorophyll");
      if (isolines.altimetry && multiLayer.altimetry.enabled && multiLayer.altimetry.opacity > 0.05)
        groups.push("altimetry");
    }
    if (!groups.length) return;

    const w = canvas.width;
    const h = canvas.height;

    // Acumulador para convergencia (densidad de cruces por celda baja-res).
    const CELL = 16; // tamaño celda en píxeles del buffer
    const gridW = Math.ceil(w / CELL);
    const gridH = Math.ceil(h / CELL);
    const heat = new Uint16Array(gridW * gridH);

    // Render escalado: dibujamos con scale para que el suavizado del navegador
    // disimule la rasterización.
    ctx.save();
    ctx.scale(1, 1);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255,255,255,0)";
    ctx.shadowColor = "rgba(0,0,0,0)";
    ctx.shadowBlur = 0;

    const nBands = Math.round(3 + isolines.density); // 4..8 — sólo principales

    for (const g of groups) {
      const raster = rasterizePaneLuminance(map, PANE_CLASS_BY_GROUP[g], w, h);
      if (!raster) continue;
      const { lum, valid } = raster;
      blurField(lum, valid, w, h, 2); // 2 pasadas → aplasta los escalones

      // Rango robusto (percentiles aproximados) para evitar outliers en costa.
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < lum.length; i += 1) {
        if (!valid[i]) continue;
        const v = lum[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 6) continue;
      // recortamos 8% por extremo
      const span = max - min;
      const lo = min + span * 0.08;
      const hi = max - span * 0.08;

      for (let b = 1; b < nBands; b += 1) {
        const t = lo + ((hi - lo) * b) / nBands;
        const segs = marchingSquaresSegments(lum, valid, w, h, t);
        if (!segs.length) continue;
        const chains = chainSegments(segs);
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        for (const raw of chains) {
          if (lineLength(raw) < MIN_SEGMENT_PIXELS) continue;
          const smooth = chaikin(raw, 2);
          ctx.moveTo(smooth[0][0], smooth[0][1]);
          for (let i = 1; i < smooth.length; i += 1) ctx.lineTo(smooth[i][0], smooth[i][1]);
          // alimenta mapa de convergencia
          if (isolines.highlightGradients) {
            for (let i = 0; i < smooth.length; i += 4) {
              const cx = Math.floor(smooth[i][0] / CELL);
              const cy = Math.floor(smooth[i][1] / CELL);
              if (cx >= 0 && cy >= 0 && cx < gridW && cy < gridH) heat[cy * gridW + cx] += 1;
            }
          }
        }
        ctx.stroke();
      }
    }

    ctx.restore();

    // Halo cálido suave en zonas de convergencia (≥3 líneas por celda).
    if (isolines.highlightGradients) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let gy = 0; gy < gridH; gy += 1) {
        for (let gx = 0; gx < gridW; gx += 1) {
          const c = heat[gy * gridW + gx];
          if (c < 3) continue;
          const intensity = Math.min(0.28, 0.06 + c * 0.04);
          const cx = gx * CELL + CELL / 2;
          const cy = gy * CELL + CELL / 2;
          const r = CELL * 1.6;
          const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          grad.addColorStop(0, `rgba(255, 210, 120, ${intensity})`);
          grad.addColorStop(1, "rgba(255, 210, 120, 0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }, [disabled, isolines, map, multiLayer]);

  const schedule = useCallback(() => {
    seqRef.current += 1;
    const seq = seqRef.current;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (seq === seqRef.current) recompute();
    }, RECOMPUTE_DELAY_MS);
  }, [recompute]);

  useMapEvents({ zoomend: schedule, resize: schedule });

  useEffect(() => {
    schedule();
    const delayed = window.setTimeout(schedule, RECOMPUTE_DELAY_MS + 600);
    map.on("tileload", schedule);
    map.on("load", schedule);
    return () => {
      window.clearTimeout(delayed);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      map.off("tileload", schedule);
      map.off("load", schedule);
      map.getPane(PANE_NAME)?.querySelector(`canvas.${CANVAS_CLASS}`)?.remove();
    };
  }, [map, schedule]);

  return null;
}

