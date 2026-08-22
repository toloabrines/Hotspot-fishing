/**
 * Pronóstico de corriente superficial (Open-Meteo Marine, sin API key).
 *
 * Devuelve módulo (nudos) y dirección "hacia donde fluye" (grados).
 * Se usa para mostrar al pescador la dirección/intensidad de la corriente
 * en el Top 1, separada del viento atmosférico.
 */

const CACHE = new Map<string, { ts: number; data: CurrentForecast }>();
const TTL_MS = 30 * 60 * 1000; // 30 min

export interface CurrentForecast {
  /** Velocidad media próximas 6h (nudos). */
  avgKn: number;
  /** Dirección media "hacia donde fluye" (grados, 0 = N). */
  dirDeg: number;
  /** Categoría legible. */
  level: "muy débil" | "débil" | "moderada" | "fuerte";
}

const KMH_TO_KN = 0.539957;

function categorize(avgKn: number): CurrentForecast["level"] {
  if (avgKn < 0.3) return "muy débil";
  if (avgKn < 1.0) return "débil";
  if (avgKn < 2.0) return "moderada";
  return "fuerte";
}

export async function fetchCurrentForecast(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<CurrentForecast | null> {
  const key = `${lat.toFixed(2)}|${lng.toFixed(2)}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  const url =
    `https://marine-api.open-meteo.com/v1/marine` +
    `?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    `&hourly=ocean_current_velocity,ocean_current_direction` +
    `&forecast_hours=6&timezone=UTC`;

  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      hourly?: {
        ocean_current_velocity?: number[];
        ocean_current_direction?: number[];
      };
    };
    const vs = (json.hourly?.ocean_current_velocity ?? []).filter((v) => Number.isFinite(v));
    const ds = (json.hourly?.ocean_current_direction ?? []).filter((v) => Number.isFinite(v));
    if (vs.length === 0) return null;
    const avgKmh = vs.reduce((a, b) => a + b, 0) / vs.length;
    // Promedio angular vectorial para evitar artefactos en 359°/1°.
    let sx = 0;
    let sy = 0;
    for (const deg of ds) {
      const r = (deg * Math.PI) / 180;
      sx += Math.cos(r);
      sy += Math.sin(r);
    }
    let avgDir = ds.length > 0 ? (Math.atan2(sy, sx) * 180) / Math.PI : 0;
    if (avgDir < 0) avgDir += 360;
    // Open-Meteo devuelve dirección "hacia donde fluye"; la app la muestra como procedencia.
    avgDir = (avgDir + 180) % 360;
    const avgKn = avgKmh * KMH_TO_KN;
    const data: CurrentForecast = {
      avgKn,
      dirDeg: avgDir,
      level: categorize(avgKn),
    };
    CACHE.set(key, { ts: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

