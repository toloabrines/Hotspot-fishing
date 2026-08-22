import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Popup, TileLayer, ZoomControl, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { MultiLayerState } from "./MultiLayerPanel";

import { BATHY_PANES, BathymetryLayer } from "./BathymetryLayer";
import { Mbar24BathymetryLayer, type Mbar24Status2D } from "./Mbar24BathymetryLayer";
import { FishingHotspots, type FishingSpot } from "./FishingHotspots";
import { GpsTracker, type GpsPosition } from "./GpsTracker";
import { MapBoundsBridge } from "./MapBoundsBridge";
import { OceanMask } from "./OceanMask";
import { HighResMallorcaCoast } from "./HighResMallorcaCoast";
import { OceanFrontEnhancer } from "./OceanFrontEnhancer";
import { IsolineLayer } from "./IsolineLayer";
import { CenterCrosshair } from "./CenterCrosshair";
import { OceanMaskedTileLayer } from "./OceanMaskedTileLayer";
import { ResolutionIndicator } from "./ResolutionIndicator";
import { SavedWaypointsLayer } from "./SavedWaypointsLayer";
import { FishingDirectionArrow } from "./FishingDirectionArrow";
import { SearchAreaLayer, type DrawMode } from "./SearchAreaLayer";
import AiPlanLayer from "./AiPlanLayer";
import type { AdvisorPlanSpot } from "../lib/ai-advisor";
import { CabreraParkBoundary } from "./CabreraParkBoundary";
import { VelocityLayer } from "./VelocityLayer";
import { FsleLayer } from "./FsleLayer";
import { ThermoclineLayer } from "./ThermoclineLayer";
import { SeafloorLayer } from "./SeafloorLayer";
import type { SeafloorSettings } from "../lib/seafloor.types";
import type { DemGrid } from "../lib/dem";
import type { SeafloorStructure } from "../lib/seafloor-structures";
import {
  ViewportAdaptiveContrast,
  type ViewportSstRanges,
  type ViewportStyleOverrides,
} from "./ViewportAdaptiveContrast";
import type { SearchArea } from "../lib/geo-area";
import type { SavedWaypoint } from "../hooks/use-saved-waypoints";
import {
  LAYER_CONFIGS,
  MED_ALT_CURRENTS_CONFIG,
  MED_ALTIMETRY_CONFIG,
  MED_CHL_CONFIG,
  MED_CHL_HC_CONFIG,
} from "./ocean-layers";
import type { LayerConfig, LayerType } from "./ocean-layers";
import { fetchCopernicusValue } from "../lib/copernicus-feature-info";
import { fetchCopernicusCurrentVector } from "../lib/copernicus-currents";
import { GradientZonesLayer } from "./GradientZonesLayer";
import type { GradientZone } from "../lib/gradient-zones.types";
import type { LatLng } from "../lib/geo-area";

const COPERNICUS_PANE = "copernicus-pane";
const COPERNICUS_PANE_CLASS = "leaflet-copernicus-pane";
const SST_PANE = "copernicus-sst-pane";
const CHL_PANE = "copernicus-chl-pane";
const ALT_PANE = "copernicus-alt-pane";
const ALL_RASTER_PANES = [COPERNICUS_PANE, SST_PANE, CHL_PANE, ALT_PANE] as const;
const ALL_BATHY_PANES = [
  BATHY_PANES.GEBCO_BASE_PANE,
  BATHY_PANES.BATHY_PANE,
  BATHY_PANES.COASTAL_RELIEF_PANE,
  BATHY_PANES.HILLSHADE_PANE,
  BATHY_PANES.SLOPE_PANE,
  BATHY_PANES.CONTOUR_PANE,
  BATHY_PANES.COASTAL_CONTOUR_PANE,
  BATHY_PANES.SHALLOW_BATHYMETRY_PANE,
] as const;
const SST_PANE_CLASS = "ocean-pane-sst";
const CHL_PANE_CLASS = "ocean-pane-chl";
const ALT_PANE_CLASS = "ocean-pane-alt";
const MAP_MIN_ZOOM = 2;
const MAP_MAX_ZOOM = 19;
const TILE_PALETTE_VERSION = "sst-red-client-contrast-v21";

type MapWithOceanLayerRegistry = L.Map & {
  __oceanTileRegistry?: Map<string, L.TileLayer>;
  __oceanVelocityLayer?: L.Layer | null;
};

function getGroupPane(group: "sst" | "chlorophyll" | "altimetry") {
  if (group === "sst") return SST_PANE;
  if (group === "chlorophyll") return CHL_PANE;
  return ALT_PANE;
}

function getPaneForLayerType(layer: LayerType) {
  return getGroupPane(LAYER_CONFIGS[layer].group);
}

// Opacidad efectiva por capa.
// En modo multi-capa las 3 capas (SST+CHL+ALT) deben verse SIMULTÁNEAMENTE.
// Para conseguirlo combinamos:
//   1. Stacking: ALT abajo, CHL en medio, SST arriba
//   2. mix-blend-mode en CSS por pane (.ocean-pane-sst soft-light, etc.)
//   3. Opacidad respetuosa del slider con mínimo visible para que ninguna
//      capa quede en 0% accidentalmente cuando el usuario activa el toggle.
// Antes este helper aplastaba SST a 0.40–0.50 y subía ALT a ≥0.9, lo que
// hacía que ALT tapara completamente a SST y CHL → solo se veía la capa de
// arriba. Ahora cada capa entra con su opacidad real (mín. 0.55 si está
// activa) y el blend se encarga de combinarlas.
function getRecommendedOpacity(
  group: "sst" | "chlorophyll" | "altimetry",
  opacity: number,
  _preserveBathy: boolean = false,
  _altActive: boolean = false,
) {
  // SST debe dominar visualmente: si se deja como velo al 35–55%, cualquier
  // resto de CHL/ALT o batimetría hace que la temperatura parezca verdosa y no
  // se distingan las décimas. CHL/ALT quedan como contexto muy suave.
  const MIN_VISIBLE = group === "sst" ? 0.82 : group === "altimetry" ? 0.16 : 0.12;
  const MAX = group === "sst" ? 0.96 : group === "altimetry" ? 0.24 : 0.18;
  return Math.min(MAX, Math.max(MIN_VISIBLE, opacity));
}

function cleanupOceanMapTransientLayers(map: L.Map) {
  const transientSelectors = [".velocity-overlay", ".leaflet-velocity-container"];

  transientSelectors.forEach((selector) => {
    map
      .getContainer()
      .querySelectorAll(selector)
      .forEach((node) => node.remove());
  });
}

function cleanupPaneDom(map: L.Map, paneName: string) {
  const pane = map.getPane(paneName);
  if (!pane) return;
  pane
    .querySelectorAll("[data-ocean-tile-managed='true'], .leaflet-layer, .leaflet-tile-container")
    .forEach((node) => node.remove());
}

function cleanupRegistryLayer(map: L.Map, key: string) {
  const registryMap = map as MapWithOceanLayerRegistry;
  const registry = registryMap.__oceanTileRegistry;
  const layer = registry?.get(key);
  if (!layer) return;
  try {
    map.removeLayer(layer);
  } catch {
    // no-op
  }
  registry?.delete(key);
}

