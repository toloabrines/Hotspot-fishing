/**
 * Listado de usuarios registrados (solo administración).
 * Cruza auth.users con la tabla `profiles` para mostrar nombre, embarcación
 * y puerto junto al email y la fecha de alta.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface RegisteredUserRow {
  id: string;
  email: string;
  full_name: string | null;
  boat_name: string | null;
  port: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  provider: string;
  confirmed: boolean;
}

export const listRegisteredUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ users: RegisteredUserRow[] }> => {
    const { assertInviteAdmin } = await import("@/lib/invites.server");
    assertInviteAdmin((context.claims as { email?: string } | null)?.email);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (authErr) throw new Error(authErr.message);
    const users = authData?.users ?? [];

    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, boat_name, port");
    const byId = new Map(
      (profiles ?? []).map((p) => [
        p.id as string,
        p as { full_name: string | null; boat_name: string | null; port: string | null },
      ]),
    );

    return {
      users: users
        .map((u): RegisteredUserRow => {
          const p = byId.get(u.id);
          const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
          const metaName =
            typeof meta['full_name'] === "string"
              ? (meta['full_name'] as string)
              : typeof meta['name'] === "string"
                ? (meta['name'] as string)
                : null;
          return {
            id: u.id,
            email: u.email ?? "—",
            full_name: p?.full_name ?? metaName,
            boat_name: p?.boat_name ?? null,
            port: p?.port ?? null,
            created_at: u.created_at,
            last_sign_in_at: u.last_sign_in_at ?? null,
            provider: (u.app_metadata?.provider as string | undefined) ?? "email",
            confirmed: Boolean(u.email_confirmed_at),
          };
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    };
  });

