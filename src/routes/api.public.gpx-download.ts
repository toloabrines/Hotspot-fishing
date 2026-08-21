import { createFileRoute } from "@tanstack/react-router";

const ALLOWED_MIME = new Set([
  "application/gpx+xml",
  "application/geo+json",
  "application/json",
  "application/vnd.google-earth.kml+xml",
  "application/xml",
  "text/plain",
  "text/xml",
]);

const MAX_EXPORT_BYTES = 50 * 1024 * 1024;

function sanitizeFilename(value: string): string {
  const fallback = "totymar-export.gpx";
  const clean = value
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return clean.includes(".") ? clean : fallback;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) =>
    char === "&"
      ? "&amp;"
      : char === "<"
        ? "&lt;"
        : char === ">"
          ? "&gt;"
          : char === '"'
            ? "&quot;"
            : "&#39;",
  );
}

export const Route = createFileRoute("/api/public/gpx-download")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData();
        const filename = sanitizeFilename(String(form.get("filename") ?? "totymar-export.gpx"));
        const requestedMime = String(form.get("mime") ?? "application/gpx+xml");
        const mime = ALLOWED_MIME.has(requestedMime) ? requestedMime : "application/gpx+xml";
        const content = String(form.get("content") ?? "");

        const bytes = new TextEncoder().encode(content).byteLength;
        if (!content || bytes > MAX_EXPORT_BYTES) {
          return new Response("Archivo vacío o demasiado grande", { status: 400 });
        }

        return new Response(content, {
          status: 200,
          headers: {
            "Content-Type": `${mime}; charset=utf-8`,
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
      GET: async () =>
        new Response(
          `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Exportar GPX</title></head><body><main><h1>Exportar GPX</h1><p>${escapeHtml("Vuelve a la app y pulsa GPX para generar el archivo.")}</p></main></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
        ),
    },
  },
});