function MapUpdater() {
  const map = useMap();

  useEffect(() => {
    let resumeTimer: number | null = null;

    const refreshMap = () => {
      if (document.visibilityState === "hidden") return;
      if (resumeTimer) window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        map.invalidateSize();
      }, 250);
    };

    map.invalidateSize();
    cleanupOceanMapTransientLayers(map);

    if (!map.getPane(COPERNICUS_PANE)) {
      const pane = map.createPane(COPERNICUS_PANE);
      pane.classList.add(COPERNICUS_PANE_CLASS);
      pane.style.zIndex = "350";
      pane.style.isolation = "isolate";
      pane.style.pointerEvents = "none";
      pane.style.background = "transparent";
    }

    // GPS pane — ALWAYS on top of every map layer (data, bathymetry, labels, markers).
    // pointerEvents: none → no captura clicks, así el mapa sigue interactivo debajo.
    if (!map.getPane("gpsPane")) {
      const pane = map.createPane("gpsPane");
      pane.style.zIndex = "9999";
      pane.style.pointerEvents = "none";
      pane.style.background = "transparent";
    }

    // Orden de apilado balanceado: SST abajo como base térmica, CHL encima
    // para productividad, ALT encima para dinámica; batimetría queda por
    // encima de las tres para que isobatas/veriles siempre se lean.
    const groupPanes: [string, string, string][] = [
      // Reordenado: SST ARRIBA para que el color térmico siempre sea legible
      // en multicapa. ALT abajo (base de altimetría), CHL en medio (multiply
      // tinta la base sin tapar), SST encima (normal, dominante).
      [ALT_PANE, "351", ALT_PANE_CLASS],
      [CHL_PANE, "352", CHL_PANE_CLASS],
      [SST_PANE, "359", SST_PANE_CLASS],
    ];

    for (const [name, zIndex, className] of groupPanes) {
      if (!map.getPane(name)) {
        const pane = map.createPane(name);
        pane.classList.add(COPERNICUS_PANE_CLASS, className);
        pane.style.zIndex = zIndex;
        pane.style.isolation = "isolate";
        pane.style.pointerEvents = "none";
        pane.style.background = "transparent";
      }
    }

    const bathyPanes: [string, string][] = [
      [BATHY_PANES.GEBCO_BASE_PANE, "338"],
      [BATHY_PANES.BATHY_PANE, "340"],
      [BATHY_PANES.COASTAL_RELIEF_PANE, "341"],
      // Hillshade + isobatas POR ENCIMA de SST/CHL/ALT (z 351–359)
      // para que el relieve y los veriles siempre se lean como en Navionics.
      [BATHY_PANES.HILLSHADE_PANE, "360"],
      [BATHY_PANES.SLOPE_PANE, "361"],
      [BATHY_PANES.CONTOUR_PANE, "362"],
      [BATHY_PANES.COASTAL_CONTOUR_PANE, "363"],
      [BATHY_PANES.SHALLOW_BATHYMETRY_PANE, "449"],
    ];

    for (const [name, zIndex] of bathyPanes) {
      const pane = map.getPane(name) ?? map.createPane(name);
      pane.style.zIndex = zIndex;
      pane.style.pointerEvents = "none";
      pane.style.background = "transparent";
    }

    document.addEventListener("visibilitychange", refreshMap);
    window.addEventListener("pageshow", refreshMap);
    window.addEventListener("focus", refreshMap);

    return () => {
      document.removeEventListener("visibilitychange", refreshMap);
      window.removeEventListener("pageshow", refreshMap);
      window.removeEventListener("focus", refreshMap);
      if (resumeTimer) window.clearTimeout(resumeTimer);
      cleanupOceanMapTransientLayers(map);
    };
  }, [map]);

  return null;
}

function MapInteractionPerformanceController() {
  const map = useMap();

  useEffect(() => {
    let releaseTimer: number | null = null;

    const holdLightMode = () => {
      if (releaseTimer) window.clearTimeout(releaseTimer);
      document.body.classList.add("map-is-moving");
    };

    const releaseLightMode = () => {
      if (releaseTimer) window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(() => {
        document.body.classList.remove("map-is-moving");
      }, 220);
    };

    map.on("movestart", holdLightMode);
    map.on("dragstart", holdLightMode);
    map.on("zoomstart", holdLightMode);
    map.on("moveend", releaseLightMode);
    map.on("dragend", releaseLightMode);
    map.on("zoomend", releaseLightMode);

    return () => {
      if (releaseTimer) window.clearTimeout(releaseTimer);
      document.body.classList.remove("map-is-moving");
      map.off("movestart", holdLightMode);
      map.off("dragstart", holdLightMode);
      map.off("zoomstart", holdLightMode);
      map.off("moveend", releaseLightMode);
      map.off("dragend", releaseLightMode);
      map.off("zoomend", releaseLightMode);
    };
  }, [map]);

  return null;
}

function LayerPaneLifecycleController({
  activeRasterPanes,
  velocityEnabled,
  bathymetryVisible,
}: {
  activeRasterPanes: string[];
  velocityEnabled: boolean;
  bathymetryVisible: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    const registryMap = map as MapWithOceanLayerRegistry;
    const registry = registryMap.__oceanTileRegistry;
    const activeSet = new Set(activeRasterPanes);

    ALL_RASTER_PANES.forEach((paneName) => {
      if (activeSet.has(paneName)) return;

      const layer = registry?.get(paneName);
      if (layer) {
        try {
          map.removeLayer(layer);
        } catch {
          // no-op
        }
        registry?.delete(paneName);
      }

      cleanupPaneDom(map, paneName);
    });

    if (!velocityEnabled) {
      const velocityLayer = registryMap.__oceanVelocityLayer;
      if (velocityLayer) {
        try {
          map.removeLayer(velocityLayer);
        } catch {
          // no-op
        }
        registryMap.__oceanVelocityLayer = null;
      }
      cleanupOceanMapTransientLayers(map);
    }

    if (!bathymetryVisible) {
      [
        "bathy-gebco-global-base",
        "bathy-emodnet-mean-atlas",
        "bathy-emodnet-hillshade",
        "bathy-emodnet-coastal-relief",
        "bathy-emodnet-coastal-hillshade",
        "bathy-emodnet-slope",
        "bathy-emodnet-contours",
        "bathy-emodnet-contours-coastal-hd",
      ].forEach((key) => cleanupRegistryLayer(map, key));

      ALL_BATHY_PANES.forEach((paneName) => {
        cleanupPaneDom(map, paneName);
      });
    }
  }, [activeRasterPanes, bathymetryVisible, map, velocityEnabled]);

  return null;
}

function FlyToController({
  center,
  zoom,
  trigger,
}: {
  center?: [number, number];
  zoom?: number;
  trigger?: number;
}) {
  const map = useMap();

  useEffect(() => {
    if (trigger === undefined || trigger === 0 || !center) return;
    map.flyTo(center, zoom ?? map.getZoom(), { duration: 1.2 });
  }, [center, map, trigger, zoom]);

  return null;
}

function getEffectiveTime(config: LayerConfig, time?: string): string | undefined {
  if (!time) return undefined;

  const match = time.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return time;

  let isoDate = match[1];
  const range = config.timeRange;

  if (range) {
    if (isoDate < range.min) isoDate = range.min;
    // Clamp también al máximo cuando esté definido. Sin esto, una fecha
    // futura provocaba HTTP 400 (ExceptionReport) y Leaflet mantenía el
    // tile previo en pantalla → la capa "no se actualizaba".
    if (range.max && isoDate > range.max) isoDate = range.max;
  }

  return `${isoDate}T00:00:00.000Z`;
}

