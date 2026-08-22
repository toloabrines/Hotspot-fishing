/**
 * Sincronización en la nube de las sesiones de AutoBatimetría.
 * Cada usuario guarda sus sondeos; la marca `is_shared` deja preparada una
 * batimetría colaborativa entre usuarios (opt-in, desactivada por defecto).
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface CloudSoundingPoint {
  lat: number;
  lng: number;
  depthM: number;
  t?: number;
  q?: number;
}

export interface SaveSessionInput {
  cloudId?: string | null;
  name: string;
  startedAt: number;
  endedAt?: number | null;
  spacingM: number;
  source?: string;
  isShared?: boolean;
  points: CloudSoundingPoint[];
}

const MAX_POINTS = 60000;

function sanitize(input: SaveSessionInput) {
  const points = (input?.points ?? [])
    .filter(
      (p) =>
        Number.isFinite(p?.lat) &&
        Number.isFinite(p?.lng) &&
        Number.isFinite(p?.depthM) &&
        Math.abs(p.lat) <= 90 &&
        Math.abs(p.lng) <= 180 &&
        p.depthM > 0 &&
        p.depthM < 6000,
    )
    .slice(0, MAX_POINTS)
    .map((p) => ({
      lat: Math.round(p.lat * 1e6) / 1e6,
      lng: Math.round(p.lng * 1e6) / 1e6,
      depthM: Math.round(p.depthM * 100) / 100,
      t: Number.isFinite(p.t) ? p.t : undefined,
      q: Number.isFinite(p.q) ? p.q : undefined,
    }));
  if (!points.length) throw new Error("No hay sondeos válidos que guardar");
  return {
    cloudId: typeof input.cloudId === "string" ? input.cloudId : null,
    name: String(input?.name ?? "AutoBatimetría").slice(0, 120),
    startedAt: Number(input?.startedAt) || Date.now(),
    endedAt: Number(input?.endedAt) || Date.now(),
    spacingM: Math.max(1, Math.min(500, Number(input?.spacingM) || 25)),
    source: String(input?.source ?? "nmea").slice(0, 32),
    isShared: input?.isShared === true,
    points,
  };
}

export const saveSoundingSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(sanitize)
  .handler(async ({ data, context }) => {
    const lats = data.points.map((p) => p.lat);
    const lngs = data.points.map((p) => p.lng);
    const depths = data.points.map((p) => p.depthM);
    const row = {
      user_id: context.userId,
      name: data.name,
      started_at: new Date(data.startedAt).toISOString(),
      ended_at: new Date(data.endedAt).toISOString(),
      point_count: data.points.length,
      min_depth_m: Math.min(...depths),
      max_depth_m: Math.max(...depths),
      south: Math.min(...lats),
      north: Math.max(...lats),
      west: Math.min(...lngs),
      east: Math.max(...lngs),
      spacing_m: data.spacingM,
      source: data.source,
      is_shared: data.isShared,
      points: data.points,
    };

    if (data.cloudId) {
      const { data: updated, error } = await context.supabase
        .from("sounding_sessions")
        .update(row)
        .eq("id", data.cloudId)
        .eq("user_id", context.userId)
        .select("id")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (updated?.id) return { id: updated.id as string, points: data.points.length };
    }

    const { data: inserted, error } = await context.supabase
      .from("sounding_sessions")
      .insert(row)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: inserted.id as string, points: data.points.length };
  });

export const listSoundingSessions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("sounding_sessions")
      .select(
        "id,name,started_at,ended_at,point_count,min_depth_m,max_depth_m,south,west,north,east,spacing_m,is_shared,user_id",
      )
      .order("started_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []).map((s) => ({ ...s, mine: s.user_id === context.userId }));
  });

export const fetchSoundingSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => ({ id: String(input?.id ?? "") }))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("sounding_sessions")
      .select("id,name,spacing_m,started_at,ended_at,points")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteSoundingSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => ({ id: String(input?.id ?? "") }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("sounding_sessions")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setSoundingSessionShared = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; shared: boolean }) => ({
    id: String(input?.id ?? ""),
    shared: input?.shared === true,
  }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("sounding_sessions")
      .update({ is_shared: data.shared })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

