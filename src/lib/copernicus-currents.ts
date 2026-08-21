import { fetchCopernicusValue } from "./copernicus-feature-info";

export type CurrentDepth = "surface" | 10 | 20 | 30 | 50 | 100 | "bottom";

const GLOBAL_DATASET =
  "SEALEVEL_GLO_PHY_L4_NRT_008_046/cmems_obs-sl_glo_phy-ssh_nrt_allsat-l4-duacs-0.125deg_P1D_202506";
const MED_DATASET =
  "MEDSEA_ANALYSISFORECAST_PHY_006_013/cmems_mod_med_phy-cur_anfc_4.2km_P1D-m_202511";

const GLOBAL_STYLE = "cmap:RdBu_r,vmin:-1.2,vmax:1.2";
const MED_STYLE = "cmap:RdBu_r,vmin:-1,vmax:1";
const MED_BBOX = { west: -17, east: 36, south: 30.5, north: 45.8 };

export interface CurrentVectorResult {
  u: number;
  v: number;
  speed: number;
  dirDeg: number;
  depth: CurrentDepth;
  source: "medsea" | "global";
}

export function currentDepthLabel(depth: CurrentDepth): string {
  if (depth === "surface") return "sup.";
  if (depth === "bottom") return "fondo";
  return `${depth} m`;
}

export function currentSpeedKnots(speedMps: number): number {
  return speedMps * 1.94384449;
}

function isInMed(lat: number, lng: number): boolean {
  return (
    lat >= MED_BBOX.south - 1.5 &&
    lat <= MED_BBOX.north + 1.5 &&
    lng >= MED_BBOX.west - 2 &&
    lng <= MED_BBOX.east + 2
  );
}

function elevationFor(depth: CurrentDepth, seafloorDepthM?: number | null): number | undefined {
  if (depth === "surface") return undefined;
  if (depth === "bottom") {
    const bottom = typeof seafloorDepthM === "number" && Number.isFinite(seafloorDepthM)
      ? Math.max(2, Math.min(500, seafloorDepthM - 1))
      : 500;
    return -bottom;
  }
  return -depth;
}

export async function fetchCopernicusCurrentVector({
  lat,
  lng,
  zoom,
  time,
  depth = "surface",
  seafloorDepthM,
  signal,
}: {
  lat: number;
  lng: number;
  zoom: number;
  time?: string;
  depth?: CurrentDepth;
  seafloorDepthM?: number | null;
  signal?: AbortSignal;
}): Promise<CurrentVectorResult | null> {
  const useMed = depth !== "surface" || isInMed(lat, lng);
  const dataset = useMed ? MED_DATASET : GLOBAL_DATASET;
  const style = useMed ? MED_STYLE : GLOBAL_STYLE;
  const uVar = useMed ? "uo" : "ugos";
  const vVar = useMed ? "vo" : "vgos";
  const elevation = useMed ? elevationFor(depth, seafloorDepthM) : undefined;

  // ---- Fuente primaria: muestreo compartido con las streamlines ----
  // Usamos exactamente el mismo pipeline de decodificado de tiles WMTS
  // que dibuja las líneas de corriente. Así el rumbo/velocidad que se
  // muestran en el crosshair y en la flecha de pesca coinciden 1:1 con
  // la dirección visual de las streamlines.
  try {
    const t = time ?? new Date().toISOString().slice(0, 10);
    const { sampleCurrentTileAt } = await import("@/components/VelocityLayer");
    const ac = signal ?? new AbortController().signal;
    const tileSample = await sampleCurrentTileAt(lat, lng, depth, t, ac);
    if (tileSample && Number.isFinite(tileSample.u) && Number.isFinite(tileSample.v)) {
      const speed = Math.sqrt(tileSample.u * tileSample.u + tileSample.v * tileSample.v);
      if (Number.isFinite(speed)) {
        // La app muestra la corriente como VIENTO: dirección DE DONDE viene.
        const dirDeg = ((Math.atan2(tileSample.u, tileSample.v) * 180) / Math.PI + 360 + 180) % 360;
        return {
          u: tileSample.u,
          v: tileSample.v,
          speed,
          dirDeg,
          depth,
          source: useMed ? "medsea" : "global",
        };
      }
    }
  } catch {
    // fallback abajo
  }

  // ---- Fallback: GetFeatureInfo JSON ----
  const [u, v] = await Promise.all([
    fetchCopernicusValue(`${dataset}/${uVar}`, style, lat, lng, zoom, time, signal, elevation),
    fetchCopernicusValue(`${dataset}/${vVar}`, style, lat, lng, zoom, time, signal, elevation),
  ]);

  if (u.value == null || v.value == null) return null;
  const speed = Math.sqrt(u.value * u.value + v.value * v.value);
  if (!Number.isFinite(speed)) return null;

  // Dirección de procedencia (como el viento), no hacia donde fluye.
  const dirDeg = ((Math.atan2(u.value, v.value) * 180) / Math.PI + 360 + 180) % 360;
  return {
    u: u.value,
    v: v.value,
    speed,
    dirDeg,
    depth,
    source: useMed ? "medsea" : "global",
  };
}

