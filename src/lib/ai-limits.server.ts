/**
 * Límite diario de consultas de IA (servidor).
 *
 * - Usuarios normales: ADVISOR_DAILY_LIMIT consultas al día (contador en BD).
 * - Administradores (rol `admin` en public.user_roles): sin límite.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = SupabaseClient<any, any, any>;

export async function isUnlimitedUser(client: AdminClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

