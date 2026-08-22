import { useEffect, useRef } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";

type MapWithOceanTileRegistry = L.Map & {
  __oceanTileRegistry?: Map<string, L.TileLayer>;
};

interface OceanMaskedTileLayerProps {
  attribution?: string;
  maxNativeZoom: number;
  maxZoom: number;
  opacity: number;
  pane: string;
  url: string;
  blendMode?: string;
  className?: string;
  /** Recolorea SST en cliente: oscuro = frío, blanco = más temperatura, con contraste local por zoom. */
  recolorSstRed?: boolean;
  /**
   * Notifies the parent that this layer is missing data (4+ tile errors).
   * Receives a stable identifier (e.g. "SST", "CHL", "ALT") so the parent
   * can show a per-layer indicator instead of a global blocking toast.
   */
  onTileError?: (layerId?: string) => void;
  /** Layer identifier passed back to onTileError. */
  layerId?: string;
  /** Notifies the parent when this layer successfully renders again. */
  onTileLoad?: (layerId?: string) => void;
}

type SstRedStop = { at: number; rgb: readonly [number, number, number] };

const SST_RED_STOPS: readonly SstRedStop[] = [
  { at: 0, rgb: [54, 0, 8] },
  { at: 0.16, rgb: [139, 0, 16] },
  { at: 0.34, rgb: [214, 40, 40] },
  { at: 0.52, rgb: [240, 110, 50] },
  { at: 0.68, rgb: [247, 127, 60] },
  { at: 0.84, rgb: [252, 191, 73] },
  { at: 1, rgb: [253, 231, 154] },
];

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function percentile(sortedValues: number[], p: number) {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (sortedValues.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function redRamp(value: number) {
  const t = clamp01(value);
  let lo = SST_RED_STOPS[0];
  let hi = SST_RED_STOPS[SST_RED_STOPS.length - 1];
  for (let i = 1; i < SST_RED_STOPS.length; i += 1) {
    if (t <= SST_RED_STOPS[i].at) {
      hi = SST_RED_STOPS[i];
      lo = SST_RED_STOPS[i - 1];
      break;
    }
  }
  const local = hi.at === lo.at ? 0 : (t - lo.at) / (hi.at - lo.at);
  return lo.rgb.map((v, i) => Math.round(v + (hi.rgb[i] - v) * local));
}

function thermalSignal(r: number, g: number, b: number) {
  // En `cmap:thermal` el Mediterráneo queda en una franja amarilla muy estrecha:
  // la luminosidad y el canal rojo-verde son monotónicos con temperatura, pero
  // varían sólo unos pocos niveles. Esta señal los combina antes de estirarlos.
  return 0.55 * (0.2126 * r + 0.7152 * g + 0.0722 * b) + 0.45 * (r - g + 128);
}

// Umbral de opacidad para considerar un píxel "dato real". Por debajo es
// borde anti-alias del recorte WMTS (tierra/transición) → si lo mantenemos,
// la interpolación bicúbica del supermuestreo lo mezcla con el RGB del agua
// vecina y aparece como un halo de "píxeles fantasma" en la costa.
const SST_DATA_ALPHA = 230;
// Banda intermedia: alpha entre EDGE y DATA → se desvanece linealmente para
// no dejar borde duro, pero sin teñir nada del fondo.
const SST_EDGE_ALPHA = 40;

function paintSstTile(imageData: ImageData, lo: number, hi: number) {
  const { data } = imageData;
  const span = Math.max(0.001, hi - lo);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < SST_EDGE_ALPHA) {
      data[i + 3] = 0;
      continue;
    }
    let t = (thermalSignal(data[i], data[i + 1], data[i + 2]) - lo) / span;
    t = clamp01(t);
    t = Math.pow(t, 0.82);
    const [r, g, b] = redRamp(t);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    if (alpha < SST_DATA_ALPHA) {
      const k = (alpha - SST_EDGE_ALPHA) / (SST_DATA_ALPHA - SST_EDGE_ALPHA);
      data[i + 3] = Math.round(k * 255);
    } else {
      data[i + 3] = 255;
    }
  }
  return imageData;
}

// Factor de supermuestreo. Lo mantenemos alto para que la interpolación del
// navegador no pinte los píxeles WMTS como bloques duros al hacer zoom.
const SST_SUPERSAMPLE = 1;

type SstTileRecord = {
  canvas: HTMLCanvasElement;
  raw: ImageData;
  samples: Float32Array;
};

