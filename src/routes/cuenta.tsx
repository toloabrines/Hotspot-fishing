import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useSubscriptions } from "@/hooks/use-subscriptions";
import { FISHING_MODULES } from "@/lib/modules";
import { createPortalSession } from "@/utils/payments.functions";
import { getStripeEnvironment, isPaymentsConfigured } from "@/lib/stripe";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";
import { InviteRedeem } from "@/components/InviteRedeem";
import { InviteAdminPanel } from "@/components/InviteAdminPanel";
import { UsersAdminPanel } from "@/components/UsersAdminPanel";
import { AiUsageAdminPanel } from "@/components/AiUsageAdminPanel";
import { AiPacksSection } from "@/components/AiPacksSection";
import { isNativeIos } from "@/lib/native-platform";
import { deleteCurrentAccount } from "@/utils/account.functions";

export const Route = createFileRoute("/cuenta")({
  component: AccountPage,
  head: () => ({
    meta: [
      { title: "Mi cuenta · Hotspot Fishing" },
      {
        name: "description",
        content: "Gestiona tu cuenta, tus módulos contratados y tu facturación en Hotspot Fishing.",
      },
      { property: "og:title", content: "Mi cuenta · Hotspot Fishing" },
      {
        property: "og:description",
        content: "Gestiona tus suscripciones y facturación de Hotspot Fishing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function fmt(date: string | null) {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function AccountPage() {
  const navigate = useNavigate();
  const { userId, rows, grants, loading, hasModule, isAdmin, isTrialActive, trialExpiresAt, refresh } = useSubscriptions();
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const iosNative = isNativeIos();

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, [userId]);

  const openPortal = async () => {
    setErr(null);
    setBusy(true);
    try {
      const result = await createPortalSession({
        data: {
          returnUrl: `${window.location.origin}/cuenta`,
          environment: getStripeEnvironment(),
        },
      });
      if ("error" in result) throw new Error(result.error);
      window.open(result.url, "_blank", "noopener");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo abrir el portal de facturación");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/", replace: true });
  };

  const deleteAccount = async () => {
    setErr(null);
    setDeleting(true);
    try {
      const result = await deleteCurrentAccount();
      if ("error" in result) throw new Error(result.error);
      await supabase.auth.signOut();
      navigate({ to: "/", replace: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo eliminar la cuenta.");
      setDeleting(false);
    }
  };

  if (!loading && !userId) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-bold text-foreground">Mi cuenta</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Inicia sesión para ver y gestionar tus suscripciones.
          </p>
          <Link
            to="/auth"
            className="mt-5 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            Iniciar sesión
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      {!iosNative && <PaymentTestModeBanner />}
      <div className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-bold text-foreground">Mi cuenta</h1>
        <p className="mt-1 text-xs text-muted-foreground">{email}</p>
        {isTrialActive && trialExpiresAt && (
          <p className="mt-2 inline-flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
            🎁 Periodo de prueba activo hasta el {fmt(trialExpiresAt)} · todos los módulos
          </p>
        )}

        <section className="mt-6 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Módulos</h2>
          {FISHING_MODULES.map((mod) => {
            const row = rows.find((r) => r.price_id === mod.priceId);
            const active = hasModule(mod.id);
            return (
              <div
                key={mod.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {mod.emoji} {mod.name}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {active
                      ? row?.cancel_at_period_end
                        ? `Activo hasta ${fmt(row.current_period_end ?? null)} (cancelación programada)`
                        : `Activo · renueva el ${fmt(row?.current_period_end ?? null)}`
                      : iosNative
                        ? "No contratado"
                        : "No contratado · 5 €/mes"}
                  </p>
                </div>
                {active ? (
                  <span className="rounded-full bg-primary/15 px-2 py-1 text-[10px] font-semibold text-primary">
                    ACTIVO
                  </span>
                ) : iosNative ? (
                  <span className="rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground">
                    NO ACTIVO
                  </span>
                ) : (
                  <Link
                    to="/precios"
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
                  >
                    Suscribirme
                  </Link>
                )}
              </div>
            );
          })}
        </section>

        {!iosNative && <AiPacksSection />}

        <InviteRedeem grants={grants} onRedeemed={refresh} />

        {isAdmin && <InviteAdminPanel />}
        {isAdmin && <UsersAdminPanel />}
        {isAdmin && <AiUsageAdminPanel />}

        {err && (
          <p className="mt-4 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            {err}
          </p>
        )}

        <section className="mt-6 flex flex-wrap gap-3">
          {!iosNative && (
            <button
              type="button"
              onClick={openPortal}
              disabled={busy || !rows.length || !isPaymentsConfigured()}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50"
            >
              {busy ? "Abriendo…" : "Gestionar facturación y cancelaciones"}
            </button>
          )}
          <button
            type="button"
            onClick={signOut}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground hover:bg-secondary"
          >
            Cerrar sesión
          </button>
        </section>

        {!iosNative && (
          <p className="mt-4 text-[11px] text-muted-foreground">
            El portal de facturación se abre en una pestaña nueva. Desde allí puedes cambiar la
            tarjeta, descargar facturas y cancelar cualquier módulo; el acceso se mantiene hasta el
            final del periodo pagado.
          </p>
        )}

        <section className="mt-8 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <h2 className="text-sm font-semibold text-foreground">Eliminar cuenta</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Elimina definitivamente tu cuenta de Hotspot Fishing. Si tienes una suscripción de Stripe
            activa, se cancelará antes de borrar la cuenta para evitar cobros posteriores.
          </p>

          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="mt-3 rounded-md border border-destructive/50 px-3 py-2 text-sm font-medium text-destructive"
            >
              Eliminar cuenta
            </button>
          ) : (
            <div className="mt-3 rounded-md border border-destructive/40 bg-background p-3">
              <p className="text-xs font-medium text-foreground">
                Esta acción es definitiva y no se puede deshacer.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={deleteAccount}
                  disabled={deleting}
                  className="rounded-md bg-destructive px-3 py-2 text-sm font-semibold text-destructive-foreground disabled:opacity-50"
                >
                  {deleting ? "Eliminando…" : "Sí, eliminar definitivamente"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                  className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground disabled:opacity-50"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </section>

        <div className="mt-8 flex gap-4 text-[11px] text-muted-foreground">
          <Link to="/" className="hover:text-foreground">
            ← Volver al mapa
          </Link>
          {!iosNative && (
            <Link to="/precios" className="hover:text-foreground">
              Ver planes
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
