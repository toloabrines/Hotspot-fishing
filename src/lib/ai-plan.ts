/**
 * Geometría del plan de pesca de la IA (cliente).
 *
 * La IA solo elige hotspots reales y un radio de trabajo; TODAS las
 * coordenadas del polígono y de la línea de deriva las calcula la app aquí,
 * de modo que nunca hay coordenadas inventadas.
 */
import { distanceNm, type AdvisorPick, type AdvisorPlanSpot, type AdvisorSpot } from "./ai-advisor";
import { driftVector } from "./drift-corridor";

const R_EARTH = 6371000;

function offset(
  p: { lat: number; lng: number },
  bearingDeg: number,
  distM: number,
): { lat: number; lng: number } {
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (p.lat * Math.PI) / 180;
  const lng1 = (p.lng * Math.PI) / 180;
  const d = distM / R_EARTH;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: (lat2 * 180) / Math.PI, lng: (((lng2 * 180) / Math.PI + 540) % 360) - 180 };
}

/** Rumbo verdadero de a hacia b. */
export function bearingDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Polígono de trabajo alrededor del punto (hexágono regular = zona de pesca). */
export function workPolygon(
  center: { lat: number; lng: number },
  radiusM: number,
  sides = 6,
): Array<{ lat: number; lng: number }> {
  const pts: Array<{ lat: number; lng: number }> = [];
  for (let i = 0; i < sides; i++) pts.push(offset(center, (360 / sides) * i, radiusM));
  return pts;
}

export interface PlanEnv {
  wind: { avgKn: number; dirDeg: number } | null;
  current: { avgKn: number; dirDeg: number } | null;
}

/** Construye el plan pintable a partir de los picks de la IA. */
export function buildPlan(
  picks: AdvisorPick[],
  spots: AdvisorSpot[],
  gps: { lat: number; lng: number } | null,
  env: PlanEnv,
): AdvisorPlanSpot[] {
  const drift = driftVector({
    currentSpeedMs: env.current ? env.current.avgKn / 1.94384 : null,
    // env.current.dirDeg es procedencia; driftVector espera sentido del flujo.
    currentDirDeg: env.current?.dirDeg != null ? (env.current.dirDeg + 180) % 360 : null,
    windKn: env.wind?.avgKn ?? null,
    // El viento de la app se da como dirección de procedencia.
    windFromDeg: env.wind?.dirDeg ?? null,
  });

  const out: AdvisorPlanSpot[] = [];
  for (const p of picks) {
    const s = spots.find((x) => x.id === p.spotId);
    if (!s) continue;
    const center = { lat: s.lat, lng: s.lng };
    const radius = Math.max(150, Math.min(2000, p.radiusM || 400));
    let driftLine: Array<{ lat: number; lng: number }> | null = null;
    if (p.drift && drift) {
      const len = Math.max(600, radius * 3);
      driftLine = [
        offset(center, (drift.dirDeg + 180) % 360, len / 2),
        offset(center, drift.dirDeg, len / 2),
      ];
    }
    out.push({
      rank: p.rank,
      lat: s.lat,
      lng: s.lng,
      depthM: s.depthM,
      distanceNm: s.distanceNm ?? (gps ? distanceNm(gps, center) : null),
      bearingDeg: gps ? bearingDeg(gps, center) : null,
      scorePct: s.scorePct,
      confidence: p.confidence,
      why: p.why,
      technique: p.technique,
      bestHours: p.bestHours,
      polygon: workPolygon(center, radius),
      driftLine,
      driftBearingDeg: driftLine && drift ? drift.dirDeg : null,
    });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

