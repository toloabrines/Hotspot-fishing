import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface AiUsageUserRow {
  userId: string;
  email: string;
  isAdmin: boolean;
  questionsToday: number;
  questionsMonth: number;
  questionsTotal: number;
  tokensToday: number;
  tokensMonth: number;
  tokensTotal: number;
  costTodayUsd: number;
  costMonthUsd: number;
  costTotalUsd: number;
  lastAt: string | null;
}

export interface AiUsageReport {
  users: AiUsageUserRow[];
  totals: {
    questionsToday: number;
    questionsMonth: number;
    tokensMonth: number;
    costMonthUsd: number;
  };
  dailyLimit: number;
  /** Presupuesto mensual estimado de AI Gateway, en USD. */
  monthlyBudgetUsd: number;
}

/** Presupuesto mensual de AI Gateway (~20 € al cambio aproximado). */
export const AI_MONTHLY_BUDGET_USD = 22;

export const listAiUsage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AiUsageReport> => {
    const { assertInviteAdmin } = await import("@/lib/invites.server");
    assertInviteAdmin((context.claims as { email?: string } | null)?.email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { ADVISOR_DAILY_LIMIT } = await import("./ai-advisor");

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const monthStart = `${today.slice(0, 7)}-01`;

    const { data: events } = await supabaseAdmin
      .from("ai_advisor_events")
      .select("user_id, created_at, prompt_tokens, completion_tokens, total_tokens, cost_usd")
      .order("created_at", { ascending: false })
      .limit(50000);

    const { data: daily } = await supabaseAdmin
      .from("ai_advisor_usage")
      .select("user_id, day, request_count, total_tokens, cost_usd");

    const { data: authData } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const emailById = new Map((authData?.users ?? []).map((u) => [u.id, u.email ?? "—"]));

    const { data: roles } = await supabaseAdmin
      .from("user_roles")
      .select("user_id, role")
      .eq("role", "admin");
    const admins = new Set((roles ?? []).map((r) => r.user_id as string));

    const map = new Map<string, AiUsageUserRow>();
    const row = (id: string): AiUsageUserRow => {
      let r = map.get(id);
      if (!r) {
        r = {
          userId: id,
          email: emailById.get(id) ?? id,
          isAdmin: admins.has(id),
          questionsToday: 0,
          questionsMonth: 0,
          questionsTotal: 0,
          tokensToday: 0,
          tokensMonth: 0,
          tokensTotal: 0,
          costTodayUsd: 0,
          costMonthUsd: 0,
          costTotalUsd: 0,
          lastAt: null,
        };
        map.set(id, r);
      }
      return r;
    };

    const n = (v: unknown) => Number(v ?? 0) || 0;

    // Preguntas por día (fuente fiable, incluye histórico previo al registro por evento)
    for (const d of daily ?? []) {
      const r = row(d.user_id as string);
      const day = String(d.day);
      const count = n(d.request_count);
      r.questionsTotal += count;
      if (day >= monthStart) r.questionsMonth += count;
      if (day === today) r.questionsToday += count;
    }

    // Tokens y coste por evento
    for (const e of events ?? []) {
      const r = row(e.user_id as string);
      const at = String(e.created_at);
      const tokens = n(e.total_tokens) || n(e.prompt_tokens) + n(e.completion_tokens);
      const cost = n(e.cost_usd);
      r.tokensTotal += tokens;
      r.costTotalUsd += cost;
      if (at.slice(0, 10) >= monthStart) {
        r.tokensMonth += tokens;
        r.costMonthUsd += cost;
      }
      if (at.slice(0, 10) === today) {
        r.tokensToday += tokens;
        r.costTodayUsd += cost;
      }
      if (!r.lastAt || at > r.lastAt) r.lastAt = at;
    }

    const users = [...map.values()].sort(
      (a, b) =>
        b.questionsMonth - a.questionsMonth ||
        b.tokensMonth - a.tokensMonth ||
        b.questionsTotal - a.questionsTotal,
    );

    return {
      users,
      totals: {
        questionsToday: users.reduce((s, u) => s + u.questionsToday, 0),
        questionsMonth: users.reduce((s, u) => s + u.questionsMonth, 0),
        tokensMonth: users.reduce((s, u) => s + u.tokensMonth, 0),
        costMonthUsd: users.reduce((s, u) => s + u.costMonthUsd, 0),
      },
      dailyLimit: ADVISOR_DAILY_LIMIT,
      monthlyBudgetUsd: AI_MONTHLY_BUDGET_USD,
    };
  });

