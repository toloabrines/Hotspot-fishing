/**
 * CÓDIGOS DE INVITADO + TRIAL AUTOMÁTICO
 * =======================================
 * Un administrador genera códigos con módulos incluidos y duración en días.
 * Cualquier usuario registrado puede canjear un código y obtiene acceso
 * temporal (invite_grants) sin pasar por Stripe.
 *
 * Además, cada nuevo usuario recibe automáticamente un trial de 7 días
 * (code='TRIAL') con acceso a todos los módulos. Solo se crea una vez.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ModuleId } from "@/lib/modules";

export const TRIAL_DAYS = 7;
export const TRIAL_CODE = "TRIAL";
export const TRIAL_MODULES: ModuleId[] = ["superficie", "fondo", "calamar", "deriva"];

export interface CreateInviteInput {
  modules: ModuleId[];
  days: number;
  maxUses: number;
  note?: string | null;
  codeValidDays?: number | null;
}

export const createInviteCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CreateInviteInput) => {
    const validModules: ModuleId[] = ["superficie", "fondo", "calamar", "deriva"];
    const modules = (input?.modules ?? []).filter((m): m is ModuleId =>
      validModules.includes(m as ModuleId),
    );
    if (!modules.length) throw new Error("Selecciona al menos un módulo");
    const days = Math.max(1, Math.min(365, Math.round(Number(input?.days) || 30)));
    const maxUses = Math.max(1, Math.min(500, Math.round(Number(input?.maxUses) || 1)));
    const codeValidDays =
      input?.codeValidDays == null
        ? null
        : Math.max(1, Math.min(365, Math.round(Number(input.codeValidDays))));
    return {
      modules,
      days,
      maxUses,
      codeValidDays,
      note: typeof input?.note === "string" ? input.note.slice(0, 120) : null,
    };
  })
  .handler(async ({ data, context }) => {
    const { assertInviteAdmin, randomInviteCode } = await import("@/lib/invites.server");
    assertInviteAdmin((context.claims as { email?: string } | null)?.email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const code = randomInviteCode();
    const expiresAt = data.codeValidDays
      ? new Date(Date.now() + data.codeValidDays * 86400000).toISOString()
      : null;
    const { error } = await supabaseAdmin.from("invite_codes").insert({
      code,
      modules: data.modules,
      days: data.days,
      max_uses: data.maxUses,
      expires_at: expiresAt,
      note: data.note,
      created_by: context.userId,
    });
    if (error) throw new Error(error.message);
    return { code };
  });

export interface InviteCodeRow {
  code: string;
  modules: string[];
  days: number;
  max_uses: number;
  uses: number;
  expires_at: string | null;
  note: string | null;
  created_at: string;
}

export const listInviteCodes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assertInviteAdmin } = await import("@/lib/invites.server");
    assertInviteAdmin((context.claims as { email?: string } | null)?.email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("invite_codes")
      .select("code, modules, days, max_uses, uses, expires_at, note, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return { codes: (data ?? []) as InviteCodeRow[] };
  });

export interface InviteRedemptionRow {
  id: string;
  code: string;
  modules: string[];
  expires_at: string;
  created_at: string;
  email: string;
  /** Estado del acceso otorgado por el canje. */
  grant_status: "activa" | "caducada";
  /** Qué hizo el canje respecto a la suscripción de pago del usuario. */
  effect: "activo_acceso" | "amplio_acceso";
  /** Estado actual de la suscripción de pago, si existe. */
  subscription_status: string | null;
}

