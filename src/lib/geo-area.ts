/**
 * Utilidades de geometría para el selector de zona de búsqueda.
 * Trabajamos en coordenadas lat/lng (grados). El point-in-polygon
 * usa el algoritmo ray-casting clásico, suficiente para zonas
 * pequeñas (<< 1000 km) sin curvatura significativa.
 */

export type LatLng = { lat: number; lng: number };

export type SearchArea =
  | { kind: "rect"; bounds: [LatLng, LatLng] /** [SW, NE] */ }
  | { kind: "polygon"; points: LatLng[] /** ≥3, anillo cerrado o no */ };

/** Convierte un área a un anillo de polígono [lat,lng]. */
export function areaToRing(area: SearchArea): LatLng[] {
  if (area.kind === "rect") {
    const [sw, ne] = area.bounds;
    return [
      { lat: sw.lat, lng: sw.lng },
      { lat: sw.lat, lng: ne.lng },
      { lat: ne.lat, lng: ne.lng },
      { lat: ne.lat, lng: sw.lng },
    ];
  }
  return area.points;
}

/** Bounding box rápido — útil para filtrar antes del PIP. */
export function areaBBox(area: SearchArea): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} {
  const ring = areaToRing(area);
  let minLat = Infinity,
    maxLat = -Infinity,
    minLng = Infinity,
    maxLng = -Infinity;
  for (const p of ring) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Ray-casting point-in-polygon CORREGIDO.
 * El bug anterior añadía `1e-12` al denominador siempre, lo que generaba
 * falsos positivos/negativos cuando una arista era horizontal (yi == yj).
 * Ahora descartamos correctamente las aristas horizontales (no contribuyen
 * a los cruces verticales por construcción del algoritmo).
 */
function pointInRing(lat: number, lng: number, ring: LatLng[]): boolean {
  let inside = false;
  const n = ring.length;
  if (n < 3) return false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i].lng,
      yi = ring[i].lat;
    const xj = ring[j].lng,
      yj = ring[j].lat;
    // Aristas horizontales no cuentan
    if (yi === yj) continue;
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** ¿Está el punto dentro del área? */
export function isPointInArea(lat: number, lng: number, area: SearchArea): boolean {
  if (area.kind === "rect") {
    const [sw, ne] = area.bounds;
    return lat >= sw.lat && lat <= ne.lat && lng >= sw.lng && lng <= ne.lng;
  }
  const bb = areaBBox(area);
  if (lat < bb.minLat || lat > bb.maxLat || lng < bb.minLng || lng > bb.maxLng) {
    return false;
  }
  return pointInRing(lat, lng, area.points);
}

