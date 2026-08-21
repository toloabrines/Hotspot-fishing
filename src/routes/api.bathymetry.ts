import { createFileRoute } from "@tanstack/react-router";

/**
 * Proxy server-side para consultas batimétricas WMS GetFeatureInfo.
 *
 * Aunque tanto EMODnet como GEBCO devuelven cabeceras CORS correctas en
 * teoría, en la práctica algunos navegadores / extensiones bloquean
 * peticiones a `wms.gebco.net` o cancelan las de EMODnet por mixed content
 * intermitente. Pasar por nuestro Worker garantiza:
 *   - mismo origen para el navegador (sin CORS)
 *   - timeouts controlados (8 s)
 *   - cache HTTP de 1 h (mismas peticiones vuelven al instante)
 *   - logs centralizados si algo falla en producción
 *
 * Acepta `?source=emodnet|gebco&lat=…&lng=…`.
 * Devuelve JSON `{ depth: number|null, source: "emodnet"|"gebco"|"none", raw: string }`.
 */

interface BathyResponse {
  depth: number | null;
  source: "emodnet" | "ncei" | "gebco" | "none";
  raw: string;
  ok: boolean;
}


type AttemptState = "ok" | "fail" | "skipped";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function parseDepth(text: string): number | null {
  if (!text || text.length < 4) return null;
  const lower = text.toLowerCase();
  if (lower.includes("serviceexception")) return null;
  if (lower.includes("layernotdefined")) return null;
  if (lower.includes("no results") || lower.includes("returned no")) return null;
  if (lower.includes("red_band") && lower.includes("green_band")) return null;

  const depthMatch = text.match(/depth\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  if (depthMatch) {
    const v = parseFloat(depthMatch[1]);
    if (!Number.isFinite(v)) return null;
    const depth = Math.abs(v);
    return depth > 0.5 ? depth : null;
  }

  const elevMatch = text.match(
    /(?:elevation|value(?:_list)?|z|height)\s*[:=]\s*'?(-?\d+(?:\.\d+)?)'?/i,
  );
  if (elevMatch) {
    const v = parseFloat(elevMatch[1]);
    if (!Number.isFinite(v)) return null;
    if (v >= 0) return null;
    return -v;
  }

  const matches = text.match(/-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;
  const last = parseFloat(matches[matches.length - 1]);
  if (!Number.isFinite(last)) return null;
  if (last < 0) return -last;
  if (lower.includes("bath") || lower.includes("depth")) {
    return last > 0.5 ? last : null;
  }
  return null;
}

async function queryWms(url: string, timeoutMs: number): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function formatBbox4326(lat: number, lng: number, delta: number): string {
  // WMS 1.3.0 con EPSG:4326 usa orden de ejes lat,lng.
  return `${lat - delta},${lng - delta},${lat + delta},${lng + delta}`;
}

async function queryEmodnet(lat: number, lng: number): Promise<BathyResponse> {
  const d = 0.01;
  const bbox = formatBbox4326(lat, lng, d);
  const url =
    `https://ows.emodnet-bathymetry.eu/wms?` +
    `SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo` +
    `&LAYERS=emodnet:mean&QUERY_LAYERS=emodnet:mean` +
    `&CRS=EPSG:4326&BBOX=${bbox}&WIDTH=11&HEIGHT=11&I=5&J=5` +
    `&INFO_FORMAT=text/plain&FORMAT=image/png`;
  const text = await queryWms(url, 8000);
  if (text == null) return { depth: null, source: "none", raw: "", ok: false };
  const depth = parseDepth(text);
  return {
    depth,
    source: depth != null ? "emodnet" : "none",
    raw: text.slice(0, 400),
    ok: true,
  };
}

/**
 * NOAA NCEI DEM mosaic: agrega levantamientos multihaz y LiDAR costero de
 * altísima resolución allí donde existen; se consulta antes que GEBCO.
 */
async function queryNcei(lat: number, lng: number): Promise<BathyResponse> {
  const geom = encodeURIComponent(
    JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
  );
  const url =
    `https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_mosaics/DEM_all/ImageServer/identify` +
    `?geometry=${geom}&geometryType=esriGeometryPoint&returnGeometry=false&f=json`;
  const text = await queryWms(url, 8000);
  if (text == null) return { depth: null, source: "none", raw: "", ok: false };
  try {
    const json = JSON.parse(text) as { value?: string; properties?: { Values?: string[] } };
    const raw = json.properties?.Values?.[0] ?? json.value;
    const v = raw != null ? parseFloat(raw) : NaN;
    if (!Number.isFinite(v) || v >= 0) return { depth: null, source: "none", raw: "", ok: true };
    return { depth: -v, source: "ncei", raw: String(raw), ok: true };
  } catch {
    return { depth: null, source: "none", raw: "", ok: false };
  }
}

async function queryGebco(lat: number, lng: number): Promise<BathyResponse> {

  const d = 0.02;
  const bbox = formatBbox4326(lat, lng, d);
  const url =
    `https://wms.gebco.net/mapserv?` +
    `SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo` +
    `&LAYERS=GEBCO_LATEST_2&QUERY_LAYERS=GEBCO_LATEST_2` +
    `&CRS=EPSG:4326&BBOX=${bbox}&WIDTH=11&HEIGHT=11&I=5&J=5` +
    `&INFO_FORMAT=text/plain&FORMAT=image/png`;
  const text = await queryWms(url, 8000);
  if (text == null) return { depth: null, source: "none", raw: "", ok: false };
  const depth = parseDepth(text);
  return {
    depth,
    source: depth != null ? "gebco" : "none",
    raw: text.slice(0, 400),
    ok: true,
  };
}

export const Route = createFileRoute("/api/bathymetry")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          const lat = parseFloat(url.searchParams.get("lat") ?? "");
          const lng = parseFloat(url.searchParams.get("lng") ?? "");
          const source = (url.searchParams.get("source") ?? "auto").toLowerCase();
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return new Response(
              JSON.stringify({ depth: null, source: "none", error: "bad-coords" }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          let result: BathyResponse;
          const attempts: { emodnet: AttemptState; ncei: AttemptState; gebco: AttemptState } = {
            emodnet: "skipped",
            ncei: "skipped",
            gebco: "skipped",
          };
          if (source === "emodnet") {
            result = await queryEmodnet(lat, lng);
            attempts.emodnet = result.depth != null ? "ok" : "fail";
          } else if (source === "ncei") {
            result = await queryNcei(lat, lng);
            attempts.ncei = result.depth != null ? "ok" : "fail";
          } else if (source === "gebco") {
            result = await queryGebco(lat, lng);
            attempts.gebco = result.depth != null ? "ok" : "fail";
          } else {
            // auto: mejor resolución disponible → EMODnet, NCEI, GEBCO
            const emo = await queryEmodnet(lat, lng);
            attempts.emodnet = emo.depth != null ? "ok" : "fail";
            if (emo.depth != null) result = emo;
            else {
              const nc = await queryNcei(lat, lng);
              attempts.ncei = nc.depth != null ? "ok" : "fail";
              if (nc.depth != null) result = nc;
              else {
                const geb = await queryGebco(lat, lng);
                attempts.gebco = geb.depth != null ? "ok" : "fail";
                result = geb.depth != null ? geb : emo;
              }
            }
          }


          return new Response(
            JSON.stringify({
              depth: result.depth,
              source: result.source,
              ok: result.ok,
              attempts,
            }),
            {
              status: 200,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=3600",
              },
            },
          );
        } catch (err) {
          return new Response(
            JSON.stringify({ depth: null, source: "none", error: (err as Error).message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});

