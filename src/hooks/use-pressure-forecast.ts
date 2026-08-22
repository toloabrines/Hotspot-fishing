import { useEffect, useState } from "react";
import { fetchPressureForecast, type PressureForecast } from "../lib/pressure-forecast";

/**
 * Hook ligero: pide presión atmosférica + tendencia 24 h (Open-Meteo)
 * para un punto. Cache interno de 30 min y cancelación en cleanup.
 */
export function usePressureForecast(lat: number | null, lng: number | null) {
  const [data, setData] = useState<PressureForecast | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (lat == null || lng == null) {
      setData(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    fetchPressureForecast(lat, lng, ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [lat, lng]);

  return { pressure: data, loading };
}

