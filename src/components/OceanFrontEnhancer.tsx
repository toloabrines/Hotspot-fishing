import { useCallback, useEffect, useRef } from "react";
import L from "leaflet";
import { useMap, useMapEvents } from "react-leaflet";

import type { MultiLayerState } from "./MultiLayerPanel";
import { LAYER_CONFIGS } from "./ocean-layers";
import type { LayerType } from "./ocean-layers";

const PANE_NAME = "ocean-front-enhancer-pane";
const CANVAS_CLASS = "ocean-front-enhancer-canvas";
const RENDER_SCALE = 0.58;
const RECOMPUTE_DELAY_MS = 520;

type FrontGroup = "sst" | "chlorophyll";

function getVisibleFrontGroups(
  activeLayer?: LayerType,
  multiLayer?: MultiLayerState,
): FrontGroup[] {
  const groups = new Set<FrontGroup>();

  if (multiLayer) {
    if (multiLayer.sst.enabled && multiLayer.sst.opacity > 0.05) groups.add("sst");
    if (multiLayer.chlorophyll.enabled && multiLayer.chlorophyll.opacity > 0.05)
      groups.add("chlorophyll");
  }

  if (activeLayer) {
    const group = LAYER_CONFIGS[activeLayer].group;
    if (group === "sst" || group === "chlorophyll") groups.add(group);
  }

  return [...groups];
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * p)));
  return values[index];
}

function ensureCanvas(map: L.Map) {
  let pane = map.getPane(PANE_NAME);
  if (!pane) {
    pane = map.createPane(PANE_NAME);
    pane.classList.add("leaflet-copernicus-pane", PANE_NAME);
    pane.style.zIndex = "385";
    pane.style.mixBlendMode = "screen";
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

function rasterizePane(map: L.Map, paneClass: string, width: number, height: number) {
  const container = map.getContainer();
  const paneEl = container.querySelector<HTMLElement>(`.${paneClass}`);
  if (!paneEl) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const containerRect = container.getBoundingClientRect();
  let drawn = 0;
  paneEl.querySelectorAll<HTMLImageElement>("img.leaflet-tile-loaded").forEach((img) => {
    if (!img.complete || img.naturalWidth === 0) return;
    const rect = img.getBoundingClientRect();
    try {
      ctx.drawImage(
        img,
        (rect.left - containerRect.left) * RENDER_SCALE,
        (rect.top - containerRect.top) * RENDER_SCALE,
        rect.width * RENDER_SCALE,
        rect.height * RENDER_SCALE,
      );
      drawn += 1;
    } catch {
      // Si una tesela no permite lectura, se ignora sin romper el mapa.
    }
  });

  if (drawn === 0) return null;
  try {
    return ctx.getImageData(0, 0, width, height);
  } catch {
    return null;
  }
}

function layerColor(group: FrontGroup, score: number): [number, number, number, number] {
  const t = Math.max(0, Math.min(1, score));
  if (group === "sst") {
    // Frentes térmicos: trazo blanco/cian brillante. Se mantiene bien
    // legible sobre la paleta SST y NO se confunde con FSLE (amarillo→rojo).
    const alpha = Math.round(190 + 65 * t);
    const r = Math.round(210 + 20 * t);
    const g = Math.round(240 + 15 * t);
    return [r, g, 255, alpha];
  }

  // Frentes de clorofila: verde lima → cian/turquesa. Antes iban a rojo
  // intenso, casi idéntico a las líneas FSLE; ahora se distinguen claramente.
  if (t < 0.55) {
    const k = t / 0.55;
    return [
      Math.round(180 - 130 * k), // 180 → 50
      255,
      Math.round(120 + 80 * k), // 120 → 200
      Math.round(110 + 90 * k),
    ];
  }
  const k = (t - 0.55) / 0.45;
  return [
    Math.round(50 - 50 * k), // 50 → 0
    Math.round(255 - 35 * k), // 255 → 220
    Math.round(200 + 55 * k), // 200 → 255
    Math.round(210 + 45 * k),
  ];
}

function compositePixel(
  out: Uint8ClampedArray,
  offset: number,
  r: number,
  g: number,
  b: number,
  a: number,
) {
  const srcA = a / 255;
  const dstA = out[offset + 3] / 255;
  const nextA = srcA + dstA * (1 - srcA);
  if (nextA <= 0) return;

  out[offset] = Math.round((r * srcA + out[offset] * dstA * (1 - srcA)) / nextA);
  out[offset + 1] = Math.round((g * srcA + out[offset + 1] * dstA * (1 - srcA)) / nextA);
  out[offset + 2] = Math.round((b * srcA + out[offset + 2] * dstA * (1 - srcA)) / nextA);
  out[offset + 3] = Math.round(nextA * 255);
}

function addFronts(source: ImageData, target: ImageData, group: FrontGroup) {
  const { data, width, height } = source;
  const gradients = new Float32Array(width * height);
  const ranked: number[] = [];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 24) continue;

      const left = i - 4;
      const right = i + 4;
      const top = i - width * 4;
      const bottom = i + width * 4;
      const dx =
        Math.abs(data[right] - data[left]) +
        Math.abs(data[right + 1] - data[left + 1]) +
        Math.abs(data[right + 2] - data[left + 2]);
      const dy =
        Math.abs(data[bottom] - data[top]) +
        Math.abs(data[bottom + 1] - data[top + 1]) +
        Math.abs(data[bottom + 2] - data[top + 2]);
      const gradient = (dx + dy) / 1530;
      if (gradient <= 0.006) continue;

      const p = y * width + x;
      gradients[p] = gradient;
      ranked.push(gradient);
    }
  }

  if (ranked.length < 80) return;
  ranked.sort((a, b) => a - b);
  const low = percentile(ranked, group === "sst" ? 0.82 : 0.5);
  const high = Math.max(percentile(ranked, 0.995), low + 0.012);
  const strength = group === "sst" ? 1.45 : 1.5;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      const gradient = gradients[p];
      if (gradient <= low) continue;

      const score = Math.pow(Math.min(1, (gradient - low) / (high - low)), 0.55) * strength;
      const [r, g, b, a] = layerColor(group, score);
      const offset = p * 4;
      compositePixel(target.data, offset, r, g, b, Math.min(245, a));
    }
  }
}

