import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const ALLOWED_HOSTS = new Set([
  "server.arcgisonline.com",
  "services.arcgisonline.com",
  "wmts.marine.copernicus.eu",
]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const BUCKET = "tile-cache";
// TTL de la caché compartida (en ms). Copernicus publica 1 vez/día por
// producto, así que 24 h es lo correcto. Pasado el TTL, el primer cliente
// que pida ese tile vuelve a descargarlo de upstream y refresca el blob.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Construye una clave estable para un tile upstream.
 * Sólo cacheamos GET de IMAGEN (PNG/JPEG). GetFeatureInfo (JSON) NO se cachea
 * porque se usa para sondas de fecha y necesita siempre datos frescos.
 */
function buildCacheKey(parsed: URL): string | null {
  const host = parsed.hostname;
  // ArcGIS basemaps: /tile/{z}/{y}/{x}
  if (host.endsWith("arcgisonline.com")) {
    const m = parsed.pathname.match(/\/tile\/(\d+)\/(\d+)\/(\d+)/i);
    if (!m) return null;
    return `arcgis/${parsed.pathname.split("/services/")[1]?.split("/MapServer")[0] ?? "basemap"}/${m[1]}/${m[2]}/${m[3]}.jpg`;
  }
  // Copernicus WMTS: leer parámetros relevantes
  if (host === "wmts.marine.copernicus.eu") {
    const sp = parsed.searchParams;
    const req = (sp.get("REQUEST") || sp.get("request") || "").toUpperCase();
    if (req !== "GETTILE") return null; // sólo cacheamos tiles imagen
    const layer = sp.get("LAYER") || sp.get("layer") || "";
    const style = sp.get("STYLE") || sp.get("style") || "";
    const tms = sp.get("TILEMATRIXSET") || sp.get("tilematrixset") || "";
    const z = sp.get("TILEMATRIX") || sp.get("tilematrix") || "";
    const x = sp.get("TILECOL") || sp.get("tilecol") || "";
    const y = sp.get("TILEROW") || sp.get("tilerow") || "";
    const time = sp.get("TIME") || sp.get("time") || "";
    const elevation = sp.get("ELEVATION") || sp.get("elevation") || "";
    const fmt = (sp.get("FORMAT") || "image/png").includes("jpeg") ? "jpg" : "png";
    if (!layer || !z || !x || !y) return null;
    // Sin TIME explícito, Copernicus devuelve "el último disponible" — un
    // valor que cambia cada día. NO cacheamos: bypass al upstream para que
    // el cliente reciba siempre el dato fresco. Si se quiere caché, el
    // caller debe pasar TIME=YYYY-MM-DD explícito.
    if (!time) return null;
    // Sanitizar
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
    const day = safe(time.slice(0, 10));
    const elevPart = elevation ? `e${safe(elevation)}/` : "";
    return `copernicus/${safe(layer)}/${safe(style)}/${safe(tms)}/${day}/${elevPart}${z}/${x}/${y}.${fmt}`;
  }
  return null;
}

async function readFromCache(
  key: string,
): Promise<{ buf: ArrayBuffer; contentType: string } | null> {
  try {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(key);
    if (error || !data) return null;
    // Comprobar antigüedad vía metadata (created_at del object)
    // La API de download no devuelve metadata, así que confiamos en TTL via list.
    const buf = await data.arrayBuffer();
    const contentType = data.type || (key.endsWith(".jpg") ? "image/jpeg" : "image/png");
    return { buf, contentType };
  } catch {
    return null;
  }
}

async function isCacheFresh(key: string): Promise<boolean> {
  try {
    const lastSlash = key.lastIndexOf("/");
    const folder = key.slice(0, lastSlash);
    const file = key.slice(lastSlash + 1);
    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .list(folder, { limit: 1, search: file });
    if (error || !data || data.length === 0) return false;
    const obj = data.find((o) => o.name === file);
    if (!obj?.created_at) return false;
    const ageMs = Date.now() - new Date(obj.created_at).getTime();
    return ageMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

async function writeToCache(key: string, buf: ArrayBuffer, contentType: string): Promise<void> {
  try {
    await supabaseAdmin.storage.from(BUCKET).upload(key, buf, {
      contentType,
      upsert: true,
      cacheControl: "86400",
    });
  } catch {
    // Falló la escritura: no bloquea la respuesta al cliente.
  }
}

function normalizeCopernicusPalette(parsed: URL) {
  if (parsed.hostname !== "wmts.marine.copernicus.eu") return parsed;
  const layer = parsed.searchParams.get("LAYER") || parsed.searchParams.get("layer") || "";
  const style = parsed.searchParams.get("STYLE") || parsed.searchParams.get("style") || "";
  if (!/analysed_sst/i.test(layer) || !/cmap:turbo/i.test(style)) return parsed;

  const normalized = new URL(parsed.toString());
  normalized.searchParams.set("STYLE", style.replace(/cmap:turbo/i, "cmap:jet"));
  return normalized;
}

export const Route = createFileRoute("/api/tile-proxy")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          const target = url.searchParams.get("url");
          if (!target) {
            return new Response("Missing url", { status: 400, headers: corsHeaders });
          }
          let parsed: URL;
          try {
            parsed = new URL(target);
          } catch {
            return new Response("Invalid url", { status: 400, headers: corsHeaders });
          }
          if (!ALLOWED_HOSTS.has(parsed.hostname)) {
            return new Response("Host not allowed", { status: 403, headers: corsHeaders });
          }
          parsed = normalizeCopernicusPalette(parsed);

          const cacheKey = buildCacheKey(parsed);

          // 1) Intentar caché compartida (Supabase Storage) si aplica.
          if (cacheKey) {
            const fresh = await isCacheFresh(cacheKey);
            if (fresh) {
              const cached = await readFromCache(cacheKey);
              if (cached) {
                return new Response(cached.buf, {
                  status: 200,
                  headers: {
                    ...corsHeaders,
                    "Content-Type": cached.contentType,
                    "Cache-Control": "public, max-age=86400, s-maxage=86400, immutable",
                    "X-Tile-Cache": "HIT",
                  },
                });
              }
            }
          }

          // 2) MISS o no cacheable → ir a upstream con reintento corto en 429/503.
          const accept =
            request.headers.get("Accept") ?? "image/png,image/jpeg,image/*,application/json";
          const fetchUpstream = () =>
            fetch(parsed.toString(), {
              headers: {
                Accept: accept.includes("application/json") ? accept : `${accept},application/json`,
              },
            });
          let upstream = await fetchUpstream();
          for (
            let attempt = 0;
            attempt < 2 && (upstream.status === 429 || upstream.status === 503);
            attempt++
          ) {
            const wait = 250 * (attempt + 1) + Math.floor(Math.random() * 200);
            await new Promise((r) => setTimeout(r, wait));
            upstream = await fetchUpstream();
          }
          if (!upstream.ok) {
            // Devolvemos 200 con sentinel para que el cliente trate el fallo
            // como "sin dato" en lugar de disparar el overlay de error 5xx.
            const wantsJson =
              (parsed.searchParams.get("INFOFORMAT") || "").includes("json") ||
              accept.includes("application/json");
            if (wantsJson) {
              return new Response(
                JSON.stringify({ features: [], error: `Upstream ${upstream.status}` }),
                {
                  status: 200,
                  headers: {
                    ...corsHeaders,
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store",
                    "X-Tile-Upstream-Status": String(upstream.status),
                  },
                },
              );
            }
            return new Response(null, {
              status: 204,
              headers: {
                ...corsHeaders,
                "Cache-Control": "no-store",
                "X-Tile-Upstream-Status": String(upstream.status),
              },
            });
          }
          const buf = await upstream.arrayBuffer();
          const contentType = upstream.headers.get("content-type") ?? "image/png";

          // 3) Escribir en caché compartida si aplica (no bloquea la respuesta).
          if (cacheKey && !contentType.includes("application/json")) {
            // fire-and-forget
            void writeToCache(cacheKey, buf.slice(0), contentType);
          }

          const isJson = contentType.includes("application/json");
          const cacheControl = isJson
            ? "public, max-age=900, s-maxage=900"
            : "public, max-age=86400, s-maxage=86400, immutable";
          return new Response(buf, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": contentType,
              "Cache-Control": cacheControl,
              "X-Tile-Cache": cacheKey ? "MISS" : "BYPASS",
            },
          });
        } catch (err) {
          return new Response(JSON.stringify({ features: [], error: (err as Error).message }), {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
              "X-Tile-Proxy-Error": "1",
            },
          });
        }
      },
    },
  },
});