class RedSstTileLayer extends L.TileLayer {
  private _sstTiles = new Map<string, SstTileRecord>();
  private _sstLo = NaN;
  private _sstHi = NaN;
  private _rangeZoom = -1;
  private _rangeTiles = 0;
  private _repaintTimer: number | null = null;

  private _computeSharedRange(zoom: number) {
    // Nunca calcular la paleta SST con una sola tesela: eso produce bloques
    // cuadrados porque cada tile queda normalizado con su propio rango local.
    if (this._sstTiles.size < 4) return null;
    let total = 0;
    for (const rec of this._sstTiles.values()) total += rec.samples.length;
    if (total < 64) return null;
    const all = new Float32Array(total);
    let off = 0;
    for (const rec of this._sstTiles.values()) {
      all.set(rec.samples, off);
      off += rec.samples.length;
    }
    const sorted = Array.from(all).sort((a, b) => a - b);
    const zoomFactor = Math.max(0, Math.min(1, (zoom - 5) / 9));
    const pLo = 0.04 + zoomFactor * 0.2;
    const pHi = 1 - pLo;
    let lo = percentile(sorted, pLo);
    let hi = percentile(sorted, pHi);
    const minSpan = 2.2 - zoomFactor * 0.8;
    if (hi - lo < minSpan) {
      const c = (hi + lo) / 2;
      lo = c - minSpan / 2;
      hi = c + minSpan / 2;
    }
    return { lo, hi };
  }

  private _repaintAll() {
    if (Number.isNaN(this._sstLo) || Number.isNaN(this._sstHi)) return;
    for (const rec of this._sstTiles.values()) {
      const ctx = rec.canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) continue;
      const copy = new ImageData(
        new Uint8ClampedArray(rec.raw.data),
        rec.raw.width,
        rec.raw.height,
      );
      ctx.putImageData(paintSstTile(copy, this._sstLo, this._sstHi), 0, 0);
    }
  }

  private _scheduleRepaint(zoom: number) {
    // Una vez fijado el rango para un zoom con >=4 tiles, no recalcular más.
    // Los tiles nuevos se pintarán directamente con el rango existente.
    if (zoom === this._rangeZoom && this._rangeTiles >= 4) return;
    if (this._repaintTimer != null) return;
    this._repaintTimer = window.setTimeout(() => {
      this._repaintTimer = null;
      const range = this._computeSharedRange(zoom);
      if (!range) return;
      const changed =
        Number.isNaN(this._sstLo) ||
        zoom !== this._rangeZoom ||
        this._rangeTiles !== this._sstTiles.size ||
        Math.abs(range.lo - this._sstLo) > 0.12 ||
        Math.abs(range.hi - this._sstHi) > 0.12;
      this._sstLo = range.lo;
      this._sstHi = range.hi;
      this._rangeZoom = zoom;
      this._rangeTiles = this._sstTiles.size;
      if (changed) this._repaintAll();
    }, 150);
  }

  createTile(coords: L.Coords, done: L.DoneCallback) {
    const size = this.getTileSize();
    const tile = document.createElement("canvas");
    const SS = SST_SUPERSAMPLE;
    tile.width = size.x * SS;
    tile.height = size.y * SS;
    tile.style.width = `${size.x}px`;
    tile.style.height = `${size.y}px`;
    tile.style.imageRendering = "auto";
    // No aplicar blur por tile: el filtro se recorta en cada tesela y acaba
    // dibujando cuadrados. El suavizado fuerte se aplica al pane SST completo.
    tile.setAttribute("role", "presentation");

    const key = `${coords.z}:${coords.x}:${coords.y}`;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const ctx = tile.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        done(undefined, tile);
        return;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, size.x * SS, size.y * SS);
      try {
        const raw = ctx.getImageData(0, 0, size.x * SS, size.y * SS);
        // Muestreamos cada N píxeles para no acumular MB en memoria.
        const STEP = 64;
        const tmp: number[] = [];
        for (let i = 0; i < raw.data.length; i += 4 * STEP) {
          if (raw.data[i + 3] < SST_DATA_ALPHA) continue;
          tmp.push(thermalSignal(raw.data[i], raw.data[i + 1], raw.data[i + 2]));
        }
        const samples = Float32Array.from(tmp);
        this._sstTiles.set(key, { canvas: tile, raw, samples });

        // Pintamos ya con el rango actual (o uno temporal calculado del tile).
        let lo = this._sstLo;
        let hi = this._sstHi;
        if ((Number.isNaN(lo) || Number.isNaN(hi)) && this._sstTiles.size >= 4) {
          const r = this._computeSharedRange(coords.z);
          if (r) {
            lo = r.lo;
            hi = r.hi;
            this._sstLo = lo;
            this._sstHi = hi;
          }
        }
        if (!Number.isNaN(lo) && !Number.isNaN(hi)) {
          const copy = new ImageData(new Uint8ClampedArray(raw.data), raw.width, raw.height);
          ctx.putImageData(paintSstTile(copy, lo, hi), 0, 0);
        }
        this._scheduleRepaint(coords.z);
      } catch {
        // canvas tainted, dejamos el tile sin recolorear
      }
      done(undefined, tile);
    };
    img.onerror = () => done(new Error("SST tile failed"), tile);
    img.src = this.getTileUrl(coords);

    return tile;
  }

  _removeTile(key: string) {
    this._sstTiles.delete(key);
    // @ts-expect-error parent method
    return L.TileLayer.prototype._removeTile.call(this, key);
  }
}

