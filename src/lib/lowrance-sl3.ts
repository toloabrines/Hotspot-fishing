import type { Sounding } from "./sonar-data";

/**
 * Lector mínimo de Lowrance/Simrad SL3 para extraer solo posición GPS,
 * profundidad y tiempo. No interpreta la imagen del sonar.
 *
 * El formato SL3 es binario. Para esta primera versión usamos la disposición
 * de cabecera documentada por proyectos open-source que leen SL2/SL3:
 * - cabecera de archivo: 8 bytes
 * - tamaño de frame: offset 28 (UInt16 LE)
 * - canal: offset 32 (UInt16 LE)
 * - profundidad: offset 64 (Float32 LE, pies)
 * - coordenadas Lowrance Mercator: offsets 108/112 (Int32 LE)
 * - tiempo relativo: offset 124 (UInt32 LE)
 *
 * Solo tomamos el canal primario (0) para evitar duplicar la misma derrota en
 * varios canales. Si un fichero no contiene canal primario, usamos cualquier
 * frame con posición y profundidad válidas.
 */

const FILE_HEADER_SIZE = 8;
const FRAME_HEADER_SIZE = 168;
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

function almostSame(a: Sounding, b: Sounding): boolean {
  return (
    Math.abs(a.lat - b.lat) < 1e-7 &&
    Math.abs(a.lng - b.lng) < 1e-7 &&
    Math.abs(a.depthM - b.depthM) < 0.02
  );
}

function parseFrames(view: DataView, primaryOnly: boolean): Sounding[] {
  const out: Sounding[] = [];
  let pos = FILE_HEADER_SIZE;
  let guard = 0;

  while (pos + 32 <= view.byteLength && guard < 2_000_000) {
    guard++;

    if (pos + FRAME_HEADER_SIZE > view.byteLength) break;

    const frameSize = view.getUint16(pos + 28, true);
    const channel = view.getUint16(pos + 32, true);

    // Evita bucles infinitos en ficheros corruptos.
    if (frameSize < 32 || pos + frameSize > view.byteLength) break;

    if (!primaryOnly || channel === 0) {
      const depthFeet = view.getFloat32(pos + 64, true);
      const x = view.getInt32(pos + 108, true);
      const y = view.getInt32(pos + 112, true);
      const t = view.getUint32(pos + 124, true);

      const depthM = Math.abs(depthFeet) * FEET_TO_METERS;
      const lng = lowranceXToLon(x);
      const lat = lowranceYToLat(y);

      if (isValidPoint(lat, lng, depthM)) {
        const point: Sounding = {
          lat,
          lng,
          depthM: Math.round(depthM * 100) / 100,
          t,
        };
        const prev = out[out.length - 1];
        if (!prev || !almostSame(prev, point)) out.push(point);
      }
    }

    pos += frameSize;
  }

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
  if (buffer.byteLength < FILE_HEADER_SIZE + FRAME_HEADER_SIZE) {
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

  let points = parseFrames(view, true);
  if (points.length === 0) points = parseFrames(view, false);

  if (points.length === 0) {
    return {
      ok: false,
      format,
      version,
      blockSize,
      points: [],
      error:
        "Se reconoce el SL3, pero no se han encontrado posiciones GPS y profundidades válidas.",
    };
  }

  return { ok: true, format, version, blockSize, points };
}
