import { useEffect, useMemo, useState } from "react";
import { computeSolunar, type SolunarSummary } from "../lib/solunar";

/**
 * Hook: calcula la tabla solunar para un punto y se actualiza cada minuto
 * para que la ventana "próxima" no se quede obsoleta.
 */
export function useSolunar(lat: number | null, lng: number | null): SolunarSummary | null {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => {
    if (lat == null || lng == null) return null;
    return computeSolunar(lat, lng, new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng, tick]);
}

