import { useEffect, useState } from "react";
import type { ViewportSstRanges } from "./ViewportAdaptiveContrast";
import type { LayerType } from "./ocean-layers";
import type { MultiLayerState } from "./MultiLayerPanel";
import type { GpsPosition } from "./GpsTracker";
import type { FishingSpot } from "./FishingHotspots.types";
import type { SavedWaypoint } from "../hooks/use-saved-waypoints";
import type { SearchArea } from "../lib/geo-area";
import type { DrawMode } from "./SearchAreaLayer";
import type { AdvisorPlanSpot } from "../lib/ai-advisor";
import type { GradientZone } from "../lib/gradient-zones.types";
import type { LatLng } from "../lib/geo-area";
import type { SeafloorSettings } from "../lib/seafloor.types";
import type { DemGrid } from "../lib/dem";
import type { SeafloorStructure } from "../lib/seafloor-structures";

interface CommonProps {
  seafloor?: SeafloorSettings;
  seafloorPickMode?: "none" | "info" | "profile";
  seafloorProfilePoints?: { lat: number; lng: number }[];
  onSeafloorPick?: (lat: number, lng: number) => void;
  onSeafloorGrid?: (grid: DemGrid | null) => void;
  onSeafloorStructures?: (list: SeafloorStructure[]) => void;
  onSeafloorLoading?: (loading: boolean) => void;
  initialCenter?: [number, number];
  initialZoom?: number;
  bathymetryRelief?: boolean;
  bathymetryContours?: boolean;
  bathymetrySlope?: boolean;
  bathymetryReliefIntensity?: number;
  bathymetryHdMode?: boolean;
  /** ISO date (YYYY-MM-DD) for historical Copernicus WMTS data. */
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
  sstScaleMode?: "auto" | "manual";
  fastMode?: boolean;
  landMask?: {
    enabled?: boolean;
    fillOpacity?: number;
    strokeOpacity?: number;
    strokeWeight?: number;
  };
  thermoclineEnabled?: boolean;
  gradientZones?: GradientZone[];
  gradientCorridors?: Record<string, LatLng[] | undefined>;
  gradientHotPoints?: Record<string, LatLng | undefined>;
  gradientFocusedId?: string | null;
  onMapViewChange?: (v: {
    bounds: { south: number; west: number; north: number; east: number };
    zoom: number;
    center?: { lat: number; lng: number };
  }) => void;
  onSaveWaypoint?: (
    lat: number,
    lng: number,
    score: number,
    depth: number | null,
    reason: string,
    defaultName: string,
  ) => void;
  addWaypointMode?: boolean;
  onPickWaypoint?: (lat: number, lng: number) => void;
}

interface SingleProps extends CommonProps {
  activeLayer: LayerType;
  multiLayer?: undefined;
}

interface MultiProps extends CommonProps {
  activeLayer?: undefined;
  multiLayer: MultiLayerState;
}

type OceanMapClientProps = SingleProps | MultiProps;

export function OceanMapClient(props: OceanMapClientProps) {
  const [OceanMapComponent, setOceanMapComponent] = useState<
    typeof import("./OceanMap").OceanMap | null
  >(null);

  useEffect(() => {
    let mounted = true;
    import("./OceanMap").then((module) => {
      if (mounted) setOceanMapComponent(() => module.OceanMap);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const shared = {
    seafloor: props.seafloor,
    seafloorPickMode: props.seafloorPickMode,
    seafloorProfilePoints: props.seafloorProfilePoints,
    onSeafloorPick: props.onSeafloorPick,
    onSeafloorGrid: props.onSeafloorGrid,
    onSeafloorStructures: props.onSeafloorStructures,
    onSeafloorLoading: props.onSeafloorLoading,
    initialCenter: props.initialCenter,
    initialZoom: props.initialZoom,
    bathymetryRelief: props.bathymetryRelief,
    bathymetryContours: props.bathymetryContours,
    bathymetrySlope: props.bathymetrySlope,
    bathymetryReliefIntensity: props.bathymetryReliefIntensity,
    bathymetryHdMode: props.bathymetryHdMode,
    time: props.time,
    layerTimes: props.layerTimes,
    cacheBust: props.cacheBust,
    flyToTrigger: props.flyToTrigger,
    flyToCenter: props.flyToCenter,
    flyToZoom: props.flyToZoom,
    onTileError: props.onTileError,
    onTileLoad: props.onTileLoad,
    gpsPosition: props.gpsPosition,
    gpsTrack: props.gpsTrack,
    gpsFollow: props.gpsFollow,
    gpsRecenterTrigger: props.gpsRecenterTrigger,
    onGpsUserPan: props.onGpsUserPan,
    navDestination: props.navDestination,
    hotZoneEnabled: props.hotZoneEnabled,
    hotZoneIntensity: props.hotZoneIntensity,
    hotZoneMode: props.hotZoneMode,
    fishingMode: props.fishingMode,
    spotsEnabled: props.spotsEnabled,
    spotsMinDepth: props.spotsMinDepth,
    spotsMaxDepth: props.spotsMaxDepth,
    spotsRecomputeTrigger: props.spotsRecomputeTrigger,
    spotsClearTrigger: props.spotsClearTrigger,
    spotsDebug: props.spotsDebug,
    onSpotsLoadingChange: props.onSpotsLoadingChange,
    onSpotsProgress: props.onSpotsProgress,
    onSpotsAnalysisError: props.onSpotsAnalysisError,
    onSpotsChange: props.onSpotsChange,
    onSpotsAnalysisSummary: props.onSpotsAnalysisSummary,
    savedWaypoints: props.savedWaypoints,
    onRemoveSavedWaypoint: props.onRemoveSavedWaypoint,
    topSpot: props.topSpot,
    searchArea: props.searchArea,
    aiPlan: props.aiPlan,
    searchDrawMode: props.searchDrawMode,
    onSearchAreaChange: props.onSearchAreaChange,
    onSearchDrawEnd: props.onSearchDrawEnd,
    onMapBoundsReady: props.onMapBoundsReady,
    onSstRangeChange: props.onSstRangeChange,
    sstScaleMode: props.sstScaleMode,
    fastMode: props.fastMode,
    landMask: props.landMask,
    thermoclineEnabled: props.thermoclineEnabled,
    gradientZones: props.gradientZones,
    gradientCorridors: props.gradientCorridors,
    gradientHotPoints: props.gradientHotPoints,
    gradientFocusedId: props.gradientFocusedId,
    onMapViewChange: props.onMapViewChange,
    onSaveWaypoint: props.onSaveWaypoint,
    addWaypointMode: props.addWaypointMode,
    onPickWaypoint: props.onPickWaypoint,
  };

  if (!OceanMapComponent) {
    return <div className="h-full w-full bg-background" />;
  }

  return props.multiLayer ? (
    <OceanMapComponent multiLayer={props.multiLayer} {...shared} />
  ) : (
    <OceanMapComponent activeLayer={props.activeLayer!} {...shared} />
  );
}