function getLayerTime(
  layer: LayerType,
  fallbackTime?: string,
  layerDates?: Partial<Record<LayerType, string>>,
): string | undefined {
  // 1) ¿Tenemos la fecha resuelta para esta capa exacta?
  const direct = layerDates?.[layer];
  if (direct) return direct;
  // 2) Compartir fecha entre hermanas del mismo grupo cuando el hook
  //    solo sondeó UNA (típico altimetría: solo se sondea alt_combined).
  //    Sin esto, las URLs salían SIN parámetro TIME y el navegador/CDN/
  //    Storage cacheaban el tile bajo clave "notime" → siempre el mismo
  //    blob aunque Copernicus tuviera datos nuevos al día siguiente.
  if (layerDates) {
    const group = LAYER_CONFIGS[layer]?.group;
    if (group === "altimetry") {
      const altSibling =
        layerDates.alt_combined ??
        layerDates.alt_adt ??
        layerDates.alt_currents ??
        layerDates.alt_sla ??
        layerDates.alt_ugos ??
        layerDates.alt_vgos ??
        layerDates.alt_eke;
      if (altSibling) return altSibling;
    } else if (group === "sst") {
      const sstSibling = layerDates.sst_analysed ?? layerDates.sst_nrt;
      if (sstSibling) return sstSibling;
    } else if (group === "chlorophyll") {
      const chlSibling = layerDates.chl ?? layerDates.chl_hc;
      if (chlSibling) return chlSibling;
    }
  }
  return fallbackTime;
}

// Cache-buster ESTABLE por día. Antes usábamos `Date.now()` cuando el caller
// no pasaba `cacheBust`, lo que generaba una URL nueva en cada render y
// forzaba a Leaflet a re-pedir todos los tiles a Copernicus de forma continua
// (la app se volvía inestable y agotaba la cuota WMTS). Ahora si no hay
// cacheBust explícito usamos solo la fecha (YYYY-MM-DD): los tiles se cachean
// 1 día completo en navegador/CDN y solo se vuelven a pedir cuando cambia la
// fecha o el usuario pulsa "Reciente".
function dayBust(time?: string): string {
  const day = (time ?? new Date().toISOString()).slice(0, 10);
  return day.replace(/-/g, "");
}

function buildWmtsUrl(config: LayerConfig, time?: string, cacheBust?: string) {
  const layer = encodeURIComponent(config.wmtsLayer);
  const style = encodeURIComponent(config.style);
  const t = getEffectiveTime(config, time);
  const timeParam = t ? `&TIME=${encodeURIComponent(t)}` : "";
  const bust = `&_t=${encodeURIComponent(cacheBust ?? dayBust(time))}`;
  const elev = config.elevation != null ? `&ELEVATION=${config.elevation}` : "";

  const upstream = `https://wmts.marine.copernicus.eu/teroWmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${style}&FORMAT=image%2Fpng&TRANSPARENT=true&TILEMATRIXSET=EPSG%3A3857&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}${timeParam}${elev}${bust}`;
  return `/api/tile-proxy?url=${encodeURIComponent(upstream)
    .replace(/%7Bz%7D/g, "{z}")
    .replace(/%7By%7D/g, "{y}")
    .replace(/%7Bx%7D/g, "{x}")}`;
}

