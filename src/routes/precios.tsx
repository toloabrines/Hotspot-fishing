import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { FISHING_MODULES } from "@/lib/modules";
import { useSubscriptions } from "@/hooks/use-subscriptions";
import { StripeEmbeddedCheckout } from "@/components/StripeEmbeddedCheckout";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";
import { isPaymentsConfigured } from "@/lib/stripe";
import { AiPacksSection } from "@/components/AiPacksSection";

export const Route = createFileRoute("/precios")({
  component: PricingPage,
  head: () => ({
    meta: [
      { title: "Precios · Hotspot Fishing" },
      {
        name: "description",
        content:
          "Cuatro módulos independientes de 5 €/mes: pesca de altura, pesca de fondo, calamar y pesca a la deriva. Contrata solo lo que necesites.",
      },
      { property: "og:title", content: "Precios · Hotspot Fishing" },
      {
        property: "og:description",
        content: "Módulos de 5 €/mes: altura, fondo, calamar y deriva. Contrata solo los que necesites.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function PricingPage() {
  const navigate = useNavigate();
  const { userId, hasModule, loading } = useSubscriptions();
  const [checkoutPriceId, setCheckoutPriceId] = useState<string | null>(null);

  const configured = isPaymentsConfigured();

  return (
    <main className="min-h-screen bg-background">
      <PaymentTestModeBanner />
      <div className="mx-auto max-w-5xl px-4 py-10">
        <header className="text-center">
          <h1 className="text-3xl font-bold text-foreground">Hotspot Fishing</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Cuatro módulos independientes. Contrata solo los que necesites — cada uno 5 €/mes, sin
            permanencia.
          </p>
          <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-medium text-primary">
            🎁 Prueba 7 días gratis al crear cuenta · sin tarjeta
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Facturación por TOTYMAR · Hotspot Fishing
          </p>
        </header>

        {checkoutPriceId ? (
          <section className="mt-8 rounded-xl border border-border bg-card p-4">
            <button
              type="button"
              onClick={() => setCheckoutPriceId(null)}
              className="mb-3 text-[11px] text-muted-foreground hover:text-foreground"
            >
              ← Volver a los planes
            </button>
            <StripeEmbeddedCheckout priceId={checkoutPriceId} />
          </section>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FISHING_MODULES.map((mod) => {
              const owned = hasModule(mod.id);
              return (
                <article
                  key={mod.id}
                  className="flex flex-col rounded-xl border border-border bg-card p-5 shadow-sm"
                >
                  <div className="text-2xl">{mod.emoji}</div>
                  <h2 className="mt-2 text-lg font-semibold text-foreground">{mod.name}</h2>
                  <p className="text-xs text-muted-foreground">{mod.tagline}</p>
                  <p className="mt-3 text-2xl font-bold text-foreground">
                    5 €<span className="text-sm font-normal text-muted-foreground">/mes</span>
                  </p>
                  <ul className="mt-4 flex-1 space-y-1.5 text-xs text-muted-foreground">
                    {mod.features.map((f) => (
                      <li key={f} className="flex gap-2">
                        <span className="text-primary">✓</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    disabled={owned || loading || !configured}
                    onClick={() => {
                      if (!userId) {
                        navigate({ to: "/auth" });
                        return;
                      }
                      setCheckoutPriceId(mod.priceId);
                    }}
                    className="mt-5 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    {owned ? "Ya contratado" : !userId ? "Crear cuenta y suscribirse" : "Suscribirse por 5 €/mes"}
                  </button>
                </article>
              );
            })}
          </div>
        )}

        {!checkoutPriceId && <AiPacksSection />}



        <div className="mt-8 flex justify-center gap-4 text-[11px] text-muted-foreground">
          <Link to="/" className="hover:text-foreground">
            ← Volver al mapa
          </Link>
          <Link to="/cuenta" className="hover:text-foreground">
            Mi cuenta
          </Link>
          <Link to="/privacy" className="hover:text-foreground">
            Privacidad
          </Link>
        </div>
      </div>
    </main>
  );
}

