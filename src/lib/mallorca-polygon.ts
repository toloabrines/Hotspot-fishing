/**
 * Loader compartido del polígono de alta resolución de Mallorca (OSM/Nominatim).
 * Cachea en memoria y en localStorage. Se usa tanto para el contorno costero
 * visible como para el clip de las capas oceanográficas.
 */

const NOMINATIM_URL =
  "https://nominatim.openstreetmap.org/search?q=Mallorca&polygon_geojson=1&format=json&limit=1";
const CACHE_KEY = "hr-mallorca-coast-v1";

let cached: GeoJSON.Geometry | null = null;
let inflight: Promise<GeoJSON.Geometry | null> | null = null;

export async function loadMallorcaPolygon(): Promise<GeoJSON.Geometry | null> {
  if (cached) return cached;
  if (inflight) return inflight;

  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(CACHE_KEY);
      if (raw) {
        cached = JSON.parse(raw) as GeoJSON.Geometry;
        return cached;
      }
    } catch {
      /* ignore */
    }
  }

  inflight = fetch(NOMINATIM_URL, { headers: { "Accept-Language": "es,en" } })
    .then((r) => r.json())
    .then((arr) => {
      const geo =
        Array.isArray(arr) && arr[0]?.geojson ? (arr[0].geojson as GeoJSON.Geometry) : null;
      if (geo && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(CACHE_KEY, JSON.stringify(geo));
        } catch {
          /* quota */
        }
      }
      cached = geo;
      return geo;
    })
    .catch((err) => {
      console.warn("loadMallorcaPolygon: failed", err);
      return null;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Devuelve los anillos como array de [lng,lat][] (uno o varios para MultiPolygon). */
export function getMallorcaRings(geo: GeoJSON.Geometry): number[][][] {
  const rings: number[][][] = [];
  if (geo.type === "Polygon") {
    for (const ring of geo.coordinates) rings.push(ring as number[][]);
  } else if (geo.type === "MultiPolygon") {
    for (const poly of geo.coordinates) {
      for (const ring of poly) rings.push(ring as number[][]);
    }
  }
  return rings;
}

