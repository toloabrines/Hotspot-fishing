/**
 * Helpers del aprendizaje adaptativo.
 *
 * Viven fuera de `catch-learning.functions.ts` porque el splitter de server
 * functions elimina los "hermanos" del handler y provocaría ReferenceError.
 */

import { type FishingModeKey, type WeightVector } from "./scoring-weights";

export const MODES: FishingModeKey[] = ["bottom", "squid", "surface"];

export function isMode(v: unknown): v is FishingModeKey {
  return typeof v === "string" && (MODES as string[]).includes(v);
}

export interface Sample {
  x: Record<string, number>;
  y: number;
}

/**
 * Regresión logística con regularización hacia los pesos base.
 * Devuelve pesos positivos normalizados a Σ = 1.
 */
export function trainWeights(
  samples: Sample[],
  base: WeightVector,
  opts: { epochs?: number; lr?: number; lambda?: number } = {},
): WeightVector {
  const keys = Object.keys(base);
  const epochs = opts.epochs ?? 400;
  const lr = opts.lr ?? 0.25;
  const lambda = opts.lambda ?? 0.6;

  const w: Record<string, number> = {};
  for (const k of keys) w[k] = base[k] * 4;
  let b = 0;

  for (let e = 0; e < epochs; e++) {
    const grad: Record<string, number> = {};
    for (const k of keys) grad[k] = 0;
    let gb = 0;
    for (const s of samples) {
      let z = b;
      for (const k of keys) z += w[k] * (s.x[k] ?? 0);
      const p = 1 / (1 + Math.exp(-z));
      const err = p - s.y;
      for (const k of keys) grad[k] += err * (s.x[k] ?? 0);
      gb += err;
    }
    const n = Math.max(1, samples.length);
    for (const k of keys) {
      const pull = lambda * (w[k] - base[k] * 4);
      w[k] -= lr * (grad[k] / n + pull / n);
    }
    b -= lr * (gb / n);
  }

  const out: WeightVector = {};
  let sum = 0;
  for (const k of keys) {
    const v = Math.max(0.02, w[k]);
    out[k] = v;
    sum += v;
  }
  for (const k of keys) out[k] = out[k] / sum;
  return out;
}

