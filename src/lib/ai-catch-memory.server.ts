/**
 * Memoria de resultados reales (solo servidor).
 *
 * Lee las capturas estructuradas y validadas del pescador (tabla
 * `public.catch_reports`) y genera:
 *  - un resumen legible para el prompt del asistente,
 *  - un ajuste de ranking por proximidad: las zonas donde ya hubo buenas
 *    capturas suben, las que fueron malas bajan. Solo se usan registros
 *    estructurados (con resultado y coordenadas), nunca comentarios sueltos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { distanceNm } from "./ai-advisor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>;

export interface CatchMemoryRow {
  lat: number;
  lng: number;
  fishedAt: string;
  mode: string;
  species: string | null;
  quantity: number | null;
  depthM: number | null;
  technique: string | null;
  bait: string | null;
  quality: string | null;
  outcome: string;
}

export async function loadCatchMemory(
  client: AnyClient,
  userId: string,
  mode: string | null,
  limit = 40,
): Promise<CatchMemoryRow[]> {
  try {
    let q = client
      .from("catch_reports")
      .select("lat, lng, fished_at, mode, species, quantity, depth_m, technique, bait, quality, outcome")
      .eq("user_id", userId)
      .order("fished_at", { ascending: false })
      .limit(limit);
    if (mode) q = q.eq("mode", mode);
    const { data, error } = await q;
    if (error || !data) return [];
    return data.map((r) => ({
      lat: Number(r.lat),
      lng: Number(r.lng),
      fishedAt: String(r.fished_at),
      mode: String(r.mode),
      species: r.species ? String(r.species) : null,
      quantity: r.quantity == null ? null : Number(r.quantity),
      depthM: r.depth_m == null ? null : Number(r.depth_m),
      technique: r.technique ? String(r.technique) : null,
      bait: r.bait ? String(r.bait) : null,
      quality: r.quality ? String(r.quality) : null,
      outcome: String(r.outcome),
    }));
  } catch {
    return [];
  }
}

/** Bloque legible para el prompt. */
export function catchMemoryBlock(rows: CatchMemoryRow[]): string {
  if (!rows.length) {
    return "Historial de capturas del pescador: todavía no ha guardado ninguna jornada.";
  }
  const lines = rows.slice(0, 15).map((r) => {
    const d = new Date(r.fishedAt);
    const fecha = Number.isNaN(d.getTime()) ? r.fishedAt : d.toLocaleDateString("es-ES");
    return (
      `- ${fecha} | ${r.lat.toFixed(4)}, ${r.lng.toFixed(4)} | ${r.mode} | ` +
      `${r.species ?? "especie n/d"} x${r.quantity ?? "?"} | ` +
      `${r.depthM != null ? `${Math.round(r.depthM)} m` : "prof. n/d"} | ` +
      `${r.technique ?? "técnica n/d"} / ${r.bait ?? "cebo n/d"} | ` +
      `resultado: ${r.quality ?? (r.outcome === "good" ? "bueno" : "malo")}`
    );
  });
  return ["HISTORIAL REAL DE CAPTURAS DEL PESCADOR (datos guardados por él):", ...lines].join("\n");
}

/**
 * Ajuste de confianza por histórico: +/- según capturas cercanas (< 1,5 nm).
 * Devuelve un texto por hotspot para que la IA lo tenga en cuenta al ordenar.
 */
export function historyHintFor(
  spot: { lat: number; lng: number },
  rows: CatchMemoryRow[],
): string | null {
  const near = rows.filter((r) => distanceNm(spot, { lat: r.lat, lng: r.lng }) <= 1.5);
  if (!near.length) return null;
  const good = near.filter((r) => r.quality === "bueno" || r.outcome === "good").length;
  const bad = near.filter((r) => r.quality === "malo" || r.outcome === "bad").length;
  return `histórico cercano: ${good} buenas / ${bad} malas en ${near.length} jornadas`;
}

