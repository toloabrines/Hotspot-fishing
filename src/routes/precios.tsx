import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useEffect } from "react";
import { FISHING_MODULES } from "@/lib/modules";
import { useSubscriptions } from "@/hooks/use-subscriptions";
import { StripeEmbeddedCheckout } from "@/components/StripeEmbeddedCheckout";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";
import { isPaymentsConfigured } from "@/lib/stripe";
import { AiPacksSection } from "@/components/AiPacksSection";
import { isNativeIos } from "@/lib/native-platform";
import { NativePurchases, PURCHASE_TYPE, type Product } from "@capgo/native-purchases";

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
        content:
          "Módulos de 5 €/mes: altura, fondo, calamar y deriva. Contrata solo los que necesites.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function PricingPage() {
  const navigate = useNavigate();
  const {
    userId,
    hasModule,
    loading,
    refreshStorePurchases: refreshStoreSubscriptions,
  } = useSubscriptions();
  const [checkoutPriceId, setCheckoutPriceId] = useState<string | null>(null);
  const [storeProducts, setStoreProducts] = useState<Record<string, Product>>({});
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeMessage, setStoreMessage] = useState<string | null>(null);
  const [purchasingId, setPurchasingId] = useState<string | null>(null);

  const configured = isPaymentsConfigured();
  const iosNative = isNativeIos();

  useEffect(() => {
    if (!iosNative) return;
    let active = true;
    setStoreLoading(true);
    NativePurchases.getProducts({
      productIdentifiers: FISHING_MODULES.map((mod) => mod.appStoreProductId),
      productType: PURCHASE_TYPE.SUBS,
    })
      .then(({ products }) => {
        if (active)
          setStoreProducts(
            Object.fromEntries(products.map((product) => [product.identifier, product])),
          );
      })
      .catch((error) => {
        console.warn("No se pudieron cargar los precios de App Store", error);
        if (active)
          setStoreMessage(
            "No se pudieron cargar los planes. Comprueba tu conexión e inténtalo de nuevo.",
          );
      })
      .finally(() => {
        if (active) setStoreLoading(false);
      });
    return () => {
      active = false;
    };
  }, [iosNative]);

  const buyModule = async (productIdentifier: string) => {
    if (!userId) {
      navigate({ to: "/auth" });
      return;
    }
    setStoreMessage(null);
    setPurchasingId(productIdentifier);
    try {
      await NativePurchases.purchaseProduct({
        productIdentifier,
        productType: PURCHASE_TYPE.SUBS,
        appAccountToken: userId,
      });
      setStoreMessage("Compra completada. El módulo ya está disponible en tu cuenta.");
      await refreshStoreSubscriptions();
    } catch (error) {
      console.warn("No se pudo completar la compra en App Store", error);
      setStoreMessage("No se ha completado la compra. Si ya la tienes, restaura tus compras.");
    } finally {
      setPurchasingId(null);
    }
  };

  const restorePurchases = async () => {
    setStoreMessage(null);
    setStoreLoading(true);
    try {
      await NativePurchases.restorePurchases();
      await refreshStoreSubscriptions();
      setStoreMessage("Compras restauradas.");
    } catch (error) {
      console.warn("No se pudieron restaurar las compras", error);
      setStoreMessage("No se pudieron restaurar las compras. Inténtalo de nuevo más tarde.");
    } finally {
      setStoreLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      {!iosNative && <PaymentTestModeBanner />}
      <div className="mx-auto max-w-5xl px-4 py-10">
        <header className="text-center">
          <h1 className="text-3xl font-bold text-foreground">Hotspot Fishing</h1>
          {iosNative ? (
            <>
              <p className="mt-3 text-sm text-muted-foreground">
                Elige los módulos que necesitas. Cada suscripción se renueva mensualmente hasta que
                la canceles.
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Puedes cancelar o cambiar tus suscripciones desde los ajustes de tu cuenta de Apple.
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                Cuatro módulos independientes. Contrata solo los que necesites — cada uno 5 €/mes,
                sin permanencia.
              </p>
              <p className="mt-3 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-medium text-primary">
                🎁 Prueba 7 días gratis al crear cuenta · sin tarjeta
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Facturación por TOTYMAR · Hotspot Fishing
              </p>
            </>
          )}
        </header>

        {iosNative ? (
          <>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {FISHING_MODULES.map((mod) => {
                const owned = hasModule(mod.id);
                const product = storeProducts[mod.appStoreProductId];
                return (
                  <article
                    key={mod.id}
                    className="flex flex-col rounded-xl border border-border bg-card p-5 shadow-sm"
                  >
                    <div className="text-2xl">{mod.emoji}</div>
                    <h2 className="mt-2 text-lg font-semibold text-foreground">{mod.name}</h2>
                    <p className="text-xs text-muted-foreground">{mod.tagline}</p>
                    <p className="mt-3 text-2xl font-bold text-foreground">
                      {product?.priceString ?? (storeLoading ? "…" : "No disponible")}
                      {product && (
                        <span className="text-sm font-normal text-muted-foreground">/mes</span>
                      )}
                    </p>
                    <ul className="mt-4 flex-1 space-y-1.5 text-xs text-muted-foreground">
                      {mod.features.map((feature) => (
                        <li key={feature} className="flex gap-2">
                          <span className="text-primary">✓</span>
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      disabled={
                        owned || loading || storeLoading || !product || purchasingId !== null
                      }
                      onClick={() => void buyModule(mod.appStoreProductId)}
                      className="mt-5 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                    >
                      {owned
                        ? "Ya contratado"
                        : purchasingId === mod.appStoreProductId
                          ? "Procesando…"
                          : !userId
                            ? "Crear cuenta para suscribirse"
                            : product
                              ? "Suscribirse"
                              : "No disponible"}
                    </button>
                  </article>
                );
              })}
            </div>
            {storeMessage && (
              <p role="status" className="mt-4 text-center text-sm text-muted-foreground">
                {storeMessage}
              </p>
            )}
            <div className="mt-6 flex flex-wrap justify-center gap-4 text-xs">
              <button
                type="button"
                onClick={() => void restorePurchases()}
                disabled={storeLoading}
                className="text-primary underline"
              >
                Restaurar compras
              </button>
              <button
                type="button"
                onClick={() => void NativePurchases.manageSubscriptions()}
                className="text-primary underline"
              >
                Gestionar suscripciones
              </button>
              <Link to="/privacy" className="text-primary underline">
                Política de privacidad
              </Link>
              <a
                href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                Términos de uso
              </a>
            </div>
          </>
        ) : checkoutPriceId ? (
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
                    {owned
                      ? "Ya contratado"
                      : !userId
                        ? "Crear cuenta y suscribirse"
                        : "Suscribirse por 5 €/mes"}
                  </button>
                </article>
              );
            })}
          </div>
        )}

        {!iosNative && !checkoutPriceId && <AiPacksSection />}

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
