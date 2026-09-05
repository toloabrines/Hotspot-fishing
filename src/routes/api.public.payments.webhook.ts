import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { type StripeEnv, verifyWebhook } from "@/lib/stripe.server";
import { MODULE_BY_PRICE_ID } from "@/lib/modules";

const HOTSPOT_STRIPE_SCOPE = "hotspot_fishing";

let _supabase: any = null;
function getSupabase(): any {
  if (!_supabase) {
    _supabase = createClient(
      process.env["SUPABASE_URL"]!,
      process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
    );
  }
  return _supabase;
}

function priceKey(item: any): string {
  return (
    item?.price?.lookup_key || item?.price?.metadata?.lovable_external_id || item?.price?.id || ""
  );
}

/**
 * Reconoce exclusivamente suscripciones pertenecientes a Hotspot Fishing.
 * Las nuevas llevan appScope. El precio reconocido mantiene compatibles las
 * suscripciones de Hotspot creadas antes de introducir este aislamiento.
 */
function isHotspotSubscription(subscription: any): boolean {
  if (subscription?.metadata?.appScope === HOTSPOT_STRIPE_SCOPE) return true;
  const item = subscription?.items?.data?.[0];
  return Boolean(MODULE_BY_PRICE_ID[priceKey(item)]);
}

async function upsertSubscription(subscription: any, env: StripeEnv) {
  if (!isHotspotSubscription(subscription)) {
    console.log("Ignoring non-Hotspot subscription event", subscription?.id);
    return;
  }

  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.error("No userId in subscription metadata", subscription.id);
    return;
  }

  const item = subscription.items?.data?.[0];
  const periodStart = item?.current_period_start ?? subscription.current_period_start;
  const periodEnd = item?.current_period_end ?? subscription.current_period_end;

  await getSupabase()
    .from("subscriptions")
    .upsert(
      {
        user_id: userId,
        stripe_subscription_id: subscription.id,
        stripe_customer_id:
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer?.id,
        product_id: typeof item?.price?.product === "string" ? item.price.product : "",
        price_id: priceKey(item),
        status: subscription.status,
        current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
        current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        cancel_at_period_end: subscription.cancel_at_period_end || false,
        environment: env,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "stripe_subscription_id" },
    );
}

async function markCanceled(subscription: any, env: StripeEnv) {
  if (!isHotspotSubscription(subscription)) {
    console.log("Ignoring non-Hotspot cancellation", subscription?.id);
    return;
  }

  await getSupabase()
    .from("subscriptions")
    .update({ status: "canceled", updated_at: new Date().toISOString() })
    .eq("stripe_subscription_id", subscription.id)
    .eq("environment", env);
}

/** Abona los créditos de un paquete de consultas extra (idempotente). */
async function grantAiCredits(session: any, env: StripeEnv) {
  // Un pago único ajeno a Hotspot (por ejemplo una licencia de pesca) jamás
  // debe tocar los créditos ni las tablas de Hotspot.
  if (
    session?.metadata?.appScope !== HOTSPOT_STRIPE_SCOPE ||
    session?.metadata?.paymentPurpose !== "ai_credits"
  ) {
    console.log("Ignoring non-Hotspot one-time payment", session?.id);
    return;
  }

  const userId = session.metadata?.userId;
  const credits = Number(session.metadata?.aiCredits ?? 0);
  if (!userId || !Number.isFinite(credits) || credits <= 0) return;

  const { error } = await getSupabase().rpc("grant_ai_credits", {
    _user_id: userId,
    _session_id: session.id,
    _price_id: session.metadata?.packPriceId ?? "",
    _credits: Math.round(credits),
    _amount_total: session.amount_total ?? null,
    _currency: session.currency ?? null,
    _environment: env,
  });
  if (error) console.error("grant_ai_credits failed", error);
}

async function handleWebhook(req: Request, env: StripeEnv) {
  const event = await verifyWebhook(req, env);

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
      await upsertSubscription(event.data.object, env);
      break;
    case "customer.subscription.deleted":
      await markCanceled(event.data.object, env);
      break;
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode === "payment" && session.payment_status !== "unpaid") {
        await grantAiCredits(session, env);
      }
      break;
    }
    case "checkout.session.async_payment_succeeded":
      await grantAiCredits(event.data.object, env);
      break;
    default:
      console.log("Unhandled event:", event.type);
  }
}

export const Route = createFileRoute("/api/public/payments/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawEnv = new URL(request.url).searchParams.get("env");
        if (rawEnv !== "sandbox" && rawEnv !== "live") {
          console.error("Webhook with invalid env:", rawEnv);
          return Response.json({ received: true, ignored: "invalid env" });
        }
        try {
          await handleWebhook(request, rawEnv);
          return Response.json({ received: true });
        } catch (e) {
          console.error("Webhook error:", e);
          return new Response("Webhook error", { status: 400 });
        }
      },
    },
  },
});
