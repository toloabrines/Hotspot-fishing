import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createStripeClient } from "@/lib/stripe.server";

type DeleteAccountResult = { ok: true } | { error: string };

export const deleteCurrentAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<DeleteAccountResult> => {
    const { userId } = context;

    try {
      const { data: subscriptions, error: subscriptionsError } = await supabaseAdmin
        .from("subscriptions")
        .select("stripe_subscription_id,environment")
        .eq("user_id", userId);

      if (subscriptionsError) {
        throw new Error(subscriptionsError.message);
      }

      for (const row of subscriptions ?? []) {
        if (!row.stripe_subscription_id) continue;

        try {
          const stripe = createStripeClient(row.environment === "live" ? "live" : "sandbox");
          await stripe.subscriptions.cancel(row.stripe_subscription_id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/No such subscription|resource_missing/i.test(message)) {
            throw new Error(
              "No se pudo cancelar una suscripción activa. La cuenta no se ha eliminado para evitar cobros pendientes.",
            );
          }
        }
      }

      const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (deleteError) throw deleteError;

      return { ok: true };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "No se pudo eliminar la cuenta. Inténtalo de nuevo.",
      };
    }
  });
