import { useCallback, useMemo } from "react";
import type { GpsPosition } from "../components/GpsTracker";
import { usePersistentState } from "./use-persistent-state";

export interface SavedTrack {
  id: string;
  name: string;
  savedAt: number;
  points: GpsPosition[];
}

/** Distancia total del track en metros. */
export function trackDistanceM(points: GpsPosition[]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    total += 2 * R * Math.asin(Math.sqrt(h));
  }
  return total;
}

/** Duración del track en milisegundos. */
export function trackDurationMs(points: GpsPosition[]): number {
  if (points.length < 2) return 0;
  return Math.max(0, points[points.length - 1]!.timestamp - points[0]!.timestamp);
}

export function formatTrackStats(points: GpsPosition[]): string {
  const km = trackDistanceM(points) / 1000;
  const nm = km / 1.852;
  const ms = trackDurationMs(points);
  const mins = Math.round(ms / 60000);
  const dur = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  return `${nm.toFixed(1)} NM · ${km.toFixed(1)} km · ${dur} · ${points.length} pts`;
}

/**
 * Tracks GPS guardados en el dispositivo (localStorage). No requiere cuenta.
 */
export function useSavedTracks() {
  const [tracks, setTracks] = usePersistentState<SavedTrack[]>("gpsTracks", []);

  const save = useCallback(
    (points: GpsPosition[], name?: string) => {
      if (points.length < 2) return null;
      const savedAt = Date.now();
      const fallback = `Track ${new Date(savedAt).toLocaleString("es-ES", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })}`;
      const track: SavedTrack = {
        id: `${savedAt}-${Math.random().toString(36).slice(2, 8)}`,
        name: (name ?? "").trim() || fallback,
        savedAt,
        // Copia defensiva: el track vivo sigue mutando.
        points: points.map((p) => ({ ...p })),
      };
      setTracks((prev) => [track, ...prev].slice(0, 100));
      return track;
    },
    [setTracks],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, name: name.trim() || t.name } : t)));
    },
    [setTracks],
  );

  const remove = useCallback(
    (id: string) => setTracks((prev) => prev.filter((t) => t.id !== id)),
    [setTracks],
  );

  const clearAll = useCallback(() => setTracks([]), [setTracks]);

  return useMemo(
    () => ({ tracks, save, rename, remove, clearAll }),
    [tracks, save, rename, remove, clearAll],
  );
}

