/**
 * GEOMETRÍA DE COSTA PARA LA PESCA A LA DERIVA
 * ============================================
 *
 * A partir de la máscara de tierra (Natural Earth 10 m) derivamos, para
 * cualquier punto de mar, los descriptores geográficos que mandan en la
 * fluixa costera:
 *
 *   · Distancia a costa
 *   · Rumbo hacia la costa más cercana (→ orientación del litoral)
 *   · Índice de punta / cabo  (tierra concentrada en un sector estrecho)
 *   · Índice de ensenada      (tierra rodeando en amplio abanico)
 *   · Abrigo frente al viento (viento de tierra = agua planchada)
 *
 * Todo se calcula con sondeos radiales sobre la máscara: sin peticiones de
 * red y con coste acotado (36 rumbos × pocos pasos).
 */

export interface LandProbe {
  isLand(lat: number, lng: number): boolean;
}

export interface CoastGeometry {
  /** Distancia a la costa más cercana en km (null si no hay tierra en el radio). */
  coastKm: number | null;
  /** Rumbo (0-360, 0 = N) hacia la tierra más cercana. */
  coastBearingDeg: number | null;
  /** Fracción de rumbos (0..1) con tierra dentro del radio de análisis. */
  landFraction: number;
  /** 0..1 — tierra concentrada en un sector estrecho (punta, cabo, islote). */
  capeIndex: number;
  /** 0..1 — tierra rodeando en amplio abanico (bahía, ensenada). */
  bayIndex: number;
}

const DEG = Math.PI / 180;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Sondea la costa en 36 rumbos hasta `maxKm`, con paso `stepKm`.
 */
export function computeCoastGeometry(
  mask: LandProbe | null,
  lat: number,
  lng: number,
  maxKm = 8,
  stepKm = 0.4,
): CoastGeometry {
  if (!mask) {
    return {
      coastKm: null,
      coastBearingDeg: null,
      landFraction: 0,
      capeIndex: 0,
      bayIndex: 0,
    };
  }

  const kmPerDegLat = 111.32;
  const kmPerDegLng = 111.32 * Math.max(0.2, Math.cos(lat * DEG));
  const nBearings = 36;
  const dists: (number | null)[] = [];

  for (let i = 0; i < nBearings; i++) {
    const brg = (i * 360) / nBearings;
    const dx = Math.sin(brg * DEG); // este
    const dy = Math.cos(brg * DEG); // norte
    let found: number | null = null;
    for (let d = stepKm; d <= maxKm; d += stepKm) {
      const la = lat + (dy * d) / kmPerDegLat;
      const lo = lng + (dx * d) / kmPerDegLng;
      if (mask.isLand(la, lo)) {
        found = d;
        break;
      }
    }
    dists.push(found);
  }

  const hits = dists.filter((d): d is number => d != null);
  if (hits.length === 0) {
    return { coastKm: null, coastBearingDeg: null, landFraction: 0, capeIndex: 0, bayIndex: 0 };
  }

  let minD = Infinity;
  let minIdx = 0;
  dists.forEach((d, i) => {
    if (d != null && d < minD) {
      minD = d;
      minIdx = i;
    }
  });
  const coastBearingDeg = (minIdx * 360) / nBearings;
  const landFraction = hits.length / nBearings;

  // Sector "cercano": rumbos con tierra a menos de 2× la distancia mínima.
  const near = dists.filter((d) => d != null && d <= Math.max(minD * 2, minD + 0.8)).length;
  const nearFraction = near / nBearings;

  // Punta/cabo: la tierra próxima ocupa un sector estrecho (<25 % de rumbos)
  // pero está claramente ahí. Ensenada: sector amplio (>45 %).
  const capeIndex = clamp01((0.3 - nearFraction) / 0.22) * clamp01((8 - minD) / 6);
  const bayIndex = clamp01((landFraction - 0.35) / 0.35);

  return { coastKm: minD, coastBearingDeg, landFraction, capeIndex, bayIndex };
}

/**
 * Abrigo del viento: 1 = viento de tierra sobre agua próxima a la costa
 * (mar plancha, deriva controlable); 0 = viento de mar abierto con fetch
 * largo sobre el punto.
 */
export function windShelterFactor(
  coastKm: number | null,
  coastBearingDeg: number | null,
  windFromDeg: number | null,
  windKn: number | null,
): number | null {
  if (coastKm == null || coastBearingDeg == null || windFromDeg == null) return null;
  // Diferencia angular entre "de dónde viene el viento" y "dónde está la tierra".
  let diff = Math.abs(((windFromDeg - coastBearingDeg + 540) % 360) - 180);
  diff = 180 - diff; // 0 = viento viene exactamente de tierra
  const offshore = clamp01(1 - diff / 90); // 1 = terral puro
  // Cuanto más cerca de la costa, más efectivo es el abrigo del terral.
  const proximity = clamp01(1 - (coastKm - 0.3) / 5);
  const shelter = 0.35 + 0.65 * offshore * proximity;
  if (windKn == null) return clamp01(shelter);
  // Con poco viento el abrigo importa poco: todo es pescable.
  const calmBonus = clamp01(1 - windKn / 12);
  return clamp01(shelter + calmBonus * (1 - shelter) * 0.8);
}

