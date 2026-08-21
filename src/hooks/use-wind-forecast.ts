import { useEffect, useState } from "react";
import { fetchWindForecast, type WindForecast } from "../lib/wind-forecast";

/**
 * Hook ligero: pide pronóstico de viento (Open-Meteo) para un punto.
 * Se cachea internamente por 30 min y se cancela en cleanup.
 */
export function useWindForecast(lat: number | null, lng: number | null) {
  const [data, setData] = useState<WindForecast | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (lat == null || lng == null) {
      setData(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    fetchWindForecast(lat, lng, ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [lat, lng]);

  return { wind: data, loading };
}

