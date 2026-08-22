/**
 * Caché persistente (localStorage) de resultados de detección de zonas
 * de gradiente, indexado por bbox+zoom+capas+tiempos. Permite recuperar
 * las líneas tras suspender/reanudar la pantalla sin reanalizar.
 */

import type { GradientZonesResult } from "./gradient-zones.types";

const STORAGE_KEY = "gradient-zones-cache:v1";
const MAX_ENTRIES = 24;
const MAX_AGE_MS = 1000 * 60 * 60 * 6; // 6h

interface CacheEntry {
  key: string;
  ts: number;
  result: GradientZonesResult;
}

type Index = CacheEntry[];

function safeRead(): Index {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Index;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((e) => e && typeof e.key === "string" && now - e.ts < MAX_AGE_MS);
  } catch {
    return [];
  }
}

function safeWrite(idx: Index): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(idx.slice(-MAX_ENTRIES)));
  } catch {
    // quota/serialization errors → ignorar; la caché es best-effort
  }
}

export function makeCacheKey(parts: {
  bbox: { south: number; west: number; north: number; east: number };
  zoom: number;
  sstLayer?: string;
  chlLayer?: string;
  altLayer?: string;
  layerTimeKey: string;
}): string {
  const b = parts.bbox;
  const bb = `${b.south.toFixed(4)},${b.west.toFixed(4)},${b.north.toFixed(4)},${b.east.toFixed(4)}`;
  return `${bb}|${makeCacheSignature(parts)}`;
}

export function makeCacheSignature(parts: {
  zoom: number;
  sstLayer?: string;
  chlLayer?: string;
  altLayer?: string;
  layerTimeKey: string;
}): string {
  return [
    `z${Math.round(parts.zoom)}`,
    parts.sstLayer ?? "-",
    parts.chlLayer ?? "-",
    parts.altLayer ?? "-",
    parts.layerTimeKey,
  ].join("|");
}

export function readCache(key: string): GradientZonesResult | null {
  const idx = safeRead();
  const hit = idx.find((e) => e.key === key);
  return hit ? hit.result : null;
}

export function readLatestCompatible(signature: string): GradientZonesResult | null {
  const idx = safeRead();
  const hit = idx
    .slice()
    .reverse()
    .find((e) => e.key.endsWith(`|${signature}`) && e.result.zones.length > 0);
  return hit ? hit.result : null;
}

export function writeCache(key: string, result: GradientZonesResult): void {
  if (result.zones.length === 0) return;
  const idx = safeRead().filter((e) => e.key !== key);
  idx.push({ key, ts: Date.now(), result });
  safeWrite(idx);
}

export function clearAllCache(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}

