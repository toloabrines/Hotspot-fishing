/**
 * Utilidades de navegación náutica: distancia, rumbo (bearing), desviación,
 * ETA y formateo. Todo se calcula a partir de las lecturas GPS reales.
 */

export interface NavTarget {
  lat: number;
  lng: number;
  name: string;
}

const R = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Distancia gran círculo en metros. */
export function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Rumbo inicial en grados (0 = N) desde a hacia b. */
export function bearingDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Diferencia angular con signo en [-180, 180]. Negativo = babor. */
export function angleDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

export const M_PER_NM = 1852;

export function metersToNm(m: number): number {
  return m / M_PER_NM;
}

export function msToKnots(ms: number): number {
  return ms * 1.94384;
}

export function cardinal(deg: number): string {
  const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Distancia formateada: millas náuticas y metros cuando queda poco. */
export function formatDistance(m: number): { value: string; unit: string } {
  if (m < 1000) return { value: m.toFixed(0), unit: "m" };
  return { value: metersToNm(m).toFixed(2), unit: "NM" };
}

/** ETA en segundos a partir de la velocidad sobre el fondo (m/s). */
export function etaSeconds(distanceMeters: number, speedMs: number | null): number | null {
  if (speedMs == null || speedMs < 0.3) return null; // < ~0,6 kn: no fiable
  return distanceMeters / speedMs;
}

export function formatEta(seconds: number | null): string {
  if (seconds == null) return "--:--";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Hora estimada de llegada en formato local HH:MM. */
export function formatArrivalClock(seconds: number | null): string {
  if (seconds == null) return "--:--";
  const d = new Date(Date.now() + seconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Umbrales de aviso visual (metros). */
export const ALERT_THRESHOLDS = [M_PER_NM, 500, 100] as const;
export const ARRIVAL_RADIUS_M = 40;

export function alertLabel(threshold: number): string {
  if (threshold === M_PER_NM) return "Falta 1 milla náutica";
  if (threshold === 500) return "Faltan 500 metros";
  return "Faltan 100 metros";
}

