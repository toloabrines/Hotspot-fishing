import type { Sounding } from "./sonar-data";

/**
 * Lector de Lowrance/Simrad SL3 para extraer posición GPS, profundidad y tiempo.
 * No interpreta la imagen del sonar.
 *
 * Disposición usada (formato 3):
 * - cabecera de archivo: 8 bytes
 * - tamaño de frame: offset 8 (UInt16 LE)
 * - canal: offset 12 (UInt16 LE)
 * - profundidad: offset 48 (Float32 LE, pies)
 * - coordenadas Lowrance Mercator: offsets 92/96 (Int32 LE)
 * - tiempo relativo: offset 124 (UInt32 LE)
 *
 * Solo usamos el canal primario (0) para no duplicar la misma derrota en los
 * canales secundarios/StructureScan.
 */

const FILE_HEADER_SIZE = 8;
const MIN_FRAME_HEADER_SIZE = 128;
const POLAR_EARTH_RADIUS = 6356752.3142;
const RAD_TO_DEG = 180 / Math.PI;
const FEET_TO_METERS = 0.3048;

function lowranceXToLon(x: number): number {
  return (x / POLAR_EARTH_RADIUS) * RAD_TO_DEG;
}

function lowranceYToLat(y: number): number {
  const t = Math.exp(y / POLAR_EARTH_RADIUS);
  return (2 * Math.atan(t) - Math.PI / 2) * RAD_TO_DEG;
}

function isValidPoint(lat: number, lng: number, depthM: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Number.isFinite(depthM) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    depthM >= 0.2 &&
    depthM <= 6000
  );
}

interface Aggregate {
  lat: number;
  lng: number;
  depthSum: number;
  count: number;
  t: number;
}

function finishAggregate(a: Aggregate | null, out: Sounding[]) {
  if (!a || !a.count) return;
  out.push({
    lat: a.lat,
    lng: a.lng,
    depthM: Math.round((a.depthSum / a.count) * 1000) / 1000,
    t: a.t,
  });
}

function parsePrimaryFrames(view: DataView): Sounding[] {
  const out: Sounding[] = [];
  let pos = FILE_HEADER_SIZE;
  let guard = 0;
  let aggregate: Aggregate | null = null;

  while (pos + MIN_FRAME_HEADER_SIZE <= view.byteLength && guard < 2_000_000) {
    guard++;

    const frameSize = view.getUint16(pos + 8, true);
    const channel = view.getUint16(pos + 12, true);

    // Tamaños imposibles indican truncado/corrupción y evitan bucles infinitos.
    if (frameSize < MIN_FRAME_HEADER_SIZE || pos + frameSize > view.byteLength) break;

    if (channel === 0) {
      const depthFeet = view.getFloat32(pos + 48, true);
      const x = view.getInt32(pos + 92, true);
      const y = view.getInt32(pos + 96, true);
      const t = view.getUint32(pos + 124, true);

      const depthM = Math.abs(depthFeet) * FEET_TO_METERS;
      const lng = lowranceXToLon(x);
      const lat = lowranceYToLat(y);

      if (isValidPoint(lat, lng, depthM)) {
        // El GPS se actualiza más despacio que los pings del sonar. Agrupamos
        // pings consecutivos con la misma posición y guardamos su profundidad media.
        if (
          aggregate &&
          Math.abs(aggregate.lat - lat) < 1e-10 &&
          Math.abs(aggregate.lng - lng) < 1e-10
        ) {
          aggregate.depthSum += depthM;
          aggregate.count++;
          aggregate.t = t;
        } else {
          finishAggregate(aggregate, out);
          aggregate = { lat, lng, depthSum: depthM, count: 1, t };
        }
      }
    }

    pos += frameSize;
  }

  finishAggregate(aggregate, out);
  return out;
}

export interface Sl3Inspection {
  ok: boolean;
  format: number;
  version: number;
  blockSize: number;
  points: Sounding[];
  error?: string;
}

export function parseLowranceSl3(buffer: ArrayBuffer): Sl3Inspection {
  if (buffer.byteLength < FILE_HEADER_SIZE + MIN_FRAME_HEADER_SIZE) {
    return {
      ok: false,
      format: 0,
      version: 0,
      blockSize: 0,
      points: [],
      error: "El archivo SL3 es demasiado pequeño o está incompleto.",
    };
  }

  const view = new DataView(buffer);
  const format = view.getUint16(0, true);
  const version = view.getUint16(2, true);
  const blockSize = view.getUint16(4, true);

  if (format !== 3) {
    return {
      ok: false,
      format,
      version,
      blockSize,
      points: [],
      error: "El archivo no parece ser un Lowrance/Simrad SL3 válido.",
    };
  }

  const points = parsePrimaryFrames(view);

  if (points.length === 0) {
    return {
      ok: false,
      format,
      version,
      blockSize,
      points: [],
      error:
        "Se reconoce el SL3, pero no se han encontrado posiciones GPS y profundidades válidas en el canal principal.",
    };
  }

  return { ok: true, format, version, blockSize, points };
}
