import { useEffect, useMemo, useRef } from "react";
import { CircleMarker, Marker, Polyline, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { toDegMinSec } from "./FishingHotspots.types";

/** Project a lat/lng forward by `distanceM` meters along bearing (deg, 0=N). */
function destinationPoint(
  lat: number,
  lng: number,
  bearingDeg: number,
  distanceM: number,
): [number, number] {
  const R = 6371000;
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const dr = distanceM / R;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(br),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(br) * Math.sin(dr) * Math.cos(lat1),
      Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [(lat2 * 180) / Math.PI, (((lng2 * 180) / Math.PI + 540) % 360) - 180];
}

/** Great-circle distance in meters between two lat/lng points. */
function distM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 3 nautical miles in meters. */
const HEADING_LINE_M = 3 * 1852;

export interface GpsPosition {
  lat: number;
  lng: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
  timestamp: number;
}

interface GpsTrackerProps {
  position: GpsPosition | null;
  track: GpsPosition[];
  follow: boolean;
  /** Triggers a one-shot recenter when this number changes. */
  recenterTrigger?: number;
  /** Called when the user manually drags the map, so the parent can disable follow. */
  onUserPan?: () => void;
  /** Destino activo de navegación: dibuja la línea barco → destino. */
  navDestination?: { lat: number; lng: number; name: string } | null;
}

/** Builds a small "boat" SVG icon, rotated by heading (degrees, 0 = N). */
function buildBoatIcon(heading: number | null) {
  const rot = heading == null || Number.isNaN(heading) ? 0 : heading;
  const html = `
    <div style="transform: rotate(${rot}deg); transform-origin: 50% 50%;">
      <svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="boatShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#000" flood-opacity="0.55"/>
          </filter>
        </defs>
        <g filter="url(#boatShadow)">
          <circle cx="17" cy="17" r="14" fill="rgba(15,23,42,0.55)" stroke="#22d3ee" stroke-width="1.5"/>
          <path d="M17 4 L24 24 L17 21 L10 24 Z" fill="#22d3ee" stroke="#0e7490" stroke-width="1" stroke-linejoin="round"/>
          <circle cx="17" cy="17" r="2" fill="#0f172a" stroke="#22d3ee" stroke-width="1"/>
        </g>
      </svg>
    </div>`;
  return L.divIcon({
    html,
    className: "gps-boat-icon",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

export function GpsTracker({
  position,
  track,
  follow,
  recenterTrigger,
  onUserPan,
  navDestination,
}: GpsTrackerProps) {
  const map = useMap();
  const lastFollowRef = useRef<number>(0);
  const pendingRecenterRef = useRef<number | null>(null);

  // Detectar interacción manual del usuario para desactivar el follow.
  // Nota: nuestro auto-follow usa panTo (no cambia zoom), así que cualquier
  // zoomstart proviene del usuario (pinch, doble-tap, rueda, botones +/-).
  useMapEvents({
    dragstart: (e: L.LeafletEvent) => {
      // Solo desactivar si el drag lo inició el usuario, no nuestro panTo programático.
      if (follow && (e as L.LeafletMouseEvent)?.originalEvent) onUserPan?.();
    },
    zoomstart: () => {
      if (follow) onUserPan?.();
    },
  });

  // Auto-follow: keep map centered on the boat when follow mode is enabled.
  useEffect(() => {
    if (!position || !follow) return;
    // Throttle to avoid excessive panning.
    const now = Date.now();
    if (now - lastFollowRef.current < 800) return;
    lastFollowRef.current = now;
    map.panTo([position.lat, position.lng], { animate: true, duration: 0.6 });
  }, [follow, map, position]);

  // One-shot "Go to my position" trigger. Si aún no hay posición, lo dejamos
  // pendiente para disparar en cuanto el GPS reporte la primera fix.
  useEffect(() => {
    if (!recenterTrigger) return;
    if (position) {
      map.flyTo([position.lat, position.lng], Math.max(map.getZoom(), 11), { duration: 1.0 });
      pendingRecenterRef.current = null;
    } else {
      pendingRecenterRef.current = recenterTrigger;
    }
  }, [recenterTrigger, position, map]);

  // Si había un recenter pendiente y llega la primera posición, vuela ahora.
  useEffect(() => {
    if (pendingRecenterRef.current != null && position) {
      map.flyTo([position.lat, position.lng], Math.max(map.getZoom(), 11), { duration: 1.0 });
      pendingRecenterRef.current = null;
    }
  }, [position, map]);

  const gpsSvgRenderer = useMemo(() => L.svg({ pane: "gpsPane", padding: 1 }), []);

  // Rumbo = Course Over Ground (dirección real de desplazamiento).
  // Priorizamos el COG derivado del track (movimiento real) sobre el
  // `heading` del dispositivo, que a veces refleja la orientación del
  // teléfono/brújula y no hacia dónde se mueve la embarcación.
  const bearing = useMemo<number | null>(() => {
    const a = track[track.length - 2];
    const b = track[track.length - 1];
    const moved = a && b ? distM(a, b) : 0;
    if (moved >= 5) {
      const φ1 = (a.lat * Math.PI) / 180;
      const φ2 = (b.lat * Math.PI) / 180;
      const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
      const y = Math.sin(Δλ) * Math.cos(φ2);
      const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
      return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    }
    if (position?.heading != null && !Number.isNaN(position.heading)) return position.heading;
    return null;
  }, [track, position]);

  const boatIcon = useMemo(() => buildBoatIcon(bearing), [bearing]);

  if (!position) return null;

  const trackPoints: [number, number][] = track.map((p) => [p.lat, p.lng]);

  const headingEnd = destinationPoint(position.lat, position.lng, bearing ?? 0, HEADING_LINE_M);
  const headingLine: [number, number][] = [[position.lat, position.lng], headingEnd];


  return (
    <>
      {navDestination && (
        <>
          <Polyline
            positions={[[position.lat, position.lng], [navDestination.lat, navDestination.lng]]}
            pane="gpsPane"
            renderer={gpsSvgRenderer}
            pathOptions={{ color: "#ffffff", weight: 8, opacity: 0.85, lineCap: "round" }}
          />
          <Polyline
            positions={[[position.lat, position.lng], [navDestination.lat, navDestination.lng]]}
            pane="gpsPane"
            renderer={gpsSvgRenderer}
            pathOptions={{
              color: "#f59e0b",
              weight: 4,
              opacity: 1,
              dashArray: "10 8",
              lineCap: "round",
            }}
          />
          <CircleMarker
            center={[navDestination.lat, navDestination.lng]}
            radius={8}
            pane="gpsPane"
            renderer={gpsSvgRenderer}
            pathOptions={{ color: "#ffffff", weight: 3, fillColor: "#f59e0b", fillOpacity: 1 }}
          >
            <Tooltip direction="top" offset={[0, -10]} opacity={0.95}>
              <span className="text-[11px] font-semibold">{navDestination.name}</span>
            </Tooltip>
          </CircleMarker>
        </>
      )}

      {trackPoints.length > 1 && (
        <Polyline
          positions={trackPoints}
          pane="gpsPane"
          renderer={gpsSvgRenderer}
          pathOptions={{
            color: "#22d3ee",
            weight: 3,
            opacity: 0.85,
            lineCap: "round",
            lineJoin: "round",
          }}
        />
      )}

      {/* Línea de rumbo: 3 millas náuticas hacia adelante (siempre visible). */}
      <Polyline
        positions={headingLine}
        pane="gpsPane"
        renderer={gpsSvgRenderer}
        pathOptions={{
          color: "#ffffff",
          weight: 7,
          opacity: 1,
          lineCap: "round",
        }}
      />
      <Polyline
        positions={headingLine}
        pane="gpsPane"
        renderer={gpsSvgRenderer}
        pathOptions={{
          color: "#000000",
          weight: 4,
          opacity: 1,
          lineCap: "round",
        }}
      />
      <CircleMarker
        center={headingEnd}
        radius={5}
        pane="gpsPane"
        renderer={gpsSvgRenderer}
        pathOptions={{ color: "#ffffff", weight: 3, fillColor: "#000000", fillOpacity: 1 }}
      />

      {/* Accuracy circle (in meters) — en gpsPane para quedar SIEMPRE encima de SST/CHL/ALT/batimetría. */}
      <CircleMarker
        center={[position.lat, position.lng]}
        radius={Math.max(6, Math.min(40, position.accuracy / 10))}
        pane="gpsPane"
        renderer={gpsSvgRenderer}
        pathOptions={{ color: "#22d3ee", weight: 1, fillColor: "#22d3ee", fillOpacity: 0.12 }}
      />

      <Marker position={[position.lat, position.lng]} icon={boatIcon} pane="gpsPane">
        <Tooltip direction="top" offset={[0, -16]} opacity={0.95}>
          <div className="font-mono text-[11px] leading-tight">
            <div>{toDegMinSec(position.lat, "lat")}</div>
            <div>{toDegMinSec(position.lng, "lng")}</div>
            <div>±{position.accuracy.toFixed(0)} m</div>
            {position.speed != null && <div>{(position.speed * 1.94384).toFixed(1)} kn</div>}
          </div>
        </Tooltip>
      </Marker>
    </>
  );
}

