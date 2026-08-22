/**
 * PROXIMIDAD A LÍNEAS FSLE (LCS)
 * ==============================
 *
 * El endpoint `/api/public/fsle` ya calcula las crestas de Finite-Size
 * Lyapunov Exponents (estructuras lagrangianas coherentes). Hasta ahora solo
 * se pintaban; aquí las convertimos en un FACTOR del Fishing Score.
 *
 * Para cada celda calculamos la distancia a la línea LCS más cercana y su
 * intensidad → `fsleProximity` ∈ 0..1. Un punto sobre un frente atractor
 * fuerte vale 1; a más de ~6 millas de cualquier línea vale 0.
 */

const TILE_DEG = 2;

export interface FsleSegment {
  aLat: number;
  aLng: number;
  bLat: number;
  bLng: number;
  intensity: number; // 0..1 normalizado
}

export interface FsleField {
  segments: FsleSegment[];
  /** 0..1 — cercanía ponderada por intensidad. */
  proximity(lat: number, lng: number): number;
  /** Distancia en millas náuticas a la línea más cercana (null si no hay). */
  distanceNm(lat: number, lng: number): number | null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Distancia punto-segmento en grados equivalentes corregidos por latitud. */
function pointSegmentKm(
  lat: number,
  lng: number,
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  const px = (lng - aLng) * kx;
  const py = (lat - aLat) * ky;
  const vx = (bLng - aLng) * kx;
  const vy = (bLat - aLat) * ky;
  const len2 = vx * vx + vy * vy;
  if (len2 <= 1e-9) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * vx + py * vy) / len2));
  return Math.hypot(px - t * vx, py - t * vy);
}

interface FsleFeatureCollection {
  features?: Array<{
    geometry?: { type?: string; coordinates?: number[][] };
    properties?: { fsle?: number };
  }>;
}

/** Descarga las teselas FSLE (2°×2°) que cubren el área y construye el campo. */
export async function buildFsleField(args: {
  south: number;
  west: number;
  north: number;
  east: number;
  date: string;
  signal?: AbortSignal;
  maxTiles?: number;
}): Promise<FsleField> {
  const { south, west, north, east, date, signal } = args;
  const maxTiles = args.maxTiles ?? 6;

  const tiles: { tileSouth: number; tileWest: number }[] = [];
  const s0 = Math.floor(south / TILE_DEG) * TILE_DEG;
  const w0 = Math.floor(west / TILE_DEG) * TILE_DEG;
  for (let s = s0; s < north; s += TILE_DEG) {
    for (let w = w0; w < east; w += TILE_DEG) {
      tiles.push({ tileSouth: s, tileWest: w });
      if (tiles.length >= maxTiles) break;
    }
    if (tiles.length >= maxTiles) break;
  }

  const segments: FsleSegment[] = [];
  const rawIntensities: number[] = [];
  const pending: Array<{ coords: number[][]; fsle: number }> = [];

  await Promise.all(
    tiles.map(async (t) => {
      try {
        const res = await fetch(
          `/api/public/fsle?date=${encodeURIComponent(date.slice(0, 10))}&tileSouth=${t.tileSouth}&tileWest=${t.tileWest}`,
          { signal },
        );
        if (!res.ok) return;
        const json = (await res.json()) as FsleFeatureCollection;
        for (const f of json.features ?? []) {
          const coords = f.geometry?.coordinates;
          if (!Array.isArray(coords) || coords.length < 2) continue;
          const fsle = Math.abs(Number(f.properties?.fsle ?? 0));
          rawIntensities.push(fsle);
          pending.push({ coords, fsle });
        }
      } catch {
        /* FSLE es opcional: sin datos, el factor queda neutro */
      }
    }),
  );

  // Normaliza la intensidad con el percentil 90 del área.
  rawIntensities.sort((a, b) => a - b);
  const ref =
    rawIntensities.length > 0
      ? rawIntensities[Math.floor(rawIntensities.length * 0.9)] || 0.2
      : 0.2;

  for (const { coords, fsle } of pending) {
    const intensity = clamp01(fsle / Math.max(1e-6, ref));
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1];
      const b = coords[i];
      if (!a || !b) continue;
      segments.push({ aLng: a[0], aLat: a[1], bLng: b[0], bLat: b[1], intensity });
    }
  }

  const MAX_KM = 11; // ~6 millas náuticas

  const nearest = (lat: number, lng: number): { km: number; intensity: number } | null => {
    let best: { km: number; intensity: number } | null = null;
    for (const s of segments) {
      // Descarte rápido por caja para no medir todos los segmentos.
      if (Math.abs(s.aLat - lat) > 0.2 && Math.abs(s.bLat - lat) > 0.2) continue;
      if (Math.abs(s.aLng - lng) > 0.25 && Math.abs(s.bLng - lng) > 0.25) continue;
      const km = pointSegmentKm(lat, lng, s.aLat, s.aLng, s.bLat, s.bLng);
      if (!best || km < best.km) best = { km, intensity: s.intensity };
    }
    return best;
  };

  return {
    segments,
    distanceNm(lat, lng) {
      const n = nearest(lat, lng);
      return n ? n.km / 1.852 : null;
    },
    proximity(lat, lng) {
      if (segments.length === 0) return 0;
      const n = nearest(lat, lng);
      if (!n || n.km > MAX_KM) return 0;
      const closeness = 1 - n.km / MAX_KM;
      return clamp01(closeness * (0.45 + 0.55 * n.intensity));
    },
  };
}

/** Campo vacío: usado cuando FSLE no está disponible. */
export function emptyFsleField(): FsleField {
  return {
    segments: [],
    proximity: () => 0,
    distanceNm: () => null,
  };
}

