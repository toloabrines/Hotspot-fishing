import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getStripeEnvironment, isPaymentsConfigured } from "@/lib/stripe";
import { TRIAL_CODE } from "@/lib/invites.functions";
import {
  FISHING_MODULES,
  MODULES_UNLOCKED,
  isAdminEmail,
  hasFreeAccess,
  hasAnyFreeAccess,
  type ModuleId,
} from "@/lib/modules";

export interface InviteGrantRow {
  id: string;
  code: string;
  modules: string[];
  expires_at: string;
}

export interface SubscriptionRow {
  id: string;
  price_id: string;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

function isActive(row: SubscriptionRow): boolean {
  const future = !row.current_period_end || new Date(row.current_period_end) > new Date();
  if (["active", "trialing", "past_due"].includes(row.status)) return future;
  if (row.status === "canceled") return future;
  return false;
}

/** Acceso por módulo: cada módulo es una suscripción independiente de 5 €/mes. */
export function useSubscriptions() {
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [rows, setRows] = useState<SubscriptionRow[]>([]);
  const [grants, setGrants] = useState<InviteGrantRow[]>([]);
  const [loading, setLoading] = useState(true);

  const trialGrant = grants.find((g) => g.code === TRIAL_CODE);
  const trialExpiresAt = trialGrant?.expires_at ?? null;
  const isTrialActive = !!trialGrant && new Date(trialGrant.expires_at) > new Date();

  const refresh = useCallback(async (uid: string | null) => {
    if (!uid) {
      setRows([]);
      setGrants([]);
      setLoading(false);
      return;
    }
    const { data: grantData } = await supabase
      .from("invite_grants")
      .select("id, code, modules, expires_at")
      .eq("user_id", uid)
      .gt("expires_at", new Date().toISOString());
    setGrants((grantData as InviteGrantRow[] | null) ?? []);
    if (!isPaymentsConfigured()) {
      setRows([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("subscriptions")
      .select("id, price_id, status, current_period_end, cancel_at_period_end")
      .eq("user_id", uid)
      .eq("environment", getStripeEnvironment())
      .order("created_at", { ascending: false });
    setRows((data as SubscriptionRow[] | null) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      const uid = data.session?.user?.id ?? null;
      setUserId(uid);
      setEmail(data.session?.user?.email ?? null);
      void refresh(uid);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      const uid = session?.user?.id ?? null;
      setUserId(uid);
      setEmail(session?.user?.email ?? null);
      void refresh(uid);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [refresh]);

  useEffect(() => {
    if (!userId) return;
    // Nombre único por instancia del hook: varios componentes lo usan a la vez
    // y reutilizar el mismo nombre de canal rompe realtime.
    const channelName = `subs-${userId}-${Math.random().toString(36).slice(2)}`;
    const channel = supabase.channel(channelName);
    channel
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "subscriptions", filter: `user_id=eq.${userId}` },
        () => void refresh(userId),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, refresh]);

  const grantedModules = new Set<string>(grants.flatMap((g) => g.modules));

  const activePriceIds = new Set(rows.filter(isActive).map((r) => r.price_id));

  const hasModule = (id: ModuleId) => {
    if (MODULES_UNLOCKED || isAdminEmail(email) || hasFreeAccess(email, id)) return true;
    if (grantedModules.has(id)) return true;
    const mod = FISHING_MODULES.find((m) => m.id === id);
    return mod ? activePriceIds.has(mod.priceId) : false;
  };

  return {
    userId,
    rows,
    grants,
    loading,
    hasModule,
    isAdmin: isAdminEmail(email),
    isTrialActive,
    trialExpiresAt,
    hasAny:
      activePriceIds.size > 0 ||
      grantedModules.size > 0 ||
      isAdminEmail(email) ||
      hasAnyFreeAccess(email) ||
      isTrialActive,
    refresh: () => refresh(userId),
  };
}

