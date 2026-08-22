import { useCallback, useEffect, useRef } from "react";
import type { LatLngBounds } from "leaflet";
import { useMap } from "react-leaflet";

import type { MultiLayerState } from "./MultiLayerPanel";
import { LAYER_CONFIGS } from "./ocean-layers";
import type { LayerType } from "./ocean-layers";

export type ViewportStyleOverrides = Partial<Record<LayerType, string>>;

export interface ViewportSstRange {
  minC: number;
  maxC: number;
  redFromC?: number;
  sensitivityC: string;
  sampleCount: number;
}

export type ViewportSstRanges = Partial<Record<LayerType, ViewportSstRange>>;

interface ViewportAdaptiveContrastProps {
  activeLayer?: LayerType;
  multiLayer?: MultiLayerState;
  onChange: (overrides: ViewportStyleOverrides, sstRanges?: ViewportSstRanges) => void;
  time?: string;
  layerTimes?: Partial<Record<LayerType, string>>;
}

const SAMPLE_COLUMNS = 9;
const SAMPLE_ROWS = 7;
const MIN_SAMPLE_COUNT = 6;
// Usamos percentiles muy cercanos a los extremos para que la paleta cubra
// el rango REAL visible (no recortamos contraste). Así un viewport con
// 17.6–18.9 °C estira azul→rojo sobre 1.3 °C y se ven los frentes térmicos.
const SST_BLUE_PERCENTILE = 0.02;
const SST_RED_PERCENTILE = 0.98;
// Mínimo absoluto para evitar parpadeos cuando todo el viewport es casi
// homogéneo (p. ej. 0.05 °C). 0.2 °C garantiza contraste sin inventar señal.
const SST_MIN_VISIBLE_SPAN = 0.2;

function getEffectiveTime(layer: LayerType, time?: string): string | undefined {
  if (!time) return undefined;

  const config = LAYER_CONFIGS[layer];
  const match = time.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return time;

  let isoDate = match[1];
  const range = config.timeRange;

  if (range) {
    if (isoDate < range.min) isoDate = range.min;
    if (range.max && isoDate > range.max) isoDate = range.max;
  }

  return `${isoDate}T00:00:00.000Z`;
}

function latLngToTilePixel(lat: number, lng: number, zoom: number, tileSize: number = 256) {
  const n = Math.pow(2, zoom);
  const xTile = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yTile = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tileX = Math.floor(xTile);
  const tileY = Math.floor(yTile);
  const i = Math.max(0, Math.min(tileSize - 1, Math.floor((xTile - tileX) * tileSize)));
  const j = Math.max(0, Math.min(tileSize - 1, Math.floor((yTile - tileY) * tileSize)));
  return { tileX, tileY, i, j };
}

