/**
 * APRENDIZAJE ADAPTATIVO DEL FISHING SCORE
 * ========================================
 *
 * El usuario marca cada punto pescado como "buena captura" o "sin resultado".
 * Guardamos el vector de factores que produjo su puntuación y, con suficientes
 * informes, ajustamos los pesos de cada variable por modalidad mediante una
 * regresión logística regularizada HACIA los pesos base: con pocos datos los
 * pesos apenas se mueven, con muchos datos se separan.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { baseWeightsFor, type FishingModeKey, type WeightVector } from "./scoring-weights";
import { MODES, isMode, trainWeights, type Sample } from "./catch-learning.server";

export interface SaveCatchInput {
  lat: number;
  lng: number;
  mode: FishingModeKey;
  outcome: "good" | "bad";
  scoreSnapshot?: number | null;
  factors: Record<string, number>;
  note?: string | null;
  /** Memoria de resultados reales (datos estructurados y validables). */
  species?: string | null;
  quantity?: number | null;
  depthM?: number | null;
  technique?: string | null;
  bait?: string | null;
  /** "bueno" | "regular" | "malo" */
  quality?: string | null;
  fishedAtIso?: string | null;
  /** Condiciones oceanográficas del momento (viento, corriente, SST…). */
  env?: Record<string, number | string | null>;
}

export const saveCatchReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: SaveCatchInput) => {
    if (!Number.isFinite(input?.lat) || !Number.isFinite(input?.lng)) {
      throw new Error("Coordenadas inválidas");
    }
    if (!isMode(input.mode)) throw new Error("Modalidad inválida");
    if (input.outcome !== "good" && input.outcome !== "bad") {
      throw new Error("Resultado inválido");
    }
    const factors: Record<string, number> = {};
    for (const [k, v] of Object.entries(input.factors ?? {})) {
      if (typeof v === "number" && Number.isFinite(v)) {
        factors[k.slice(0, 40)] = Math.max(0, Math.min(1, v));
      }
    }
    return {
      lat: input.lat,
      lng: input.lng,
      mode: input.mode,
      outcome: input.outcome,
      scoreSnapshot:
        typeof input.scoreSnapshot === "number" && Number.isFinite(input.scoreSnapshot)
          ? input.scoreSnapshot
          : null,
      factors,
      note: typeof input.note === "string" ? input.note.slice(0, 300) : null,
      species: typeof input.species === "string" ? input.species.trim().slice(0, 80) || null : null,
      quantity:
        typeof input.quantity === "number" && Number.isFinite(input.quantity)
          ? Math.max(0, Math.min(10000, Math.round(input.quantity)))
          : null,
      depthM:
        typeof input.depthM === "number" && Number.isFinite(input.depthM)
          ? Math.max(0, Math.min(4000, input.depthM))
          : null,
      technique:
        typeof input.technique === "string" ? input.technique.trim().slice(0, 80) || null : null,
      bait: typeof input.bait === "string" ? input.bait.trim().slice(0, 80) || null : null,
      quality:
        input.quality === "bueno" || input.quality === "regular" || input.quality === "malo"
          ? input.quality
          : null,
      fishedAtIso:
        typeof input.fishedAtIso === "string" && !Number.isNaN(Date.parse(input.fishedAtIso))
          ? input.fishedAtIso
          : null,
      env: (input.env && typeof input.env === "object" ? input.env : {}) as Record<
        string,
        number | string | null
      >,
    };
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("catch_reports").insert({
      user_id: context.userId,
      lat: data.lat,
      lng: data.lng,
      mode: data.mode,
      outcome: data.outcome,
      score_snapshot: data.scoreSnapshot,
      factors_snapshot: data.factors,
      note: data.note,
      species: data.species,
      quantity: data.quantity,
      depth_m: data.depthM,
      technique: data.technique,
      bait: data.bait,
      quality: data.quality,
      env_snapshot: data.env,
      validated: Boolean(data.species || data.quality),
      ...(data.fishedAtIso ? { fished_at: data.fishedAtIso } : {}),
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const recomputeLearnedWeights = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { mode: FishingModeKey }) => {
    if (!isMode(input?.mode)) throw new Error("Modalidad inválida");
    return { mode: input.mode };
  })
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("catch_reports")
      .select("outcome, factors_snapshot")
      .eq("user_id", context.userId)
      .eq("mode", data.mode)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    const base = baseWeightsFor(data.mode);
    const samples: Sample[] = (rows ?? [])
      .map((r) => ({
        x: (r.factors_snapshot ?? {}) as Record<string, number>,
        y: r.outcome === "good" ? 1 : 0,
      }))
      .filter((s) => Object.keys(s.x).length > 0);

    const nGood = samples.filter((s) => s.y === 1).length;
    const nBad = samples.length - nGood;

    // Necesitamos señal en ambas clases: sin negativos no hay nada que aprender.
    if (samples.length < 8 || nGood === 0 || nBad === 0) {
      return {
        mode: data.mode,
        nSamples: samples.length,
        nGood,
        nBad,
        weights: base,
        trained: false,
      };
    }

    const weights = trainWeights(samples, base);

    const { error: upErr } = await context.supabase.from("user_weights").upsert(
      {
        user_id: context.userId,
        mode: data.mode,
        weights,
        n_samples: samples.length,
      },
      { onConflict: "user_id,mode" },
    );
    if (upErr) throw new Error(upErr.message);

    return { mode: data.mode, nSamples: samples.length, nGood, nBad, weights, trained: true };
  });

export const getLearningState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [{ data: weightRows }, { data: reportRows }] = await Promise.all([
      context.supabase
        .from("user_weights")
        .select("mode, weights, n_samples, updated_at")
        .eq("user_id", context.userId),
      context.supabase
        .from("catch_reports")
        .select("mode, outcome")
        .eq("user_id", context.userId)
        .limit(2000),
    ]);

    const counts: Record<string, { good: number; bad: number }> = {};
    for (const m of MODES) counts[m] = { good: 0, bad: 0 };
    for (const r of reportRows ?? []) {
      const c = counts[r.mode as string];
      if (!c) continue;
      if (r.outcome === "good") c.good++;
      else c.bad++;
    }

    return {
      counts,
      learned: (weightRows ?? []).map((r) => ({
        mode: r.mode as FishingModeKey,
        weights: (r.weights ?? {}) as WeightVector,
        nSamples: r.n_samples as number,
        updatedAt: r.updated_at as string,
      })),
      base: Object.fromEntries(MODES.map((m) => [m, baseWeightsFor(m)])) as Record<
        FishingModeKey,
        WeightVector
      >,
    };
  });

export const resetLearnedWeights = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { mode: FishingModeKey }) => {
    if (!isMode(input?.mode)) throw new Error("Modalidad inválida");
    return { mode: input.mode };
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("user_weights")
      .delete()
      .eq("user_id", context.userId)
      .eq("mode", data.mode);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

