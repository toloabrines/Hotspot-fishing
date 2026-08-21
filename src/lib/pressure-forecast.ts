/**
 * Presión atmosférica + tendencia 24 h (Open-Meteo, sin API key).
 *
 * Se usa para informar al pescador si la presión está subiendo (mejor
 * actividad) o bajando (puede empeorar), un factor clave en la pesca.
 */

const CACHE = new Map<string, { ts: number; data: PressureForecast }>();
const TTL_MS = 30 * 60 * 1000; // 30 min

export interface PressureForecast {
  /** Presión actual estimada (hPa). */
  hPa: number;
  /** Tendencia en 24 h (hPa). Positivo = sube, negativo = baja. */
  delta24h: number;
  /** Tendencia legible. */
  trend: "subiendo" | "estable" | "bajando";
  /** Intensidad de la tendencia. */
  trendLevel: "fuerte" | "moderada" | "leve";
}

function categorizeTrend(delta: number): {
  trend: PressureForecast["trend"];
  trendLevel: PressureForecast["trendLevel"];
} {
  const abs = Math.abs(delta);
  const trend = delta > 1.5 ? "subiendo" : delta < -1.5 ? "bajando" : "estable";
  const trendLevel = abs > 5 ? "fuerte" : abs > 2 ? "moderada" : "leve";
  return { trend, trendLevel };
}

export async function fetchPressureForecast(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<PressureForecast | null> {
  const key = `${lat.toFixed(2)}|${lng.toFixed(2)}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    `&hourly=surface_pressure` +
    `&past_hours=24&forecast_hours=0&timezone=UTC`;

  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      hourly?: { surface_pressure?: number[] };
    };
    const arr = json.hourly?.surface_pressure ?? [];
    if (arr.length < 2) return null;
    const now = arr[arr.length - 1];
    const before = arr[0];
    const delta24h = now - before;
    const { trend, trendLevel } = categorizeTrend(delta24h);
    const data: PressureForecast = {
      hPa: now,
      delta24h,
      trend,
      trendLevel,
    };
    CACHE.set(key, { ts: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

