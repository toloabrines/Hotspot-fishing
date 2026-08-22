import { useCallback, useEffect, useRef } from "react";
import type L from "leaflet";
import { useMap, useMapEvents } from "react-leaflet";

import type { MultiLayerState } from "./MultiLayerPanel";
import { LAYER_CONFIGS } from "./ocean-layers";
import type { LayerConfig, LayerType } from "./ocean-layers";

const PANE_NAME = "ocean-local-contrast-pane";
const CANVAS_CLASS = "ocean-local-contrast-canvas";
const RENDER_SCALE = 0.7;
const SAMPLE_COLUMNS = 10;
const SAMPLE_ROWS = 8;
const CONCURRENCY = 6;
const RECOMPUTE_DELAY_MS = 900;

type ContrastGroup = "sst" | "chlorophyll";

interface SamplePoint {
  x: number;
  y: number;
  lat: number;
  lng: number;
}

interface LayerSamples {
  group: ContrastGroup;
  layer: LayerType;
  values: (number | null)[];
}

function getEffectiveTime(config: LayerConfig, time?: string): string | undefined {
  if (!time) return undefined;
  const match = time.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return time;

  let isoDate = match[1];
  const range = config.timeRange;
  if (range && isoDate < range.min) isoDate = range.min;
  return `${isoDate}T00:00:00.000Z`;
}

function getLayerTime(
  layer: LayerType,
  fallbackTime?: string,
  layerTimes?: Partial<Record<LayerType, string>>,
) {
  return layerTimes?.[layer] ?? fallbackTime;
}

function latLngToTilePixel(lat: number, lng: number, zoom: number, tileSize = 256) {
  const n = Math.pow(2, zoom);
  const xTile = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yTile = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tileX = Math.floor(xTile);
  const tileY = Math.floor(yTile);
  const i = Math.floor((xTile - tileX) * tileSize);
  const j = Math.floor((yTile - tileY) * tileSize);
  return { tileX, tileY, i, j };
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const t = index - lower;
  return sorted[lower] * (1 - t) + sorted[upper] * t;
}

function colorRamp(
  group: ContrastGroup,
  value: number,
  alpha: number,
): [number, number, number, number] {
  const t = Math.max(0, Math.min(1, value));
  if (group === "sst") {
    // SST Mediterráneo: el amarillo debe ser una transición corta; el tercio
    // cálido se pinta naranja/rojo para que los máximos locales se vean claro.
    if (t < 0.2) return interpolateRgb([31, 94, 199], [19, 136, 184], t / 0.2, alpha);
    if (t < 0.38) return interpolateRgb([19, 136, 184], [39, 173, 113], (t - 0.2) / 0.18, alpha);
    if (t < 0.5) return interpolateRgb([39, 173, 113], [230, 207, 50], (t - 0.38) / 0.12, alpha);
    if (t < 0.58) return interpolateRgb([230, 207, 50], [240, 106, 34], (t - 0.5) / 0.08, alpha);
    if (t < 0.72) return interpolateRgb([240, 106, 34], [215, 25, 28], (t - 0.58) / 0.14, alpha);
    return interpolateRgb([215, 25, 28], [143, 0, 0], (t - 0.72) / 0.28, alpha);
  }

  const stops: [number, number, number][] = [
    [14, 110, 56],
    [82, 220, 95],
    [255, 245, 70],
    [255, 130, 35],
    [205, 0, 40],
  ];
  return interpolateStops(stops, t, alpha);
}

function interpolateRgb(
  a: [number, number, number],
  b: [number, number, number],
  value: number,
  alpha: number,
): [number, number, number, number] {
  const t = Math.max(0, Math.min(1, value));
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    alpha,
  ];
}

function interpolateStops(
  stops: [number, number, number][],
  value: number,
  alpha: number,
): [number, number, number, number] {
  const scaled = value * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const t = scaled - index;
  const a = stops[index];
  const b = stops[index + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    alpha,
  ];
}

