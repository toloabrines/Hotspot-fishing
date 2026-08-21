/**
 * Exportación / compartición de los frentes de deriva (Fluixa).
 *
 * Serializa los 3 corredores en un payload compacto que viaja en el hash de
 * la URL (`/frentes#d=...`). Esa página muestra la ficha completa y permite
 * imprimir/guardar como PDF sin necesidad de backend.
 */

import type { DriftCorridor, DriftCorridorEnv } from "./drift-corridor";
import { buildShareUrl } from "./share-link";

export interface CorridorSharePayload {
  v: 1;
  t: number;
  e: {
    c: number | null;
    cd: number | null;
    w: number | null;
    wd: number | null;
    g?: number | null;
  };
  f: Array<{
    r: number;
    s: number;
    l: number;
    b: number;
    dd: number | null;
    dk: number | null;
    eta: number | null;
    dep: number | null;
    sst: number | null;
    chl: number | null;
    sg: number;
    ci: number;
    fs: number;
    cf: number;
    n: number;
    p: [number, number][];
  }>;
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
const r2 = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;

/** Reduce la polilínea a un máximo de puntos para que el enlace no crezca. */
function thin(points: { lat: number; lng: number }[], max = 24): [number, number][] {
  if (points.length <= max) return points.map((p) => [r5(p.lat), r5(p.lng)]);
  const step = (points.length - 1) / (max - 1);
  const out: [number, number][] = [];
  for (let i = 0; i < max; i++) {
    const p = points[Math.round(i * step)];
    out.push([r5(p.lat), r5(p.lng)]);
  }
  return out;
}

export function buildCorridorPayload(
  corridors: DriftCorridor[],
  env: DriftCorridorEnv & { gustKn?: number | null },
): CorridorSharePayload {
  return {
    v: 1,
    t: Date.now(),
    e: {
      c: r2(env.currentSpeedMs),
      cd: env.currentDirDeg == null ? null : Math.round(env.currentDirDeg),
      w: r2(env.windKn),
      wd: env.windFromDeg == null ? null : Math.round(env.windFromDeg),
      g: r2(env.gustKn ?? null),
    },
    f: corridors.map((c) => ({
      r: c.rank,
      s: c.score,
      l: Math.round(c.lengthKm * 100) / 100,
      b: c.bearingDeg,
      dd: c.driftDirDeg == null ? null : Math.round(c.driftDirDeg),
      dk: r2(c.driftKn),
      eta: c.etaMin,
      dep: c.meanDepthM == null ? null : Math.round(c.meanDepthM),
      sst: r2(c.sstC ?? null),
      chl: c.chlMg == null ? null : Math.round(c.chlMg * 10000) / 10000,
      sg: Math.round(c.sstGrad * 100) / 100,
      ci: Math.round(c.chlIndex * 100) / 100,
      fs: Math.round(c.fsle * 100) / 100,
      cf: c.confidence,
      n: c.cellCount,
      p: thin(c.points),
    })),
  };
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeCorridorPayload(payload: CorridorSharePayload): string {
  return toBase64Url(JSON.stringify(payload));
}

export function decodeCorridorPayload(encoded: string): CorridorSharePayload | null {
  try {
    const parsed = JSON.parse(fromBase64Url(encoded)) as CorridorSharePayload;
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.f)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Enlace absoluto a la ficha imprimible de los frentes. */
export function buildCorridorShareUrl(
  corridors: DriftCorridor[],
  env: DriftCorridorEnv & { gustKn?: number | null },
): string {
  return buildShareUrl("/frentes", `d=${encodeCorridorPayload(buildCorridorPayload(corridors, env))}`);
}