function buildWmtsUrlWithStyle(
  config: LayerConfig,
  styleOverride?: string,
  time?: string,
  cacheBust?: string,
) {
  const style = styleOverride ?? config.style;
  const layer = encodeURIComponent(config.wmtsLayer);
  const encodedStyle = encodeURIComponent(style);
  const t = getEffectiveTime(config, time);
  const timeParam = t ? `&TIME=${encodeURIComponent(t)}` : "";
  const styleHash = (() => {
    let h = 5381;
    for (let i = 0; i < style.length; i++) h = ((h << 5) + h + style.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  })();
  const bust = `&_t=${encodeURIComponent(`${cacheBust ?? dayBust(time)}_${styleHash}_${TILE_PALETTE_VERSION}`)}`;
  const elev = config.elevation != null ? `&ELEVATION=${config.elevation}` : "";

  const upstream = `https://wmts.marine.copernicus.eu/teroWmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${encodedStyle}&FORMAT=image%2Fpng&TRANSPARENT=true&TILEMATRIXSET=EPSG%3A3857&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}${timeParam}${elev}${bust}`;
  return `/api/tile-proxy?url=${encodeURIComponent(upstream)
    .replace(/%7Bz%7D/g, "{z}")
    .replace(/%7By%7D/g, "{y}")
    .replace(/%7Bx%7D/g, "{x}")}`;
}

function getLayerClass(layer: LayerType) {
  const group = LAYER_CONFIGS[layer].group;
  const isHighContrast = layer === "sst_nrt_hc" || layer === "chl_hc";
  const hcClass = isHighContrast ? " high-contrast" : "";
  if (group === "sst") return "ocean-tile-sst" + hcClass;
  if (group === "chlorophyll") return "ocean-tile-chl" + hcClass;
  return "ocean-tile-alt";
}

function shouldRecolorSstRed(layer: LayerType) {
  const config = LAYER_CONFIGS[layer];
  return config.group === "sst" && layer !== "sst_error" && layer !== "sst_ice";
}

function getDataLayerMaxZoom(config: LayerConfig) {
  return config.nativeZoom;
}

// Detecta si el viewport mira claramente al Mediterráneo, incluso a zooms bajos
// donde el centro cae fuera de la cuenca. Si sólo miramos el centro, la app
// seguía pidiendo ADT global y el usuario veía el Mediterráneo plano.
function MedViewportDetector({ onChange }: { onChange: (inMed: boolean) => void }) {
  const map = useMap();
  const lastRef = useRef<boolean | null>(null);
  const evaluate = useCallback(() => {
    const c = map.getCenter();
    const bounds = map.getBounds();
    const med = { west: -6, east: 36, south: 30, north: 46 };
    const centerInMed =
      c.lat >= med.south && c.lat <= med.north && c.lng >= med.west && c.lng <= med.east;
    const interW = Math.max(bounds.getWest(), med.west);
    const interE = Math.min(bounds.getEast(), med.east);
    const interS = Math.max(bounds.getSouth(), med.south);
    const interN = Math.min(bounds.getNorth(), med.north);
    const interArea = Math.max(0, interE - interW) * Math.max(0, interN - interS);
    const medArea = (med.east - med.west) * (med.north - med.south);
    const inMed = centerInMed || interArea / medArea >= 0.18;
    if (lastRef.current !== inMed) {
      lastRef.current = inMed;
      onChange(inMed);
    }
  }, [map, onChange]);
  useEffect(() => {
    evaluate();
    return undefined;
  }, [evaluate, map]);
  return null;
}

// Devuelve el cfg efectivo a renderizar: cuando el viewport está en el
// Mediterráneo, sustituimos ADT/SSH global por MEDSEA 1/24°.
function resolveEffectiveCfg(layer: LayerType, inMed: boolean): LayerConfig {
  if (layer === "alt_currents" && inMed) return MED_ALT_CURRENTS_CONFIG;
  if ((layer === "alt_adt" || layer === "alt_combined" || layer === "alt_adt_micro") && inMed)
    return MED_ALTIMETRY_CONFIG;
  if (layer === "chl" && inMed) return MED_CHL_CONFIG;
  if (layer === "chl_hc" && inMed) return MED_CHL_HC_CONFIG;
  return LAYER_CONFIGS[layer];
}

function getEffectiveStyleOverride(
  layer: LayerType,
  inMed: boolean,
  overrides: ViewportStyleOverrides,
) {
  // Si estamos renderizando MEDSEA, no aplicar autoescala calculada sobre el
  // producto global ADT: esa era la causa de seguir viendo un fondo plano.
  if (
    inMed &&
    (layer === "alt_currents" ||
      layer === "alt_adt" ||
      layer === "alt_combined" ||
      layer === "alt_adt_micro" ||
      layer === "chl" ||
      layer === "chl_hc")
  ) {
    return undefined;
  }
  return overrides[layer];
}

interface MultiPointInfo {
  lat: number;
  lng: number;
  loading: boolean;
  time?: string;
  sst: { value: string | null; raw: number | null } | null;
  chl: { value: string | null; raw: number | null } | null;
  alt: { value: string | null; raw: number | null } | null;
  current: { speed: number; dirDeg: number } | null;
}

function latLngToTilePixel(lat: number, lng: number, zoom: number, tileSize: number = 256) {
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

async function fetchRawValue(
  wmtsLayer: string,
  style: string,
  lat: number,
  lng: number,
  zoom: number,
  time?: string,
  signal?: AbortSignal,
  elevation?: number,
): Promise<{ value: number | null; units?: string }> {
  // UNIFICADO: usa el mismo cliente que el motor de spots, así popup y
  // análisis ven el mismo dato (misma URL, mismo cache, misma validación).
  return fetchCopernicusValue(wmtsLayer, style, lat, lng, zoom, time, signal, elevation);
}

async function fetchLayerValue(
  config: LayerConfig,
  lat: number,
  lng: number,
  zoom: number,
  time?: string,
  signal?: AbortSignal,
): Promise<{ value: string | null; raw: number | null }> {
  const t = getEffectiveTime(config, time);
  const { value, units } = await fetchRawValue(
    config.wmtsLayer,
    config.style,
    lat,
    lng,
    zoom,
    t,
    signal,
    config.elevation,
  );
  if (value == null) return { value: null, raw: null };
  return { value: formatValue(value, config, units), raw: value };
}

function formatValue(val: number, config: LayerConfig, units?: string): string {
  if (config.unit === "°C" || units === "kelvin") {
    const celsius = units === "kelvin" || val > 200 ? val - 273.15 : val;
    return `${celsius.toFixed(2)} °C`;
  }
  if (config.unit === "%") return `${(val * 100).toFixed(1)} %`;
  if (config.unit === "mg/m³") return `${val.toFixed(4)} mg/m³`;
  if (config.unit === "m" || config.unit.startsWith("m /")) {
    return `${(val * 100).toFixed(1)} cm`;
  }
  return `${val.toFixed(4)} ${config.unit}`;
}

function bearingToCompass(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return dirs[idx];
}

function toDMS(deg: number, isLat: boolean): string {
  const hemi = isLat ? (deg >= 0 ? "N" : "S") : deg >= 0 ? "E" : "W";
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFloat = (abs - d) * 60;
  const m = Math.floor(minFloat);
  const s = (minFloat - m) * 60;
  return `${d}° ${m.toString().padStart(2, "0")}′ ${s.toFixed(1).padStart(4, "0")}″ ${hemi}`;
}

interface ClickHandlerProps {
  activeLayer: LayerType;
  multiLayer?: MultiLayerState;
  time?: string;
  layerTimes?: Partial<Record<LayerType, string>>;
  disabled?: boolean;
}

function ClickHandler({ activeLayer, multiLayer, time, layerTimes, disabled }: ClickHandlerProps) {
  const [info, setInfo] = useState<MultiPointInfo | null>(null);
  const map = useMap();
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setInfo(null);
  }, [
    activeLayer,
    multiLayer?.sst.layer,
    multiLayer?.chlorophyll.layer,
    multiLayer?.altimetry.layer,
  ]);

  useMapEvents({
    dblclick: async (e: L.LeafletMouseEvent) => {
      if (disabled) return;
      // Ignorar clicks sobre controles UI (botones, paneles, etc.)
      const target = e.originalEvent.target as HTMLElement | null;
      if (target && target.closest(".leaflet-control, [data-no-map-click]")) return;

      const { lat, lng } = e.latlng;
      const zoom = Math.min(Math.max(map.getZoom(), 3), 9);

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // Determinar qué capas consultar
      const queries: Array<{ key: "sst" | "chl" | "alt"; cfg: LayerConfig; layer: LayerType }> = [];
      if (multiLayer) {
        if (multiLayer.sst.enabled)
          queries.push({
            key: "sst",
            cfg: LAYER_CONFIGS[multiLayer.sst.layer],
            layer: multiLayer.sst.layer,
          });
        if (multiLayer.chlorophyll.enabled)
          queries.push({
            key: "chl",
            cfg: LAYER_CONFIGS[multiLayer.chlorophyll.layer],
            layer: multiLayer.chlorophyll.layer,
          });
        if (multiLayer.altimetry.enabled)
          queries.push({
            key: "alt",
            cfg: LAYER_CONFIGS[multiLayer.altimetry.layer],
            layer: multiLayer.altimetry.layer,
          });
      } else {
        const cfg = LAYER_CONFIGS[activeLayer];
        const k = cfg.group === "sst" ? "sst" : cfg.group === "chlorophyll" ? "chl" : "alt";
        queries.push({ key: k, cfg, layer: activeLayer });
      }

      // Para corrientes: usa el mismo selector de profundidad que las streamlines.
      const altLayer = multiLayer?.altimetry.enabled ? multiLayer.altimetry.layer : undefined;
      const altCfg = altLayer ? LAYER_CONFIGS[altLayer] : null;
      const altTime = altCfg
        ? getEffectiveTime(altCfg, getLayerTime(altLayer!, time, layerTimes))
        : undefined;

      setInfo({
        lat,
        lng,
        loading: true,
        time: time?.slice(0, 10),
        sst: null,
        chl: null,
        alt: null,
        current: null,
      });

      const results = await Promise.all(
        queries.map(async (q) => ({
          key: q.key,
          res: await fetchLayerValue(
            q.cfg,
            lat,
            lng,
            zoom,
            getLayerTime(q.layer, time, layerTimes),
            ctrl.signal,
          ),
        })),
      );

      // Corrientes (MEDSEA uo/vo en Mediterráneo y profundidad seleccionada;
      // global ugos/vgos fuera del Med para superficie).
      let current: { speed: number; dirDeg: number } | null = null;
      if (altCfg || multiLayer?.streamlines.enabled) {
        const vector = await fetchCopernicusCurrentVector({
          lat,
          lng,
          zoom,
          time: altTime ?? time,
          depth: multiLayer?.streamlines.depth ?? "surface",
          signal: ctrl.signal,
        });
        if (vector) current = { speed: vector.speed, dirDeg: vector.dirDeg };
      }

      if (ctrl.signal.aborted) return;

      const next: MultiPointInfo = {
        lat,
        lng,
        loading: false,
        time: time?.slice(0, 10),
        sst: results.find((r) => r.key === "sst")?.res ?? null,
        chl: results.find((r) => r.key === "chl")?.res ?? null,
        alt: results.find((r) => r.key === "alt")?.res ?? null,
        current,
      };
      setInfo(next);
    },
  });

  if (!info) return null;

  const hasAny =
    (info.sst && info.sst.raw != null) ||
    (info.chl && info.chl.raw != null) ||
    (info.alt && info.alt.raw != null) ||
    info.current != null;

  return (
    <Popup
      position={[info.lat, info.lng]}
      eventHandlers={{ remove: () => setInfo(null) }}
      maxWidth={180}
      minWidth={130}
      className="compact-popup"
    >
      <div className="font-body min-w-[130px] max-w-[170px] text-[10px] leading-tight">
        <div
          className="mb-1 text-[9px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--muted-foreground)" }}
        >
          Punto
        </div>

        {info.loading ? (
          <div className="text-[10px]" style={{ color: "var(--muted-foreground)" }}>
            Consultando…
          </div>
        ) : !hasAny ? (
          <div className="text-[10px]" style={{ color: "var(--muted-foreground)" }}>
            Sin datos
          </div>
        ) : (
          <div className="space-y-0.5">
            {info.sst && (
              <div className="flex justify-between gap-1 text-[10px]">
                <span style={{ color: "var(--muted-foreground)" }}>Temp.</span>
                <span className="font-semibold" style={{ color: "var(--foreground)" }}>
                  {info.sst.value ?? "–"}
                </span>
              </div>
            )}
            {info.chl && (
              <div className="flex justify-between gap-1 text-[10px]">
                <span style={{ color: "var(--muted-foreground)" }}>Clor.</span>
                <span className="font-semibold" style={{ color: "var(--foreground)" }}>
                  {info.chl.value ?? "–"}
                </span>
              </div>
            )}
            {info.alt && (
              <div className="flex justify-between gap-1 text-[10px]">
                <span style={{ color: "var(--muted-foreground)" }}>Nivel</span>
                <span className="font-semibold" style={{ color: "var(--foreground)" }}>
                  {info.alt.value ?? "–"}
                </span>
              </div>
            )}
            {info.current && (
              <div className="flex justify-between gap-1 text-[10px]">
                <span style={{ color: "var(--muted-foreground)" }}>Corr.de</span>
                <span className="font-semibold" style={{ color: "var(--foreground)" }}>
                  {info.current.speed.toFixed(2)} m/s {bearingToCompass(info.current.dirDeg)}
                </span>
              </div>
            )}
          </div>
        )}

        <div
          className="mt-1 border-t pt-1 font-mono text-[9px] leading-tight"
          style={{ color: "var(--muted-foreground)", borderColor: "var(--border)" }}
        >
          <div>{toDMS(info.lat, true)}</div>
          <div>{toDMS(info.lng, false)}</div>
        </div>
      </div>
    </Popup>
  );
}