async function fetchFeatureNumeric(
  layer: LayerType,
  lat: number,
  lng: number,
  zoom: number,
  time?: string,
) {
  const config = LAYER_CONFIGS[layer];
  const { tileX, tileY, i, j } = latLngToTilePixel(lat, lng, zoom);
  const t = getEffectiveTime(layer, time);
  const timeParam = t ? `&TIME=${encodeURIComponent(t)}` : "";
  const upstream =
    `https://wmts.marine.copernicus.eu/teroWmts?SERVICE=WMTS&REQUEST=GetFeatureInfo` +
    `&VERSION=1.0.0&LAYER=${encodeURIComponent(config.wmtsLayer)}` +
    `&STYLE=${encodeURIComponent(config.style)}` +
    `&FORMAT=image%2Fpng&TILEMATRIXSET=EPSG%3A3857` +
    `&TILEMATRIX=${zoom}&TILEROW=${tileY}&TILECOL=${tileX}` +
    `&INFOFORMAT=application%2Fjson&I=${i}&J=${j}${timeParam}` +
    `${config.elevation != null ? `&ELEVATION=${encodeURIComponent(config.elevation)}` : ""}` +
    `&_t=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const url = `/api/tile-proxy?url=${encodeURIComponent(upstream)}`;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "cache-control": "no-cache", pragma: "no-cache" },
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const data = await res.json();
    const value = data?.features?.[0]?.properties?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function getSamplePoints(bounds: LatLngBounds) {
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const latPadding = (north - south) * 0.1;
  const lngPadding = (east - west) * 0.1;
  const minLat = south + latPadding;
  const maxLat = north - latPadding;
  const minLng = west + lngPadding;
  const maxLng = east - lngPadding;
  const points: { lat: number; lng: number }[] = [];

  for (let row = 0; row < SAMPLE_ROWS; row += 1) {
    const rowRatio = row / (SAMPLE_ROWS - 1);
    const lat = maxLat - (maxLat - minLat) * rowRatio;

    for (let col = 0; col < SAMPLE_COLUMNS; col += 1) {
      const colRatio = col / (SAMPLE_COLUMNS - 1);
      const lng = minLng + (maxLng - minLng) * colRatio;
      points.push({ lat, lng });
    }
  }

  return points;
}

function percentile(sortedValues: number[], p: number) {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (sortedValues.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function parseStyleRange(style: string) {
  const vminMatch = style.match(/(?:^|,)vmin:([^,]+)/);
  const vmaxMatch = style.match(/(?:^|,)vmax:([^,]+)/);
  if (!vminMatch || !vmaxMatch) return null;

  const min = Number(vminMatch[1]);
  const max = Number(vmaxMatch[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { max, min };
}

function formatStyleNumber(value: number) {
  if (Math.abs(value) >= 100) return value.toFixed(4);
  if (Math.abs(value) >= 10) return value.toFixed(4);
  if (Math.abs(value) >= 1) return value.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function replaceStyleRange(style: string, min: number, max: number) {
  return style
    .replace(/vmin:[^,]+/, `vmin:${formatStyleNumber(min)}`)
    .replace(/vmax:[^,]+/, `vmax:${formatStyleNumber(max)}`);
}

function isSstTemperatureLayer(layer: LayerType) {
  return LAYER_CONFIGS[layer].group === "sst" && layer !== "sst_error" && layer !== "sst_ice";
}

function toCelsius(value: number) {
  return value > 200 ? value - 273.15 : value;
}

function styleValueFromCelsius(celsius: number, baseRange: { min: number; max: number }) {
  return baseRange.min > 200 || baseRange.max > 200 ? celsius + 273.15 : celsius;
}

function isAltMicroLayer(layer: LayerType) {
  return layer === "alt_adt_micro";
}

function isAltAdaptiveLayer(layer: LayerType) {
  return (
    layer === "alt_adt_micro" ||
    layer === "alt_adt" ||
    layer === "alt_combined" ||
    layer === "alt_currents"
  );
}

function isChlAdaptiveLayer(layer: LayerType) {
  return (
    layer === "chl" ||
    layer === "chl_hc" ||
    layer === "chl_monthly" ||
    layer === "chl_micro" ||
    layer === "chl_nano" ||
    layer === "chl_pico"
  );
}

// Centro del viewport dentro del Mediterráneo (Gibraltar → Levante).
// En esta cuenca aplicamos contraste x2 (percentiles más estrechos P10–P90)
// y span mínimo más pequeño para resaltar microfrentes/microeddies.
function isMediterraneanViewport(bounds: LatLngBounds) {
  const c = bounds.getCenter();
  return c.lat >= 30 && c.lat <= 46 && c.lng >= -6 && c.lng <= 36;
}

function buildViewportAdjustedStyle(
  layer: LayerType,
  values: number[],
  inMediterranean: boolean,
  zoom: number,
) {
  const config = LAYER_CONFIGS[layer];
  const parsedBaseRange = parseStyleRange(config.style);
  if (!parsedBaseRange || values.length < MIN_SAMPLE_COUNT) return null;

  const isSst = isSstTemperatureLayer(layer);
  const isAltMicro = isAltMicroLayer(layer);
  const isAlt = isAltAdaptiveLayer(layer);
  const isChl = isChlAdaptiveLayer(layer);
  const baseRange = isSst
    ? { min: toCelsius(parsedBaseRange.min), max: toCelsius(parsedBaseRange.max) }
    : parsedBaseRange;
  const filtered = isSst
    ? values.filter((value) => {
        const c = toCelsius(value);
        return c >= -3 && c <= 40;
      })
    : isChl
      ? values.filter((value) => value > 0)
      : isAlt
        ? values.filter((v) => Number.isFinite(v) && Math.abs(v) <= 2)
        : values;
  if (filtered.length < MIN_SAMPLE_COUNT) return null;

  const sorted = [...filtered].sort((a, b) => a - b);
  const sstCelsius = isSst ? sorted.map(toCelsius) : sorted;
  const actualMin = sstCelsius[0];
  const actualMax = sstCelsius[sstCelsius.length - 1];

  // Ajuste por zoom: a más zoom (más cerca), el viewport cubre menos área y
  // las diferencias térmicas son más sutiles → percentiles MÁS estrechos y
  // span mínimo MÁS pequeño para estirar la paleta sobre microfrentes.
  // A menos zoom (vista amplia), abrimos los percentiles para no exagerar
  // outliers locales y mostrar el patrón regional.
  // zoom típico: 5 (cuenca) … 14 (bahía).
  const zoomFactor = Math.max(0, Math.min(1, (zoom - 5) / 9)); // 0 lejos … 1 cerca

  // Mediterráneo → percentiles muy estrechos para SST (hasta P30–P70 ≈ x5)
  // de modo que la paleta cubra el rango térmico realmente visible y permita
  // distinguir frentes de 0.05–0.1 °C en aguas casi homogéneas al hacer zoom.
  const isAltCurrents = layer === "alt_currents";
  // SST: P10→P30 según zoom en Med, P02→P20 fuera de Med.
  const sstPLo = inMediterranean ? 0.1 + zoomFactor * 0.2 : 0.02 + zoomFactor * 0.18;
  const sstPHi = 1 - sstPLo;
  const pLo = inMediterranean
    ? isAltCurrents
      ? 0.15
      : isSst
        ? sstPLo
        : isChl
          ? 0.05
          : 0.1
    : isSst
      ? sstPLo
      : isChl
        ? 0.05
        : 0.05;
  const pHi = inMediterranean
    ? isAltCurrents
      ? 0.85
      : isSst
        ? sstPHi
        : isChl
          ? 0.95
          : 0.9
    : isSst
      ? sstPHi
      : isChl
        ? 0.95
        : 0.95;

  const rawMin = percentile(isSst ? sstCelsius : sorted, pLo);
  const rawMax = percentile(isSst ? sstCelsius : sorted, pHi);
  if (rawMin === null || rawMax === null || rawMax <= rawMin) return null;

  const span = rawMax - rawMin;
  const baseSpan = baseRange.max - baseRange.min;
  const padding = isSst || isAlt ? 0 : Math.max(span * 0.05, baseSpan * 0.005);

  let min = isSst || isAlt ? rawMin : Math.max(baseRange.min, rawMin - padding);
  let max = isSst || isAlt ? rawMax : Math.min(baseRange.max, rawMax + padding);

  if (isAlt) {
    // Clamp al rango físico de la capa.
    min = Math.max(baseRange.min, min);
    max = Math.min(baseRange.max, max);
    // Span mínimo: muy pequeño en Med para alt_currents (0.04 m) para que la
    // paleta cmo.balance estire azul→blanco→rojo sobre microvariaciones reales.
    const MIN_SPAN = isAltMicro
      ? 0.04
      : isAltCurrents && inMediterranean
        ? 0.04
        : inMediterranean
          ? 0.08
          : 0.2;
    if (max - min < MIN_SPAN) {
      const center = (max + min) / 2;
      min = center - MIN_SPAN / 2;
      max = center + MIN_SPAN / 2;
      min = Math.max(baseRange.min, min);
      max = Math.min(baseRange.max, max);
    }
  }

  if (isSst) {
    // Span mínimo escalado por zoom: a zoom muy alto bajamos a 0.05 °C
    // (microfrentes en bahía), a zoom bajo subimos a 0.5 °C.
    const minSpanMed = Math.max(0.05, 0.5 - zoomFactor * 0.45);
    const minSpan = inMediterranean ? minSpanMed : Math.max(0.15, 0.6 - zoomFactor * 0.45);
    if (max - min < minSpan) {
      const centerC = (min + max) / 2;
      min = centerC - minSpan / 2;
      max = centerC + minSpan / 2;
    }
  }

  // 🔒 PALETA FIJA POR CAPA Y RANGO: snap del [min, max] a buckets discretos
  // para que paneos suaves dentro de una misma zona produzcan EXACTAMENTE el
  // mismo rango → mismo estilo WMTS → cero parpadeo de color. El bucket SST
  // se hace más fino al acercar para no perder la resolución sub-grado.
  if (isSst) {
    // Bucket más fino al acercar: 0.5 → 0.25 → 0.1 → 0.05 °C.
    const STEP =
      zoomFactor >= 0.85 ? 0.05 : zoomFactor >= 0.6 ? 0.1 : zoomFactor >= 0.3 ? 0.25 : 0.5;
    min = Math.floor(min / STEP) * STEP;
    max = Math.ceil(max / STEP) * STEP;
  } else if (isAlt) {
    const STEP = 0.02;
    min = Math.floor(min / STEP) * STEP;
    max = Math.ceil(max / STEP) * STEP;
  } else if (isChl) {
    // Cuantización logarítmica en factor √2 — un escalón perceptible en la
    // paleta CHL sin sobre-discretizar valores bajos.
    const LOG_STEP = Math.log(Math.SQRT2);
    const lo = Math.max(1e-4, min);
    const hi = Math.max(lo * 1.0001, max);
    min = Math.exp(Math.floor(Math.log(lo) / LOG_STEP) * LOG_STEP);
    max = Math.exp(Math.ceil(Math.log(hi) / LOG_STEP) * LOG_STEP);
  }
  // Re-clamp al rango físico de la capa por si el snap se salió. En SST el
  // cálculo está en Celsius, pero el WMTS usa Kelvin en el style base; antes
  // comparábamos 25 °C contra 288 K y el ajuste quedaba siempre descartado.
  const clampMin = isSst ? -3 : baseRange.min;
  const clampMax = isSst ? 40 : baseRange.max;
  min = Math.max(clampMin, min);
  max = Math.min(clampMax, max);

  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;

  return {
    range: isSst
      ? {
          maxC: max,
          minC: min,
          redFromC: max,
          sampleCount: filtered.length,
          sensitivityC: `${(actualMax - actualMin).toFixed(2)} ºC viewport`,
        }
      : undefined,
    style: replaceStyleRange(
      config.style,
      isSst ? styleValueFromCelsius(min, parsedBaseRange) : min,
      isSst ? styleValueFromCelsius(max, parsedBaseRange) : max,
    ),
  };
}

function getAdaptiveLayers(activeLayer?: LayerType, multiLayer?: MultiLayerState) {
  const layers = new Set<LayerType>();

  // SST adaptativo
  if (multiLayer?.sst.enabled && isSstTemperatureLayer(multiLayer.sst.layer))
    layers.add(multiLayer.sst.layer);
  // Clorofila adaptativa (separa cian → verde/amarillo)
  if (multiLayer?.chlorophyll.enabled && isChlAdaptiveLayer(multiLayer.chlorophyll.layer))
    layers.add(multiLayer.chlorophyll.layer);
  // ADT adaptativo (normal, combinada y micro)
  if (multiLayer?.altimetry.enabled && isAltAdaptiveLayer(multiLayer.altimetry.layer))
    layers.add(multiLayer.altimetry.layer);

  if (activeLayer) {
    if (isSstTemperatureLayer(activeLayer)) layers.add(activeLayer);
    if (isChlAdaptiveLayer(activeLayer)) layers.add(activeLayer);
    if (isAltAdaptiveLayer(activeLayer)) layers.add(activeLayer);
  }

  return [...layers];
}

// Debounce GENEROSO: evitamos recalcular por cada movimiento del mapa.
// Sólo se actualiza cuando cambia la capa o la fecha.
const CONTRAST_DEBOUNCE_MS = 500;
// Igual que FSLE: pan/zoom no debe provocar nuevas consultas GetFeatureInfo a
// Copernicus. La paleta adaptativa se calcula al activar/cambiar capa/fecha y
// se mantiene estable mientras navegas por el mapa.
const AUTO_RECOMPUTE_AFTER_MAP_MOVE = false;

export function ViewportAdaptiveContrast({
  activeLayer,
  multiLayer,
  onChange,
  time,
  layerTimes,
}: ViewportAdaptiveContrastProps) {
  const map = useMap();
  const resultKeyRef = useRef("");
  const requestKeyRef = useRef("");
  const requestSequenceRef = useRef(0);
  const debounceRef = useRef<number | null>(null);

  const updateContrast = useCallback(async () => {
    // Adaptamos al viewport TODAS las capas que lo soportan: SST, CHL y ADT.
    // SST especialmente: en Med en verano la cuenca es casi isoterma
    // (22-24 °C) y un rango fijo de 15-23 °C deja todo en rojo, indistinguible.
    // Muestreando GetFeatureInfo se ajusta la paleta al rango térmico real
    // del viewport — y el rango/percentiles se afinan según zoom.
    const adaptiveLayers = getAdaptiveLayers(activeLayer, multiLayer);

    if (adaptiveLayers.length === 0) {
      if (resultKeyRef.current !== "fixed") {
        resultKeyRef.current = "fixed";
        requestKeyRef.current = "fixed";
        onChange({}, {});
      }
      return;
    }

    const bounds = map.getBounds();
    const inMed = isMediterraneanViewport(bounds);
    const mapZoom = map.getZoom();
    const key = `${adaptiveLayers.join(",")}|${mapZoom}|${bounds.toBBoxString()}|${time ?? ""}`;
    if (requestKeyRef.current === key) return;
    requestKeyRef.current = key;
    const seq = ++requestSequenceRef.current;

    const points = getSamplePoints(bounds);
    const overrides: ViewportStyleOverrides = {};
    const sstRanges: ViewportSstRanges = {};

    await Promise.allSettled(
      adaptiveLayers.map(async (layer) => {
        const zoom = Math.min(mapZoom, LAYER_CONFIGS[layer].nativeZoom);
        // Usar primero la fecha resuelta por capa. La fecha global puede ser
        // "hoy" aunque el último tile SST disponible sea ayer; si muestreamos
        // con la fecha global, GetFeatureInfo devuelve null y nunca se aplica
        // el rango dinámico.
        const effTime = getEffectiveTime(layer, layerTimes?.[layer] ?? time);
        const values = await Promise.all(
          points.map((p) => fetchFeatureNumeric(layer, p.lat, p.lng, zoom, effTime)),
        );
        if (seq !== requestSequenceRef.current) return;
        const numeric = values.filter((v): v is number => typeof v === "number");
        const adjusted = buildViewportAdjustedStyle(layer, numeric, inMed, mapZoom);
        if (adjusted) {
          overrides[layer] = adjusted.style;
          if (adjusted.range) sstRanges[layer] = adjusted.range;
          if (isSstTemperatureLayer(layer)) {
            onChange({ ...overrides }, { ...sstRanges });
          }
        }
      }),
    );
    if (seq !== requestSequenceRef.current) return;

    const newKey = `${key}|${JSON.stringify(overrides)}`;
    if (resultKeyRef.current === newKey) return;
    resultKeyRef.current = newKey;
    onChange(overrides, sstRanges);
  }, [map, multiLayer, activeLayer, time, layerTimes, onChange]);

  // Programador único: cancela el timer anterior y reagenda. Así sólo se
  // ejecuta UNA vez cuando el usuario para de moverse / hacer zoom.
  const schedule = useCallback(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void updateContrast();
    }, CONTRAST_DEBOUNCE_MS);
  }, [updateContrast]);

  useEffect(() => {
    schedule();
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [schedule]);

  // Recalcular el rango local sólo con zoom. En CHL/ALT, recalcular por paneo
  // cambia vmin/vmax y hace que las manchas parezcan moverse aunque el dato no
  // cambie; mantener la paleta estable evita ese efecto.
  useEffect(() => {
    const onZoom = () => {
      if (!AUTO_RECOMPUTE_AFTER_MAP_MOVE) return;
      schedule();
    };
    map.on("zoomend", onZoom);
    return () => {
      map.off("zoomend", onZoom);
    };
  }, [map, schedule]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, []);

  return null;
}

