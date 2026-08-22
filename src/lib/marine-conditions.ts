/**
 * CONDICIONES MARINAS PARA LA PESCA A LA DERIVA (FLUIXA)
 * ======================================================
 *
 * Open-Meteo Marine + Forecast (gratis, sin API key) para obtener las
 * variables que el motor de deriva necesita y que Copernicus no da con
 * suficiente frescura en costa:
 *
 *   · Altura y periodo de ola
 *   · Corriente oceánica superficial (velocidad y dirección)
 *   · Viento a 10 m (media y racha próximas horas)
 *
 * Se pide UNA sola vez por análisis (centroide del área) y se cachea.
 */

export interface MarineConditions {
  /** Altura significativa de ola (m). */
  waveHeightM: number | null;
  /** Periodo de ola (s). */
  wavePeriodS: number | null;
  /** Dirección de procedencia de la ola (grados). */
  waveDirDeg: number | null;
  /** Corriente superficial (m/s). */
  currentSpeedMs: number | null;
  /** Dirección HACIA la que va la corriente (grados). */
  currentDirDeg: number | null;
  /** Viento medio (nudos). */
  windKn: number | null;
  /** Racha (nudos). */
  gustKn: number | null;
  /** Dirección DE DONDE viene el viento (grados). */
  windFromDeg: number | null;
}

const MS_TO_KN = 1.94384;
const TTL_MS = 30 * 60 * 1000;
const CACHE = new Map<string, { ts: number; data: MarineConditions }>();

const mean = (xs: (number | undefined | null)[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
};

/** Media circular de ángulos en grados. */
function meanDeg(xs: (number | undefined | null)[]): number | null {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const d of v) {
    sx += Math.cos((d * Math.PI) / 180);
    sy += Math.sin((d * Math.PI) / 180);
  }
  const deg = (Math.atan2(sy, sx) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export const EMPTY_MARINE: MarineConditions = {
  waveHeightM: null,
  wavePeriodS: null,
  waveDirDeg: null,
  currentSpeedMs: null,
  currentDirDeg: null,
  windKn: null,
  gustKn: null,
  windFromDeg: null,
};

export async function fetchMarineConditions(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<MarineConditions> {
  const key = `${lat.toFixed(2)}|${lng.toFixed(2)}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  const marineUrl =
    `https://marine-api.open-meteo.com/v1/marine` +
    `?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    `&hourly=wave_height,wave_period,wave_direction,ocean_current_velocity,ocean_current_direction` +
    `&forecast_hours=6&timezone=UTC`;
  const windUrl =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    `&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m` +
    `&wind_speed_unit=ms&forecast_hours=6&timezone=UTC`;

  const out: MarineConditions = { ...EMPTY_MARINE };
  try {
    const [mRes, wRes] = await Promise.all([
      fetch(marineUrl, { signal }).catch(() => null),
      fetch(windUrl, { signal }).catch(() => null),
    ]);

    if (mRes?.ok) {
      const j = (await mRes.json()) as {
        hourly?: {
          wave_height?: number[];
          wave_period?: number[];
          wave_direction?: number[];
          ocean_current_velocity?: number[];
          ocean_current_direction?: number[];
        };
      };
      const h = j.hourly ?? {};
      out.waveHeightM = mean(h.wave_height ?? []);
      out.wavePeriodS = mean(h.wave_period ?? []);
      out.waveDirDeg = meanDeg(h.wave_direction ?? []);
      // Open-Meteo devuelve la corriente en km/h → m/s.
      const kmh = mean(h.ocean_current_velocity ?? []);
      out.currentSpeedMs = kmh == null ? null : kmh / 3.6;
      out.currentDirDeg = meanDeg(h.ocean_current_direction ?? []);
    }

    if (wRes?.ok) {
      const j = (await wRes.json()) as {
        hourly?: {
          wind_speed_10m?: number[];
          wind_gusts_10m?: number[];
          wind_direction_10m?: number[];
        };
      };
      const h = j.hourly ?? {};
      const ws = mean(h.wind_speed_10m ?? []);
      const gs = mean(h.wind_gusts_10m ?? []);
      out.windKn = ws == null ? null : ws * MS_TO_KN;
      out.gustKn = gs == null ? null : gs * MS_TO_KN;
      out.windFromDeg = meanDeg(h.wind_direction_10m ?? []);
    }
  } catch {
    /* sin datos → el motor renormaliza pesos */
  }

  CACHE.set(key, { ts: Date.now(), data: out });
  return out;
}

