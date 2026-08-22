import { createFileRoute } from "@tanstack/react-router";

const MAX_GEOJSON_BYTES = 50 * 1024 * 1024;

function sanitizeFilename(value: string): string {
  const clean = value
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
  if (!clean || !clean.toLowerCase().endsWith(".geojson")) return "fsle.geojson";
  return clean;
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function isCleanFeatureCollection(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const fc = value as { type?: unknown; features?: unknown };
  if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) return false;
  return fc.features.every((feature) => {
    if (!feature || typeof feature !== "object") return false;
    const f = feature as { type?: unknown; geometry?: { type?: unknown; coordinates?: unknown } };
    return f.type === "Feature" && f.geometry?.type === "LineString" && Array.isArray(f.geometry.coordinates);
  });
}

export const Route = createFileRoute("/api/public/fsle-geojson-download")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = new URL(request.url).searchParams.get("token") ?? "";
        if (!/^[a-f0-9]{36}$/.test(token)) {
          return new Response("Enlace GeoJSON no válido", { status: 400 });
        }

        const { supabaseAdmin } = await import("../integrations/supabase/client.server");

        const { data, error } = await supabaseAdmin
          .from("fsle_exports")
          .select("filename, content, created_at")
          .eq("token", token)
          .maybeSingle();
        if (error || !data) return new Response("GeoJSON no encontrado", { status: 404 });

        const ageMs = Date.now() - new Date(data.created_at).getTime();
        if (ageMs > 24 * 60 * 60 * 1000) {
          return new Response("Enlace GeoJSON caducado", { status: 410 });
        }

        return new Response(data.content, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": contentDisposition(sanitizeFilename(data.filename)),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
      POST: async ({ request }) => {
        const form = await request.formData();
        const filename = sanitizeFilename(String(form.get("filename") ?? "fsle.geojson"));
        const content = String(form.get("content") ?? "");
        const bytes = new TextEncoder().encode(content).byteLength;

        if (!content || bytes > MAX_GEOJSON_BYTES) {
          return new Response("GeoJSON vacío o demasiado grande", { status: 400 });
        }

        try {
          const parsed = JSON.parse(content) as unknown;
          if (!isCleanFeatureCollection(parsed)) {
            return new Response("GeoJSON FSLE no válido", { status: 400 });
          }
        } catch {
          return new Response("JSON no válido", { status: 400 });
        }

        return new Response(content, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": contentDisposition(filename),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
