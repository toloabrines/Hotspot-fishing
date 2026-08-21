import { fetchCopernicusValue } from "./copernicus-feature-info";
import type { DemPointInfo } from "./dem";
import { bottomCurrentFactor, bottomTempFactor } from "./bottom-field";

/**
 * Ficha del punto: combina la morfología del DEM con temperatura y corriente
 * de fondo del modelo MEDSEA y produce un Score de pesca de fondo 0–100.
 */

const MED_TEMP =
  "MEDSEA_ANALYSISFORECAST_PHY_006_013/cmems_mod_med_phy-tem_anfc_4.2km_P1D-m_202511";
const MED_CUR = "MEDSEA_ANALYSISFORECAST_PHY_006_013/cmems_mod_med_phy-cur_anfc_4.2km_P1D-m_202511";
const STYLE_TEMP = "cmap:thermal,vmin:10,vmax:26";
const STYLE_CUR = "cmap:RdBu_r,vmin:-1,vmax:1";

export interface SeafloorPointReport {
  lat: number;
  lng: number;
  info: DemPointInfo;
  tempC: number | null;
  speed: number | null;
  dirDeg: number | null;
  /** Score de pesca de fondo 0–100. */
  score: number;
  reasons: string[];
  loading: boolean;
}

function bottomElevation(depthM: number | null): number {
  if (depthM == null || !Number.isFinite(depthM) || depthM <= 0) return -10;
  return -Math.max(2, Math.min(2000, depthM - 1));
}

function toCelsius(v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v > 200 ? v - 273.15 : v;
}

/** Bonificación morfológica: pendiente moderada-fuerte + rugosidad + relieve. */
export function morphologyScore(info: DemPointInfo): { value: number; reasons: string[] } {
  const reasons: string[] = [];
  const slope = info.slopeDeg ?? 0;
  const rough = info.roughness01 ?? 0;
  const curv = info.curvature ?? 0;

  let slopeScore: number;
  if (slope < 1) slopeScore = 0.15;
  else if (slope < 4) slopeScore = 0.4;
  else if (slope < 10) slopeScore = 0.8;
  else if (slope < 25) slopeScore = 1;
  else slopeScore = 0.85;
  if (slope >= 10) reasons.push(`Veril marcado (${slope.toFixed(0)}° de pendiente): concentra pescado.`);
  else if (slope < 1.5) reasons.push("Fondo muy llano: menos estructura donde se refugie el pescado.");

  const roughScore = Math.min(1, rough * 1.25);
  if (rough > 0.45) reasons.push("Fondo rugoso (roca/grietas): ideal para dentón, pagel y mero.");
  else if (rough < 0.15) reasons.push("Fondo liso tipo arena o fango.");

  let structScore = 0.4;
  if (info.landform === "bajo" || info.landform === "cima") {
    structScore = 1;
    reasons.push("Estructura tipo bajo/cima: punto de agregación clásico.");
  } else if (info.landform === "veril") {
    structScore = 0.95;
  } else if (info.landform === "canon" || info.landform === "agujero") {
    structScore = 0.8;
    reasons.push("Canal o depresión: ruta de paso y refugio.");
  } else if (info.landform === "meseta" || info.landform === "llano") {
    structScore = 0.25;
  }
  if (Math.abs(curv) > 3) reasons.push("Cambio brusco de relieve en pocos metros.");

  return { value: slopeScore * 0.4 + roughScore * 0.3 + structScore * 0.3, reasons };
}

export async function fetchBottomConditions(
  lat: number,
  lng: number,
  depthM: number | null,
  time: string,
  signal?: AbortSignal,
): Promise<{ tempC: number | null; speed: number | null; dirDeg: number | null }> {
  const elev = bottomElevation(depthM);
  try {
    const [t, u, v] = await Promise.all([
      fetchCopernicusValue(`${MED_TEMP}/thetao`, STYLE_TEMP, lat, lng, 10, time, signal, elev).then(
        (r) => r.value,
      ),
      fetchCopernicusValue(`${MED_CUR}/uo`, STYLE_CUR, lat, lng, 10, time, signal, elev).then(
        (r) => r.value,
      ),
      fetchCopernicusValue(`${MED_CUR}/vo`, STYLE_CUR, lat, lng, 10, time, signal, elev).then(
        (r) => r.value,
      ),
    ]);
    const speed = u != null && v != null ? Math.hypot(u, v) : null;
    const dirDeg =
      u != null && v != null ? (((Math.atan2(u, v) * 180) / Math.PI + 360 + 180) % 360) : null;
    return { tempC: toCelsius(t), speed, dirDeg };
  } catch {
    return { tempC: null, speed: null, dirDeg: null };
  }
}

export function seafloorScore(
  info: DemPointInfo,
  tempC: number | null,
  speed: number | null,
): { score: number; reasons: string[] } {
  const morph = morphologyScore(info);
  const reasons = [...morph.reasons];

  const tf = bottomTempFactor(tempC);
  if (tf != null && tempC != null) {
    reasons.push(
      tf > 0.75
        ? `Temperatura de fondo ${tempC.toFixed(1)} °C: en el rango bueno para demersales.`
        : `Temperatura de fondo ${tempC.toFixed(1)} °C: fuera del óptimo (13–16 °C).`,
    );
  }
  const cf = bottomCurrentFactor(speed);
  if (cf != null && speed != null) {
    reasons.push(
      cf > 0.75
        ? `Corriente de fondo ${(speed * 100).toFixed(0)} cm/s: suave y activa, buena señal.`
        : speed < 0.03
          ? "Corriente de fondo casi nula: menos actividad."
          : `Corriente de fondo fuerte (${(speed * 100).toFixed(0)} cm/s): difícil de pescar.`,
    );
  }

  // Pesos: morfología manda, T y corriente modulan.
  let wSum = 0.55;
  let acc = morph.value * 0.55;
  if (tf != null) {
    acc += tf * 0.25;
    wSum += 0.25;
  }
  if (cf != null) {
    acc += cf * 0.2;
    wSum += 0.2;
  }
  const score = Math.round((acc / wSum) * 100);
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

