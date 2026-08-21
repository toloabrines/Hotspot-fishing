import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AI_PACKS } from "@/lib/ai-packs";
import { isPaymentsConfigured } from "@/lib/stripe";
import { StripeEmbeddedCheckout } from "@/components/StripeEmbeddedCheckout";

interface Props {
  /** Si es false, sólo se muestra el saldo (sin poder comprar). */
  canBuy?: boolean;
}

/** Paquetes de consultas extra de IA (pago único, no caducan). */
export function AiPacksSection({ canBuy = true }: Props) {
  const [balance, setBalance] = useState<number | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [priceId, setPriceId] = useState<string | null>(null);

  const load = useCallback(async (uid: string | null) => {
    if (!uid) {
      setBalance(null);
      return;
    }
    const { data } = await supabase
      .from("ai_credits")
      .select("balance")
      .eq("user_id", uid)
      .maybeSingle();
    setBalance(Number(data?.balance ?? 0) || 0);
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      const uid = data.session?.user?.id ?? null;
      setUserId(uid);
      void load(uid);
    });
    return () => {
      alive = false;
    };
  }, [load]);

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`ai-credits-${userId}-${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ai_credits", filter: `user_id=eq.${userId}` },
        () => void load(userId),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, load]);

  const configured = isPaymentsConfigured();

  return (
    <section id="packs-ia" className="mt-8">
      <h2 className="text-sm font-semibold text-foreground">Consultas extra de IA</h2>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Cada día tienes 5 consultas gratuitas al asistente. Si las agotas, puedes seguir con un
        paquete de consultas extra: pago único, sin suscripción y sin caducidad.
      </p>
      {balance != null && (
        <p className="mt-2 inline-flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
          ⚡ Saldo actual: {balance} {balance === 1 ? "consulta extra" : "consultas extra"}
        </p>
      )}

      {priceId ? (
        <div className="mt-4 rounded-xl border border-border bg-card p-4">
          <button
            type="button"
            onClick={() => setPriceId(null)}
            className="mb-3 text-[11px] text-muted-foreground hover:text-foreground"
          >
            ← Volver a los paquetes
          </button>
          <StripeEmbeddedCheckout priceId={priceId} />
        </div>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {AI_PACKS.map((pack) => (
            <article
              key={pack.priceId}
              className="flex flex-col rounded-xl border border-border bg-card p-4"
            >
              <div className="text-xl">{pack.emoji}</div>
              <h3 className="mt-1 text-sm font-semibold text-foreground">{pack.name}</h3>
              <p className="text-[11px] text-muted-foreground">{pack.hint}</p>
              <p className="mt-3 text-lg font-bold text-foreground">{pack.priceLabel}</p>
              <button
                type="button"
                disabled={!canBuy || !userId || !configured}
                onClick={() => setPriceId(pack.priceId)}
                className="mt-3 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {!userId ? "Inicia sesión" : "Comprar"}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