const MemoizedOceanMask = memo(OceanMask);
const MemoizedBathymetryLayer = memo(BathymetryLayer);
const MemoizedGpsTracker = memo(GpsTracker);
const MemoizedFishingHotspots = memo(FishingHotspots);
const MemoizedSavedWaypointsLayer = memo(SavedWaypointsLayer);
const MemoizedSearchAreaLayer = memo(SearchAreaLayer);

interface SingleLayerProps {
  activeLayer: LayerType;
  multiLayer?: undefined;
}

interface MultiLayerProps {
  activeLayer?: undefined;
  multiLayer: MultiLayerState;
}

type OceanMapProps = (SingleLayerProps | MultiLayerProps) & {
  initialCenter?: [number, number];
  initialZoom?: number;
  bathymetryRelief?: boolean;
  bathymetryContours?: boolean;
  bathymetrySlope?: boolean;
  bathymetryReliefIntensity?: number;
  bathymetryHdMode?: boolean;
  time?: string;
  layerTimes?: Partial<Record<LayerType, string>>;
  cacheBust?: string;
  flyToTrigger?: number;
  flyToCenter?: [number, number];
  flyToZoom?: number;
  onTileError?: (layerId?: string) => void;
  onTileLoad?: (layerId?: string) => void;
  gpsPosition?: GpsPosition | null;
  gpsTrack?: GpsPosition[];
  gpsFollow?: boolean;
  gpsRecenterTrigger?: number;
  onGpsUserPan?: () => void;
  navDestination?: { lat: number; lng: number; name: string } | null;
  hotZoneEnabled?: boolean;
  hotZoneIntensity?: number;
  hotZoneMode?: "precise" | "explore";
  fishingMode?: "surface" | "bottom" | "squid" | "drift";
  spotsEnabled?: boolean;
  spotsMinDepth?: number;
  spotsMaxDepth?: number;
  spotsRecomputeTrigger?: number;
  spotsClearTrigger?: number;
  spotsDebug?: boolean;
  onSpotsLoadingChange?: (loading: boolean) => void;
  onSpotsProgress?: (phase: string | null) => void;
  onSpotsAnalysisError?: (message: string) => void;
  onSpotsChange?: (spots: FishingSpot[], routes: FishingSpot[][]) => void;
  onSpotsAnalysisSummary?: (s: {
    cellsAnalyzed: number;
    maxScore: number;
    bestCluster: { lat: number; lng: number; score: number; cells: number } | null;
    insideArea: boolean;
    mode: "surface" | "bottom";
    noResultReason?: string;
    bathymetrySource?: "emodnet" | "ncei" | "gebco" | "mixed" | "none";
    bathymetryLabel?: string;
  }) => void;
  savedWaypoints?: SavedWaypoint[];
  onRemoveSavedWaypoint?: (id: string) => void;
  topSpot?: { lat: number; lng: number } | null;
  searchArea?: SearchArea | null;
  /** Plan de pesca marcado por la IA (Top 1/2/3 + polígonos + deriva). */
  aiPlan?: AdvisorPlanSpot[] | null;
  searchDrawMode?: DrawMode;
  onSearchAreaChange?: (area: SearchArea | null) => void;
  onSearchDrawEnd?: () => void;
  onMapBoundsReady?: (
    getBounds: () => {
      sw: { lat: number; lng: number };
      ne: { lat: number; lng: number };
      center: { lat: number; lng: number };
      zoom: number;
    },
  ) => void;

  onSstRangeChange?: (ranges: ViewportSstRanges) => void;
  /** "auto" = escala adapta al viewport; "manual" = rango fijo del config */
  sstScaleMode?: "auto" | "manual";
  fastMode?: boolean;
  /** Mostrar líneas de frentes térmicos (estilo ROFFS). Default: true. */
  frontLines?: boolean;
  landMask?: {
    enabled?: boolean;
    fillOpacity?: number;
    strokeOpacity?: number;
    strokeWeight?: number;
  };
  thermoclineEnabled?: boolean;
  /** Capa profesional de fondo marino (DEM propio). */
  seafloor?: SeafloorSettings;
  seafloorPickMode?: "none" | "info" | "profile";
  seafloorProfilePoints?: { lat: number; lng: number }[];
  onSeafloorPick?: (lat: number, lng: number) => void;
  onSeafloorGrid?: (grid: DemGrid | null) => void;
  onSeafloorStructures?: (list: SeafloorStructure[]) => void;
  onSeafloorLoading?: (loading: boolean) => void;
  /** Zonas de gradiente detectadas (Frentes Productivos). */
  gradientZones?: GradientZone[];
  /** Corredores de pesca por id de zona. */
  gradientCorridors?: Record<string, LatLng[] | undefined>;
  /** Zona enfocada (resaltada). */
  gradientFocusedId?: string | null;
  /** Puntos calientes marcados por zona. */
  gradientHotPoints?: Record<string, LatLng | undefined>;
  /** Notifica cambios de la vista (bounds + zoom) — usado por Frentes Productivos. */
  onMapViewChange?: (v: {
    bounds: { south: number; west: number; north: number; east: number };
    zoom: number;
    center?: { lat: number; lng: number };
  }) => void;
  /** Permite guardar un spot del análisis como waypoint persistente. */
  onSaveWaypoint?: (
    lat: number,
    lng: number,
    score: number,
    depth: number | null,
    reason: string,
    defaultName: string,
  ) => void;
  /** Modo "Añadir waypoint": el siguiente clic en el mapa abre el diálogo. */
  addWaypointMode?: boolean;
  /** Callback cuando el usuario hace clic con el modo activo. */
  onPickWaypoint?: (lat: number, lng: number) => void;
};

