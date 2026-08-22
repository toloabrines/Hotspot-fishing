/**
 * Créditos extra de IA (servidor).
 *
 * Se consumen únicamente cuando el usuario ya ha agotado su cupo diario
 * gratuito. El descuento es atómico (función SQL `consume_ai_credit`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = SupabaseClient<any, any, any>;

/** Saldo actual de consultas extra compradas. */
export async function getAiCreditBalance(
  client: AdminClient,
  userId: string,
): Promise<number> {
  try {
    const { data } = await client
      .from("ai_credits")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle();
    return Number(data?.balance ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * Descuenta un crédito. Devuelve el saldo restante, o null si no había saldo
 * (en ese caso el usuario está realmente sin consultas).
 */
export async function consumeAiCredit(
  client: AdminClient,
  userId: string,
): Promise<number | null> {
  try {
    const { data, error } = await client.rpc("consume_ai_credit", { _user_id: userId });
    if (error) return null;
    return typeof data === "number" ? data : null;
  } catch {
    return null;
  }
}

