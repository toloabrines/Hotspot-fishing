/**
 * Lector TIFF mínimo (sin dependencias) para las rejillas de profundidad que
 * devuelve el WCS de EMODnet Bathymetry.
 *
 * Soporta exactamente lo que emite GeoServer para `emodnet:mean`:
 *  - un solo canal (SamplesPerPixel = 1)
 *  - sin compresión (Compression = 1)
 *  - Float32 / Float64 / Int16 / Int32 / UInt16
 *  - organización por tiles o por strips
 *  - byte order MM (big endian) o II (little endian)
 */

export interface RasterGrid {
  width: number;
  height: number;
  /** Elevación en metros (negativo = bajo el nivel del mar). NaN = sin dato. */
  data: Float32Array;
}

const TAG = {
  width: 256,
  height: 257,
  bitsPerSample: 258,
  compression: 259,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripOffsets: 273,
  stripByteCounts: 279,
  tileWidth: 322,
  tileHeight: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  sampleFormat: 339,
  gdalNoData: 42113,
} as const;

interface Entry {
  type: number;
  count: number;
  values: number[];
  strings?: string;
}

const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};

function readValue(dv: DataView, type: number, offset: number, le: boolean): number {
  switch (type) {
    case 1:
    case 7:
      return dv.getUint8(offset);
    case 2:
      return dv.getUint8(offset);
    case 3:
      return dv.getUint16(offset, le);
    case 4:
      return dv.getUint32(offset, le);
    case 5:
      return dv.getUint32(offset, le) / (dv.getUint32(offset + 4, le) || 1);
    case 6:
      return dv.getInt8(offset);
    case 8:
      return dv.getInt16(offset, le);
    case 9:
      return dv.getInt32(offset, le);
    case 10:
      return dv.getInt32(offset, le) / (dv.getInt32(offset + 4, le) || 1);
    case 11:
      return dv.getFloat32(offset, le);
    case 12:
      return dv.getFloat64(offset, le);
    default:
      return 0;
  }
}

export function parseTiffGrid(buffer: ArrayBuffer): RasterGrid {
  const dv = new DataView(buffer);
  const bo = String.fromCharCode(dv.getUint8(0), dv.getUint8(1));
  if (bo !== "MM" && bo !== "II") throw new Error("no-tiff");
  const le = bo === "II";
  if (dv.getUint16(2, le) !== 42) throw new Error("no-tiff42");

  const ifdOffset = dv.getUint32(4, le);
  const count = dv.getUint16(ifdOffset, le);
  const entries = new Map<number, Entry>();

  for (let i = 0; i < count; i++) {
    const off = ifdOffset + 2 + i * 12;
    const tag = dv.getUint16(off, le);
    const type = dv.getUint16(off + 2, le);
    const n = dv.getUint32(off + 4, le);
    const size = (TYPE_SIZE[type] ?? 1) * n;
    const valueOffset = size <= 4 ? off + 8 : dv.getUint32(off + 8, le);
    const values: number[] = [];
    let strings: string | undefined;
    if (type === 2) {
      let s = "";
      for (let k = 0; k < n; k++) {
        const c = dv.getUint8(valueOffset + k);
        if (c) s += String.fromCharCode(c);
      }
      strings = s;
    } else {
      const step = TYPE_SIZE[type] ?? 1;
      for (let k = 0; k < Math.min(n, 4096); k++) {
        values.push(readValue(dv, type, valueOffset + k * step, le));
      }
    }
    entries.set(tag, { type, count: n, values, strings });
  }

  const num = (tag: number, fallback: number) => entries.get(tag)?.values[0] ?? fallback;

  const width = num(TAG.width, 0);
  const height = num(TAG.height, 0);
  if (!width || !height) throw new Error("tiff-dims");
  if (num(TAG.compression, 1) !== 1) throw new Error("tiff-compressed");
  if (num(TAG.samplesPerPixel, 1) !== 1) throw new Error("tiff-multiband");

  const bits = num(TAG.bitsPerSample, 32);
  const format = num(TAG.sampleFormat, 1); // 1=uint 2=int 3=float
  const bytes = bits / 8;

  const noDataStr = entries.get(TAG.gdalNoData)?.strings;
  const noData = noDataStr != null ? parseFloat(noDataStr) : NaN;

  const out = new Float32Array(width * height);
  out.fill(NaN);

  const readSample = (byteOffset: number): number => {
    if (byteOffset + bytes > buffer.byteLength) return NaN;
    if (format === 3) return bits === 64 ? dv.getFloat64(byteOffset, le) : dv.getFloat32(byteOffset, le);
    if (format === 2) {
      if (bits === 8) return dv.getInt8(byteOffset);
      if (bits === 16) return dv.getInt16(byteOffset, le);
      return dv.getInt32(byteOffset, le);
    }
    if (bits === 8) return dv.getUint8(byteOffset);
    if (bits === 16) return dv.getUint16(byteOffset, le);
    return dv.getUint32(byteOffset, le);
  };

  const put = (x: number, y: number, v: number) => {
    if (x >= width || y >= height) return;
    let value = v;
    if (!Number.isFinite(value)) value = NaN;
    else if (Number.isFinite(noData) && Math.abs(value - noData) < 1e-6) value = NaN;
    else if (value < -12000 || value > 9000) value = NaN;
    out[y * width + x] = value;
  };

  const tileW = entries.get(TAG.tileWidth)?.values[0];
  const tileH = entries.get(TAG.tileHeight)?.values[0];

  if (tileW && tileH) {
    const offsets = entries.get(TAG.tileOffsets)?.values ?? [];
    const tilesAcross = Math.ceil(width / tileW);
    for (let t = 0; t < offsets.length; t++) {
      const base = offsets[t];
      const tx = (t % tilesAcross) * tileW;
      const ty = Math.floor(t / tilesAcross) * tileH;
      for (let y = 0; y < tileH; y++) {
        for (let x = 0; x < tileW; x++) {
          put(tx + x, ty + y, readSample(base + (y * tileW + x) * bytes));
        }
      }
    }
  } else {
    const offsets = entries.get(TAG.stripOffsets)?.values ?? [];
    const rowsPerStrip = num(TAG.rowsPerStrip, height);
    for (let s = 0; s < offsets.length; s++) {
      const base = offsets[s];
      const y0 = s * rowsPerStrip;
      for (let y = 0; y < rowsPerStrip && y0 + y < height; y++) {
        for (let x = 0; x < width; x++) {
          put(x, y0 + y, readSample(base + (y * width + x) * bytes));
        }
      }
    }
  }

  return { width, height, data: out };
}

