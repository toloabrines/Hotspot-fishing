/**
 * Descarga (proxy) de una hoja MBAR24 desde un enlace público.
 *
 * Permite cargar GeoTIFF grandes en la pantalla /mbar24 sin depender del
 * límite de adjuntos: el navegador pide el fichero a través de este endpoint,
 * que además evita los problemas de CORS del servidor de origen.
 *
 * Solo administración: exige un token válido de sesión y correo de admin.
 * El cuerpo se reenvía en streaming (no se acumula en memoria del servidor).
 */
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

async function assertAdmin(request: Request): Promise<void> {
  const SUPABASE_URL = process.env["SUPABASE_URL"];
  const SUPABASE_PUBLISHABLE_KEY = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Response("Configuración de servidor incompleta", { status: 500 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) throw new Response("No autorizado", { status: 401 });
  const token = auth.slice(7);
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims) throw new Response("Sesión no válida", { status: 401 });
  const { assertInviteAdmin } = await import("@/lib/invites.server");
  try {
    assertInviteAdmin((data.claims as { email?: string }).email);
  } catch {
    throw new Response("Solo administración", { status: 403 });
  }
}

export const Route = createFileRoute("/api/mbar24-download")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          await assertAdmin(request);
        } catch (r) {
          return r instanceof Response ? r : new Response("No autorizado", { status: 401 });
        }

        const raw = new URL(request.url).searchParams.get("url") ?? "";
        let target: URL;
        try {
          target = new URL(raw);
        } catch {
          return new Response("Enlace no válido", { status: 400 });
        }
        if (target.protocol !== "https:" && target.protocol !== "http:") {
          return new Response("Solo se admiten enlaces http(s)", { status: 400 });
        }

        let upstream: Response;
        try {
          upstream = await fetch(target.toString(), {
            redirect: "follow",
            headers: { accept: "*/*" },
          });
        } catch (e) {
          return new Response(
            `No se ha podido descargar el fichero: ${e instanceof Error ? e.message : "error de red"}`,
            { status: 502 },
          );
        }
        if (!upstream.ok || !upstream.body) {
          const body = await upstream.text().catch(() => "");
          return new Response(
            `El servidor de origen respondió ${upstream.status}. ${body.slice(0, 200)}`,
            { status: 502 },
          );
        }

        const headers = new Headers({
          "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        const len = upstream.headers.get("content-length");
        if (len) headers.set("content-length", len);
        const disp = upstream.headers.get("content-disposition");
        if (disp) headers.set("content-disposition", disp);
        return new Response(upstream.body, { status: 200, headers });
      },
    },
  },
});

