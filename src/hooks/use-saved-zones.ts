/**
 * Persistencia local de "Frentes Productivos" detectados.
 *
 * Guarda un snapshot completo (zonas + corredores + bbox + fecha de los
 * datos Copernicus) en localStorage, para poder reabrirlo otro día y
 * comparar la evolución del frente sin tener que reanalizar.
 */

import { useCallback, useEffect, useState } from "react";
import type { GradientZone } from "../lib/gradient-zones.types";
import type { LatLng } from "../lib/geo-area";

export interface SavedZoneSet {
  id: string;
  /** Etiqueta editable (por defecto fecha + nº zonas). */
  name: string;
  /** Cuando se guardó (ms epoch). */
  savedAt: number;
  /** Fecha de los datos Copernicus que originaron las zonas (ISO YYYY-MM-DD). */
  dataDate: string | null;
  /** BBox del análisis (para recuperar la vista). */
  bbox: { south: number; west: number; north: number; east: number };
  zones: GradientZone[];
  corridors: Record<string, LatLng[] | undefined>;
}

const KEY = "totymar.savedZones.v1";
const MAX = 50;

function read(): SavedZoneSet[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as SavedZoneSet[]) : [];
  } catch {
    return [];
  }
}

function write(list: SavedZoneSet[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* quota — ignorar */
  }
}

export function useSavedZones() {
  const [sets, setSets] = useState<SavedZoneSet[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setSets(read());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    write(sets);
  }, [hydrated, sets]);

  const save = useCallback(
    (input: Omit<SavedZoneSet, "id" | "savedAt" | "name"> & { name?: string }) => {
      const id = `gz-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const dateLabel = input.dataDate ? input.dataDate.slice(0, 10) : "sin fecha";
      const name = input.name ?? `${dateLabel} · ${input.zones.length} zonas`;
      const entry: SavedZoneSet = {
        id,
        name,
        savedAt: Date.now(),
        dataDate: input.dataDate,
        bbox: input.bbox,
        zones: input.zones,
        corridors: input.corridors,
      };
      setSets((prev) => [entry, ...prev].slice(0, MAX));
      return entry;
    },
    [],
  );

  const remove = useCallback((id: string) => {
    setSets((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const rename = useCallback((id: string, name: string) => {
    setSets((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  }, []);

  const clear = useCallback(() => setSets([]), []);

  return { sets, hydrated, save, remove, rename, clear };
}

