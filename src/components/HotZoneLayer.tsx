import { useEffect, useRef } from "react";
import { useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";

/**
 * "Zona Caliente" — Detector visual de mejores zonas de pesca.
 *
 * Estrategia (primera versión, 100% en cliente, sin llamadas extra):
 *
 *   1. Samplea los tiles ya renderizados de las capas SST y CLOROFILA
 *      directamente del DOM (panes copernicus-sst-pane / copernicus-chl-pane).
 *   2. Sobre una grilla baja (cell ~ 18 px del viewport) calcula:
 *        - gradiente local de SST   →  frente térmico
 *        - gradiente local de CHL   →  borde de clorofila / frente de productividad
 *        - intensidad local de CHL  →  presencia de productividad (no solo borde)
 *   3. Combina con pesos:
 *        score = 0.50 * frenteSST + 0.35 * bordeCHL + 0.15 * intensidadCHL
 *   4. Suaviza con blur y pinta un heatmap con paleta azul→cian→amarillo→rojo
 *      sobre un canvas posicionado encima del mapa.
 *
 * Pensado para ser claro y útil: no muestra la matemática, muestra el resultado.
 * Recalcula automáticamente al mover/zoom y al re-render del mapa.
 */

interface HotZoneLayerProps {
  enabled: boolean;
  /** 0..1 — opacidad final del overlay sobre el mapa */
  intensity: number;
}

const PANE_NAME = "ocean-hotzone-pane";
const CELL_PX = 18; // tamaño de celda de scoring en píxeles de pantalla
// Debounce alto: la rasterización del pane + scoring por celdas es pesada.
// Sólo recomputamos cuando el usuario PARA de mover/zoom el mapa.
const RECOMPUTE_DEBOUNCE_MS = 600;

// Paleta heatmap: azul oscuro (frío/sin interés) → cian → amarillo → rojo (zona muy buena)
function scoreToColor(score: number): [number, number, number, number] {
  // score: 0..1
  const s = Math.max(0, Math.min(1, score));
  // Stops: 0.00 → transparente, 0.20 → azul, 0.45 → cian/verde, 0.70 → amarillo, 0.90+ → rojo
  let r: number, g: number, b: number, a: number;

  if (s < 0.18) {
    // por debajo: prácticamente transparente (zonas sin interés)
    return [0, 0, 0, 0];
  } else if (s < 0.4) {
    // azul → cian
    const t = (s - 0.18) / (0.4 - 0.18);
    r = 30 + (40 - 30) * t;
    g = 90 + (190 - 90) * t;
    b = 200 + (220 - 200) * t;
    a = 90 + (140 - 90) * t;
  } else if (s < 0.65) {
    // cian → amarillo
    const t = (s - 0.4) / (0.65 - 0.4);
    r = 40 + (250 - 40) * t;
    g = 190 + (220 - 190) * t;
    b = 220 + (60 - 220) * t;
    a = 140 + (180 - 140) * t;
  } else {
    // amarillo → rojo
    const t = (s - 0.65) / (1 - 0.65);
    r = 250 + (235 - 250) * t;
    g = 220 + (40 - 220) * t;
    b = 60 + (40 - 60) * t;
    a = 180 + (215 - 180) * t;
  }

  return [Math.round(r), Math.round(g), Math.round(b), Math.round(a)];
}

/** Captura un pane Leaflet a un canvas off-screen del tamaño del viewport. */
function rasterizePane(map: L.Map, paneClass: string): HTMLCanvasElement | null {
  const size = map.getSize();
  const w = size.x;
  const h = size.y;
  if (w <= 0 || h <= 0) return null;

  // Buscar el pane: getPanes devuelve los standard, pero los nuestros son custom.
  const container = map.getContainer();
  const paneEl = container.querySelector<HTMLElement>(`.${paneClass}`);
  if (!paneEl) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  // Iterar las imágenes/tiles dentro del pane y dibujarlas en el canvas usando
  // su transform CSS (Leaflet posiciona los tiles con translate3d).
  const tiles = paneEl.querySelectorAll<HTMLImageElement>("img.leaflet-tile-loaded");
  const paneRect = paneEl.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  // Offset entre el pane y el container (suele ser 0,0 pero lo medimos por seguridad)
  const offsetX = paneRect.left - containerRect.left;
  const offsetY = paneRect.top - containerRect.top;

  let drawn = 0;
  tiles.forEach((img) => {
    if (!img.complete || img.naturalWidth === 0) return;
    const rect = img.getBoundingClientRect();
    const x = rect.left - containerRect.left;
    const y = rect.top - containerRect.top;
    const tw = rect.width;
    const th = rect.height;
    // Dibuja sin reaccionar a CSS filters (el canvas no aplica filter:; es la
    // imagen "cruda" de Copernicus, lo cual es perfecto para análisis numérico).
    try {
      ctx.drawImage(img, x, y, tw, th);
      drawn += 1;
    } catch {
      // crossOrigin/CORS: si una imagen no permite extracción, la saltamos.
    }
  });

  // Indicar levemente el offset por si aplica (en práctica suele ser 0).
  void offsetX;
  void offsetY;

  if (drawn === 0) return null;
  return canvas;
}

/** Convierte RGBA → "intensidad de dato" 0..1.
 *  Usamos saturación + luminancia: cuanto más vivo el color y más claro,
 *  más alto el valor del dato (Copernicus pinta con paletas turbo/thermal).
 */
function pixelToValue(r: number, g: number, b: number, a: number): number {
  if (a < 30) return NaN; // píxel transparente → sin dato
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  // Mezcla: prioridad a saturación (los datos pintan colores vivos)
  return 0.65 * sat + 0.35 * lum;
}

interface CellSample {
  v: number; // valor central
  vAvg: number; // promedio en la ventana
  grad: number; // magnitud aproximada del gradiente local (frente)
  hasData: boolean;
}

/** Muestrea valor + gradiente local en (px,py) usando una ventana 3×3 escalada. */
function sampleAt(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  px: number,
  py: number,
  step: number,
): CellSample {
  const get = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= w || y >= h) return NaN;
    const i = (y * w + x) * 4;
    return pixelToValue(data[i], data[i + 1], data[i + 2], data[i + 3]);
  };

  const c = get(px, py);
  const n = get(px, py - step);
  const s = get(px, py + step);
  const e = get(px + step, py);
  const w_ = get(px - step, py);

  const vals = [c, n, s, e, w_].filter((v) => !Number.isNaN(v));
  if (vals.length < 3 || Number.isNaN(c)) {
    return { v: 0, vAvg: 0, grad: 0, hasData: false };
  }
  const vAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
  // Gradiente Sobel-lite
  const gx = (Number.isNaN(e) ? c : e) - (Number.isNaN(w_) ? c : w_);
  const gy = (Number.isNaN(s) ? c : s) - (Number.isNaN(n) ? c : n);
  const grad = Math.sqrt(gx * gx + gy * gy);
  return { v: c, vAvg, grad, hasData: true };
}

