/**
 * TABLA ÚNICA DE PESOS DEL FISHING SCORE
 * ======================================
 *
 * Antes los pesos estaban repartidos por el motor (la documentación decía
 * 75/25 y el código usaba 65/35). Aquí vive la ÚNICA fuente de verdad:
 *
 *   · MIX_WEIGHTS      → cómo se mezclan bloque fondo y bloque superficie.
 *   · BASE_WEIGHTS     → peso de cada variable dentro de cada modalidad.
 *
 * Los pesos base pueden ser sustituidos por pesos APRENDIDOS (ver
 * `catch-learning.functions.ts`): el cliente carga el vector aprendido del
 * usuario al arrancar y `getWeights()` lo devuelve mezclado con la base.
 */

export type FishingModeKey = "bottom" | "squid" | "surface" | "drift";

/** Mezcla fondo/superficie por modalidad. Σ = 1 en cada fila. */
export const MIX_WEIGHTS: Record<FishingModeKey, { fondo: number; superficie: number }> = {
  bottom: { fondo: 0.7, superficie: 0.3 },
  squid: { fondo: 0.8, superficie: 0.2 },
  surface: { fondo: 0.3, superficie: 0.7 },
  // La deriva NO usa esta mezcla (tiene motor propio), pero se declara para
  // mantener la tabla completa por modalidad.
  drift: { fondo: 0.45, superficie: 0.55 },
};


/**
 * Variables normalizadas (0..1) que alimentan cada modalidad. El nombre es
 * la clave que se guarda en `factors_snapshot` y en los pesos aprendidos.
 */
export const FACTOR_LABELS: Record<string, string> = {
  estructura: "Estructura de fondo",
  veril: "Veril / cambio de profundidad",
  profundidad: "Profundidad adecuada",
  tempFondo: "Temperatura de fondo",
  corrFondo: "Corriente de fondo",
  oxigeno: "Oxígeno disuelto",
  frenteSalino: "Frente salino",
  fondoMixto: "Fondo arena–roca",
  luna: "Luz lunar",
  crepusculo: "Amanecer / atardecer",
  sst: "Gradiente de temperatura",
  chl: "Gradiente de clorofila",
  alt: "Altimetría / corriente",
  fsle: "Frente FSLE (LCS)",
  coherencia: "Coincidencia entre capas",
  persistencia: "Persistencia 2–3 días",
  // Motor de pesca a la deriva (fluixa)
  deriva: "Velocidad de deriva",
  abrigo: "Abrigo del viento",
  oleaje: "Oleaje",
  punta: "Punta / cabo",
  canal: "Canal o depresión",
  distCosta: "Distancia a la costa",
  altCorriente: "Corriente superficial",
  calidadDatos: "Calidad de los datos",
};


/** Pesos base del BLOQUE DE FONDO (modo fondo). Σ = 1. */
export const BOTTOM_BLOCK_WEIGHTS = {
  estructura: 0.3,
  veril: 0.25,
  profundidad: 0.18,
  tempFondo: 0.1,
  corrFondo: 0.07,
  oxigeno: 0.07,
  frenteSalino: 0.03,
} as const;

/** Pesos base del BLOQUE DE SUPERFICIE. Σ = 1. */
export const SURFACE_BLOCK_WEIGHTS = {
  sst: 0.3,
  chl: 0.2,
  alt: 0.35,
  fsle: 0.15,
} as const;

/** Peso del FSLE dentro del bloque de superficie según modalidad. */
export const FSLE_WEIGHT_BY_MODE: Record<FishingModeKey, number> = {
  surface: 0.15,
  squid: 0.07,
  bottom: 0.03,
  drift: 0.12,
};

/** Pesos base del MOTOR DE CALAMAR. Σ = 1. */
export const SQUID_WEIGHTS = {
  tempFondo: 0.24,
  corrFondo: 0.2,
  fondoMixto: 0.18,
  luna: 0.14,
  crepusculo: 0.12,
  profundidad: 0.08,
  fsle: 0.04,
} as const;

/**
 * Pesos base del MOTOR DE PESCA A LA DERIVA (FLUIXA). Σ = 1.
 * Motor propio: ni reutiliza ni mezcla los de altura, fondo o calamar.
 * Está preparado para incorporar variables nuevas: basta con añadir la
 * clave aquí y renormalizar (weightedScore ya ignora factores ausentes).
 */
export const DRIFT_WEIGHTS = {
  // Geografía y fondo costero (0.42)
  veril: 0.11,
  estructura: 0.1,
  profundidad: 0.09,
  punta: 0.07,
  canal: 0.05,
  // Deriva real del barco (0.22)
  deriva: 0.12,
  abrigo: 0.05,
  oleaje: 0.05,
  // Oceanografía (0.28)
  fsle: 0.09,
  sst: 0.08,
  chl: 0.07,
  altCorriente: 0.04,
  // Contexto (0.08)
  distCosta: 0.05,
  persistencia: 0.02,
  calidadDatos: 0.01,
} as const;

export type WeightVector = Record<string, number>;

export function baseWeightsFor(mode: FishingModeKey): WeightVector {
  if (mode === "squid") return { ...SQUID_WEIGHTS };
  if (mode === "drift") return { ...DRIFT_WEIGHTS };
  if (mode === "surface") return { ...SURFACE_BLOCK_WEIGHTS };
  return { ...BOTTOM_BLOCK_WEIGHTS };
}


// ─────────────── Pesos aprendidos (memoria de proceso) ───────────────

const learned: Partial<Record<FishingModeKey, { weights: WeightVector; nSamples: number }>> = {};

export function setLearnedWeights(
  mode: FishingModeKey,
  weights: WeightVector | null,
  nSamples = 0,
) {
  if (!weights || Object.keys(weights).length === 0) {
    delete learned[mode];
    return;
  }
  learned[mode] = { weights, nSamples };
}

export function getLearnedInfo(mode: FishingModeKey) {
  return learned[mode] ?? null;
}

/**
 * Devuelve los pesos efectivos: base si no hay aprendizaje, o la mezcla
 * base↔aprendido ponderada por el nº de muestras (crece hasta 100 % de
 * peso aprendido en ~40 capturas registradas).
 */
export function getWeights(mode: FishingModeKey): WeightVector {
  const base = baseWeightsFor(mode);
  const info = learned[mode];
  if (!info) return base;
  const trust = Math.max(0, Math.min(1, info.nSamples / 40));
  const out: WeightVector = {};
  let sum = 0;
  for (const k of Object.keys(base)) {
    const w = base[k] * (1 - trust) + (info.weights[k] ?? base[k]) * trust;
    out[k] = Math.max(0.005, w);
    sum += out[k];
  }
  // Renormaliza a Σ = 1 para que la escala del score no cambie.
  for (const k of Object.keys(out)) out[k] = out[k] / sum;
  return out;
}

/** Suma ponderada segura: ignora factores ausentes y renormaliza. */
export function weightedScore(
  factors: Record<string, number | null | undefined>,
  weights: WeightVector,
): number {
  let sum = 0;
  let total = 0;
  for (const [k, w] of Object.entries(weights)) {
    const v = factors[k];
    if (v == null || !Number.isFinite(v)) continue;
    sum += Math.max(0, Math.min(1, v)) * w;
    total += w;
  }
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, sum / total));
}

