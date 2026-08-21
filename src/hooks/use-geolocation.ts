import { useCallback, useEffect, useRef, useState } from "react";
import type { GpsPosition } from "../components/GpsTracker";
import { downloadGeneratedFile } from "../lib/file-export";

export type GeolocationError =
  | "permission_denied"
  | "position_unavailable"
  | "timeout"
  | "unsupported"
  | "insecure_context"
  | "unknown";

interface UseGeolocationResult {
  active: boolean;
  position: GpsPosition | null;
  track: GpsPosition[];
  error: GeolocationError | null;
  start: () => void;
  stop: () => void;
  clearTrack: () => void;
  setTrack: React.Dispatch<React.SetStateAction<GpsPosition[]>>;
}

/** Minimum distance (meters) between consecutive track points to record a new one. */
const TRACK_MIN_DISTANCE_M = 8;

function haversine(a: GpsPosition, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function useGeolocation(): UseGeolocationResult {
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState<GpsPosition | null>(null);
  const [track, setTrack] = useState<GpsPosition[]>([]);
  const [error, setError] = useState<GeolocationError | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const lastFixAtRef = useRef<number | null>(null);


  const acceptPosition = useCallback((pos: GeolocationPosition) => {
    const next: GpsPosition = {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      heading: pos.coords.heading ?? null,
      speed: pos.coords.speed ?? null,
      timestamp: pos.timestamp,
    };
    lastFixAtRef.current = Date.now();
    setError(null);

    setPosition(next);
    setTrack((prev) => {
      const last = prev[prev.length - 1];
      if (!last || haversine(last, next) >= TRACK_MIN_DISTANCE_M) return [...prev, next];
      return prev;
    });
  }, []);

  const rejectPosition = useCallback((err: GeolocationPositionError) => {
    if (err.code === err.PERMISSION_DENIED) {
      activeRef.current = false;
      setActive(false);
      setError("permission_denied");
    } else if (err.code === err.POSITION_UNAVAILABLE) setError("position_unavailable");
    else if (err.code === err.TIMEOUT) setError("timeout");
    else setError("unknown");
  }, []);

  const stop = useCallback(() => {
    if (watchIdRef.current != null && typeof navigator !== "undefined") {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
    activeRef.current = false;
    setActive(false);
  }, []);

  const start = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!("geolocation" in navigator)) {
      setError("unsupported");
      return;
    }
    // iOS Safari only exposes geolocation on secure contexts.
    if (!window.isSecureContext && window.location.hostname !== "localhost") {
      setError("insecure_context");
      return;
    }

    setError(null);
    if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    activeRef.current = true;
    lastFixAtRef.current = Date.now();
    setActive(true);


    const options: PositionOptions = { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 };
    // Una lectura inmediata acelera el primer centrado; el watch mantiene el barco en movimiento.
    navigator.geolocation.getCurrentPosition(acceptPosition, rejectPosition, options);
    const id = navigator.geolocation.watchPosition(acceptPosition, rejectPosition, options);

    watchIdRef.current = id;
  }, [acceptPosition, rejectPosition]);

  const clearTrack = useCallback(() => setTrack([]), []);

  useEffect(() => {
    // Algunos WebView pausan el proveedor al girar o mandar la app al fondo.
    // Al volver visible (o tras rotar) reenganchamos el watch sin perder el track.
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const restart = (delay = 0) => {
      if (!activeRef.current) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (activeRef.current) start();
      }, delay);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") restart(150);
    };
    const onOrientation = () => restart(450);

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("resume", onVisible);
    window.addEventListener("orientationchange", onOrientation);
    screen.orientation?.addEventListener?.("change", onOrientation);

    // Vigilante: si el watch deja de emitir más de 25 s, lo recreamos solo.
    const watchdog = setInterval(() => {
      if (!activeRef.current || document.visibilityState !== "visible") return;
      const last = lastFixAtRef.current;
      if (last && Date.now() - last > 25000) restart(0);
    }, 10000);

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("resume", onVisible);
      window.removeEventListener("orientationchange", onOrientation);
      screen.orientation?.removeEventListener?.("change", onOrientation);
      if (watchIdRef.current != null && typeof navigator !== "undefined") {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, [start]);


  return { active, position, track, error, start, stop, clearTrack, setTrack };
}

export function exportTrackAsGpx(track: GpsPosition[], name = "Totymar track"): string {
  const points = track
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"><time>${new Date(
          p.timestamp,
        ).toISOString()}</time></trkpt>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Hotspot Fishing" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>`;
}

export async function downloadGpx(track: GpsPosition[]) {
  if (track.length === 0) {
    if (typeof window !== "undefined")
      window.alert("El track está vacío. Activa GPS y navega un poco antes de exportar.");
    return;
  }
  const gpx = exportTrackAsGpx(track);
  const filename = `totymar-track-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.gpx`;
  await downloadGeneratedFile({
    filename,
    mime: "application/gpx+xml",
    content: gpx,
    shareTitle: filename,
    shareText: "Track GPS Totymar",
  });
}