function MapViewBridge({
  onChange,
}: {
  onChange: (v: {
    bounds: { south: number; west: number; north: number; east: number };
    zoom: number;
    center?: { lat: number; lng: number };
  }) => void;
}) {
  const map = useMap();
  const emit = () => {
    const b = map.getBounds();
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    // Centro REAL del mapa (proyección Mercator). La media aritmética de
    // latitudes desplaza el punto varios km hacia el sur/norte y hacía que
    // el waypoint "del centro" cayera en tierra.
    const c = map.getCenter();
    onChange({
      bounds: { south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng },
      zoom: map.getZoom(),
      center: { lat: c.lat, lng: c.lng },
    });
  };
  useEffect(() => {
    emit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useMapEvents({ moveend: emit, zoomend: emit });
  return null;
}

/**
 * Captura un único clic del usuario cuando está activo el modo "Añadir
 * waypoint". Cambia el cursor a crosshair para feedback visual.
 */
function WaypointPickHandler({
  active,
  onPick,
}: {
  active: boolean;
  onPick: (lat: number, lng: number) => void;
}) {
  const map = useMap();
  useEffect(() => {
    if (!active) return;
    const container = map.getContainer();
    const prev = container.style.cursor;
    container.style.cursor = "crosshair";
    return () => {
      container.style.cursor = prev;
    };
  }, [active, map]);
  useMapEvents({
    click(e) {
      if (!active) return;
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export function OceanMap(props: OceanMapProps) {
  const [mbar24Status, setMbar24Status] = useState<Mbar24Status2D>({
    active: false,
    sheet: null,
    resolutionM: null,
    fullyInside: false,
    atNativeLimit: false,
  });
  const isMulti = !!props.multiLayer;
  const primaryLayer: LayerType = isMulti ? props.multiLayer!.sst.layer : props.activeLayer!;
  const sstAutoScale = props.sstScaleMode !== "manual";
  // Sólo mantenemos lectura estable si el usuario fuerza escala manual. En Auto
  // el rango SST tiene que recalcularse por zoom/viewport para ver diferencias
  // pequeñas; antes esto estaba siempre en true y bloqueaba el cambio real.
  const stableReadingMode = !sstAutoScale;
  // Altimetría Micro queda también fija para evitar cambios de color al mover.
  const altMicroActive =
    props.activeLayer === "alt_adt_micro" ||
    (props.multiLayer?.altimetry.enabled && props.multiLayer.altimetry.layer === "alt_adt_micro");
  // Autoescala regional dinámica: además de SST-auto y AltMicro, activamos
  // siempre el muestreo viewport cuando hay CHL o ADT (normal/combinada)
  // visibles, para que se adapten al área visible (Mediterráneo vs Atlántico).
  const adtAdaptiveActive = !!(
    props.multiLayer?.altimetry.enabled &&
    (props.multiLayer.altimetry.layer === "alt_adt" ||
      props.multiLayer.altimetry.layer === "alt_combined" ||
      props.multiLayer.altimetry.layer === "alt_adt_micro")
  );
  const chlAdaptiveActive = !!(
    props.multiLayer?.chlorophyll.enabled &&
    ["chl", "chl_hc", "chl_monthly", "chl_micro", "chl_nano", "chl_pico"].includes(
      props.multiLayer.chlorophyll.layer,
    )
  );
  const activeIsAdaptive =
    props.activeLayer === "alt_adt_micro" ||
    props.activeLayer === "alt_adt" ||
    props.activeLayer === "alt_combined" ||
    props.activeLayer === "chl" ||
    props.activeLayer === "chl_hc";
  // SST siempre adapta su escala al rango térmico del viewport: es la única
  // forma de distinguir frentes de 0.1–0.2 °C en el Mediterráneo (no se
  // requiere modo Auto explícito).
  const sstAdaptiveActive =
    !!props.multiLayer?.sst.enabled ||
    (props.activeLayer
      ? props.activeLayer.startsWith("sst_") &&
        props.activeLayer !== "sst_error" &&
        props.activeLayer !== "sst_ice"
      : false);
  // Re-activado: el modo adaptativo es la única forma de distinguir diferencias
  // térmicas pequeñas (0.1–0.3 °C) en el Mediterráneo en verano. El bug del
  // bucle infinito ya está corregido vía onSstRangeChangeRef.
  const adaptiveEnabled =
    sstAutoScale && (sstAdaptiveActive || chlAdaptiveActive || adtAdaptiveActive);
  const [viewportStyleOverrides, setViewportStyleOverrides] = useState<ViewportStyleOverrides>({});
  const effectiveViewportStyleOverrides = adaptiveEnabled
    ? viewportStyleOverrides
    : ({} as ViewportStyleOverrides);
  // Mantenemos onSstRangeChange en una ref para que el callback que pasamos a
  // ViewportAdaptiveContrast sea ESTABLE entre renders. Antes dependía de
  // `props` completo y se recreaba en cada render, lo que hacía que el
  // useEffect interno de ViewportAdaptiveContrast cancelase y reprogramara su
  // debounce de 500ms infinitamente → nunca se muestreaba la SST y la escala
  // Auto se quedaba colgada (en verano todo rojo con paleta fija 16–22 °C).
  const onSstRangeChangeRef = useRef(props.onSstRangeChange);
  useEffect(() => {
    onSstRangeChangeRef.current = props.onSstRangeChange;
  }, [props.onSstRangeChange]);
  const handleViewportStyleChange = useCallback(
    (overrides: ViewportStyleOverrides, sstRanges: ViewportSstRanges = {}) => {
      setViewportStyleOverrides(overrides);
      onSstRangeChangeRef.current?.(sstRanges);
    },
    [],
  );
  // Cuando el usuario vuelve a Manual, limpiamos la leyenda dinámica.
  useEffect(() => {
    if (!adaptiveEnabled) {
      setViewportStyleOverrides({});
      onSstRangeChangeRef.current?.({});
    }
  }, [adaptiveEnabled]);
  // Activado por MedViewportDetector — fuerza el swap del dataset altimétrico
  // global por el modelo MEDSEA (1/24°) cuando el viewport está en el Med.
  const [medViewport, setMedViewport] = useState(false);

  const activeLegendLayers = useMemo(() => {
    if (props.multiLayer) {
      return [props.multiLayer.sst, props.multiLayer.chlorophyll, props.multiLayer.altimetry]
        .filter((layer) => layer.enabled)
        .map((layer) => layer.layer);
    }
    return props.activeLayer ? [props.activeLayer] : [];
  }, [props.activeLayer, props.multiLayer]);
  const activeRasterPanes = useMemo(() => {
    if (props.multiLayer) {
      return (["sst", "chlorophyll", "altimetry"] as const)
        .filter((group) => props.multiLayer?.[group].enabled && props.multiLayer[group].opacity > 0)
        .map((group) => getGroupPane(group));
    }

    if (!props.activeLayer) return [];
    return [getPaneForLayerType(props.activeLayer)];
  }, [props.activeLayer, props.multiLayer]);
  // Streamlines de corrientes geostróficas (ugos+vgos de Copernicus
  // SEALEVEL_GLO_PHY_L4_NRT_OBSERVATIONS).
  // - Modo multi-capa: controlado por el toggle "Corrientes visuales" del panel.
  // - Modo single-layer: ON automático cuando el usuario elige una capa de
  //   altimetría (para ver corrientes encima de SLA/ADT/EKE).
  const velocityEnabled = useMemo(() => {
    if (props.multiLayer) return !!props.multiLayer.streamlines?.enabled;
    if (!props.activeLayer) return false;
    return LAYER_CONFIGS[props.activeLayer].group === "altimetry";
  }, [props.activeLayer, props.multiLayer]);
  const velocityOpacity = props.multiLayer?.streamlines?.opacity ?? 0.9;
  const velocityIntensity = props.multiLayer?.streamlines?.intensity ?? "high";
  const velocityDepth = props.multiLayer?.streamlines?.depth ?? "surface";
  const bathymetryVisible = !!(
    props.bathymetryRelief ||
    props.bathymetryContours ||
    props.bathymetrySlope
  );

  // Detectamos si hay UNA sola capa Copernicus activa para desactivar los
  // mix-blend-mode (que solo tienen sentido cuando combinamos varias capas).
  const enabledCopernicusCount = useMemo(() => {
    if (props.multiLayer) {
      return (["sst", "chlorophyll", "altimetry"] as const).filter(
        (g) => props.multiLayer?.[g].enabled && props.multiLayer[g].opacity > 0,
      ).length;
    }
    return props.activeLayer ? 1 : 0;
  }, [props.activeLayer, props.multiLayer]);

  // Detectamos preset "compare3" para activar blend modes disjuntos (paletas
  // que NO se solapan): ALT base, CHL multiply verde, SST screen cálido.
  const isCompare3 = useMemo(() => {
    const m = props.multiLayer;
    if (!m) return false;
    return (
      m.sst.enabled &&
      m.chlorophyll.enabled &&
      m.altimetry.enabled &&
      m.sst.layer === "sst_nrt_hc" &&
      m.chlorophyll.layer === "chl_hc" &&
      m.altimetry.layer === "alt_combined"
    );
  }, [props.multiLayer]);

  const sstBlendMode = sstAutoScale ? "normal" : (props.multiLayer?.sstBlendMode ?? "normal");
  useEffect(() => {
    const single = enabledCopernicusCount <= 1;
    document.body.classList.toggle("ocean-data-stable", stableReadingMode);
    document.body.classList.toggle("ocean-single-layer", single);
    document.body.classList.toggle("ocean-compare3", isCompare3);
    document.body.dataset.sstBlend = sstBlendMode;
    return () => {
      document.body.classList.remove("ocean-data-stable");
      document.body.classList.remove("ocean-single-layer");
      document.body.classList.remove("ocean-compare3");
      delete document.body.dataset.sstBlend;
    };
  }, [enabledCopernicusCount, isCompare3, sstBlendMode, stableReadingMode]);

  return (
    <MapContainer
      center={props.initialCenter ?? [39.65, 3.05]}
      zoom={props.initialZoom ?? 10}
      minZoom={MAP_MIN_ZOOM}
      maxZoom={MAP_MAX_ZOOM}
      className="h-full w-full"
      preferCanvas={true}
      fadeAnimation={false}
      zoomAnimation={false}
      markerZoomAnimation={false}
      wheelDebounceTime={80}
      zoomControl={false}
      attributionControl={true}
      doubleClickZoom={false}
    >
      <MapUpdater />
      <MapInteractionPerformanceController />
      <LayerPaneLifecycleController
        activeRasterPanes={activeRasterPanes}
        velocityEnabled={velocityEnabled}
        bathymetryVisible={bathymetryVisible}
      />
      {adaptiveEnabled && !props.fastMode && (
        <ViewportAdaptiveContrast
          activeLayer={props.activeLayer}
          multiLayer={props.multiLayer}
          time={props.time}
          layerTimes={props.layerTimes}
          onChange={handleViewportStyleChange}
        />
      )}
      <OceanFrontEnhancer
        activeLayer={props.activeLayer}
        multiLayer={props.multiLayer}
        disabled={stableReadingMode || props.fastMode}
      />
      {!stableReadingMode && props.multiLayer?.isolines && (
        <IsolineLayer
          isolines={props.multiLayer.isolines}
          multiLayer={props.multiLayer}
          disabled={props.fastMode}
        />
      )}
      <CenterCrosshair
        enabled={!!props.multiLayer?.centerCrosshair}
        multiLayer={props.multiLayer}
        activeLayer={props.activeLayer}
        time={props.time}
        layerTimes={props.layerTimes}
        topSpot={props.topSpot}
        fishingMode={props.fishingMode}
      />
      <FishingDirectionArrow
        spot={props.topSpot ?? null}
        zones={props.gradientZones ?? []}
        depth={props.multiLayer?.streamlines?.depth ?? "surface"}
      />
      <FlyToController
        center={props.flyToCenter}
        zoom={props.flyToZoom}
        trigger={props.flyToTrigger}
      />
      <ZoomControl position="bottomright" />
      <ClickHandler
        activeLayer={primaryLayer}
        multiLayer={props.multiLayer}
        time={props.time}
        layerTimes={props.layerTimes}
        disabled={!!props.multiLayer?.fsle?.enabled}
      />
      <ResolutionIndicator activeLayer={primaryLayer} />

      <TileLayer
        url="https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}"
        attribution="Ocean Basemap &copy; Esri, GEBCO, NOAA"
        maxNativeZoom={13}
        maxZoom={MAP_MAX_ZOOM}
        crossOrigin={true}
        className="basemap-smooth"
        updateWhenIdle={true}
        updateWhenZooming={false}
        keepBuffer={1}
        noWrap={true}
      />

      <TileLayer
        url="https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}"
        attribution=""
        maxNativeZoom={16}
        maxZoom={MAP_MAX_ZOOM}
        opacity={0.25}
        crossOrigin={true}
        className="basemap-hillshade"
        updateWhenIdle={true}
        updateWhenZooming={false}
        keepBuffer={1}
        noWrap={true}
      />

      <MemoizedOceanMask
        targetPaneClass={COPERNICUS_PANE_CLASS}
        enabled={false}
        fillOpacity={0}
        strokeOpacity={0}
        strokeWeight={0}
      />

      {/* High-res OSM Mallorca: solo línea de costa, sin relleno gris que tape el mar. */}
      <HighResMallorcaCoast enabled={!props.fastMode && (props.landMask?.enabled ?? true)} />

      {isMulti ? (
        <>
          {(["sst", "chlorophyll", "altimetry"] as const).map((group) => {
            const gs = props.multiLayer![group];
            if (!gs.enabled || gs.opacity <= 0) return null;

            const cfg = resolveEffectiveCfg(gs.layer, medViewport);
            const targetPane = getGroupPane(group);
            const altActive =
              !!props.multiLayer?.altimetry.enabled && props.multiLayer.altimetry.opacity > 0;
            const layerOpacity = getRecommendedOpacity(
              group,
              gs.opacity,
              !!props.bathymetryHdMode,
              altActive,
            );
            const layerTime = getLayerTime(gs.layer, props.time, props.layerTimes);

            return (
              <Fragment
                key={`multi-${group}-${gs.layer}-${cfg.wmtsLayer}-${layerTime ?? "latest"}-${props.cacheBust ?? "fresh"}`}
              >
                <OceanMaskedTileLayer
                  url={buildWmtsUrlWithStyle(
                    cfg,
                    getEffectiveStyleOverride(
                      gs.layer,
                      medViewport,
                      effectiveViewportStyleOverrides,
                    ),
                    layerTime,
                    props.cacheBust,
                  )}
                  opacity={layerOpacity}
                  maxNativeZoom={cfg.nativeZoom}
                  maxZoom={getDataLayerMaxZoom(cfg)}
                  pane={targetPane}
                  className={getLayerClass(gs.layer)}
                  recolorSstRed={shouldRecolorSstRed(gs.layer)}
                  attribution='&copy; <a href="https://marine.copernicus.eu/">Copernicus Marine</a>'
                  layerId={group === "sst" ? "SST" : group === "chlorophyll" ? "CHL" : "ALT"}
                  onTileError={props.onTileError}
                  onTileLoad={props.onTileLoad}
                />
              </Fragment>
            );
          })}
        </>
      ) : (
        <>
          {(() => {
            const activeCfg = resolveEffectiveCfg(props.activeLayer!, medViewport);
            return (
              <OceanMaskedTileLayer
                key={`${props.activeLayer}-${activeCfg.wmtsLayer}-${getLayerTime(props.activeLayer!, props.time, props.layerTimes) ?? "latest"}-${props.cacheBust ?? "fresh"}`}
                url={buildWmtsUrlWithStyle(
                  activeCfg,
                  getEffectiveStyleOverride(
                    props.activeLayer!,
                    medViewport,
                    effectiveViewportStyleOverrides,
                  ),
                  getLayerTime(props.activeLayer!, props.time, props.layerTimes),
                  props.cacheBust,
                )}
                opacity={getRecommendedOpacity(activeCfg.group, 1, !!props.bathymetryHdMode)}
                maxNativeZoom={activeCfg.nativeZoom}
                maxZoom={getDataLayerMaxZoom(activeCfg)}
                pane={getPaneForLayerType(props.activeLayer!)}
                className={getLayerClass(props.activeLayer!)}
                recolorSstRed={shouldRecolorSstRed(props.activeLayer!)}
                attribution='&copy; <a href="https://marine.copernicus.eu/">Copernicus Marine</a>'
                layerId={
                  activeCfg.group === "sst"
                    ? "SST"
                    : activeCfg.group === "chlorophyll"
                      ? "CHL"
                      : "ALT"
                }
                onTileError={props.onTileError}
                onTileLoad={props.onTileLoad}
              />
            );
          })()}
        </>
      )}

      {!props.fastMode && (
        <>
          <MemoizedBathymetryLayer
            showRelief={!!props.bathymetryRelief}
            showContours={!!props.bathymetryContours}
            coastalEnhancement={!!props.bathymetryHdMode}
            showSlope={!!props.bathymetrySlope}
            reliefIntensity={props.bathymetryReliefIntensity ?? 1}
            hideEmodnet={mbar24Status.active && mbar24Status.fullyInside}
            hideEmodnetContours={mbar24Status.active}
            onTileError={props.onTileError}
          />
          {/* Batimetría real IHM MBAR24 (16 m) sobre el mapa 2D principal. */}
          <Mbar24BathymetryLayer
            showRelief={!!props.bathymetryRelief}
            showContours={!!props.bathymetryContours}
            contrast={0.7 + (props.bathymetryReliefIntensity ?? 0.85) * 1.2}
            onStatusChange={setMbar24Status}
          />
        </>
      )}

      <TileLayer
        url="https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
        attribution="Labels &copy; Esri"
        maxNativeZoom={19}
        maxZoom={MAP_MAX_ZOOM}
        crossOrigin={true}
        updateWhenIdle={true}
        updateWhenZooming={false}
        keepBuffer={1}
        noWrap={true}
      />

      <MemoizedGpsTracker
        position={props.gpsPosition ?? null}
        track={props.gpsTrack ?? []}
        follow={!!props.gpsFollow}
        recenterTrigger={props.gpsRecenterTrigger}
        onUserPan={props.onGpsUserPan}
        navDestination={props.navDestination ?? null}
      />

      {(() => {
        // Fecha efectiva compartida por streamlines (uo/vo) y FSLE. Se
        // recalcula en cada render de OceanMap a partir de la fecha que el
        // usuario tiene seleccionada en el DateSelector (props.time) o, si
        // está en modo "Reciente", de la fecha resuelta por capa. La misma
        // fecha alimenta ambas capas para que corrientes, líneas FSLE y
        // dataset_time avancen SIEMPRE juntas al mover el selector.
        const resolvedTime =
          getLayerTime("alt_combined", props.time, props.layerTimes) ??
          props.time ??
          new Date().toISOString().slice(0, 10);
        const clamped = getEffectiveTime(LAYER_CONFIGS.alt_combined, resolvedTime);
        const sharedDate = (clamped ?? resolvedTime).slice(0, 10);
        return (
          <>
            {velocityEnabled && (
              <VelocityLayer
                time={sharedDate}
                opacity={velocityOpacity}
                intensity={velocityIntensity}
                depth={velocityDepth}
                refreshKey={`${props.cacheBust ?? ""}::${sharedDate}::${velocityDepth}`}
              />
            )}
            <FsleLayer
              enabled={!!props.multiLayer?.fsle?.enabled}
              multiLayer={props.multiLayer}
              layerTimes={props.layerTimes}
              time={sharedDate}
            />

          </>
        );
      })()}


      <ThermoclineLayer enabled={!!props.thermoclineEnabled} time={props.time} />

      {props.seafloor && (
        <SeafloorLayer
          settings={props.seafloor}
          gpsPosition={props.gpsPosition ?? null}
          pickMode={props.seafloorPickMode ?? "none"}
          profilePoints={props.seafloorProfilePoints ?? []}
          onPick={props.onSeafloorPick}
          onGridChange={props.onSeafloorGrid}
          onStructuresChange={props.onSeafloorStructures}
          onLoadingChange={props.onSeafloorLoading}
        />
      )}

      <MemoizedFishingHotspots
        enabled={!props.fastMode && !!props.spotsEnabled}
        layerTimes={props.layerTimes}
        minDepth={props.spotsMinDepth ?? 200}
        maxDepth={props.spotsMaxDepth ?? 1000}
        recomputeTrigger={props.spotsRecomputeTrigger}
        clearTrigger={props.spotsClearTrigger}
        onSpotsChange={props.onSpotsChange}
        searchArea={props.searchArea ?? null}
        minScore={props.searchArea ? 0.18 : 0.35}
        // 🔥 Zona caliente activa → pocos puntos rankeados.
        // - precise: máx 3 (filtros estrictos)
        // - explore: máx 5 (filtros más permisivos)
        maxSpots={
          props.hotZoneEnabled
            ? props.hotZoneMode === "explore"
              ? 5
              : 3
            : props.searchArea
              ? 30
              : 18
        }
        // 🔥 Modo "solo el mejor": oculta marcadores secundarios y rutas,
        // muestra únicamente Top 1–N (uno por microzona, sin solape).
        hotZoneOnly={!!props.hotZoneEnabled}
        hotZoneMode={props.hotZoneMode ?? "precise"}
        fishingMode={props.fishingMode ?? "surface"}
        debug={!!props.spotsDebug}
        onLoadingChange={props.onSpotsLoadingChange}
        onProgress={props.onSpotsProgress}
        onAnalysisError={props.onSpotsAnalysisError}
        onAnalysisSummary={props.onSpotsAnalysisSummary}
        onSaveWaypoint={props.onSaveWaypoint}
      />

      <MemoizedSavedWaypointsLayer
        waypoints={props.savedWaypoints ?? []}
        onRemove={props.onRemoveSavedWaypoint}
      />

      <WaypointPickHandler
        active={!!props.addWaypointMode}
        onPick={(lat, lng) => props.onPickWaypoint?.(lat, lng)}
      />

      <MemoizedSearchAreaLayer
        mode={props.searchDrawMode ?? null}
        area={props.searchArea ?? null}
        onAreaChange={(a) => props.onSearchAreaChange?.(a)}
        onDrawEnd={() => props.onSearchDrawEnd?.()}
      />

      <AiPlanLayer plan={props.aiPlan ?? null} />

      <CabreraParkBoundary />

      <GradientZonesLayer
        zones={props.gradientZones ?? []}
        corridors={props.gradientCorridors ?? {}}
        hotPoints={props.gradientHotPoints ?? {}}
        focusedId={props.gradientFocusedId ?? null}
      />

      {props.onMapViewChange && <MapViewBridge onChange={props.onMapViewChange} />}
      {props.onMapBoundsReady && <MapBoundsBridge onReady={props.onMapBoundsReady} />}
      <MedViewportDetector onChange={setMedViewport} />
    </MapContainer>
  );
}

