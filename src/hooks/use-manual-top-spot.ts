import { useCallback, useEffect, useState } from "react";

/**
 * Top 1 MANUAL — un único punto que el usuario marca a propósito sobre el
 * mapa (pulsación larga / doble toque / botón). Se persiste en localStorage
 * para que sobreviva a recargas y cambios de capa. NO se recalcula nunca de
 * forma automática.
 */
export interface ManualTopSpot {
  lat: number;
  lng: number;
  /** ms de cuando se creó/movió por última vez. */
  updatedAt: number;
}

const STORAGE_KEY = "totymar.manualTopSpot.v1";

function read(): ManualTopSpot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (
      v &&
      typeof v === "object" &&
      typeof v.lat === "number" &&
      typeof v.lng === "number" &&
      Number.isFinite(v.lat) &&
      Number.isFinite(v.lng)
    ) {
      return {
        lat: v.lat,
        lng: v.lng,
        updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : Date.now(),
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function write(value: ManualTopSpot | null) {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* quota / private */
  }
}

export function useManualTopSpot() {
  const [spot, setSpot] = useState<ManualTopSpot | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setSpot(read());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    write(spot);
  }, [spot, hydrated]);

  const set = useCallback((lat: number, lng: number) => {
    const next = { lat, lng, updatedAt: Date.now() };
    write(next);
    setSpot(next);
  }, []);

  const clear = useCallback(() => {
    // Persistimos inmediatamente para no depender del ciclo de efectos:
    // si el usuario pulsa ✕ antes de que termine la hidratación, evitamos
    // que el valor antiguo de localStorage reaparezca al recargar.
    write(null);
    setSpot(null);
  }, []);

  return { spot, set, clear };
}