function HotZoneRenderer({ enabled, intensity }: HotZoneLayerProps) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Crear pane + canvas SOLO cuando enabled. Cuando está apagada (caso por
  // defecto) no creamos ningún canvas que pudiera aparecer como rectángulo.
  useEffect(() => {
    if (!enabled) return;
    let pane = map.getPane(PANE_NAME);
    if (!pane) {
      pane = map.createPane(PANE_NAME);
      pane.style.zIndex = "395";
      pane.style.pointerEvents = "none";
      pane.style.mixBlendMode = "screen";
    }

    const canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.pointerEvents = "none";
    canvas.style.transition = "opacity 200ms ease";
    pane.appendChild(canvas);
    canvasRef.current = canvas;

    return () => {
      canvas.remove();
      canvasRef.current = null;
    };
  }, [map, enabled]);

  // Render del heatmap
  const compute = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    const W = size.x;
    const H = size.y;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (!enabled) return;

    // Rasterizar SST y CHL al tamaño de pantalla
    const sstCanvas = rasterizePane(map, "ocean-pane-sst");
    const chlCanvas = rasterizePane(map, "ocean-pane-chl");

    // Si no hay ni SST ni CHL aún, no hay nada que pintar
    if (!sstCanvas && !chlCanvas) return;

    const sstCtx = sstCanvas?.getContext("2d", { willReadFrequently: true });
    const chlCtx = chlCanvas?.getContext("2d", { willReadFrequently: true });

    let sstData: Uint8ClampedArray | null = null;
    let chlData: Uint8ClampedArray | null = null;

    try {
      sstData = sstCtx ? sstCtx.getImageData(0, 0, W, H).data : null;
    } catch {
      sstData = null;
    }
    try {
      chlData = chlCtx ? chlCtx.getImageData(0, 0, W, H).data : null;
    } catch {
      chlData = null;
    }

    if (!sstData && !chlData) return;

    // Grid de scoring
    const cols = Math.ceil(W / CELL_PX);
    const rows = Math.ceil(H / CELL_PX);
    const grid = new Float32Array(cols * rows);
    let maxScore = 0.0001;

    const sampleStep = Math.max(2, Math.floor(CELL_PX / 2));

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const px = col * CELL_PX + Math.floor(CELL_PX / 2);
        const py = row * CELL_PX + Math.floor(CELL_PX / 2);

        let frenteSst = 0;
        let bordeChl = 0;
        let intensidadChl = 0;
        let dataPresent = false;

        if (sstData) {
          const s = sampleAt(sstData, W, H, px, py, sampleStep);
          if (s.hasData) {
            // gradiente normalizado (gradientes típicos pequeños → multiplicamos)
            frenteSst = Math.min(1, s.grad * 6);
            dataPresent = true;
          }
        }
        if (chlData) {
          const s = sampleAt(chlData, W, H, px, py, sampleStep);
          if (s.hasData) {
            bordeChl = Math.min(1, s.grad * 5);
            // Productividad: valor central > umbral mínimo
            intensidadChl = Math.max(0, Math.min(1, (s.v - 0.15) / 0.55));
            dataPresent = true;
          }
        }

        if (!dataPresent) continue;

        const score = 0.5 * frenteSst + 0.35 * bordeChl + 0.15 * intensidadChl;
        grid[row * cols + col] = score;
        if (score > maxScore) maxScore = score;
      }
    }

    // Normalizar al máximo observado (resultado siempre vistoso aunque la
    // ventana actual sea suave). Se aplica además un boost por intensidad UI.
    const norm = 1 / maxScore;
    const boost = 0.6 + intensity * 0.9; // 0.6..1.5

    // Pintar celdas con un gaussiano (radial gradient) por celda
    const radius = CELL_PX * 1.6;
    ctx.globalCompositeOperation = "lighter";
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const raw = grid[row * cols + col];
        if (raw <= 0) continue;
        const score = Math.min(1, raw * norm * boost);
        if (score < 0.18) continue;

        const cx = col * CELL_PX + CELL_PX / 2;
        const cy = row * CELL_PX + CELL_PX / 2;
        const [r, g, b, a] = scoreToColor(score);

        const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        const a01 = (a / 255) * 0.85;
        gradient.addColorStop(0, `rgba(${r},${g},${b},${a01})`);
        gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  };

  const schedule = () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => compute());
    }, RECOMPUTE_DEBOUNCE_MS);
  };

  // Re-compute al activar/desactivar y cambiar intensidad
  useEffect(() => {
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intensity]);

  // Limpiar canvas si se desactiva
  useEffect(() => {
    if (enabled) return;
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx?.clearRect(0, 0, c.width, c.height);
  }, [enabled]);

  // Sólo escuchamos eventos del mapa cuando la capa está ACTIVA. Si está
  // desactivada (caso por defecto), useMapEvents no engancha listeners y
  // el MutationObserver no se monta → coste cero al hacer pan/zoom.
  useMapEvents(
    enabled
      ? {
          moveend: () => schedule(),
          zoomend: () => schedule(),
          resize: () => schedule(),
          load: () => schedule(),
        }
      : {},
  );

  // Observar carga de tiles del DOM (cuando llegan tiles nuevos de Copernicus)
  useEffect(() => {
    if (!enabled) return;
    const container = map.getContainer();
    let pending = false;
    const tick = () => {
      if (pending) return;
      pending = true;
      window.setTimeout(() => {
        pending = false;
        schedule();
      }, 350);
    };
    const observer = new MutationObserver(() => tick());
    const sstPane = container.querySelector(".ocean-pane-sst");
    const chlPane = container.querySelector(".ocean-pane-chl");
    if (sstPane)
      observer.observe(sstPane, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "class"],
      });
    if (chlPane)
      observer.observe(chlPane, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "class"],
      });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, map]);

  return null;
}

export function HotZoneLayer(props: HotZoneLayerProps) {
  return <HotZoneRenderer {...props} />;
}

