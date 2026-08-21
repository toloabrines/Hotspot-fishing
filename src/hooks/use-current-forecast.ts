import { useEffect, useState } from "react";
import { fetchCurrentForecast, type CurrentForecast } from "../lib/current-forecast";

/**
 * Hook ligero: pide pronóstico de corriente superficial (Open-Meteo Marine)
 * para un punto. Cache interno de 30 min y cancelación en cleanup.
 */
export function useCurrentForecast(lat: number | null, lng: number | null) {
  const [data, setData] = useState<CurrentForecast | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (lat == null || lng == null) {
      setData(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    fetchCurrentForecast(lat, lng, ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [lat, lng]);

  return { current: data, loading };
}

