import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const MAX_BYTES = 50 * 1024 * 1024;

const inputSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{36}$/),
  filename: z.string().min(1).max(200),
  content: z.string().min(2),
  lineCount: z.number().int().nonnegative().default(0),
});

export const saveFsleExport = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }) => {
    const bytes = new TextEncoder().encode(data.content).byteLength;
    if (bytes > MAX_BYTES) {
      throw new Response("GeoJSON demasiado grande", { status: 413 });
    }
    try {
      const parsed = JSON.parse(data.content) as { type?: unknown; features?: unknown };
      if (parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
        throw new Response("GeoJSON FSLE no válido", { status: 400 });
      }
    } catch {
      throw new Response("JSON no válido", { status: 400 });
    }

    const { supabaseAdmin } = await import("../integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("fsle_exports").upsert(
      {
        token: data.token,
        filename: data.filename,
        content: data.content,
        line_count: data.lineCount,
      },
      { onConflict: "token" },
    );
    if (error) {
      throw new Response(`No se pudo guardar: ${error.message}`, { status: 500 });
    }
    return { ok: true as const, token: data.token };
  });