function getVisibleLayers(activeLayer?: LayerType, multiLayer?: MultiLayerState): LayerSamples[] {
  const layers: LayerSamples[] = [];
  const add = (layer: LayerType, group: ContrastGroup) => {
    if (!layers.some((item) => item.layer === layer)) layers.push({ group, layer, values: [] });
  };

  if (multiLayer) {
    if (multiLayer.sst.enabled && multiLayer.sst.opacity > 0.05) add(multiLayer.sst.layer, "sst");
  }

  if (activeLayer) {
    const group = LAYER_CONFIGS[activeLayer].group;
    if (group === "sst") add(activeLayer, "sst");
  }

  return layers;
}

function getSamplePoints(map: L.Map): SamplePoint[] {
  const size = map.getSize();
  const points: SamplePoint[] = [];
  for (let row = 0; row < SAMPLE_ROWS; row += 1) {
    const y = Math.round((size.y * row) / (SAMPLE_ROWS - 1));
    for (let col = 0; col < SAMPLE_COLUMNS; col += 1) {
      const x = Math.round((size.x * col) / (SAMPLE_COLUMNS - 1));
      const ll = map.containerPointToLatLng([x, y]);
      points.push({ x, y, lat: ll.lat, lng: ll.lng });
    }
  }
  return points;
}

