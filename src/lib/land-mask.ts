/**
 * Máscara de tierra global basada en Natural Earth (ne_10m_land).
 *
 * Por qué existe este módulo:
 *   - GEBCO es batimetría, NO una máscara tierra/mar fiable. En mar abierto
 *     puede devolver elevaciones cercanas a 0 (o positivas por ruido del
 *     servicio WMS) y el motor de hotspots interpretaba eso como "isla",
 *     bloqueando análisis en pleno Mediterráneo.
 *   - Natural Earth 10m_land es la referencia geográfica estándar para
 *     costas mundiales y la usamos también para pintar continentes
 *     (`OceanMask.tsx`). Aquí la reutilizamos para PIP (point-in-polygon).
 *
 * API:
 *   - `getLandMask()` → Promise<LandMask>     (carga + cachea el dataset)
 *   - `mask.isLand(lat, lng)` → boolean       (true si el punto cae en
 *                                              tierra/isla emergida)
 *   - `mask.waterRatio(lat, lng, halfLat, halfLng, n=7)` → 0..1
 *           muestra n×n puntos en la celda y devuelve la fracción que
 *           cae en agua (NO tierra). Permite tolerar celdas costeras
 *           con suficiente mar pescable.
 */

const LAND_GEOJSON_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson";

type Ring = number[][]; // [[lng, lat], ...]
type Polygon = Ring[]; // [outer, hole1, hole2, ...]

interface FeatureBBox {
  bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
  polygons: Polygon[];
}

export interface LandMask {
  /** ¿El punto cae sobre tierra emergida según Natural Earth 10m? */
  isLand(lat: number, lng: number): boolean;
  /**
   * Muestrea n×n puntos uniformemente repartidos dentro de la celda
   * [lat-halfLat, lat+halfLat] × [lng-halfLng, lng+halfLng] y devuelve
   * la fracción que cae en AGUA (0..1).
   *
   * Esto es lo que la app usa para decidir si una celda "borde de costa"
   * tiene suficiente mar para ser analizada (regla: waterRatio > 0.2).
   */
  waterRatio(lat: number, lng: number, halfLat: number, halfLng: number, n?: number): number;
}

let cachedPromise: Promise<LandMask> | null = null;

function bboxOfRing(ring: Ring): [number, number, number, number] {
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

/** Ray-casting clásico sobre un anillo en formato [lng, lat]. */
function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  const n = ring.length;
  if (n < 3) return false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];
    if (yi === yj) continue; // aristas horizontales no cuentan
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Polígono = anillo exterior + huecos. Punto está dentro si entra al
 *  exterior y NO está en ningún hueco. */
function pointInPolygon(lng: number, lat: number, poly: Polygon): boolean {
  if (poly.length === 0) return false;
  if (!pointInRing(lng, lat, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) {
    if (pointInRing(lng, lat, poly[i])) return false;
  }
  return true;
}

async function buildMask(): Promise<LandMask> {
  const res = await fetch(LAND_GEOJSON_URL);
  if (!res.ok) throw new Error(`land geojson HTTP ${res.status}`);
  const data = (await res.json()) as GeoJSON.FeatureCollection;

  // Aplanamos features a una lista de {bbox, polygons}. Cada feature puede
  // ser Polygon o MultiPolygon. El bbox precalculado permite descartar
  // rapidísimo features irrelevantes en cada PIP.
  const features: FeatureBBox[] = [];
  for (const f of data.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    let polygons: Polygon[] = [];
    if (g.type === "Polygon") {
      polygons = [g.coordinates as Polygon];
    } else if (g.type === "MultiPolygon") {
      polygons = g.coordinates as Polygon[];
    } else {
      continue;
    }
    let minLng = Infinity,
      minLat = Infinity,
      maxLng = -Infinity,
      maxLat = -Infinity;
    for (const poly of polygons) {
      if (poly.length === 0) continue;
      const [a, b, c, d] = bboxOfRing(poly[0]);
      if (a < minLng) minLng = a;
      if (b < minLat) minLat = b;
      if (c > maxLng) maxLng = c;
      if (d > maxLat) maxLat = d;
    }
    if (!Number.isFinite(minLng)) continue;
    features.push({ bbox: [minLng, minLat, maxLng, maxLat], polygons });
  }

  const isLand = (lat: number, lng: number): boolean => {
    for (const f of features) {
      const [minLng, minLat, maxLng, maxLat] = f.bbox;
      if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue;
      for (const poly of f.polygons) {
        if (pointInPolygon(lng, lat, poly)) return true;
      }
    }
    return false;
  };

  const waterRatio = (
    lat: number,
    lng: number,
    halfLat: number,
    halfLng: number,
    n = 7,
  ): number => {
    if (n < 1) n = 1;
    let water = 0;
    let total = 0;
    // Muestreo regular n×n. Evitamos los bordes exactos para que las celdas
    // adyacentes no se solapen en sus muestras.
    for (let i = 0; i < n; i++) {
      const fy = (i + 0.5) / n; // 0..1
      const sLat = lat - halfLat + fy * 2 * halfLat;
      for (let j = 0; j < n; j++) {
        const fx = (j + 0.5) / n;
        const sLng = lng - halfLng + fx * 2 * halfLng;
        total++;
        if (!isLand(sLat, sLng)) water++;
      }
    }
    return total === 0 ? 0 : water / total;
  };

  return { isLand, waterRatio };
}

/**
 * Carga (una sola vez) y devuelve la máscara global. Si la primera llamada
 * falla, dejamos que el caller maneje el error y reintente.
 */
export function getLandMask(): Promise<LandMask> {
  if (!cachedPromise) {
    cachedPromise = buildMask().catch((err) => {
      cachedPromise = null; // permite reintentar
      throw err;
    });
  }
  return cachedPromise;
}

