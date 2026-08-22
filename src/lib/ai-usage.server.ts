/**
 * Contabilidad de consumo de IA (servidor).
 *
 * - Registra CADA consulta en public.ai_advisor_events (usuario, fecha/hora,
 *   modelo, tokens y coste estimado).
 * - Mantiene el agregado diario en public.ai_advisor_usage (nº de preguntas,
 *   tokens y coste del día).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = SupabaseClient<any, any, any>;

/** Precio estimado por millón de tokens (USD). Solo orientativo. */
export const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  "google/gemini-3.7-flash": { in: 0.3, out: 2.5 },
  "google/gemini-3.1-flash-lite": { in: 0.05, out: 0.4 },
  "google/gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "openai/gpt-5-mini": { in: 0.25, out: 2.0 },
};

const DEFAULT_PRICING = { in: 0.3, out: 2.5 };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const p = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  const cost = (usage.promptTokens / 1e6) * p.in + (usage.completionTokens / 1e6) * p.out;
  return Math.round(cost * 1e6) / 1e6;
}

/** Normaliza el objeto `usage` del AI SDK (los nombres cambian según versión). */
export function readUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const num = (...keys: string[]) => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return 0;
  };
  return {
    promptTokens: num("inputTokens", "promptTokens"),
    completionTokens: num("outputTokens", "completionTokens"),
  };
}

export interface RecordUsageParams {
  userId: string;
  day: string;
  kind: "chat" | "advisor";
  model: string;
  usage: TokenUsage;
  errorMessage?: string | undefined;
  /** Fila agregada del día ya leída (o null si no existe). */
  usageRow: { id: string; request_count: number } | null;
  usedToday: number;
}

export async function recordAiUsage(client: AdminClient, p: RecordUsageParams): Promise<void> {
  const totalTokens = p.usage.promptTokens + p.usage.completionTokens;
  const cost = estimateCostUsd(p.model, p.usage);

  try {
    await client.from("ai_advisor_events").insert({
      user_id: p.userId,
      kind: p.kind,
      model: p.model,
      prompt_tokens: p.usage.promptTokens,
      completion_tokens: p.usage.completionTokens,
      total_tokens: totalTokens,
      cost_usd: cost,
      ok: !p.errorMessage,
      error: p.errorMessage ? p.errorMessage.slice(0, 300) : null,
    });
  } catch {
    /* el registro nunca debe romper la respuesta al usuario */
  }

  try {
    if (p.usageRow) {
      const { data: current } = await client
        .from("ai_advisor_usage")
        .select("prompt_tokens, completion_tokens, total_tokens, cost_usd")
        .eq("id", p.usageRow.id)
        .maybeSingle();
      const c = (current ?? {}) as Record<string, number | string | null>;
      const n = (v: number | string | null | undefined) => Number(v ?? 0) || 0;
      await client
        .from("ai_advisor_usage")
        .update({
          request_count: p.usedToday + 1,
          error_count: p.errorMessage ? 1 : 0,
          last_error: p.errorMessage ? p.errorMessage.slice(0, 300) : null,
          prompt_tokens: n(c['prompt_tokens']) + p.usage.promptTokens,
          completion_tokens: n(c['completion_tokens']) + p.usage.completionTokens,
          total_tokens: n(c['total_tokens']) + totalTokens,
          cost_usd: n(c['cost_usd']) + cost,
          updated_at: new Date().toISOString(),
        })
        .eq("id", p.usageRow.id);
    } else {
      await client.from("ai_advisor_usage").insert({
        user_id: p.userId,
        day: p.day,
        request_count: 1,
        error_count: p.errorMessage ? 1 : 0,
        last_error: p.errorMessage ? p.errorMessage.slice(0, 300) : null,
        prompt_tokens: p.usage.promptTokens,
        completion_tokens: p.usage.completionTokens,
        total_tokens: totalTokens,
        cost_usd: cost,
      });
    }
  } catch {
    /* idem */
  }
}

