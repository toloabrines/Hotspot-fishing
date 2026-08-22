/**
 * Pronóstico de viento gratuito (Open-Meteo, sin API key).
 *
 * Se usa para avisar al pescador si las próximas horas el viento será
 * fuerte. NO se recalcula el score automáticamente: solo informamos.
 *
 *   < 10 kn → ok (verde)
 *   10-20 kn → moderado (ámbar)
 *   > 20 kn → fuerte (rojo) — no recomendado para pesca de superficie
 */

const CACHE = new Map<string, { ts: number; data: WindForecast }>();
const TTL_MS = 30 * 60 * 1000; // 30 min

export interface WindForecast {
  /** Velocidad media próximas 6h (nudos). */
  avgKn: number;
  /** Pico de ráfaga próximas 6h (nudos). */
  gustKn: number;
  /** Dirección media (grados). */
  dirDeg: number;
  /** Categoría legible. */
  level: "calmo" | "ok" | "moderado" | "fuerte" | "muy fuerte";
}

const MS_TO_KN = 1.94384;

function categorize(avgKn: number): WindForecast["level"] {
  if (avgKn < 5) return "calmo";
  if (avgKn < 10) return "ok";
  if (avgKn < 18) return "moderado";
  if (avgKn < 25) return "fuerte";
  return "muy fuerte";
}

export async function fetchWindForecast(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<WindForecast | null> {
  const key = `${lat.toFixed(2)}|${lng.toFixed(2)}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m` +
    `&wind_speed_unit=ms&forecast_hours=6&timezone=UTC`;

  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      hourly?: {
        wind_speed_10m?: number[];
        wind_gusts_10m?: number[];
        wind_direction_10m?: number[];
      };
    };
    const ws = json.hourly?.wind_speed_10m ?? [];
    const gs = json.hourly?.wind_gusts_10m ?? [];
    const ds = json.hourly?.wind_direction_10m ?? [];
    if (ws.length === 0) return null;
    const avgMs = ws.reduce((a, b) => a + b, 0) / ws.length;
    const gustMs = gs.length > 0 ? Math.max(...gs) : avgMs;
    const avgDir = ds.length > 0 ? ds.reduce((a, b) => a + b, 0) / ds.length : 0;
    const data: WindForecast = {
      avgKn: avgMs * MS_TO_KN,
      gustKn: gustMs * MS_TO_KN,
      dirDeg: avgDir,
      level: categorize(avgMs * MS_TO_KN),
    };
    CACHE.set(key, { ts: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