async function fetchFeatureValue(
  layer: LayerType,
  lat: number,
  lng: number,
  zoom: number,
  time?: string,
  signal?: AbortSignal,
) {
  const config = LAYER_CONFIGS[layer];
  const { tileX, tileY, i, j } = latLngToTilePixel(lat, lng, zoom);
  const effectiveTime = getEffectiveTime(config, time);
  const timeParam = effectiveTime ? `&TIME=${encodeURIComponent(effectiveTime)}` : "";
  const upstream =
    `https://wmts.marine.copernicus.eu/teroWmts?SERVICE=WMTS&REQUEST=GetFeatureInfo` +
    `&VERSION=1.0.0&LAYER=${encodeURIComponent(config.wmtsLayer)}` +
    `&STYLE=${encodeURIComponent(config.style)}` +
    `&FORMAT=image%2Fpng&TILEMATRIXSET=EPSG%3A3857` +
    `&TILEMATRIX=${zoom}&TILEROW=${tileY}&TILECOL=${tileX}` +
    `&INFOFORMAT=application%2Fjson&I=${i}&J=${j}${timeParam}&_=${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const url = `/api/tile-proxy?url=${encodeURIComponent(upstream)}`;

  try {
    const res = await fetch(url, {
      signal,
      cache: "no-store",
      headers: { "cache-control": "no-cache", pragma: "no-cache" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const value = data?.features?.[0]?.properties?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(items: T[], mapper: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index]);
      }
    }),
  );
  return results;
}

function ensureCanvas(map: L.Map) {
  let pane = map.getPane(PANE_NAME);
  if (!pane) {
    pane = map.createPane(PANE_NAME);
    pane.classList.add(PANE_NAME, "leaflet-copernicus-pane");
    pane.style.zIndex = "354";
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
  const width = Math.max(1, Math.round(size.x * RENDER_SCALE));
  const height = Math.max(1, Math.round(size.y * RENDER_SCALE));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  canvas.style.width = `${size.x}px`;
  canvas.style.height = `${size.y}px`;
  const topLeft = map.containerPointToLayerPoint([0, 0]);
  canvas.style.transform = `translate3d(${Math.round(topLeft.x)}px, ${Math.round(topLeft.y)}px, 0)`;
  return canvas;
}

function renderFromVisibleSstTiles(map: L.Map, canvas: HTMLCanvasElement) {
  const container = map.getContainer();
  const paneEl = container.querySelector<HTMLElement>(".ocean-pane-sst");
  if (!paneEl) return null;

  const source = document.createElement("canvas");
  source.width = canvas.width;
  source.height = canvas.height;
  const sctx = source.getContext("2d", { willReadFrequently: true });
  if (!sctx) return null;

  const containerRect = container.getBoundingClientRect();
  let drawn = 0;
  paneEl.querySelectorAll<HTMLImageElement>("img.leaflet-tile-loaded").forEach((img) => {
    if (!img.complete || img.naturalWidth === 0) return;
    const rect = img.getBoundingClientRect();
    try {
      sctx.drawImage(
        img,
        (rect.left - containerRect.left) * RENDER_SCALE,
        (rect.top - containerRect.top) * RENDER_SCALE,
        rect.width * RENDER_SCALE,
        rect.height * RENDER_SCALE,
      );
      drawn += 1;
    } catch {
      // Si una tesela aún no permite lectura, esperamos al siguiente tileload.
    }
  });

  if (drawn === 0) return null;

  let sourceImage: ImageData;
  try {
    sourceImage = sctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }

  const metrics: number[] = [];
  const { data } = sourceImage;
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];
    if (alpha < 16) continue;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    if (r + g + b < 24) continue;
    metrics.push(r * 0.55 + g * 0.35 - b * 0.18);
  }

  if (metrics.length < 600) return null;
  metrics.sort((a, b) => a - b);
  const low = percentile(metrics, 0.02) ?? metrics[0];
  const high = Math.max(percentile(metrics, 0.68) ?? metrics[metrics.length - 1], low + 1);
  const output = new ImageData(canvas.width, canvas.height);

  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];
    if (alpha < 16) continue;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    if (r + g + b < 24) continue;
    const metric = r * 0.55 + g * 0.35 - b * 0.18;
    const normalized = Math.max(0, Math.min(1, (metric - low) / (high - low)));
    const warmBiased = Math.pow(normalized, 0.68);
    const [rr, gg, bb, aa] = colorRamp("sst", warmBiased, 236);
    output.data[offset] = rr;
    output.data[offset + 1] = gg;
    output.data[offset + 2] = bb;
    output.data[offset + 3] = aa;
  }

  return output;
}

function renderWarmFallback(canvas: HTMLCanvasElement, map: L.Map) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const image = ctx.createImageData(canvas.width, canvas.height);
  const center = map.getCenter();
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const nx = x / Math.max(1, canvas.width - 1);
      const ny = y / Math.max(1, canvas.height - 1);
      const wave =
        Math.sin((nx * 5.4 + center.lng * 0.08) * Math.PI) * 0.08 +
        Math.cos((ny * 4.6 + center.lat * 0.06) * Math.PI) * 0.07;
      const normalized = Math.max(0, Math.min(1, 0.16 + nx * 0.48 + (1 - ny) * 0.18 + wave));
      const [r, g, b, a] = colorRamp("sst", normalized, 218);
      const offset = (y * canvas.width + x) * 4;
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = a;
    }
  }

  return image;
}

function renderLayer(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  layer: LayerSamples,
  points: SamplePoint[],
) {
  const transformed = layer.values.map((value) => {
    if (value == null || value <= 0) return null;
    return layer.group === "chlorophyll" ? Math.log10(value) : value;
  });
  const finite = transformed
    .filter((value): value is number => value != null && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (finite.length < 8) return false;

  const pMin = layer.group === "sst" ? finite[0] : percentile(finite, 0.1);
  const pMax = layer.group === "sst" ? finite[finite.length - 1] : percentile(finite, 0.9);
  if (pMin == null || pMax == null || pMax <= pMin) return false;

  // Estiramiento LOCAL puro: el mínimo visible va al inicio de la paleta y
  // el máximo visible al final. Sin "minimumSpan" para SST → así una variación
  // de 0.1 °C en el Mediterráneo se reparte por toda la rampa de color.
  const minimumSpan = layer.group === "chlorophyll" ? 0.16 : 0;
  const mid = (pMin + pMax) / 2;
  const rawSpan = pMax - pMin;
  const span = Math.max(rawSpan, minimumSpan);
  const min = mid - span / 2;
  const max = mid + span / 2;

  // Boost de contraste para microgradientes (0.1–0.3 °C en SST):
  // aplicamos una curva sigmoide alrededor del centro para que las décimas
  // intermedias se separen más visualmente. El boost se atenúa cuando el
  // rango ya es amplio (>0.6 °C) para no saturar océanos abiertos.
  const microBoost =
    layer.group === "sst"
      ? Math.max(0, Math.min(1, (0.6 - rawSpan) / 0.5)) // 1 cuando span≤0.1, 0 cuando span≥0.6
      : 0;

  const grid = document.createElement("canvas");
  grid.width = SAMPLE_COLUMNS;
  grid.height = SAMPLE_ROWS;
  const gtx = grid.getContext("2d");
  if (!gtx) return false;
  const image = gtx.createImageData(SAMPLE_COLUMNS, SAMPLE_ROWS);

  transformed.forEach((value, index) => {
    if (value == null) return;
    let normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));
    if (microBoost > 0) {
      // Sigmoide centrada: estira el rango medio sin tocar extremos.
      const k = 1 + microBoost * 3.2; // pendiente: 1 (neutra) → 4.2 (microgradiente)
      const sig = 1 / (1 + Math.exp(-k * (normalized - 0.5) * 2));
      const sigMin = 1 / (1 + Math.exp(k));
      const sigMax = 1 / (1 + Math.exp(-k));
      normalized = (sig - sigMin) / (sigMax - sigMin);
    }
    // Overlay SST con sesgo cálido: si el Mediterráneo tiene poca diferencia,
    // la mitad alta entra ya en naranja/rojo en vez de quedarse amarilla.
    const alpha = layer.group === "sst" ? 210 : 135;
    const displayValue = layer.group === "sst" ? Math.pow(normalized, 0.66) : normalized;
    const [r, g, b, a] = colorRamp(layer.group, displayValue, alpha);
    const offset = index * 4;
    image.data[offset] = r;
    image.data[offset + 1] = g;
    image.data[offset + 2] = b;
    image.data[offset + 3] = a;
  });

  gtx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.globalCompositeOperation = layer.group === "sst" ? "source-over" : "screen";
  ctx.drawImage(grid, 0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "source-over";

  // Realce de microfrentes térmicos: trazos finos sobre transiciones locales.
  ctx.lineWidth = Math.max(1.0, canvas.width / 320);
  const edgeThreshold = layer.group === "sst" ? 0.1 : 0.18;
  for (let row = 0; row < SAMPLE_ROWS - 1; row += 1) {
    for (let col = 0; col < SAMPLE_COLUMNS - 1; col += 1) {
      const i = row * SAMPLE_COLUMNS + col;
      const right = i + 1;
      const bottom = i + SAMPLE_COLUMNS;
      const a = transformed[i];
      const b = transformed[right];
      const c = transformed[bottom];
      if (a == null || b == null || c == null) continue;
      const edge = Math.max(Math.abs(a - b), Math.abs(a - c)) / span;
      if (edge < edgeThreshold) continue;
      const point = points[i];
      const x = point.x * RENDER_SCALE;
      const y = point.y * RENDER_SCALE;
      const intensity = Math.min(1, (edge - edgeThreshold) / 0.3);
      if (layer.group === "sst") {
        // Frentes térmicos en naranja/rojo, sin amarillo dominante.
        ctx.strokeStyle = `rgba(225, 74, 44, ${0.16 + intensity * 0.28})`;
      } else {
        ctx.strokeStyle = `rgba(90, 255, 90, ${0.28 + intensity * 0.42})`;
      }
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(points[right].x * RENDER_SCALE, points[right].y * RENDER_SCALE);
      ctx.stroke();
    }
  }

  return true;
}

interface OceanLocalContrastLayerProps {
  activeLayer?: LayerType;
  multiLayer?: MultiLayerState;
  time?: string;
  layerTimes?: Partial<Record<LayerType, string>>;
  disabled?: boolean;
}

export function OceanLocalContrastLayer({
  activeLayer,
  multiLayer,
  time,
  layerTimes,
  disabled = false,
}: OceanLocalContrastLayerProps) {
  const map = useMap();
  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);
  const lastFrameRef = useRef<ImageData | null>(null);
  const effectiveDisabled = disabled;

  const recompute = useCallback(async () => {
    const canvas = ensureCanvas(map);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (effectiveDisabled) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      lastFrameRef.current = null;
      return;
    }

    const layers = getVisibleLayers(activeLayer, multiLayer);
    if (layers.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      lastFrameRef.current = null;
      return;
    }

    const hasSst = layers.some((layer) => layer.group === "sst");
    if (
      hasSst &&
      (!lastFrameRef.current ||
        lastFrameRef.current.width !== canvas.width ||
        lastFrameRef.current.height !== canvas.height)
    ) {
      const fallback = renderWarmFallback(canvas, map);
      if (fallback) {
        lastFrameRef.current = fallback;
        ctx.putImageData(fallback, 0, 0);
      }
    }

    if (
      lastFrameRef.current &&
      lastFrameRef.current.width === canvas.width &&
      lastFrameRef.current.height === canvas.height
    ) {
      ctx.putImageData(lastFrameRef.current, 0, 0);
    }

    const tileFrame = renderFromVisibleSstTiles(map, canvas);
    if (tileFrame) {
      lastFrameRef.current = tileFrame;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.putImageData(tileFrame, 0, 0);
      return;
    }

    const points = getSamplePoints(map);
    // Usamos el zoom real hasta 8: evita pedir una grilla distinta de la vista
    // actual y mantiene GetFeatureInfo estable al hacer zoom/pan.
    const zoom = Math.max(5, Math.min(Math.round(map.getZoom()), 8));
    const requestId = sequenceRef.current + 1;
    sequenceRef.current = requestId;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    const sampledLayers = await Promise.all(
      layers.map(async (layer) => ({
        ...layer,
        values: await mapWithConcurrency(points, (point) =>
          fetchFeatureValue(
            layer.layer,
            point.lat,
            point.lng,
            zoom,
            getLayerTime(layer.layer, time, layerTimes),
            abort.signal,
          ),
        ),
      })),
    );

    if (requestId !== sequenceRef.current || abort.signal.aborted) return;

    const nextCanvas = document.createElement("canvas");
    nextCanvas.width = canvas.width;
    nextCanvas.height = canvas.height;
    const nextCtx = nextCanvas.getContext("2d");
    if (!nextCtx) return;

    const renderedAny = sampledLayers.some((layer) =>
      renderLayer(nextCtx, nextCanvas, layer, points),
    );
    if (renderedAny) {
      try {
        lastFrameRef.current = nextCtx.getImageData(0, 0, canvas.width, canvas.height);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.putImageData(lastFrameRef.current, 0, 0);
      } catch {
        lastFrameRef.current = null;
      }
      return;
    }

    if (
      lastFrameRef.current &&
      lastFrameRef.current.width === canvas.width &&
      lastFrameRef.current.height === canvas.height
    ) {
      ctx.putImageData(lastFrameRef.current, 0, 0);
    }
  }, [activeLayer, effectiveDisabled, layerTimes, map, multiLayer, time]);

  const schedule = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void recompute();
    }, RECOMPUTE_DELAY_MS);
  }, [recompute]);

  // Igual que el front enhancer: sin recálculo en moveend. Sólo cuando
  // realmente cambia el zoom o el tamaño del visor. Paneos pequeños ya no
  // alteran el realce local de contraste.
  useMapEvents({
    resize: schedule,
    zoomend: schedule,
  });

  useEffect(() => {
    schedule();
    const quick = window.setTimeout(schedule, 220);
    map.on("tileload", schedule);
    map.on("load", schedule);
    return () => {
      window.clearTimeout(quick);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      abortRef.current?.abort();
      map.off("tileload", schedule);
      map.off("load", schedule);
      map.getPane(PANE_NAME)?.querySelector(`canvas.${CANVAS_CLASS}`)?.remove();
    };
  }, [map, schedule]);

  return null;
}

