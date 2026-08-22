import { useCallback, useEffect, useState } from "react";
import type { FishingSpot } from "../components/FishingHotspots.types";
import { supabase } from "../integrations/supabase/client";

/**
 * Waypoint FIJO guardado por el usuario.
 *
 * Persistencia:
 *  - Si el usuario está autenticado → se guarda en la tabla `waypoints` de
 *    Lovable Cloud y se sincroniza entre dispositivos.
 *  - Si no hay sesión → se guarda en localStorage de este navegador.
 *
 * Al iniciar sesión, los waypoints locales se suben automáticamente a la
 * nube para no perderlos.
 */
export interface SavedWaypoint {
  id: string;
  lat: number;
  lng: number;
  score: number;
  depth: number | null;
  reason: string;
  name: string;
  savedAt: number;
}

const STORAGE_KEY = "totymar.savedWaypoints.v1";

function readStorage(): SavedWaypoint[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (w: unknown): w is SavedWaypoint =>
        !!w &&
        typeof w === "object" &&
        typeof (w as SavedWaypoint).lat === "number" &&
        typeof (w as SavedWaypoint).lng === "number" &&
        typeof (w as SavedWaypoint).id === "string",
    );
  } catch {
    return [];
  }
}

function writeStorage(list: SavedWaypoint[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* quota / privado — silenciar */
  }
}

function sameSpot(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  return Math.abs(a.lat - b.lat) < 3e-4 && Math.abs(a.lng - b.lng) < 3e-4;
}

interface DbRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  depth: number | null;
  score: number;
  reason: string;
  saved_at: string;
}

function rowToWaypoint(r: DbRow): SavedWaypoint {
  return {
    id: r.id,
    name: r.name,
    lat: Number(r.lat),
    lng: Number(r.lng),
    depth: r.depth === null ? null : Number(r.depth),
    score: Number(r.score),
    reason: r.reason,
    savedAt: new Date(r.saved_at).getTime(),
  };
}