/** Historial de canjes: quién usó cada código, cuándo y en qué estado está. */
export const listInviteRedemptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assertInviteAdmin } = await import("@/lib/invites.server");
    assertInviteAdmin((context.claims as { email?: string } | null)?.email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("invite_grants")
      .select("id, user_id, code, modules, expires_at, created_at")
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    const emails = new Map<string, string>();
    if (rows.length) {
      const { data: users } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      for (const u of users?.users ?? []) emails.set(u.id, u.email ?? "—");
    }

    // Suscripción de pago más reciente por usuario (para saber si el canje
    // dio acceso nuevo o solo amplió uno ya pagado).
    const subs = new Map<string, { status: string; created_at: string | null }>();
    if (rows.length) {
      const userIds = [...new Set(rows.map((r) => r.user_id))];
      const { data: subRows } = await supabaseAdmin
        .from("subscriptions")
        .select("user_id, status, created_at")
        .in("user_id", userIds)
        .order("created_at", { ascending: false });
      for (const s of subRows ?? []) {
        if (!subs.has(s.user_id)) subs.set(s.user_id, { status: s.status, created_at: s.created_at });
      }
    }

    const now = Date.now();
    return {
      redemptions: rows.map((r) => {
        const sub = subs.get(r.user_id) ?? null;
        const paidActive = sub
          ? ["active", "trialing", "past_due"].includes(sub.status)
          : false;
        return {
          id: r.id,
          code: r.code,
          modules: r.modules as string[],
          expires_at: r.expires_at,
          created_at: r.created_at,
          email: emails.get(r.user_id) ?? "usuario desconocido",
          grant_status: new Date(r.expires_at).getTime() > now ? "activa" : "caducada",
          effect: paidActive ? "amplio_acceso" : "activo_acceso",
          subscription_status: sub?.status ?? null,
        };
      }) as InviteRedemptionRow[],
    };
  });


export const revokeInviteCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { code: string }) => ({ code: String(input?.code ?? "").slice(0, 40) }))
  .handler(async ({ data, context }) => {
    const { assertInviteAdmin } = await import("@/lib/invites.server");
    assertInviteAdmin((context.claims as { email?: string } | null)?.email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("invite_codes").delete().eq("code", data.code);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const redeemInviteCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { code: string }) => {
    const code = String(input?.code ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 40);
    if (code.length < 4) throw new Error("Código inválido");
    return { code };
  })
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("invite_codes")
      .select("code, modules, days, max_uses, uses, expires_at")
      .eq("code", data.code)
      .maybeSingle();
    if (!row) throw new Error("Ese código no existe");
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      throw new Error("Ese código ha caducado");
    }
    if (row.uses >= row.max_uses) throw new Error("Ese código ya se ha agotado");

    const { data: existing } = await supabaseAdmin
      .from("invite_grants")
      .select("id")
      .eq("user_id", context.userId)
      .eq("code", row.code)
      .maybeSingle();
    if (existing) throw new Error("Ya has canjeado este código");

    const expiresAt = new Date(Date.now() + row.days * 86400000).toISOString();
    const { error: gErr } = await supabaseAdmin.from("invite_grants").insert({
      user_id: context.userId,
      code: row.code,
      modules: row.modules,
      expires_at: expiresAt,
    });
    if (gErr) throw new Error(gErr.message);

    await supabaseAdmin
      .from("invite_codes")
      .update({ uses: row.uses + 1 })
      .eq("code", row.code);

    return { modules: row.modules as ModuleId[], expiresAt };
  });

/**
 * Asegura que un usuario NUEVO tenga el trial de 7 días creado.
 * Solo se crea una vez y solo si el usuario se registró en las últimas 24 h.
 */
export const ensureTrialGrant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existing } = await supabaseAdmin
      .from("invite_grants")
      .select("id, expires_at")
      .eq("user_id", context.userId)
      .eq("code", TRIAL_CODE)
      .maybeSingle();

    if (existing) {
      return { created: false, expiresAt: existing.expires_at };
    }

    const { data: user, error: userError } = await supabaseAdmin.auth.admin.getUserById(
      context.userId,
    );
    if (userError || !user?.user?.created_at) {
      return { created: false, expiresAt: null };
    }

    const createdAt = new Date(user.user.created_at).getTime();
    const hoursSinceSignup = (Date.now() - createdAt) / 3600000;
    if (hoursSinceSignup > 24) {
      return { created: false, expiresAt: null, reason: "user_not_new" };
    }

    const expiresAt = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();
    const { error } = await supabaseAdmin.from("invite_grants").insert({
      user_id: context.userId,
      code: TRIAL_CODE,
      modules: TRIAL_MODULES,
      expires_at: expiresAt,
    });

    if (error) throw new Error(error.message);
    return { created: true, expiresAt };
  });

