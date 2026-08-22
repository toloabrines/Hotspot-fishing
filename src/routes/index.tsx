import { useSubscriptions } from "../hooks/use-subscriptions";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { supabase } from "../integrations/supabase/client";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ColorLegend } from "../components/ColorLegend";
import { DateSelector } from "../components/DateSelector";
import type { FishingSpot } from "../components/FishingHotspots.types";
import { FishingHotspotsControl } from "../components/FishingHotspotsControl";
import AiFishingAdvisor from "../components/AiFishingAdvisor";
import CatchLogPanel, { type CatchLogTarget } from "../components/CatchLogPanel";
import type { AdvisorPlanSpot } from "../lib/ai-advisor";

import { GpsControl } from "../components/GpsControl";
import { HotZoneControl } from "../components/HotZoneControl";
import { LayerSelector } from "../components/LayerSelector";
import { DEFAULT_MULTI_LAYER, MultiLayerPanel } from "../components/MultiLayerPanel";
import { OceanMapClient } from "../components/OceanMapClient";
import { REGIONS, RegionSelector, type Region } from "../components/RegionSelector";
import type { DrawMode } from "../components/SearchAreaLayer";
import { downloadGpx, useGeolocation } from "../hooks/use-geolocation";
import { useSavedTracks, type SavedTrack } from "../hooks/use-saved-tracks";
import { SavedTracksPanel } from "../components/SavedTracksPanel";
import { useWakeLock } from "../hooks/use-wake-lock";
import { useLowPower } from "../hooks/use-low-power";
import { useSavedWaypoints } from "../hooks/use-saved-waypoints";

import { usePersistentState } from "../hooks/use-persistent-state";
import { useWindForecast } from "../hooks/use-wind-forecast";
import { useCurrentForecast } from "../hooks/use-current-forecast";
import { usePressureForecast } from "../hooks/use-pressure-forecast";
import { useSolunar } from "../hooks/use-solunar";
import { formatHHMM, formatMinutesUntil } from "../lib/solunar";
import { toDegMinSec } from "../components/FishingHotspots.types";
import type { SearchArea } from "../lib/geo-area";
import { LAYER_CONFIGS, type LayerType } from "../components/ocean-layers";

import { useResolvedCopernicusDate } from "../hooks/use-resolved-copernicus-date";
import { AppMenu } from "../components/AppMenu";
import type { ViewportSstRanges } from "../components/ViewportAdaptiveContrast";
import { GradientZonesControl } from "../components/GradientZonesControl";
import { WaypointsPanel } from "../components/WaypointsPanel";
import { NavigationScreen } from "../components/NavigationScreen";
import type { NavTarget } from "../lib/navigation";
import { useGradientZones } from "../hooks/use-gradient-zones";
import { useSavedZones, type SavedZoneSet } from "../hooks/use-saved-zones";
import { buildFishingCorridor, pickHotPointFromZone } from "../lib/fishing-corridor";
import type { GradientZone } from "../lib/gradient-zones.types";
import type { LatLng } from "../lib/geo-area";
import { SeafloorPanel } from "../components/SeafloorPanel";
import { SeafloorPointCard } from "../components/SeafloorPointCard";
import { SeafloorProfileChart } from "../components/SeafloorProfileChart";
import { Seafloor3DView } from "../components/Seafloor3DView";
import { DEFAULT_SEAFLOOR } from "../lib/seafloor.types";
import type { DemGrid, DemPointInfo } from "../lib/dem";
import type { SeafloorStructure } from "../lib/seafloor-structures";
import { getLandMask } from "../lib/land-mask";

export const Route = createFileRoute("/")({
  component: IndexRoute,
  head: () => ({
    meta: [
      { title: "Hotspot Fishing — Mapas Copernicus Marine" },
      {
        name: "description",
        content:
          "Visualización de clorofila, temperatura y altimetría oceánica con datos de Copernicus Marine Service",
      },
    ],
  }),
});

/**
 * Puerta de entrada: al abrir la URL de Hotspot Fishing lo primero es tener
 * cuenta. Si no hay sesión, redirigimos a /auth (modo «Crear cuenta»).
 */
function IndexRoute() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"checking" | "in" | "out">("checking");

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setStatus(data.session ? "in" : "out");
      if (!data.session) navigate({ to: "/auth", replace: true });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!alive) return;
      setStatus(session ? "in" : "out");
      if (!session) navigate({ to: "/auth", replace: true });
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [navigate]);

  if (status !== "in") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4">
        <p className="text-sm text-muted-foreground">Cargando Hotspot Fishing…</p>
      </main>
    );
  }
  return <Index />;
}