export function useSavedWaypoints() {
  const [waypoints, setWaypoints] = useState<SavedWaypoint[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const cloudMode = userId !== null;

  // Hidratación inicial desde localStorage y suscripción a auth.
  useEffect(() => {
    setWaypoints(readStorage());
    setHydrated(true);

    let cancelled = false;
    const fetchCloud = async (uid: string) => {
      const { data, error } = await supabase
        .from("waypoints")
        .select("id,name,lat,lng,depth,score,reason,saved_at")
        .order("saved_at", { ascending: true });
      if (cancelled) return;
      if (error) {
        console.error("[waypoints] fetch error", error);
        return;
      }
      const cloud = (data ?? []).map((r) => rowToWaypoint(r as DbRow));

      // Migrar waypoints locales que aún no estén en la nube.
      const local = readStorage();
      const toUpload = local.filter((l) => !cloud.some((c) => sameSpot(c, l)));
      if (toUpload.length > 0) {
        const { data: inserted, error: insErr } = await supabase
          .from("waypoints")
          .insert(
            toUpload.map((w) => ({
              user_id: uid,
              name: w.name,
              lat: w.lat,
              lng: w.lng,
              depth: w.depth,
              score: w.score,
              reason: w.reason,
              saved_at: new Date(w.savedAt).toISOString(),
            })),
          )
          .select("id,name,lat,lng,depth,score,reason,saved_at");
        if (!insErr && inserted) {
          cloud.push(...inserted.map((r) => rowToWaypoint(r as DbRow)));
        } else {
          // Sin cobertura o con un fallo temporal de nube, conserva los
          // puntos del teléfono. Se volverán a intentar en la próxima sesión.
          cloud.push(...toUpload);
        }
      }
      if (!cancelled) setWaypoints(cloud);
    };

    supabase.auth.getSession().then(({ data }) => {
      const uid = data.session?.user.id ?? null;
      setUserId(uid);
      if (uid) fetchCloud(uid);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      const uid = session?.user.id ?? null;
      setUserId(uid);
      if (uid) {
        fetchCloud(uid);
      } else {
        // Sign-out: vuelve a lo que haya en localStorage.
        setWaypoints(readStorage());
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Persistir SIEMPRE una copia en el teléfono (localStorage), también en modo
  // cloud: así los waypoints siguen disponibles sin cobertura ni sesión.
  useEffect(() => {
    if (!hydrated) return;
    writeStorage(waypoints);
  }, [hydrated, waypoints]);

  const isSaved = useCallback(
    (spot: { lat: number; lng: number }) => waypoints.some((w) => sameSpot(w, spot)),
    [waypoints],
  );

  const save = useCallback(
    (spot: FishingSpot, name?: string) => {
      const wpName = name ?? `Spot ${waypoints.length + 1}`;
      if (waypoints.some((w) => sameSpot(w, spot))) return;

      if (cloudMode && userId) {
        const tempId = `tmp-${Date.now()}`;
        const optimistic: SavedWaypoint = {
          id: tempId,
          lat: spot.lat,
          lng: spot.lng,
          score: spot.score,
          depth: spot.depth,
          reason: spot.reason,
          name: wpName,
          savedAt: Date.now(),
        };
        setWaypoints((prev) => [...prev, optimistic]);
        supabase
          .from("waypoints")
          .insert({
            user_id: userId,
            name: wpName,
            lat: spot.lat,
            lng: spot.lng,
            depth: spot.depth,
            score: spot.score,
            reason: spot.reason,
          })
          .select("id,name,lat,lng,depth,score,reason,saved_at")
          .single()
          .then(({ data, error }) => {
            if (error || !data) {
              console.error("[waypoints] insert error", error);
              setWaypoints((prev) => prev.filter((w) => w.id !== tempId));
              return;
            }
            const fresh = rowToWaypoint(data as DbRow);
            setWaypoints((prev) => prev.map((w) => (w.id === tempId ? fresh : w)));
          });
      } else {
        const wp: SavedWaypoint = {
          id: `wp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          lat: spot.lat,
          lng: spot.lng,
          score: spot.score,
          depth: spot.depth,
          reason: spot.reason,
          name: wpName,
          savedAt: Date.now(),
        };
        setWaypoints((prev) => [...prev, wp]);
      }
    },
    [cloudMode, userId, waypoints],
  );

  const addManual = useCallback(
    (lat: number, lng: number, name?: string) => {
      const wpName = name ?? `Waypoint ${waypoints.length + 1}`;
      if (waypoints.some((w) => sameSpot(w, { lat, lng }))) return;

      if (cloudMode && userId) {
        const tempId = `tmp-${Date.now()}`;
        const optimistic: SavedWaypoint = {
          id: tempId,
          lat,
          lng,
          score: 0,
          depth: null,
          reason: "Waypoint manual",
          name: wpName,
          savedAt: Date.now(),
        };
        setWaypoints((prev) => [...prev, optimistic]);
        supabase
          .from("waypoints")
          .insert({
            user_id: userId,
            name: wpName,
            lat,
            lng,
            depth: null,
            score: 0,
            reason: "Waypoint manual",
          })
          .select("id,name,lat,lng,depth,score,reason,saved_at")
          .single()
          .then(({ data, error }) => {
            if (error || !data) {
              console.error("[waypoints] insert error", error);
              setWaypoints((prev) => prev.filter((w) => w.id !== tempId));
              return;
            }
            const fresh = rowToWaypoint(data as DbRow);
            setWaypoints((prev) => prev.map((w) => (w.id === tempId ? fresh : w)));
          });
      } else {
        const wp: SavedWaypoint = {
          id: `wp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          lat,
          lng,
          score: 0,
          depth: null,
          reason: "Waypoint manual",
          name: wpName,
          savedAt: Date.now(),
        };
        setWaypoints((prev) => [...prev, wp]);
      }
    },
    [cloudMode, userId, waypoints],
  );

  const remove = useCallback(
    (id: string) => {
      setWaypoints((prev) => prev.filter((w) => w.id !== id));
      if (cloudMode && !id.startsWith("tmp-") && !id.startsWith("wp-")) {
        supabase
          .from("waypoints")
          .delete()
          .eq("id", id)
          .then(({ error }) => {
            if (error) console.error("[waypoints] delete error", error);
          });
      }
    },
    [cloudMode],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      setWaypoints((prev) => prev.map((w) => (w.id === id ? { ...w, name } : w)));
      if (cloudMode && !id.startsWith("tmp-") && !id.startsWith("wp-")) {
        supabase
          .from("waypoints")
          .update({ name })
          .eq("id", id)
          .then(({ error }) => {
            if (error) console.error("[waypoints] rename error", error);
          });
      }
    },
    [cloudMode],
  );

  const clear = useCallback(() => {
    setWaypoints([]);
    if (cloudMode && userId) {
      supabase
        .from("waypoints")
        .delete()
        .eq("user_id", userId)
        .then(({ error }) => {
          if (error) console.error("[waypoints] clear error", error);
        });
    } else {
      writeStorage([]);
    }
  }, [cloudMode, userId]);

  /**
   * Importa una lista de waypoints (desde GPX/KML). Evita duplicados por
   * proximidad y sube a la nube si hay sesión.
   */
  const bulkAdd = useCallback(
    async (
      items: Array<{
        lat: number;
        lng: number;
        name: string;
        depth: number | null;
        reason: string;
      }>,
    ): Promise<number> => {
      const fresh = items.filter(
        (it) =>
          Number.isFinite(it.lat) &&
          Number.isFinite(it.lng) &&
          !waypoints.some((w) => sameSpot(w, it)),
      );
      // Deduplicar dentro del propio import
      const seen: Array<{ lat: number; lng: number }> = [];
      const unique = fresh.filter((it) => {
        if (seen.some((s) => sameSpot(s, it))) return false;
        seen.push({ lat: it.lat, lng: it.lng });
        return true;
      });
      if (unique.length === 0) return 0;

      if (cloudMode && userId) {
        // Guardado local inmediato: el waypoint no depende de la cobertura ni
        // de que la petición a la nube termine correctamente.
        const optimistic = unique.map((it, index): SavedWaypoint => ({
          id: `wp-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
          lat: it.lat,
          lng: it.lng,
          score: 0,
          depth: it.depth,
          reason: it.reason,
          name: it.name,
          savedAt: Date.now(),
        }));
        const optimisticIds = new Set(optimistic.map((item) => item.id));
        setWaypoints((prev) => {
          const next = [...prev, ...optimistic];
          writeStorage(next);
          return next;
        });

        const payload = unique.map((it) => ({
          user_id: userId,
          name: it.name,
          lat: it.lat,
          lng: it.lng,
          depth: it.depth,
          score: 0,
          reason: it.reason,
        }));
        const { data, error } = await supabase
          .from("waypoints")
          .insert(payload)
          .select("id,name,lat,lng,depth,score,reason,saved_at");
        if (error || !data) {
          console.error("[waypoints] bulkAdd error", error);
          // Ya está guardado en el teléfono. No lo elimines por un fallo de
          // red: fetchCloud volverá a sincronizarlo al recuperar conexión.
          return optimistic.length;
        }
        const persisted = data.map((r) => rowToWaypoint(r as DbRow));
        setWaypoints((prev) => {
          const next = [...prev.filter((item) => !optimisticIds.has(item.id)), ...persisted];
          writeStorage(next);
          return next;
        });
        return data.length;
      }


      const added: SavedWaypoint[] = unique.map((it) => ({
        id: `wp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        lat: it.lat,
        lng: it.lng,
        score: 0,
        depth: it.depth,
        reason: it.reason,
        name: it.name,
        savedAt: Date.now(),
      }));
      setWaypoints((prev) => [...prev, ...added]);
      return added.length;
    },
    [cloudMode, userId, waypoints],
  );

  return {
    waypoints,
    isSaved,
    save,
    addManual,
    remove,
    rename,
    clear,
    bulkAdd,
    cloudMode,
    userId,
  };
}


/** Convierte un SavedWaypoint a FishingSpot (para reusar utilidades GPX). */
export function savedToSpot(w: SavedWaypoint): FishingSpot {
  return {
    id: w.id,
    lat: w.lat,
    lng: w.lng,
    score: w.score,
    depth: w.depth,
    reason: w.reason,
  };
}