export function OceanFrontEnhancer({
  activeLayer,
  multiLayer,
  disabled = false,
}: {
  activeLayer?: LayerType;
  multiLayer?: MultiLayerState;
  disabled?: boolean;
}) {
  const map = useMap();
  const timerRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);
  const movingRef = useRef(false);

  const recompute = useCallback(() => {
    const canvas = ensureCanvas(map);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const groups = disabled ? [] : getVisibleFrontGroups(activeLayer, multiLayer);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (groups.length === 0) return;

    const target = ctx.createImageData(canvas.width, canvas.height);
    if (groups.includes("chlorophyll")) {
      const chl = rasterizePane(map, "ocean-pane-chl", canvas.width, canvas.height);
      if (chl) addFronts(chl, target, "chlorophyll");
    }
    if (groups.includes("sst")) {
      const sst = rasterizePane(map, "ocean-pane-sst", canvas.width, canvas.height);
      if (sst) addFronts(sst, target, "sst");
    }

    ctx.putImageData(target, 0, 0);
  }, [activeLayer, disabled, map, multiLayer]);

  const schedule = useCallback(() => {
    if (movingRef.current) return;
    sequenceRef.current += 1;
    const seq = sequenceRef.current;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (seq === sequenceRef.current) recompute();
    }, RECOMPUTE_DELAY_MS);
  }, [recompute]);

  // Sólo recomputamos al hacer zoom o al cambiar el tamaño. En paneo suave
  // el canvas queda anclado a coordenadas de capa y se desplaza con el mapa,
  // evitando que las manchas parezcan pegadas al cursor.
  useMapEvents({
    movestart: () => {
      movingRef.current = true;
      sequenceRef.current += 1;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    moveend: () => {
      movingRef.current = false;
      schedule();
    },
    resize: schedule,
    zoomend: schedule,
  });

  useEffect(() => {
    schedule();
    const delayed = window.setTimeout(schedule, RECOMPUTE_DELAY_MS + 650);
    const onVisible = () => {
      if (document.visibilityState !== "hidden") schedule();
    };
    map.on("tileload", schedule);
    map.on("load", schedule);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", schedule);
    window.addEventListener("focus", schedule);
    return () => {
      window.clearTimeout(delayed);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      map.off("tileload", schedule);
      map.off("load", schedule);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", schedule);
      window.removeEventListener("focus", schedule);
    };
  }, [map, schedule]);

  return null;
}