function Index() {
  // Default SST → producto ANALIZADO global (REP), estable en TODO el mundo.
  // El producto NRT de alta resolución (sst_nrt) sólo cubre regiones concretas
  // y devuelve error en zonas como África/Atlántico Sur — por eso usamos el
  // global aquí. El usuario puede cambiar a sst_nrt manualmente si quiere
  // detalle Mediterráneo.
  const [activeLayer, setActiveLayer] = usePersistentState<LayerType>(
    "activeLayer",
    "sst_analysed",
  );
  // Vista combinada estilo FishTrack:
  //  - SST como base nítida (gradiente suave de temperatura)
  //  - Clorofila encima en multiply (verdes marcando productividad)
  //  - Altimetría = corrientes animadas (líneas/flechas) por encima de todo
  const [multiLayer, setMultiLayer] = usePersistentState("multiLayer", {
    ...DEFAULT_MULTI_LAYER,
    sst: { layer: "sst_analysed" as LayerType, opacity: 0.52, enabled: false },
    chlorophyll: { layer: "chl" as LayerType, opacity: 0.78, enabled: false },
    altimetry: { layer: "alt_combined" as LayerType, opacity: 0.72, enabled: false },
  });
  // FSLE es un cálculo pesado. Aunque el usuario lo hubiese dejado activo
  // en una sesión anterior (persistido en localStorage), siempre arrancamos
  // con fsle.enabled=false: solo debe calcularse tras pulsar el toggle.
  useEffect(() => {
    if (multiLayer.fsle?.enabled) {
      setMultiLayer((s) => ({ ...s, fsle: { ...(s.fsle ?? { enabled: false }), enabled: false } }));
    }
    // Migración: sesiones antiguas no tienen streamlines.depth. Rellenar
    // con "surface" para que aparezca el selector de profundidad.
    if (multiLayer.streamlines && (multiLayer.streamlines as { depth?: unknown }).depth === undefined) {
      setMultiLayer((s) => ({
        ...s,
        streamlines: { ...s.streamlines, depth: "surface" },
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [multiLayerEnabled, setMultiLayerEnabled] = usePersistentState("multiLayerEnabled", true);
  const [panelOpen, setPanelOpen] = useState(false);
  // ☰ Menú lateral profesional — consolida TODOS los controles dispersos.
  const [menuOpen, setMenuOpen] = useState(false);
  // Fondo batimétrico + isobatas activadas por defecto: "carta náutica de pesca".
  const [bathyRelief, setBathyRelief] = usePersistentState("bathyRelief", true);
  const [bathyContours, setBathyContours] = usePersistentState("bathyContours", true);
  const [bathySlope, setBathySlope] = usePersistentState("bathySlope", false);
  const [bathyHdMode, setBathyHdMode] = usePersistentState("bathyHdMode", false);
  // ── Fondo marino profesional (DEM propio: hillshade, pendientes, estructuras) ──
  const [seafloor, setSeafloor] = usePersistentState("seafloorSettings", DEFAULT_SEAFLOOR);
  const [seafloorPickMode, setSeafloorPickMode] = useState<"none" | "info" | "profile">("none");
  const [seafloorProfilePoints, setSeafloorProfilePoints] = useState<
    { lat: number; lng: number }[]
  >([]);
  const [seafloorGrid, setSeafloorGrid] = useState<DemGrid | null>(null);
  const [seafloorStructures, setSeafloorStructures] = useState<SeafloorStructure[]>([]);
  const [seafloorLoading, setSeafloorLoading] = useState(false);
  const [seafloorPoint, setSeafloorPoint] = useState<{
    lat: number;
    lng: number;
    info: DemPointInfo;
  } | null>(null);
  const [seafloorShow3d, setSeafloorShow3d] = useState(false);

  const handleSeafloorPick = useCallback(
    (lat: number, lng: number) => {
      if (seafloorPickMode === "profile") {
        setSeafloorProfilePoints((prev) => (prev.length >= 2 ? [{ lat, lng }] : [...prev, { lat, lng }]));
        return;
      }
      if (seafloorPickMode === "info") {
        const info = seafloorGrid?.info(lat, lng);
        if (info) setSeafloorPoint({ lat, lng, info });
      }
    },
    [seafloorPickMode, seafloorGrid],
  );
  // Arranque limpio SIEMPRE: al abrir la app sólo se carga el mapa base y la
  // batimetría nueva. Ninguna capa de datos (SST, clorofila, altimetría,
  // corrientes, FSLE, viento) se monta hasta que una búsqueda la necesite.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setMultiLayer((s) => ({
      ...s,
      sst: { ...s.sst, enabled: false },
      chlorophyll: { ...s.chlorophyll, enabled: false },
      altimetry: { ...s.altimetry, enabled: false },
      streamlines: { ...(s.streamlines ?? { depth: "surface" }), enabled: false },
      fsle: { ...(s.fsle ?? { enabled: false }), enabled: false },
    }));
    setBathyRelief(true);
    setBathyContours(true);
    // Carta legible y ligera: base + relieve + isóbatas. Pendiente y doble
    // refuerzo costero quedan disponibles, pero no deben tapar ni bloquear.
    setBathySlope(false);
    setBathyHdMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [bathyIntensity, setBathyIntensity] = usePersistentState("bathyIntensity", 0.85);
  // 🟫 Máscara de tierra
  const [landMaskEnabled, setLandMaskEnabled] = usePersistentState("landMaskEnabled", true);
  const [landFillOpacity, setLandFillOpacity] = usePersistentState("landFillOpacity", 1);
  const [landStrokeOpacity, setLandStrokeOpacity] = usePersistentState("landStrokeOpacity", 0.85);
  const [landStrokeWeight, setLandStrokeWeight] = usePersistentState("landStrokeWeight", 0.6);
  // 🕘 Historial de auto-ajustes — guarda los últimos snapshots aplicados
  // por el botón "Auto-ajustar" para poder volver atrás con un clic. Se
  // persiste en localStorage para sobrevivir recargas. Máx 8 entradas.
  type LandMaskSnapshot = {
    id: number;
    ts: number;
    fillOpacity: number;
    strokeOpacity: number;
    strokeWeight: number;
  };
  const LAND_MASK_HISTORY_KEY = "landMaskAutoAdjustHistory.v1";
  const LAND_MASK_HISTORY_MAX = 8;
  const [landMaskHistory, setLandMaskHistory] = useState<LandMaskSnapshot[]>([]);
  // Cargar historial desde localStorage al montar (solo cliente).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(LAND_MASK_HISTORY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as LandMaskSnapshot[];
      if (Array.isArray(parsed)) setLandMaskHistory(parsed.slice(0, LAND_MASK_HISTORY_MAX));
    } catch {
      // ignorar JSON corrupto
    }
  }, []);
  // Persistir historial.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(LAND_MASK_HISTORY_KEY, JSON.stringify(landMaskHistory));
    } catch {
      // quota o storage deshabilitado: ignorar
    }
  }, [landMaskHistory]);
  // Cuando SST o CHL entran en modo "alto contraste", el relieve compite
  // visualmente con los microfrentes. Aplicamos un factor de atenuación
  // automático (×0.5) sobre la intensidad del slider para preservar la
  // legibilidad de los datos oceanográficos sin tener que tocar nada.
  const isHighContrastMode =
    multiLayerEnabled &&
    (multiLayer.sst.layer === "sst_nrt_hc" || multiLayer.chlorophyll.layer === "chl_hc");
  const HC_RELIEF_DAMPING = 0.5;
  // Cuando SOLO la capa de clorofila está activa, atenuamos fuerte el relieve
  // batimétrico (sombreado coloreado) para que las manchas de CHL destaquen
  // sobre el fondo. Las isobatas siguen visibles porque van en otra capa.
  const onlyChlActive =
    multiLayerEnabled &&
    multiLayer.chlorophyll.enabled &&
    !multiLayer.sst.enabled &&
    !multiLayer.altimetry.enabled;
  const CHL_ONLY_RELIEF_DAMPING = 0.45;
  const effectiveBathyIntensity = onlyChlActive
    ? bathyIntensity * CHL_ONLY_RELIEF_DAMPING
    : isHighContrastMode
      ? bathyIntensity * HC_RELIEF_DAMPING
      : bathyIntensity;

  const landMaskConfig = useMemo(
    () => ({
      enabled: landMaskEnabled,
      fillOpacity: landFillOpacity,
      strokeOpacity: landStrokeOpacity,
      strokeWeight: landStrokeWeight,
    }),
    [landFillOpacity, landMaskEnabled, landStrokeOpacity, landStrokeWeight],
  );
  // Fecha:
  //   - undefined  → seguir automáticamente la fecha resuelta más reciente.
  //   - string ISO → fecha fija elegida por el usuario en el DateSelector.
  // Al arrancar la app SIEMPRE intentamos hoy → ayer → … hasta hace 7 días
  // y nos quedamos con la primera que tenga datos. Esto evita el clásico
  // "Datos no disponibles" cuando Copernicus aún no ha publicado el día.
  const [time, setTime] = useState<string | undefined>(undefined);
  // Probamos primero el SST NRT alta resolución (cobertura hasta ~ayer),
  // luego CHL gap-free (también cerca de tiempo real), y por último el REP
  // global (que va con varios meses/años de retraso). Así, si Copernicus aún
  // no ha publicado SST NRT de hoy, igual obtenemos clorofila de hoy y la
  // app entra directa al modo combinado del día actual sin "datos no
  // disponibles".
  const resolved = useResolvedCopernicusDate(["sst_analysed", "chl", "alt_combined", "sst_nrt"]);
  // Fecha realmente cargada (lo que viaja a las capas WMTS):
  //   - si el usuario eligió una fecha → esa
  //   - si no → la última con datos detectada por la sonda
  const effectiveTime = time ?? resolved.resolvedDate;
  const effectiveLayerTimes = time ? undefined : resolved.resolvedByLayer;
  // CACHE DIARIO + REFRESCO MANUAL.
  // - El día efectivo controla la caché normal: las capas se vuelven a pedir
  //   automáticamente cuando cambia la fecha.
  // - `resolvedAt` se incluye SOLO cuando el usuario pulsa "Reciente" y la
  //   sonda termina con éxito. Sin esto, si la fecha resuelta no cambiaba
  //   (p.ej. SST y ALT ya estaban en su último día publicado), pulsar
  //   "Reciente" no remontaba los TileLayer y el navegador seguía mostrando
  //   los PNGs cacheados (Cache-Control: max-age=86400, immutable).
  //   Resultado: la altimetría parecía "siempre igual" al usuario.
  // Nonce manual para forzar refresco de tiles (botón "↻ Paleta"). Bumpea
  // el cacheBust ignorando la caché del navegador y del proxy upstream.
  const [manualPaletteNonce, setManualPaletteNonce] = useState(0);
  // Firma de las paletas activas: cualquier cambio en el `style` (cmap, vmin,
  // vmax) de las capas visibles invalida la caché automáticamente.
  const paletteSignature = useMemo(() => {
    const parts: string[] = [];
    if (multiLayerEnabled) {
      if (multiLayer.sst.enabled) parts.push(`sst:${LAYER_CONFIGS[multiLayer.sst.layer].style}`);
      if (multiLayer.chlorophyll.enabled)
        parts.push(`chl:${LAYER_CONFIGS[multiLayer.chlorophyll.layer].style}`);
      if (multiLayer.altimetry.enabled)
        parts.push(`alt:${LAYER_CONFIGS[multiLayer.altimetry.layer].style}`);
    } else {
      parts.push(`one:${LAYER_CONFIGS[activeLayer].style}`);
    }
    // Hash corto (djb2) para no inflar la URL.
    let h = 5381;
    const s = parts.join("|");
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }, [activeLayer, multiLayer, multiLayerEnabled]);
  const dataRefreshKey = `${(effectiveTime ?? "auto").slice(0, 10)}::${resolved.resolvedAt ?? 0}::p${paletteSignature}::m${manualPaletteNonce}`;
  // Panel diagnóstico de fecha (colapsable). Útil para verificar a simple
  // vista qué fecha pidió la app vs qué fecha cargó realmente.
  const [diagOpen, setDiagOpen] = useState(false);

  // Zona Caliente — heatmap de scoring multi-capa
  const [hotZoneEnabled, setHotZoneEnabled] = usePersistentState("hotZoneEnabled", false);
  const [hotZoneIntensity, setHotZoneIntensity] = usePersistentState("hotZoneIntensity", 0.7);
  const [hotZoneMode, setHotZoneMode] = usePersistentState<"precise" | "explore">(
    "hotZoneMode",
    "precise",
  );

  // ─────── Frentes Productivos ───────
  const [gradientEnabled, setGradientEnabled] = usePersistentState("gradientEnabledV2", false);
  const [gradientRecomputeNonce, setGradientRecomputeNonce] = useState(0);
  type MapViewSnapshot = {
    bounds: { south: number; west: number; north: number; east: number };
    zoom: number;
    center?: { lat: number; lng: number };
  };
  const [mapView, setMapView] = useState<MapViewSnapshot | null>(null);
  const handleMapViewChange = useCallback((v: MapViewSnapshot) => setMapView(v), []);
  const [gradientFocusedId, setGradientFocusedId] = useState<string | null>(null);
  const [gradientCorridors, setGradientCorridors] = useState<Record<string, LatLng[] | undefined>>(
    {},
  );
  const [gradientDetailedCorridors, setGradientDetailedCorridors] = useState<
    Record<string, LatLng[] | undefined>
  >({});
  const [gradientHotPoints, setGradientHotPoints] = useState<Record<string, LatLng | undefined>>(
    {},
  );
  const startGradientAnalysis = useCallback(() => {
    setGradientRecomputeNonce((n) => n + 1);
  }, []);
  const handleToggleCorridor = useCallback((zone: GradientZone) => {
    setGradientCorridors((prev) => {
      const next = { ...prev };
      if (next[zone.id]) delete next[zone.id];
      else next[zone.id] = buildFishingCorridor(zone);
      return next;
    });
  }, []);
  const handleToggleDetailedCorridor = useCallback((zone: GradientZone) => {
    setGradientDetailedCorridors((prev) => {
      const next = { ...prev };
      if (next[zone.id]) delete next[zone.id];
      else next[zone.id] = buildFishingCorridor(zone, { detailed: true });
      return next;
    });
  }, []);
  const handleToggleHotPoint = useCallback((zone: GradientZone) => {
    setGradientHotPoints((prev) => {
      const next = { ...prev };
      if (next[zone.id]) delete next[zone.id];
      else next[zone.id] = pickHotPointFromZone(zone);
      return next;
    });
  }, []);

  // Auto-construir corredores para TODAS las zonas detectadas (efecto declarado
  // más abajo, una vez que gradientResult está disponible).

  // 📂 Snapshots guardados de "Frentes Productivos" (persisten en este dispositivo).
  const savedZones = useSavedZones();
  const [viewingSavedId, setViewingSavedId] = useState<string | null>(null);
  const [savedView, setSavedView] = useState<SavedZoneSet | null>(null);

  // 🌊 Termoclina — capa bajo demanda. Al activar, un clic en el mapa
  // calcula la profundidad aproximada de la termoclina (perfil thetao).
  const [thermoclineEnabled, setThermoclineEnabled] = usePersistentState(
    "thermoclineEnabled",
    false,
  );

  // Region (preset center/zoom)
  const INITIAL_REGION = REGIONS.find((r) => r.key === "baleares") ?? REGIONS[0];
  const [regionKeyStored, setRegionKeyStored] = usePersistentState<string>(
    "regionKeyBalearesV1",
    INITIAL_REGION.key,
  );
  const initialRegionFromStorage = REGIONS.find((r) => r.key === regionKeyStored) ?? INITIAL_REGION;
  const [region, setRegion] = useState<Region>(initialRegionFromStorage);
  const [flyToTrigger, setFlyToTrigger] = useState(0);
  const [flyToCenter, setFlyToCenter] = useState<[number, number]>(initialRegionFromStorage.center);
  const [flyToZoom, setFlyToZoom] = useState<number>(initialRegionFromStorage.zoom);
  const handleRegion = (r: Region) => {
    setRegion(r);
    setRegionKeyStored(r.key);
    setFlyToCenter(r.center);
    setFlyToZoom(r.zoom);
    setFlyToTrigger((n) => n + 1);
  };

  const { hasModule, hasAny } = useSubscriptions();
  const [fishingMode, setFishingMode] = usePersistentState<"surface" | "bottom" | "squid" | "drift">(
    "fishingMode",
    "surface",
  );


  // Spots pescables (puntos GPS reales detectados)
  // Top1/Spots NO debe arrancar solo al abrir la app. Antes se persistía en
  // localStorage y si el usuario lo había dejado ON, al reabrir iOS/Android
  // empezaba a buscar y podía recentrar el mapa sin tocar nada.
  const [spotsEnabled, setSpotsEnabled] = useState(false);
  const [spotsMinDepth, setSpotsMinDepth] = usePersistentState("spotsMinDepth", 15);
  const [spotsMaxDepth, setSpotsMaxDepth] = usePersistentState("spotsMaxDepth", 600);
  const [spotsRecomputeTrigger, setSpotsRecomputeTrigger] = useState(0);
  const [spotsClearTrigger, setSpotsClearTrigger] = useState(0);
  const [spotsDebug, setSpotsDebug] = useState(false);
  // Persistimos spots / spotRoutes en localStorage: en iOS Safari/PWA, cuando
  // la pantalla se duerme o la app pasa mucho rato en segundo plano, el
  // WebView puede ser reciclado y al volver la página se recarga desde cero.
  // Sin persistencia, el TOP 1 que el usuario acababa de calcular desaparece
  // ("a veces sí, otras no" — depende de si iOS recicló el contexto).
  const [spots, setSpots] = usePersistentState<FishingSpot[]>("spots.last", []);
  const [spotRoutes, setSpotRoutes] = usePersistentState<FishingSpot[][]>("spotRoutes.last", []);
  const [spotsLoading, setSpotsLoading] = useState(false);
  const [analysisPhase, setAnalysisPhase] = useState<string | null>(null);
  const spotsRecomputeTimerRef = useRef<number | null>(null);
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null);
  const requestSpotsAnalysis = useCallback(() => {
    setSpotsLoading(true);
    setAnalysisPhase("Activando capas y cargando datos…");
    setAnalysisMessage(null);
    if (spotsRecomputeTimerRef.current) window.clearTimeout(spotsRecomputeTimerRef.current);
    spotsRecomputeTimerRef.current = window.setTimeout(() => {
      setSpotsRecomputeTrigger((n) => n + 1);
      spotsRecomputeTimerRef.current = null;
    }, 1200);
  }, []);
  const handleSpotsProgress = useCallback((phase: string | null) => {
    setAnalysisPhase(phase);
  }, []);
  const handleSpotsError = useCallback((msg: string) => {
    setAnalysisPhase(null);
    setSpotsLoading(false);
    setAnalysisMessage(msg);
  }, []);
  useEffect(
    () => () => {
      if (spotsRecomputeTimerRef.current) window.clearTimeout(spotsRecomputeTimerRef.current);
    },
    [],
  );
  const handleSpotsChange = useCallback((s: FishingSpot[], r: FishingSpot[][]) => {
    setSpots(s);
    setSpotRoutes(r);
  }, []);
  const handleAnalysisSummary = useCallback(
    (s: {
      cellsAnalyzed: number;
      maxScore: number;
      bestCluster: { lat: number; lng: number; score: number; cells: number } | null;
      insideArea: boolean;
      mode: "surface" | "bottom";
      noResultReason?: string;
      bathymetrySource?: "emodnet" | "ncei" | "gebco" | "mixed" | "none";
      bathymetryLabel?: string;
      layerStatus?: {
        sst: "ok" | "sin dato";
        chl: "ok" | "sin dato";
        alt: "ok" | "sin dato";
        bat: "ok" | "sin dato";
      };
    }) => {
      // Sufijo con la fuente real de batimetría — siempre informativo, así
      // el usuario sabe si está mirando EMODnet (alta res) o GEBCO (gruesa).
      const bathySuffix =
        s.bathymetryLabel && s.bathymetrySource && s.bathymetrySource !== "none"
          ? ` · ${s.bathymetryLabel}`
          : "";

      // Estado por capa SIEMPRE visible: el usuario ve exactamente qué se ha
      // podido leer en numérico. No mezclamos esto con el bathySuffix porque
      // ese es la fuente concreta (EMODnet/GEBCO), aquí va la cobertura real.
      const ls = s.layerStatus;
      const layersTag = ls
        ? ` · Capas → SST ${ls.sst} · CHL ${ls.chl} · ALT ${ls.alt} · BAT ${ls.bat}`
        : "";

      // Mensajes contextuales — informativos cuando hay resultado parcial,
      // solo de "error" cuando realmente no hay datos suficientes.
      if (s.insideArea && !s.bestCluster) {
        setAnalysisMessage(
          s.noResultReason
            ? `Análisis limitado: ${s.noResultReason}${bathySuffix}${layersTag}`
            : `Sin señales suficientes en esta área${bathySuffix}${layersTag}`,
        );
      } else if (s.insideArea && s.bestCluster) {
        const score100 = Math.round(s.bestCluster.score * 100);
        if (score100 < 55 && s.noResultReason) {
          setAnalysisMessage(
            `Mejor punto ${score100}/100 — ${s.noResultReason}${bathySuffix}${layersTag}`,
          );
        } else if (s.noResultReason) {
          // Resultado bueno pero con datos parciales: nota informativa
          setAnalysisMessage(`${s.noResultReason}${bathySuffix}${layersTag}`);
        } else {
          // Sin notas pero queremos mostrar la fuente y estado de capas.
          setAnalysisMessage(`${s.bathymetryLabel ?? "Análisis OK"}${layersTag}`);
        }
      } else {
        setAnalysisMessage(null);
      }
    },
    [],
  );
  const handleFlyToSpot = useCallback((s: FishingSpot) => {
    setFlyToCenter([s.lat, s.lng]);
    setFlyToZoom((z) => Math.max(8, z));
    setFlyToTrigger((n) => n + 1);
  }, []);
  const handleSpotsDepthChange = useCallback((mn: number, mx: number) => {
    setSpotsMinDepth(mn);
    setSpotsMaxDepth(mx);
  }, []);

  // Cambio de modo de pesca: ajusta automáticamente el rango de profundidad
  // recomendado para evitar criterios mezclados (superficie vs fondo).
  // No disparamos recomputeTrigger manualmente: el `useEffect` interno de
  // FishingHotspots ya tiene `fishingMode` en sus deps → evita doble compute
  // (causa de parpadeos en iPhone al alternar Superficie/Fondo).
  const handleFishingModeChange = useCallback((mode: "surface" | "bottom" | "squid" | "drift") => {
    setFishingMode((prev) => {
      if (prev === mode) return prev;
      if (mode === "bottom") {
        setSpotsMinDepth(20);
        setSpotsMaxDepth(70);
      } else if (mode === "drift") {
        // Fluixa: franja costera pescable a la deriva.
        setSpotsMinDepth(8);
        setSpotsMaxDepth(60);
      } else if (mode === "squid") {
        // Calamar: profundidades típicas de potera (plataforma + cabezos)
        setSpotsMinDepth(30);
        setSpotsMaxDepth(150);
      } else {
        setSpotsMinDepth(50);
        setSpotsMaxDepth(600);
      }
      return mode;
    });
  }, []);

  // Waypoints FIJOS (persisten en localStorage, no cambian al mover el mapa)
  const savedWp = useSavedWaypoints();
  const [addWaypointMode, setAddWaypointMode] = useState(false);
  const [waypointsPanelOpen, setWaypointsPanelOpen] = useState(false);
  const [waypointNotice, setWaypointNotice] = useState<string | null>(null);
  const showWaypointNotice = useCallback((name: string) => {
    setWaypointNotice(`✅ Guardado: ${name}`);
    window.setTimeout(() => setWaypointNotice(null), 3500);
  }, []);
  const handleFlyToSaved = useCallback((w: { lat: number; lng: number }) => {
    setFlyToCenter([w.lat, w.lng]);
    setFlyToZoom((z) => Math.max(12, z));
    setFlyToTrigger((n) => n + 1);
  }, []);

  // Guardar un spot del análisis como waypoint (botón en el popup).
  const handleSaveWaypointFromSpot = useCallback(
    (
      lat: number,
      lng: number,
      score: number,
      depth: number | null,
      reason: string,
      defaultName: string,
    ) => {
      const name = window.prompt("Nombre del waypoint:", defaultName);
      if (name === null) return; // cancelado
      const finalName = name.trim() || defaultName;
      savedWp.save(
        {
          id: `from-spot-${Date.now()}`,
          lat,
          lng,
          score,
          depth,
          reason,
        },
        finalName,
      );
    },
    [savedWp],
  );
  // Modo "Añadir waypoint": el siguiente clic en el mapa fija uno.
  const handlePickWaypoint = useCallback(
    (lat: number, lng: number) => {
      const def = `Waypoint ${savedWp.waypoints.length + 1}`;
      const name = window.prompt(
        `Nombre del waypoint en\n${toDegMinSec(lat, "lat")} · ${toDegMinSec(lng, "lng")}`,
        def,
      );
      setAddWaypointMode(false);
      if (name === null) return;
      savedWp.addManual(lat, lng, name.trim() || def);
      showWaypointNotice(name.trim() || def);
    },
    [savedWp, showWaypointNotice],
  );
  // Botón directo: guarda el CENTRO visible de la pantalla sin tener que entrar en modo clic.
  const handleAddWaypointAtMapCenter = useCallback(() => {
    // Leemos el centro REAL del mapa en este mismo instante (getCenter de
    // Leaflet). Antes se usaba `mapView`, un estado que solo se refresca en
    // moveend/zoomend: si el mapa estaba animando o el estado iba retrasado,
    // el waypoint se creaba en la posición anterior (varios km de error).
    const live = getMapBoundsRef.current?.();
    const c = live?.center ?? mapView?.center;
    const bounds = mapView?.bounds;
    const lat = c ? c.lat : bounds ? (bounds.south + bounds.north) / 2 : region.center[0];
    const lng = c ? c.lng : bounds ? (bounds.west + bounds.east) / 2 : region.center[1];


    const create = () => {
      const name = `Waypoint ${savedWp.waypoints.length + 1}`;
      savedWp.addManual(lat, lng, name);
      showWaypointNotice(name);
      setFlyToCenter([lat, lng]);
      setFlyToZoom((z) => Math.max(10, z));
      setFlyToTrigger((n) => n + 1);
      setAddWaypointMode(false);
    };

    // Aviso si el punto cae sobre tierra firme (Natural Earth 10m).
    void getLandMask()
      .then((mask) => {
        if (
          mask.isLand(lat, lng) &&
          !window.confirm("Este punto está en tierra. ¿Quieres guardarlo igualmente?")
        ) {
          return;
        }
        create();
      })
      .catch(() => create());
  }, [mapView?.center, mapView?.bounds, region.center, savedWp, showWaypointNotice]);
  // handleAddWaypointAtGps se define más abajo, cuando `gps` ya existe.

  // Seguimiento GPS.
  const [gpsFollow, setGpsFollow] = useState(false);

  // Zona de búsqueda manual sobre el mapa
  const [searchArea, setSearchArea] = usePersistentState<SearchArea | null>(
    "searchArea.last",
    null,
  );
  const [drawMode, setDrawMode] = useState<DrawMode>(null);

  // ── Bloqueo por suscripción: FSLE (superficie), fondo marino (fondo) y
  // dibujo de zona (cualquier módulo) sólo para usuarios con acceso.
  const canFsle = hasModule("superficie");
  const canSeafloor = hasModule("fondo");
  const gatedMultiLayer = canFsle
    ? multiLayer
    : { ...multiLayer, fsle: { enabled: false } };
  const gatedSeafloor = canSeafloor ? seafloor : { ...seafloor, enabled: false };
  const gatedDrawMode = hasAny ? drawMode : null;

  type MapSnapshotFn = () => {
    sw: { lat: number; lng: number };
    ne: { lat: number; lng: number };
    center: { lat: number; lng: number };
    zoom: number;
  };
  const getMapBoundsRef = useRef<null | MapSnapshotFn>(null);
  const handleMapBoundsReady = useCallback(
    (fn: MapSnapshotFn) => {
      getMapBoundsRef.current = fn;
    },
    [],

  );
  // Cuando el usuario termina de dibujar el triángulo NO encuadramos
  // automáticamente — antes provocaba parpadeos/refresh continuo en iPhone
  // (re-render del mapa + re-trigger del flyTo en cadena). El usuario ya
  // está mirando la zona que dibujó.
  const handleSearchAreaChange = useCallback((area: SearchArea | null) => {
    setSearchArea(area);
    setAnalysisMessage(null);
    setDrawMode(null);
  }, []);
  // Reset completo y atómico: zona, dibujo, marcadores, mensajes, rutas y spots.
  // Idempotente: pulsarlo varias veces no causa estados raros.
  const clearSearchArea = useCallback(() => {
    if (spotsRecomputeTimerRef.current) window.clearTimeout(spotsRecomputeTimerRef.current);
    pendingTop1AfterDrawRef.current = false;
    setSpotsLoading(false);
    setAnalysisPhase(null);
    setSearchArea(null);
    setDrawMode(null);
    setAnalysisMessage(null);
    setSpots([]);
    setSpotRoutes([]);
    setSpotsEnabled(false);
    setHotZoneEnabled(false);
    setSpotsClearTrigger((n) => n + 1);
    // Descargar (desmontar) todas las capas adicionales: vuelve a quedar sólo
    // el mapa base + la batimetría nueva. Al desmontarse, sus peticiones en
    // curso se abortan y dejan de consumir datos/memoria.
    setMultiLayer((s) => ({
      ...s,
      sst: { ...s.sst, enabled: false },
      chlorophyll: { ...s.chlorophyll, enabled: false },
      altimetry: { ...s.altimetry, enabled: false },
      streamlines: { ...(s.streamlines ?? { depth: "surface" }), enabled: false },
      fsle: { ...(s.fsle ?? { enabled: false }), enabled: false },
    }));
    setBathyRelief(true);
    setBathyContours(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Se rellena más abajo (necesita `gps`). Activa automáticamente GPS y las
  // capas que requiere cada modo de búsqueda.
  const ensurePrereqRef = useRef<(mode: "surface" | "bottom" | "squid" | "drift") => void>(() => {});
  const searchInsideArea = useCallback(() => {
    const modId =
      fishingMode === "surface" || fishingMode === "drift"
        ? "superficie"
        : fishingMode === "bottom"
          ? "fondo"
          : "calamar";
    if (!hasModule(modId)) {
      setAnalysisMessage(
        "Este modo de pesca requiere suscripción (5 €/mes). Actívalo en Planes y suscripción.",
      );
      return;
    }
    // Al buscar una zona, el usuario espera ver y usar las capas del análisis
    // (y tener GPS si el modo lo necesita): se activan automáticamente.
    ensurePrereqRef.current(fishingMode);
    // En FONDO y CALAMAR el análisis es puntual y caro: exigimos el triángulo
    // dibujado. Antes se usaba la vista de pantalla y "buscaba solo".
    if (
      !searchArea &&
      (fishingMode === "bottom" || fishingMode === "squid" || fishingMode === "drift")
    ) {
      setDrawMode("triangle");
      setAnalysisMessage("Dibuja el triángulo de la zona (3 clics) para analizar el fondo.");
      return;
    }
    // Solo en superficie usamos la vista actual como área automática.
    setSearchArea((prev) => {
      if (prev) return prev;
      const fn = getMapBoundsRef.current;
      if (fn) {
        const { sw, ne } = fn();
        return { kind: "rect", bounds: [sw, ne] };
      }
      return prev;
    });
    // Cancelamos cualquier dibujo activo para no quedarnos en modo crosshair.
    setDrawMode(null);
    setSpotsEnabled(true);
    setAnalysisMessage(null);
    requestSpotsAnalysis();
  }, [requestSpotsAnalysis, fishingMode, hasModule, searchArea]);

  // Si el usuario pidió TOP 1 sin tener zona, esperamos al triángulo y
  // disparamos la búsqueda UNA sola vez en cuanto el área queda definida.
  // Antes este efecto se disparaba con cada cambio de `searchArea` y, peor,
  // cada vez que `spots` se vaciaba al cambiar de capa/fecha (efecto 615),
  // lanzando un TOP 1 "fantasma" sin que el usuario lo pidiera.
  const pendingTop1AfterDrawRef = useRef(false);
  useEffect(() => {
    if (!pendingTop1AfterDrawRef.current) return;
    if (searchArea && !spotsLoading) {
      pendingTop1AfterDrawRef.current = false;
      requestSpotsAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchArea]);

  const handleSearchDrawEnd = useCallback(() => setDrawMode(null), []);

  // Estado por capa: qué capas tienen datos vs cuáles han fallado.
  // NUNCA bloqueamos el visor con un toast global — sólo mostramos un chip
  // pequeño "Sin: SST" abajo a la izquierda con las que no han cargado.
  // Si la capa vuelve a renderizar bien, se quita del set automáticamente.
  const [missingLayers, setMissingLayers] = useState<Set<string>>(new Set());
  // Leyenda inferior izquierda — colapsable para liberar mapa.
  const [legendOpen, setLegendOpen] = useState(false);
  const [sstRanges, setSstRanges] = useState<ViewportSstRanges>({});
  // Auto = la escala SST se adapta al rango térmico del viewport (frentes
  // visibles todo el año). Manual = rango fijo del config (comparación entre
  // fechas/regiones).
  const [sstScaleMode, setSstScaleMode] = useState<"auto" | "manual">("auto");
  // Reset por-capa cuando cambia la capa, fecha o región (vamos a re-pedir).
  // IMPORTANTE: usamos primitivos derivados (no el objeto multiLayer entero)
  // para evitar que el efecto se dispare en cada render — antes el objeto
  // multiLayer cambiaba de identidad cada render y reseteaba el set + spots
  // continuamente, provocando lag al hacer cualquier cosa.
  const multiLayerKey =
    `${multiLayer.sst.layer}:${multiLayer.sst.enabled}|` +
    `${multiLayer.chlorophyll.layer}:${multiLayer.chlorophyll.enabled}|` +
    `${multiLayer.altimetry.layer}:${multiLayer.altimetry.enabled}`;
  const regionKey = region.key;

  useEffect(() => {
    setMissingLayers(new Set());
  }, [activeLayer, multiLayerKey, effectiveTime, regionKey]);

  // Limpiamos spots cuando el usuario cambia capa/fecha/modo. PERO ignoramos:
  //   - el primer disparo tras el montaje (rehidratación desde localStorage).
  //   - la transición undefined → fecha resuelta (sonda Copernicus al arrancar
  //     o tras un re-mount del WebView en iOS/Android al despertar pantalla).
  // Sin esto, el TOP 1 y los marcadores "desaparecían al cabo de un rato"
  // cada vez que la sonda re-resolvía la fecha en background.
  const clearSpotsOnLayerChangeFirst = useRef(true);
  const prevEffectiveTimeRef = useRef<string | undefined>(effectiveTime);
  useEffect(() => {
    const prev = prevEffectiveTimeRef.current;
    prevEffectiveTimeRef.current = effectiveTime;
    if (clearSpotsOnLayerChangeFirst.current) {
      clearSpotsOnLayerChangeFirst.current = false;
      return;
    }
    // Ignorar transiciones de "sin fecha" → "con fecha" (resolución automática
    // de la sonda tras un re-mount). Solo limpiamos cuando la fecha cambia
    // entre dos valores reales distintos (el usuario pulsó otra fecha) o
    // cuando cambia la capa/modo.
    if (!prev && effectiveTime) return;
    setAnalysisMessage(null);
    setSpots([]);
    setSpotRoutes([]);
    setSpotsClearTrigger((n) => n + 1);
  }, [multiLayerEnabled, activeLayer, multiLayerKey, effectiveTime]);

  // GPS / geolocation
  const gps = useGeolocation();
  const [gpsRecenterTrigger, setGpsRecenterTrigger] = useState(0);
  // Navegación a destino (pantalla de rumbo, sin voz ni sonidos).
  const [navTarget, setNavTarget] = useState<NavTarget | null>(null);
  const [navScreenOpen, setNavScreenOpen] = useState(false);
  const startNavigation = useCallback(
    (t: NavTarget) => {
      setNavTarget(t);
      setNavScreenOpen(true);
      if (!gps.active) gps.start();
    },
    [gps],
  );
  // Mantener pantalla encendida mientras la app esté abierta en cubierta.
  // En Android nativo usa KeepAwake; en web/PWA usa Screen Wake Lock si existe.
  useWakeLock(true);
  // Modo bajo consumo: se activa cuando la app está en segundo plano más de
  // 20 s o cuando se detecta un dispositivo con poca memoria. Reduce capas
  // pesadas (gradientes, spots, contraste local) y evita que iOS mate el WebView.
  const lowPower = useLowPower();
  // Auto-degradación inicial UNA VEZ en dispositivos de poca memoria: apaga el
  // modo HD de batimetría que es lo que más memoria consume en móviles antiguos.
  useEffect(() => {
    if (!lowPower.isLowMemoryDevice) return;
    if (typeof window === "undefined") return;
    const FLAG = "ov.lowPowerAutoDegraded.v2";
    if (window.localStorage.getItem(FLAG)) return;
    window.localStorage.setItem(FLAG, "1");
    setBathyHdMode(false);
    setHotZoneEnabled(false);
    setGradientEnabled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lowPower.isLowMemoryDevice]);
  // En low-power (incluido Android WebView) activamos "modo-rapido": elimina
  // blurs/filtros/animaciones globales que en gama media saturan la GPU.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!lowPower.isLowMemoryDevice) return;
    document.body.classList.add("modo-rapido");
    return () => {
      document.body.classList.remove("modo-rapido");
    };
  }, [lowPower.isLowMemoryDevice]);
  const fastMode = false;
  const handleToggleGps = useCallback(() => {
    if (gps.active) {
      gps.stop();
      setGpsFollow(false);
    } else {
      gps.start();
      setGpsFollow(true);
    }
  }, [gps]);
  const handleToggleFollow = useCallback(() => setGpsFollow((v) => !v), []);
  const handleRecenter = useCallback(() => {
    // Si no hay GPS activo aún, lo arrancamos para conseguir la posición.
    if (!gps.active) {
      gps.start();
      setGpsFollow(true);
    }
    // Dispara el recenter en el mapa (GpsTracker hará flyTo cuando tenga posición).
    setGpsRecenterTrigger((n) => n + 1);
  }, [gps]);
  const handleExportGpx = useCallback(() => downloadGpx(gps.track), [gps.track]);

  // ── Preparación automática de la búsqueda ──────────────────────────────
  // Cualquier análisis (menú, TOP 1 o asistente IA) activa por sí solo el GPS
  // y las capas que ese modo necesita, para que el usuario no tenga que
  // acordarse de encenderlas a mano.
  const ensureSearchPrerequisites = useCallback(
    (mode: "surface" | "bottom" | "squid" | "drift") => {
      if (!gps.active) gps.start();

      // Sólo las capas que ese modo necesita para el cálculo. El resto NO se
      // monta (no consumen red, memoria ni CPU).
      const need = {
        sst: mode === "surface" || mode === "squid",
        chl: mode === "surface",
        alt: mode === "surface",
        streamlines: true,
        fsle: mode === "surface" || mode === "drift",
      };

      setMultiLayerEnabled(true);
      setMultiLayer((prev) => ({
        ...prev,
        sst: {
          ...prev.sst,
          enabled: need.sst,
          opacity: need.sst ? Math.max(prev.sst.opacity, 0.52) : prev.sst.opacity,
        },
        chlorophyll: {
          ...prev.chlorophyll,
          enabled: need.chl,
          opacity: need.chl ? Math.max(prev.chlorophyll.opacity, 0.78) : prev.chlorophyll.opacity,
        },
        altimetry: {
          ...prev.altimetry,
          enabled: need.alt,
          opacity: need.alt ? Math.max(prev.altimetry.opacity, 0.72) : prev.altimetry.opacity,
        },
        streamlines: {
          ...prev.streamlines,
          enabled: need.streamlines,
          depth:
            mode === "bottom" || mode === "squid"
              ? ("bottom" as const)
              : (prev.streamlines?.depth ?? ("surface" as const)),
        },
        fsle: { ...(prev.fsle ?? { enabled: false }), enabled: need.fsle },
      }));

      // La batimetría nueva permanece visible durante toda la búsqueda.
      setBathyRelief(true);
      setBathyContours(true);
      if (mode === "bottom" || mode === "squid" || mode === "drift") {
        setSeafloor((s) => ({ ...s, enabled: true }));
      }
    },
    [gps, setMultiLayer, setMultiLayerEnabled, setBathyRelief, setBathyContours, setSeafloor],
  );

  ensurePrereqRef.current = ensureSearchPrerequisites;



  const savedTracks = useSavedTracks();
  const [activeSavedTrackId, setActiveSavedTrackId] = useState<string | null>(null);

  const handleSaveGpsTrack = useCallback(() => {
    if (gps.track.length < 2) {
      window.alert("El track está vacío. Activa el GPS y navega un poco antes de guardarlo.");
      return;
    }
    const name = window.prompt("Nombre del track", "");
    if (name === null) return;
    const saved = savedTracks.save(gps.track, name);
    if (saved) setActiveSavedTrackId(saved.id);
  }, [gps.track, savedTracks]);

  const handleShowSavedTrack = useCallback(
    (t: SavedTrack) => {
      gps.setTrack(t.points);
      setActiveSavedTrackId(t.id);
      const mid = t.points[Math.floor(t.points.length / 2)];
      if (mid) {
        setFlyToCenter([mid.lat, mid.lng]);
        setFlyToTrigger((n) => n + 1);
      }
      setMenuOpen(false);
    },
    [gps],
  );

  // Crea un waypoint en la posición GPS actual (botón del panel Waypoints).
  const handleAddWaypointAtGps = useCallback(() => {
    if (!gps.position) return;
    const def = `GPS ${new Date().toLocaleTimeString().slice(0, 5)}`;
    const name = window.prompt("Nombre del waypoint (posición GPS):", def);
    if (name === null) return;
    savedWp.addManual(gps.position.lat, gps.position.lng, name.trim() || def);
  }, [gps.position, savedWp]);

  useEffect(() => {
    return () => {
      if (typeof document !== "undefined") {
        document.body.classList.remove("modo-rapido");
      }
    };
  }, []);

  // Por-capa: añade al set "sin datos". El chip lateral muestra el resumen.
  const handleTileError = useCallback((layerId?: string) => {
    if (!layerId) return;
    setMissingLayers((prev) => {
      if (prev.has(layerId)) return prev;
      const next = new Set(prev);
      next.add(`${layerId} (capa no compatible con Leaflet EPSG:3857)`);
      return next;
    });
  }, []);
  // Cuando la capa carga correctamente la quitamos del set: el chip se actualiza solo.
  const handleTileLoad = useCallback((layerId?: string) => {
    if (!layerId) return;
    setMissingLayers((prev) => {
      const next = new Set(Array.from(prev).filter((item) => !item.startsWith(layerId)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  // ───── Detección de Frentes Productivos sobre la vista actual ─────
  const gradientResult = useGradientZones({
    enabled: gradientEnabled && !savedView,
    // Analizar SIEMPRE sobre el viewport visible actual, no sobre una
    // vista congelada. Si el usuario mueve el mapa, los corredores se
    // recalculan dentro de lo que está viendo.
    bbox: mapView?.bounds ?? null,
    zoom: mapView?.zoom ?? 6,
    sstLayer: multiLayer.sst.enabled ? multiLayer.sst.layer : undefined,
    chlLayer: multiLayer.chlorophyll.enabled ? multiLayer.chlorophyll.layer : undefined,
    altLayer: multiLayer.altimetry.enabled ? multiLayer.altimetry.layer : undefined,
    time: effectiveTime,
    layerTimes: effectiveLayerTimes,
    recomputeNonce: gradientRecomputeNonce,
  });
  const handleFocusZone = useCallback((zone: GradientZone) => {
    setGradientFocusedId(zone.id);
    setFlyToCenter([zone.axis.centroid.lat, zone.axis.centroid.lng]);
    setFlyToTrigger((n) => n + 1);
  }, []);

  // Zonas/corredores que se renderizan: si hay un snapshot guardado activo,
  // mostramos ESE; si no, las del análisis en vivo.
  const displayedZones = savedView ? savedView.zones : (gradientResult.result?.zones ?? []);
  const displayedCorridors = useMemo(() => {
    if (savedView) return savedView.corridors;
    const base = { ...gradientCorridors };
    for (const [id, route] of Object.entries(gradientDetailedCorridors)) {
      if (route && route.length >= 2) base[id] = route;
    }
    return base;
  }, [savedView, gradientCorridors, gradientDetailedCorridors]);

  // 🎯 Alinear Top-N con los corredores: si un spot cae cerca de un corredor,
  // lo "snap" al punto más próximo de la cresta y le da un boost de score.
  // Re-rankea para que el Top 1 esté SIEMPRE dentro de un corredor cuando exista.
  const alignedSpots = useMemo<FishingSpot[]>(() => {
    if (!spots.length) return spots;
    const corridorPts: Array<{ lat: number; lng: number }> = [];
    for (const route of Object.values(displayedCorridors)) {
      if (!route || route.length < 2) continue;
      for (const p of route) corridorPts.push(p);
    }
    if (!corridorPts.length) return spots;
    const MAX_SNAP_M = 9260; // ~5 millas náuticas
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const distM = (aLat: number, aLng: number, bLat: number, bLng: number) => {
      const dLat = toRad(bLat - aLat);
      const dLng = toRad(bLng - aLng);
      const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    };
    const adjusted = spots.map((s) => {
      let bestD = Infinity;
      let bestPt = corridorPts[0];
      for (const p of corridorPts) {
        const d = distM(s.lat, s.lng, p.lat, p.lng);
        if (d < bestD) {
          bestD = d;
          bestPt = p;
        }
      }
      if (bestD <= MAX_SNAP_M) {
        // Boost proporcional a cercanía: 1.15× pegado, 1.0× en el límite.
        const closeness = 1 - bestD / MAX_SNAP_M;
        const boost = 1 + 0.15 * closeness;
        return {
          ...s,
          lat: bestPt.lat,
          lng: bestPt.lng,
          score: Math.min(1, s.score * boost),
          reason: s.reason ? `${s.reason} · sobre corredor` : "Sobre corredor",
        };
      }
      return s;
    });
    // Re-rank por score descendente.
    const sorted = adjusted
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((s, i) => ({ ...s, rank: i + 1 }));
    // Conservar el orden original del array para no romper consumidores
    // que dependan de índices, pero con los nuevos rank/lat/lng/score.
    const byId = new Map(sorted.map((s) => [s.id, s]));
    return adjusted.map((s) => byId.get(s.id) ?? s);
  }, [spots, displayedCorridors]);

  // 🌬️ Viento próximas 6h sobre el Top 1 (Open-Meteo, sin API key).
  // Sirve para avisar al pescador si el día no es navegable, no penaliza
  // el score automáticamente.
  const top1 = alignedSpots.find((s) => s.rank === 1) ?? alignedSpots[0] ?? null;
  const { wind: top1Wind } = useWindForecast(top1?.lat ?? null, top1?.lng ?? null);
  const { current: top1Current } = useCurrentForecast(top1?.lat ?? null, top1?.lng ?? null);
  const { pressure: top1Pressure } = usePressureForecast(top1?.lat ?? null, top1?.lng ?? null);
  const top1Solunar = useSolunar(top1?.lat ?? null, top1?.lng ?? null);
  const [aiAdvisorOpen, setAiAdvisorOpen] = useState(false);
  const [aiPlan, setAiPlan] = useState<AdvisorPlanSpot[] | null>(null);
  const [catchTarget, setCatchTarget] = useState<CatchLogTarget | null>(null);

  // ── Exclusividad de ventanas emergentes ──────────────────────────────
  // Solo puede haber una ventana grande abierta a la vez, así ninguna tapa
  // a otra: vista 3D > asistente IA > menú lateral.
  useEffect(() => {
    if (seafloorShow3d) {
      setAiAdvisorOpen(false);
      setMenuOpen(false);
    }
  }, [seafloorShow3d]);

  useEffect(() => {
    if (aiAdvisorOpen) setMenuOpen(false);
  }, [aiAdvisorOpen]);

  useEffect(() => {
    if (menuOpen) setAiAdvisorOpen(false);
  }, [menuOpen]);

  const activeLayersLabels = useMemo(() => {
    const out: string[] = [];
    if (multiLayer.sst.enabled) out.push("temperatura superficie");
    if (multiLayer.chlorophyll.enabled) out.push("clorofila");
    if (multiLayer.altimetry.enabled) out.push("altimetría");
    if (multiLayer.fsle?.enabled) out.push("FSLE");
    return out;
  }, [
    multiLayer.sst.enabled,
    multiLayer.chlorophyll.enabled,
    multiLayer.altimetry.enabled,
    multiLayer.fsle?.enabled,
  ]);



  // Auto-construir corredores para TODAS las zonas detectadas en cuanto
  // termine el análisis: el usuario no debe pulsar 14 veces.
  const liveZones = gradientResult.result?.zones;
  useEffect(() => {
    if (!liveZones || liveZones.length === 0) {
      setGradientCorridors({});
      setGradientDetailedCorridors({});
      setGradientHotPoints({});
      return;
    }
    const next: Record<string, LatLng[] | undefined> = {};
    for (const z of liveZones) {
      const route = buildFishingCorridor(z);
      if (route.length >= 2) next[z.id] = route;
    }
    setGradientCorridors(next);
    setGradientDetailedCorridors({});
    setGradientHotPoints({});
  }, [liveZones]);

  const handleSaveCurrent = useCallback(() => {
    const zones = gradientResult.result?.zones ?? [];
    const bbox = gradientResult.result?.bbox ?? mapView?.bounds;
    if (zones.length === 0 || !bbox) return;
    savedZones.save({
      zones,
      corridors: gradientCorridors,
      bbox,
      dataDate: effectiveTime ?? resolved.resolvedDate ?? null,
    });
  }, [
    gradientResult.result,
    gradientCorridors,
    mapView,
    effectiveTime,
    resolved.resolvedDate,
    savedZones,
  ]);

  const handleLoadSaved = useCallback((s: SavedZoneSet) => {
    setSavedView(s);
    setViewingSavedId(s.id);
    setGradientEnabled(true);
    const cLat = (s.bbox.south + s.bbox.north) / 2;
    const cLng = (s.bbox.west + s.bbox.east) / 2;
    setFlyToCenter([cLat, cLng]);
    const span = Math.max(s.bbox.north - s.bbox.south, s.bbox.east - s.bbox.west);
    const z = span > 20 ? 4 : span > 10 ? 5 : span > 5 ? 6 : span > 2 ? 7 : 8;
    setFlyToZoom(z);
    setFlyToTrigger((n) => n + 1);
  }, []);

  const handleExitSavedView = useCallback(() => {
    setSavedView(null);
    setViewingSavedId(null);
  }, []);

  // Borrar un análisis guardado: si era el que se estaba visualizando,
  // salimos de la vista guardada para que las zonas y corredores
  // desaparezcan inmediatamente del mapa.
  const handleDeleteSavedZone = useCallback(
    (id: string) => {
      if (viewingSavedId === id) {
        setSavedView(null);
        setViewingSavedId(null);
      }
      savedZones.remove(id);
    },
    [viewingSavedId, savedZones],
  );

  const handleClearZones = useCallback(() => {
    gradientResult.clear();
    setGradientCorridors({});
    setGradientDetailedCorridors({});
    setGradientHotPoints({});
    setGradientFocusedId(null);
    if (viewingSavedId) {
      setSavedView(null);
      setViewingSavedId(null);
    }
  }, [gradientResult, viewingSavedId]);


  const handleShowTop1 = () => {
    const next = !hotZoneEnabled;
    setHotZoneEnabled(next);
    if (!next) return;

    setSpotsEnabled(true);
    ensureSearchPrerequisites(fishingMode);
    if (searchArea) {
      requestSpotsAnalysis();
    } else if (
      fishingMode === "bottom" ||
      fishingMode === "squid" ||
      fishingMode === "drift"
    ) {
      pendingTop1AfterDrawRef.current = true;
      setDrawMode("triangle");
      setAnalysisMessage("Dibuja el triángulo de la zona (3 clics) para buscar el TOP 1.");
    } else {
      const fn = getMapBoundsRef.current;
      if (fn) {
        const { sw, ne } = fn();
        setSearchArea({ kind: "rect", bounds: [sw, ne] });
        setDrawMode(null);
        setAnalysisMessage(null);
        pendingTop1AfterDrawRef.current = true;
      } else {
        pendingTop1AfterDrawRef.current = true;
        setDrawMode("triangle");
        setAnalysisMessage("Dibuja el triángulo de la zona (3 clics) para buscar el TOP 1.");
      }
    }
    setMenuOpen(false);
  };

  return (
    <div id="app-map-root" className="relative h-screen w-screen overflow-hidden">
      {multiLayerEnabled ? (
        <OceanMapClient
          multiLayer={gatedMultiLayer}
          initialCenter={region.center}
          initialZoom={region.zoom}
          bathymetryRelief={bathyRelief}
          bathymetryContours={bathyContours}
          bathymetrySlope={bathySlope}
          bathymetryHdMode={bathyHdMode}
          bathymetryReliefIntensity={effectiveBathyIntensity}
          time={effectiveTime}
          layerTimes={effectiveLayerTimes}
          cacheBust={dataRefreshKey}
          aiPlan={aiPlan}
          flyToTrigger={flyToTrigger}
          flyToCenter={flyToCenter}
          flyToZoom={flyToZoom}
          onTileError={handleTileError}
          onTileLoad={handleTileLoad}
          navDestination={navTarget}
          gpsPosition={gps.position}
          gpsTrack={gps.track}
          gpsFollow={gpsFollow}
          gpsRecenterTrigger={gpsRecenterTrigger}
          onGpsUserPan={() => setGpsFollow(false)}
          hotZoneEnabled={hotZoneEnabled}
          hotZoneIntensity={hotZoneIntensity}
          hotZoneMode={hotZoneMode}
          fishingMode={fishingMode}
          spotsEnabled={spotsEnabled}
          spotsMinDepth={spotsMinDepth}
          spotsMaxDepth={spotsMaxDepth}
          spotsRecomputeTrigger={spotsRecomputeTrigger}
          spotsClearTrigger={spotsClearTrigger}
          spotsDebug={spotsDebug}
          onSpotsLoadingChange={setSpotsLoading}
          onSpotsProgress={handleSpotsProgress}
          onSpotsAnalysisError={handleSpotsError}
          onSpotsChange={handleSpotsChange}
          onSpotsAnalysisSummary={handleAnalysisSummary}
          savedWaypoints={savedWp.waypoints}
          onRemoveSavedWaypoint={savedWp.remove}
          topSpot={alignedSpots.find((s) => s.rank === 1) ?? alignedSpots[0] ?? null}
          searchArea={searchArea}
          searchDrawMode={gatedDrawMode}
          onSearchAreaChange={handleSearchAreaChange}
          onSearchDrawEnd={handleSearchDrawEnd}
          onMapBoundsReady={handleMapBoundsReady}
          onSstRangeChange={setSstRanges}
          sstScaleMode={sstScaleMode}
          fastMode={fastMode}
          landMask={landMaskConfig}
          thermoclineEnabled={thermoclineEnabled}
          seafloor={gatedSeafloor}
          seafloorPickMode={canSeafloor ? seafloorPickMode : "none"}
          seafloorProfilePoints={seafloorProfilePoints}
          onSeafloorPick={handleSeafloorPick}
          onSeafloorGrid={setSeafloorGrid}
          onSeafloorStructures={setSeafloorStructures}
          onSeafloorLoading={setSeafloorLoading}
          gradientZones={displayedZones}
          gradientCorridors={displayedCorridors}
          gradientHotPoints={gradientHotPoints}
          gradientFocusedId={gradientFocusedId}
          onMapViewChange={handleMapViewChange}
          onSaveWaypoint={handleSaveWaypointFromSpot}
          addWaypointMode={addWaypointMode}
          onPickWaypoint={handlePickWaypoint}
        />
      ) : (
        <OceanMapClient
          activeLayer={activeLayer}
          initialCenter={region.center}
          initialZoom={region.zoom}
          bathymetryRelief={bathyRelief}
          bathymetryContours={bathyContours}
          bathymetrySlope={bathySlope}
          bathymetryHdMode={bathyHdMode}
          bathymetryReliefIntensity={effectiveBathyIntensity}
          time={effectiveTime}
          layerTimes={effectiveLayerTimes}
          cacheBust={dataRefreshKey}
          aiPlan={aiPlan}
          flyToTrigger={flyToTrigger}
          flyToCenter={flyToCenter}
          flyToZoom={flyToZoom}
          onTileError={handleTileError}
          onTileLoad={handleTileLoad}
          navDestination={navTarget}
          gpsPosition={gps.position}
          gpsTrack={gps.track}
          gpsFollow={gpsFollow}
          gpsRecenterTrigger={gpsRecenterTrigger}
          onGpsUserPan={() => setGpsFollow(false)}
          hotZoneEnabled={hotZoneEnabled}
          hotZoneIntensity={hotZoneIntensity}
          hotZoneMode={hotZoneMode}
          fishingMode={fishingMode}
          spotsEnabled={spotsEnabled}
          spotsMinDepth={spotsMinDepth}
          spotsMaxDepth={spotsMaxDepth}
          spotsRecomputeTrigger={spotsRecomputeTrigger}
          spotsClearTrigger={spotsClearTrigger}
          spotsDebug={spotsDebug}
          onSpotsLoadingChange={setSpotsLoading}
          onSpotsProgress={handleSpotsProgress}
          onSpotsAnalysisError={handleSpotsError}
          onSpotsChange={handleSpotsChange}
          onSpotsAnalysisSummary={handleAnalysisSummary}
          savedWaypoints={savedWp.waypoints}
          onRemoveSavedWaypoint={savedWp.remove}
          topSpot={alignedSpots.find((s) => s.rank === 1) ?? alignedSpots[0] ?? null}
          searchArea={searchArea}
          searchDrawMode={gatedDrawMode}
          onSearchAreaChange={handleSearchAreaChange}
          onSearchDrawEnd={handleSearchDrawEnd}
          onMapBoundsReady={handleMapBoundsReady}
          onSstRangeChange={setSstRanges}
          sstScaleMode={sstScaleMode}
          fastMode={fastMode}
          landMask={landMaskConfig}
          thermoclineEnabled={thermoclineEnabled}
          seafloor={gatedSeafloor}
          seafloorPickMode={canSeafloor ? seafloorPickMode : "none"}
          seafloorProfilePoints={seafloorProfilePoints}
          onSeafloorPick={handleSeafloorPick}
          onSeafloorGrid={setSeafloorGrid}
          onSeafloorStructures={setSeafloorStructures}
          onSeafloorLoading={setSeafloorLoading}
          gradientZones={displayedZones}
          gradientCorridors={displayedCorridors}
          gradientHotPoints={gradientHotPoints}
          gradientFocusedId={gradientFocusedId}
          onMapViewChange={handleMapViewChange}
          onSaveWaypoint={handleSaveWaypointFromSpot}
          addWaypointMode={addWaypointMode}
          onPickWaypoint={handlePickWaypoint}
        />
      )}

      {/* Header slim — logo + fecha arriba, botón ☰ menú debajo. */}
      <div className="pointer-events-none absolute top-0 left-0 right-0 z-[1000]">
        <div className="flex items-start justify-between gap-2 px-2 py-1.5">
          <div className="flex flex-col gap-1.5">
            <div className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-lg border border-border bg-panel/90 px-2">
              <span className="text-sm">🛰️</span>
              <span className="hidden text-[11px] font-bold tracking-tight text-foreground sm:inline">
                Hotspot Fishing
              </span>
              <span className="text-[10px] font-medium text-muted-foreground">
                {(() => {
                  const sourceIso = time ?? resolved.resolvedDate;
                  if (!sourceIso) return "—";
                  const [y, m, d] = sourceIso.split("-").map(Number);
                  if (!y || !m || !d) return sourceIso;
                  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
                })()}
                {resolved.daysBack > 0 && (
                  <span className="ml-1 text-amber-300">(−{resolved.daysBack}d)</span>
                )}
              </span>
            </div>

            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Abrir menú"
              title="Menú · Capas, modo pesca, zona caliente, ajustes"
              className="pointer-events-auto flex h-9 items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-black/85 px-2.5 text-[12px] font-semibold text-cyan-100 shadow-[0_0_10px_rgba(6,182,212,0.25)] transition-colors hover:bg-black"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
              <span>Menú</span>
            </button>

            <button
              type="button"
              onClick={() => setWaypointsPanelOpen((v) => !v)}
              title={waypointsPanelOpen ? "Cerrar waypoints" : "Ver waypoints guardados"}
              className={`pointer-events-auto flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-bold shadow-lg transition-colors ${
                waypointsPanelOpen
                  ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border-primary/70 bg-panel/95 text-primary hover:bg-secondary"
              }`}
            >
              <span className="text-base">📌</span>
              <span>Waypoints</span>
              {savedWp.waypoints.length > 0 && (
                <span className={`ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] ${
                  waypointsPanelOpen ? "bg-primary-foreground text-primary" : "bg-secondary text-secondary-foreground"
                }`}>
                  {savedWp.waypoints.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={handleShowTop1}
              title={hotZoneEnabled ? "Ocultar Top 1" : "Buscar y mostrar Top 1"}
              className={`pointer-events-auto flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] font-bold shadow-lg transition-colors ${
                hotZoneEnabled
                  ? "border-amber-300 bg-amber-400 text-black hover:bg-amber-300"
                  : "border-amber-400/70 bg-panel/95 text-amber-100 hover:bg-amber-500/15"
              }`}
            >
              <span className="text-base">🏆</span>
              <span>Top 1</span>
            </button>

            {/* Asesor IA — siempre disponible: el cliente solo elige modalidad. */}
            <button
              type="button"
              onClick={() => setAiAdvisorOpen(true)}
              className="pointer-events-auto flex h-9 items-center gap-1.5 rounded-lg border border-sky-400/60 bg-black px-2.5 text-[11.5px] font-bold text-sky-50 shadow-lg hover:bg-black/80"
            >
              <span className="text-base">🤖</span>
              <span>La IA analiza el mar por ti</span>
            </button>



            {/* Tira compacta Top 1/2/3 — debajo del botón Menú para evitar
                solaparse con el chip "sin datos" o el banner de análisis. */}
            {alignedSpots.length > 0 &&
              (() => {
                const top = alignedSpots
                  .slice()
                  .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || b.score - a.score)
                  .slice(0, 3);
                const badgeBg = (rank: number) =>
                  rank === 1
                    ? "linear-gradient(135deg,#fbbf24,#f59e0b)"
                    : rank === 2
                      ? "linear-gradient(135deg,#cbd5e1,#94a3b8)"
                      : "linear-gradient(135deg,#fb923c,#c2410c)";
                return (
                  <details
                    open
                    className="pointer-events-auto group flex max-h-[55vh] w-[190px] max-w-[70vw] flex-col overflow-hidden rounded-lg border border-amber-400/40 bg-black/85 px-1.5 py-1 shadow-lg"
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-[9px] font-bold text-amber-300">
                      <span>🏆</span>
                      {top.map((s, i) => {
                        const rank = s.rank ?? i + 1;
                        return (
                          <span
                            key={`b-${s.id}`}
                            className="inline-flex h-4 min-w-[20px] items-center justify-center rounded-full text-[8px] font-bold text-white"
                            style={{ background: badgeBg(rank) }}
                          >
                            T{rank}
                          </span>
                        );
                      })}
                      <span className="ml-auto text-amber-100/80 group-open:hidden">▾</span>
                      <span className="ml-auto hidden text-amber-100/80 group-open:inline">▴</span>
                    </summary>
                    <div className="mt-1 flex flex-1 flex-col gap-1 overflow-y-auto pr-0.5">
                      <div className="flex flex-col gap-1">

                        {top.map((s, i) => {
                          const rank = s.rank ?? i + 1;
                          return (
                            <button
                              key={s.id}
                              onClick={() => handleFlyToSpot(s)}
                              title={`Centrar en Top ${rank} (${Math.round(s.score * 100)}%)`}
                              className="flex items-center gap-1.5 rounded border border-amber-400/30 bg-black/60 px-1 py-0.5 text-left hover:bg-amber-500/15"
                            >
                              <span
                                className="inline-flex h-4 min-w-[22px] items-center justify-center rounded-full text-[8px] font-bold text-white"
                                style={{ background: badgeBg(rank) }}
                              >
                                T{rank}
                              </span>
                              <span className="font-mono text-[9px] leading-tight text-amber-50">
                                <span className="block">{toDegMinSec(s.lat, "lat")}</span>
                                <span className="block">{toDegMinSec(s.lng, "lng")}</span>
                              </span>
                              <span className="ml-auto text-[9px] font-semibold tabular-nums text-amber-200">
                                {Math.round(s.score * 100)}
                              </span>
                              <span
                                role="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigator.clipboard?.writeText(
                                    `${toDegMinSec(s.lat, "lat")}  ${toDegMinSec(s.lng, "lng")}`,
                                  );
                                }}
                                title="Copiar GPS"
                                className="rounded border border-amber-400/40 px-1 text-[8px] text-amber-100 hover:bg-amber-500/20"
                              >
                                📋
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {(() => {
                        const COMPASS = [
                          "N",
                          "NNE",
                          "NE",
                          "ENE",
                          "E",
                          "ESE",
                          "SE",
                          "SSE",
                          "S",
                          "SSW",
                          "SW",
                          "WSW",
                          "W",
                          "WNW",
                          "NW",
                          "NNW",
                        ];
                        const toCardinal = (deg: number | null | undefined) =>
                          deg != null
                            ? COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]
                            : "";
                        return (
                          <>
                            {top1Wind &&
                              (() => {
                                const lvl = top1Wind.level;
                                const color =
                                  lvl === "muy fuerte" || lvl === "fuerte"
                                    ? "#dc2626"
                                    : lvl === "moderado"
                                      ? "#f59e0b"
                                      : "#22c55e";
                                const warn =
                                  lvl === "fuerte" || lvl === "muy fuerte"
                                    ? " · no recomendado"
                                    : "";
                                const dir = toCardinal(top1Wind.dirDeg);
                                return (
                                  <div
                                    className="mt-1 flex items-center justify-between gap-1 rounded border border-amber-400/30 bg-black/60 px-1.5 py-0.5 text-[9px]"
                                    title={`Viento atmosférico a 10 m sobre Top 1 — pronóstico próximas 6h (Open-Meteo) · dirección ${top1Wind.dirDeg?.toFixed(0) ?? "—"}°`}
                                  >
                                    <span className="text-amber-100/80">
                                      🌬 Viento atmosférico 6h
                                    </span>
                                    <span style={{ color, fontWeight: 700 }}>
                                      {top1Wind.avgKn.toFixed(0)} kn {dir} · ráf{" "}
                                      {top1Wind.gustKn.toFixed(0)}
                                      {warn}
                                    </span>
                                  </div>
                                );
                              })()}
                            {top1Current &&
                              (() => {
                                const lvl = top1Current.level;
                                const color =
                                  lvl === "fuerte"
                                    ? "#dc2626"
                                    : lvl === "moderada"
                                      ? "#f59e0b"
                                      : "#38bdf8";
                                const dir = toCardinal(top1Current.dirDeg);
                                return (
                                  <div
                                    className="mt-1 flex items-center justify-between gap-1 rounded border border-sky-400/30 bg-black/60 px-1.5 py-0.5 text-[9px]"
                                    title={`Corriente superficial sobre Top 1 — pronóstico próximas 6h (Open-Meteo Marine) · procedencia ${top1Current.dirDeg?.toFixed(0) ?? "—"}°`}
                                  >
                                    <span className="text-sky-100/80">🌊 Corriente 6h</span>
                                    <span style={{ color, fontWeight: 700 }}>
                                      {top1Current.avgKn.toFixed(1)} kn de {dir}
                                    </span>
                                  </div>
                                );
                              })()}
                            {top1Pressure &&
                              (() => {
                                const tr = top1Pressure.trend;
                                const color =
                                  tr === "subiendo"
                                    ? "#22c55e"
                                    : tr === "bajando"
                                      ? "#dc2626"
                                      : "#f59e0b";
                                const arrow =
                                  tr === "subiendo" ? "↗" : tr === "bajando" ? "↘" : "→";
                                const warn =
                                  top1Pressure.trendLevel === "fuerte" && tr === "bajando"
                                    ? " · aviso"
                                    : "";
                                return (
                                  <div
                                    className="mt-1 flex items-center justify-between gap-1 rounded border border-emerald-400/30 bg-black/60 px-1.5 py-0.5 text-[9px]"
                                    title={`Presión atmosférica sobre Top 1 (Open-Meteo) · ${top1Pressure.hPa.toFixed(0)} hPa · ${top1Pressure.delta24h > 0 ? "+" : ""}${top1Pressure.delta24h.toFixed(1)} hPa en 24 h`}
                                  >
                                    <span className="text-emerald-100/80">🌡 Presión 24 h</span>
                                    <span style={{ color, fontWeight: 700 }}>
                                      {top1Pressure.hPa.toFixed(0)} hPa {arrow}{" "}
                                      {Math.abs(top1Pressure.delta24h).toFixed(1)} hPa{warn}
                                    </span>
                                  </div>
                                );
                              })()}
                            {top1Solunar?.next &&
                              (() => {
                                const w = top1Solunar.next!;
                                const active = top1Solunar.active;
                                const isMayor = w.kind === "mayor";
                                const color = active ? "#22c55e" : isMayor ? "#a78bfa" : "#c4b5fd";
                                const icon = isMayor ? "🌕" : "🌒";
                                const illumPct = Math.round(top1Solunar.moonIllumination * 100);
                                return (
                                  <div
                                    className="mt-1 flex items-center justify-between gap-1 rounded border border-violet-400/30 bg-black/60 px-1.5 py-0.5 text-[9px]"
                                    title={`Tabla solunar sobre Top 1 — ${w.label} (${isMayor ? "período mayor ~2h" : "período menor ~1h"}) · ${formatHHMM(w.start)}–${formatHHMM(w.end)} · Luna ${illumPct}%`}
                                  >
                                    <span className="text-violet-100/80">
                                      {icon} Solunar {isMayor ? "mayor" : "menor"}
                                    </span>
                                    <span style={{ color, fontWeight: 700 }}>
                                      {formatHHMM(w.start)}–{formatHHMM(w.end)} ·{" "}
                                      {active
                                        ? "activa"
                                        : formatMinutesUntil(top1Solunar.minutesUntil)}
                                    </span>
                                  </div>
                                );
                              })()}
                          </>
                        );
                      })()}
                    </div>
                  </details>
                );
              })()}
          </div>
        </div>
      </div>

      {/* Panel flotante de Waypoints — siempre accesible desde el botón 📌,
          colapsable para no tapar el mapa cuando no se usa. */}
      {waypointsPanelOpen && (
        <div className="pointer-events-auto absolute top-[88px] left-2 z-[1300] w-[min(86vw,260px)] max-h-[calc(100vh-180px)] overflow-y-auto rounded-xl border border-border bg-black/90 p-2 shadow-[0_0_24px_rgba(0,0,0,0.5)] backdrop-blur-md sm:w-[min(92vw,320px)]">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-foreground">
              📍 Waypoints
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={handleAddWaypointAtMapCenter}
                title="Añadir waypoint en el centro de pantalla"
                className="flex h-7 items-center gap-1 rounded border border-primary/60 bg-primary/10 px-1.5 text-[10px] font-semibold text-primary hover:bg-primary/20"
              >
                <span>+</span>
                <span className="hidden sm:inline">Centro</span>
              </button>
              <button
                type="button"
                onClick={() => setWaypointsPanelOpen(false)}
                title="Cerrar waypoints"
                className="grid h-7 w-7 place-items-center rounded border border-border bg-secondary/60 text-[13px] leading-none text-foreground hover:bg-secondary"
              >
                ✕
              </button>
            </div>
          </div>
          <WaypointsPanel
            waypoints={savedWp.waypoints}
            addMode={addWaypointMode}
            onToggleAddMode={() => setAddWaypointMode((v) => !v)}
            onAddAtGps={gps.position ? handleAddWaypointAtGps : null}
            onFlyTo={(w) => {
              handleFlyToSaved(w);
              setMenuOpen(false);
            }}
            onNavigate={(w) => {
              startNavigation({ lat: w.lat, lng: w.lng, name: w.name });
              setWaypointsPanelOpen(false);
              setMenuOpen(false);
            }}
            onRename={savedWp.rename}
            onRemove={savedWp.remove}
            onBulkImport={savedWp.bulkAdd}
            onClearAll={savedWp.clear}
            cloudMode={savedWp.cloudMode}
          />
        </div>
      )}

      {/* Avisos superiores — apilados en una sola columna centrada para que
          nunca se solapen entre ellos ni con el chip lateral. */}
      <div className="pointer-events-none absolute left-1/2 top-14 z-[1300] flex w-[min(92vw,420px)] -translate-x-1/2 flex-col items-center gap-1.5">
        {drawMode && (
          <div className="rounded-full border border-cyan-400/60 bg-black/85 px-3 py-1.5 text-xs font-medium text-cyan-100 shadow-lg">
            🖱 Haz 3 clics sobre el mapa para crear el triángulo
          </div>
        )}

        {spotsLoading && (
          <div className="flex flex-col items-center">
            <div className="flex items-center gap-2 rounded-full border border-cyan-400/60 bg-black/85 px-3 py-1.5 text-[11px] font-semibold text-cyan-50 shadow-lg">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-cyan-300/40 border-t-cyan-200" />
              <span>{analysisPhase ?? "Buscando mejor zona…"}</span>
            </div>
            <div className="mt-1 px-1 text-center text-[9px] text-cyan-200/70">
              Analizando temperatura, clorofila, altimetría, corrientes y profundidad
            </div>
          </div>
        )}

        {waypointNotice && (
          <div className="rounded-lg border border-primary/70 bg-panel/95 px-3 py-2 text-sm font-bold text-primary shadow-lg">
            {waypointNotice}
          </div>
        )}
      </div>

      {/* Chip discreto: capas que NO han devuelto datos. */}
      {missingLayers.size > 0 && (
        <div className="pointer-events-none absolute top-12 right-2 z-[1200] max-w-[38vw]">
          <div className="rounded-md border border-amber-400/40 bg-black/70 px-2 py-1 text-[10px] font-medium text-amber-100 shadow">
            ⚠ Sin datos: {Array.from(missingLayers).join(" · ")}
          </div>
        </div>
      )}

      {analysisMessage && (
        <AnalysisMessageChip message={analysisMessage} onDismiss={() => setAnalysisMessage(null)} />
      )}


      {/* Layer panel detallado eliminado — todos los controles viven ahora en
          <AppMenu /> (botón ☰ arriba a la derecha). */}

      {/* Legend — bottom-left, colapsable para no tapar el mapa */}
      <div
        className="pointer-events-auto absolute bottom-10 left-3 z-[1050]"
        style={
          legendOpen
            ? {
                transform: "scale(0.5)",
                transformOrigin: "bottom left",
                width: "50%",
                maxWidth: "210px",
              }
            : undefined
        }
      >
        {legendOpen ? (
          <div className="rounded-xl border border-border bg-panel/95 p-2 shadow-lg">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Leyenda
              </span>
              <button
                onClick={() => setLegendOpen(false)}
                title="Ocultar leyenda"
                className="ml-2 flex h-5 w-5 items-center justify-center rounded text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                ✕
              </button>
            </div>
            {multiLayerEnabled ? (
              <ColorLegend
                layers={(["sst", "chlorophyll", "altimetry"] as const)
                  .filter((g) => multiLayer[g].enabled && multiLayer[g].opacity > 0)
                  .map((g) => multiLayer[g].layer)}
                sstRanges={sstRanges}
              />
            ) : (
              <ColorLegend activeLayer={activeLayer} sstRanges={sstRanges} />
            )}
            {/* Escala SST: Auto (se adapta al viewport, ideal pesca) vs Manual (rango fijo). */}
            <div className="mt-2 border-t border-border/60 pt-1.5">
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                Escala SST
              </div>
              <div className="flex gap-1">
                {(["auto", "manual"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setSstScaleMode(mode)}
                    className={`flex-1 rounded px-1.5 py-1 text-[10px] font-medium transition-colors ${
                      sstScaleMode === mode
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {mode === "auto" ? "Auto" : "Manual"}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-[8px] leading-tight text-muted-foreground">
                {sstScaleMode === "auto"
                  ? "Se ajusta al rango térmico visible."
                  : "Rango fijo: ideal para comparar fechas."}
              </div>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setLegendOpen(true)}
            title="Mostrar leyenda"
            className="flex h-7 items-center gap-1 rounded-lg border border-border bg-panel/90 px-2 text-[10px] font-medium text-muted-foreground hover:text-foreground"
          >
            🎨 Leyenda
          </button>
        )}
      </div>

      {/* GPS movido al menú lateral (sección Ajustes). */}



      {/* Attribution badge — small, centered-bottom para no pisar zoom (bottomright) */}
      <div className="pointer-events-none absolute left-1/2 bottom-3 z-[1000] -translate-x-1/2">
        <div className="rounded-lg border border-border bg-panel/90 px-2 py-1 text-[9px] text-muted-foreground">
          Datos: E.U. Copernicus Marine Service
        </div>
      </div>

      {/* Mini leyenda de Frentes Productivos directamente sobre el mapa. */}
      {gradientEnabled && displayedZones.length > 0 && (
        <div className="pointer-events-none absolute right-3 bottom-24 z-[1050] max-w-[150px]">
          <div className="rounded-lg border border-orange-400/40 bg-black/80 px-2 py-1.5 shadow-lg">
            <div className="mb-1 text-[9px] font-semibold text-orange-100">Frentes Productivos</div>
            <div className="flex items-center gap-1.5">
              <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-slate-950 bg-orange-500 text-[6px] font-extrabold text-slate-950">
                1
              </div>
              <span className="text-[8px] leading-tight text-slate-100">Inicio · referencia</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <div className="h-1 w-5 shrink-0 rounded-full bg-orange-500" />
              <span className="text-[8px] leading-tight text-slate-100">Línea · pescar aquí</span>
            </div>
          </div>
        </div>
      )}

      {/* Menú lateral profesional ☰ — consolida CAPAS / MODO PESCA / ZONA CALIENTE / FECHA / AJUSTES */}
      {/* ── Superposiciones del fondo marino profesional ── */}
      {(seafloorPoint || seafloorProfilePoints.length >= 2) && (
        <div className="pointer-events-none absolute bottom-24 left-2 z-[1200] flex max-h-[62vh] flex-col gap-2 overflow-y-auto sm:top-20 sm:bottom-auto">
          {seafloorPoint && (
            <SeafloorPointCard
              lat={seafloorPoint.lat}
              lng={seafloorPoint.lng}
              info={seafloorPoint.info}
              time={effectiveTime ?? new Date().toISOString().slice(0, 10)}
              onClose={() => setSeafloorPoint(null)}
            />
          )}
          {seafloorProfilePoints.length >= 2 && (
            <SeafloorProfileChart
              grid={seafloorGrid}
              points={seafloorProfilePoints}
              onReset={() => setSeafloorProfilePoints([])}
              onClose={() => {
                setSeafloorProfilePoints([]);
                setSeafloorPickMode("none");
              }}
            />
          )}
        </div>
      )}

      {seafloorShow3d && (
        <Seafloor3DView
          grid={seafloorGrid}
          gpsPosition={
            gps.position
              ? {
                  lat: gps.position.lat,
                  lng: gps.position.lng,
                  heading: gps.position.heading ?? null,
                  speed: gps.position.speed ?? null,
                }
              : null
          }
          spots={alignedSpots}
          waypoints={savedWp.waypoints}
          followGps={seafloor.focusGps}
          onToggleFollowGps={(next) =>
            setSeafloor((s) => ({ ...s, focusGps: next, focusRadiusM: s.focusRadiusM || 800 }))
          }
          onClose={() => setSeafloorShow3d(false)}
        />
      )}


      {catchTarget && (
        <CatchLogPanel
          target={catchTarget}
          mode={fishingMode}
          env={{
            windKn: top1Wind?.avgKn ?? null,
            windDirDeg: top1Wind?.dirDeg ?? null,
            currentKn: top1Current?.avgKn ?? null,
            currentDirDeg: top1Current?.dirDeg ?? null,
            pressureHpa: top1Pressure?.hPa ?? null,
            dataDateIso: effectiveTime ?? resolved.resolvedDate ?? null,
          }}
          onClose={() => setCatchTarget(null)}
        />
      )}

      {aiAdvisorOpen && (
        <AiFishingAdvisor
          mode={fishingMode}
          analyzing={spotsLoading}
          drawing={drawMode === "triangle"}
          hasSearchArea={!!searchArea}
          onRequestDrawArea={() => {
            // Siempre triángulo nuevo: borramos el anterior y entramos en dibujo.
            setSearchArea(null);
            setSpots([]);
            setSpotRoutes([]);
            setSpotsClearTrigger((n) => n + 1);
            setAnalysisMessage(null);
            setSpotsEnabled(true);
            ensureSearchPrerequisites(fishingMode);
            pendingTop1AfterDrawRef.current = true;
            setDrawMode("triangle");
          }}
          onClearArea={() => {
            pendingTop1AfterDrawRef.current = false;
            clearSearchArea();
          }}
          onSelectMode={(m) => {
            // El cliente solo elige modalidad: la app ajusta profundidades,
            // GPS y capas; el área la marca el usuario con 3 clics.
            handleFishingModeChange(m);
            ensureSearchPrerequisites(m);
          }}


          spots={alignedSpots}
          gps={gps.position ? { lat: gps.position.lat, lng: gps.position.lng } : null}
          dataDateIso={effectiveTime ?? resolved.resolvedDate ?? null}
          wind={top1Wind ?? null}
          current={top1Current ?? null}
          pressureHpa={top1Pressure?.hPa ?? null}
          pressureTrend={top1Pressure?.trend ?? null}
          activeLayers={activeLayersLabels}
          fsleActive={!!multiLayer.fsle?.enabled}
          onPlan={(plan) => setAiPlan(plan)}
          onLogCatch={(sp) => setCatchTarget(sp)}
          onFlyTo={(lat, lng) => {
            setFlyToCenter([lat, lng]);
            setFlyToZoom((z) => Math.max(10, z));
            setFlyToTrigger((n) => n + 1);
          }}
          onClose={() => setAiAdvisorOpen(false)}
        />
      )}

      <AppMenu

        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        seafloorPanel={
          <SeafloorPanel
            settings={seafloor}
            onChange={setSeafloor}
            pickMode={seafloorPickMode}
            onPickModeChange={(m) => {
              setSeafloorPickMode(m);
              if (m === "profile") setSeafloorProfilePoints([]);
              if (m !== "none") setMenuOpen(false);
            }}
            show3d={seafloorShow3d}
            onToggle3d={() => {
              setSeafloorShow3d((v) => !v);
              setMenuOpen(false);
            }}
            loading={seafloorLoading}
            structuresCount={seafloorStructures.length}
          />
        }
        multiLayer={multiLayer}
        setMultiLayer={setMultiLayer}
        bathyRelief={bathyRelief}
        setBathyRelief={setBathyRelief}
        bathyContours={bathyContours}
        setBathyContours={setBathyContours}
        bathyIntensity={bathyIntensity}
        setBathyIntensity={setBathyIntensity}
        fishingMode={fishingMode}
        onFishingModeChange={handleFishingModeChange}
        drawMode={drawMode}
        onDrawTriangle={() => {
          setDrawMode((m) => {
            const next = m === "triangle" ? null : "triangle";
            if (next === "triangle") {
              // Empezar un triángulo nuevo borra siempre el anterior:
              // antes se quedaba el viejo pintado y no había forma de quitarlo.
              setSearchArea(null);
              setSpots([]);
              setSpotRoutes([]);
              setSpotsClearTrigger((n) => n + 1);
              setAnalysisMessage(null);
            }
            return next;
          });
          setMenuOpen(false);
        }}
        hasSearchArea={!!searchArea}
        hotZoneEnabled={hotZoneEnabled}
        onAnalyzeZone={() => {
          searchInsideArea();
          setMenuOpen(false);
        }}
        onShowTop1={handleShowTop1}
        onClearZone={clearSearchArea}
        spotsLoading={spotsLoading}
        time={time}
        onTimeChange={(value) => {
          setTime(value);
          if (!value) resolved.refresh();
        }}
        resolvedStatus={resolved.status}
        resolvedDate={resolved.resolvedDate}
        daysBack={resolved.daysBack}
        resolvedByLayer={resolved.resolvedByLayer}
        layerKeys={{
          sst: multiLayer.sst.layer,
          chl: multiLayer.chlorophyll.layer,
          alt: multiLayer.altimetry.layer,
        }}
        onUseLatest={() => {
          setTime(undefined);
          resolved.refresh();
        }}
        gpsActive={gps.active}
        gpsFollow={gpsFollow}
        gpsPosition={gps.position}
        gpsTrackLength={gps.track.length}
        gpsError={gps.error}
        onToggleGps={handleToggleGps}
        onToggleFollow={handleToggleFollow}
        onRecenterGps={handleRecenter}
        onExportGpx={handleExportGpx}
        onClearGpsTrack={() => {
          gps.clearTrack();
          setActiveSavedTrackId(null);
        }}
        onSaveGpsTrack={handleSaveGpsTrack}
        savedTracksSection={
          <SavedTracksPanel
            tracks={savedTracks.tracks}
            activeId={activeSavedTrackId}
            onShow={handleShowSavedTrack}
            onExport={(t) => downloadGpx(t.points)}
            onRename={savedTracks.rename}
            onDelete={(id) => {
              savedTracks.remove(id);
              setActiveSavedTrackId((cur) => (cur === id ? null : cur));
            }}
          />
        }
        onCenterMap={() => {
          setFlyToCenter(region.center);
          setFlyToZoom(region.zoom);
          setFlyToTrigger((n) => n + 1);
          setMenuOpen(false);
        }}
        onClearMarkers={() => {
          clearSearchArea();
        }}
        extraSection={
          <GradientZonesControl
            enabled={gradientEnabled}
            onToggle={() => {
              setGradientEnabled((v) => {
                const next = !v;
                if (next) {
                  // Limpia vista guardada al activar, pero NO lanza análisis automático.
                  startTransition(() => {
                    setSavedView(null);
                    setViewingSavedId(null);
                  });
                }
                return next;
              });
            }}
            zones={displayedZones}
            corridors={displayedCorridors}
            hotPoints={gradientHotPoints}
            loading={gradientResult.loading && !savedView}
            progress={gradientResult.progress}
            error={gradientResult.error}
            onRecompute={() => {
              handleExitSavedView();
              startGradientAnalysis();
            }}
            onToggleCorridor={handleToggleCorridor}
            onFocusZone={handleFocusZone}
            onToggleHotPoint={handleToggleHotPoint}
            onToggleDetailedCorridor={handleToggleDetailedCorridor}
            detailedCorridors={gradientDetailedCorridors}
            focusedId={gradientFocusedId}
            savedSets={savedZones.sets}
            onSaveCurrent={handleSaveCurrent}
            onLoadSaved={handleLoadSaved}
            onDeleteSaved={handleDeleteSavedZone}
            onRenameSaved={savedZones.rename}
            viewingSavedId={viewingSavedId}
            onExitSavedView={handleExitSavedView}
            onClear={handleClearZones}
          />
        }
      />

      {navTarget && !navScreenOpen && (
        <button
          type="button"
          onClick={() => setNavScreenOpen(true)}
          className="pointer-events-auto absolute bottom-24 left-1/2 z-[1500] -translate-x-1/2 rounded-full border-2 border-amber-300 bg-black/90 px-4 py-2 text-sm font-black uppercase text-amber-100 shadow-lg"
        >
          🧭 Navegando a {navTarget.name}
        </button>
      )}

      {navTarget && navScreenOpen && (
        <NavigationScreen
          target={navTarget}
          position={gps.position}
          track={gps.track}
          gpsError={gps.error}
          onBackToMap={() => setNavScreenOpen(false)}
          onEnd={() => {
            setNavScreenOpen(false);
            setNavTarget(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Chip compacto de mensaje del análisis. Por defecto colapsado a un icono
 * pequeño en la esquina inferior izquierda — no tapa el popup del marker
 * ni el centro del mapa. Al pulsarlo se expande mostrando el texto completo
 * en una caja estrecha y scrollable. Esto evita el banner gigante anterior
 * que cubría todo el popup del Top 1 (que mostraba 0/100 detrás).
 */
function AnalysisMessageChip({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  // Cada mensaje nuevo arranca cerrado: NUNCA tapará el popup del marker.
  useEffect(() => {
    setOpen(false);
  }, [message]);
  return (
    <div className="pointer-events-auto absolute right-2 top-24 z-[1200] max-w-[45vw] sm:max-w-[260px]">
      {open ? (
        <div className="flex items-start gap-1 rounded-md border border-amber-400/60 bg-black/90 p-1 shadow-lg">
          <span className="text-[9px] leading-tight text-amber-100 break-words max-h-24 overflow-y-auto pr-1">
            {message}
          </span>
          <div className="flex flex-col gap-0.5 shrink-0">
            <button
              onClick={() => setOpen(false)}
              className="rounded px-1 text-[9px] leading-none text-amber-200 hover:bg-amber-500/20"
              title="Plegar"
            >
              –
            </button>
            <button
              onClick={onDismiss}
              className="rounded px-1 text-[9px] leading-none text-amber-200 hover:bg-amber-500/20"
              title="Cerrar"
            >
              ×
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex h-5 items-center rounded-full border border-amber-400/60 bg-black/85 px-1.5 text-[9px] font-medium text-amber-100 shadow-md hover:bg-black/95"
          title="Ver análisis"
        >
          ⚠
        </button>
      )}
    </div>
  );
}