function cleanupManagedTileContainers(paneElement: HTMLElement | null) {
  if (!paneElement) return;
  paneElement.querySelectorAll<HTMLElement>('[data-ocean-tile-managed="true"]').forEach((node) => {
    node.remove();
  });
}

export function OceanMaskedTileLayer({
  attribution = "",
  maxNativeZoom,
  maxZoom,
  opacity,
  pane,
  url,
  blendMode,
  className,
  recolorSstRed = false,
  onTileError,
  onTileLoad,
  layerId,
}: OceanMaskedTileLayerProps) {
  const map = useMap();
  const layerRef = useRef<L.TileLayer | null>(null);
  const callbacksRef = useRef({ onTileError, onTileLoad, layerId });

  useEffect(() => {
    callbacksRef.current = { onTileError, onTileLoad, layerId };
  }, [layerId, onTileError, onTileLoad]);

  useEffect(() => {
    layerRef.current?.setOpacity(opacity);
  }, [opacity]);

  useEffect(() => {
    const registryMap = map as MapWithOceanTileRegistry;
    const registry = registryMap.__oceanTileRegistry ?? new Map<string, L.TileLayer>();
    registryMap.__oceanTileRegistry = registry;

    const previousLayer = registry.get(pane);
    if (previousLayer) {
      try {
        map.removeLayer(previousLayer);
      } catch {
        // no-op
      }
      registry.delete(pane);
    }

    const paneElement = map.getPane(pane) ?? null;
    cleanupManagedTileContainers(paneElement);

    const layerOptions: L.TileLayerOptions = {
      attribution,
      className: [className, "ocean-tile-smooth"].filter(Boolean).join(" "),
      crossOrigin: true,
      keepBuffer: 1,
      maxNativeZoom,
      maxZoom,
      opacity,
      pane,
      tileSize: 256,
      updateWhenIdle: true,
      updateWhenZooming: false,
      noWrap: true,
    };
    const layer = recolorSstRed
      ? new RedSstTileLayer(url, layerOptions)
      : L.tileLayer(url, layerOptions);

    let errorCount = 0;
    let notifiedError = false;
    const handleTileError = () => {
      errorCount += 1;
      if (errorCount >= 4 && !notifiedError) {
        notifiedError = true;
        callbacksRef.current.onTileError?.(callbacksRef.current.layerId);
      }
    };
    const handleLoad = () => {
      errorCount = 0;
      if (notifiedError) {
        notifiedError = false;
        callbacksRef.current.onTileLoad?.(callbacksRef.current.layerId);
      } else {
        callbacksRef.current.onTileLoad?.(callbacksRef.current.layerId);
      }
    };
    const applyVisualState = () => {
      const container = layer.getContainer();
      if (!container) return;
      container.dataset.oceanTileManaged = "true";
      container.style.background = "transparent";
      container.style.backgroundColor = "transparent";
      if (blendMode) container.style.mixBlendMode = blendMode;
    };

    layer.on("tileerror", handleTileError);
    layer.on("load", handleLoad);
    layer.addTo(map);
    layerRef.current = layer;
    registry.set(pane, layer);
    applyVisualState();
    layer.on("load", applyVisualState);

    return () => {
      layer.off("tileerror", handleTileError);
      layer.off("load", handleLoad);
      layer.off("load", applyVisualState);
      if (registry.get(pane) === layer) {
        registry.delete(pane);
      }
      if (layerRef.current === layer) {
        layerRef.current = null;
      }
      try {
        map.removeLayer(layer);
      } catch {
        // no-op
      }
      const container = layer.getContainer();
      if (container?.dataset.oceanTileManaged === "true") {
        container.remove();
      }
    };
  }, [attribution, blendMode, className, map, maxNativeZoom, maxZoom, pane, recolorSstRed, url]);

  return null;
}

