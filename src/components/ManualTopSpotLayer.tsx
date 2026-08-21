/**
 * ManualTopSpotLayer — pinta el "Top 1 manual" del usuario sobre el mapa,
 * traza una línea desde la posición GPS al punto y permite:
 *   - crear el punto con pulsación larga (contextmenu en móvil/desktop)
 *   - arrastrar el marcador para reposicionarlo
 *   - mostrar distancia (millas náuticas), rumbo y ETA según la velocidad GPS
 *
 * El punto vive en localStorage (ver use-manual-top-spot), así sobrevive a
 * cambios de capa y recargas. NUNCA se recalcula automáticamente.
 */

import { useEffect, useMemo, useRef } from "react";
import { useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { GpsPosition } from "./GpsTracker";
import type { ManualTopSpot } from "../hooks/use-manual-top-spot";
import { toDegMinSec } from "./FishingHotspots.types";

interface Props {
  spot: ManualTopSpot | null;
  gpsPosition?: GpsPosition | null;
  onSet: (lat: number, lng: number) => void;
  onMove: (lat: number, lng: number) => void;
  onClear: () => void;
}

const METERS_PER_NM = 1852;

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const φ1 = toRad(aLat);
  const φ2 = toRad(bLat);
  const dλ = toRad(bLng - aLng);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "–";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h} h ${String(mm).padStart(2, "0")} min`;
}

function buildIcon() {
  const html = `
    <div style="position:relative;width:40px;height:48px;display:flex;align-items:flex-start;justify-content:center;filter:drop-shadow(0 3px 4px rgba(0,0,0,0.65));">
      <svg width="40" height="48" viewBox="0 0 40 48" xmlns="http://www.w3.org/2000/svg">
        <path d="M20 1 C9 1 2 9 2 19 C2 31 20 46 20 46 C20 46 38 31 38 19 C38 9 31 1 20 1 Z"
          fill="#f59e0b" stroke="#fff" stroke-width="2.2"/>
        <circle cx="20" cy="18" r="11" fill="#000"/>
        <text x="20" y="22" text-anchor="middle" font-size="11" font-weight="900"
          fill="#f59e0b" font-family="ui-sans-serif,system-ui">T1</text>
      </svg>
    </div>`;
  return L.divIcon({
    html,
    className: "manual-top-spot-icon",
    iconSize: [40, 48],
    iconAnchor: [20, 46],
  });
}

export function ManualTopSpotLayer({ spot, gpsPosition, onSet, onMove, onClear }: Props) {
  const map = useMap();

  // Pulsación larga / clic derecho → fijar nuevo T1. Leaflet dispara
  // `contextmenu` también al mantener pulsado en móvil (gracias a su tap
  // handler), por lo que cubre ambos casos.
  useMapEvents({
    contextmenu: (e) => {
      const target = e.originalEvent?.target as HTMLElement | null;
      if (target && target.closest(".leaflet-control, [data-no-map-click]")) return;
      e.originalEvent?.preventDefault?.();
      onSet(e.latlng.lat, e.latlng.lng);
    },
  });

  // Marcador draggable (creado imperativamente para tener acceso fino al drag).
  const markerRef = useRef<L.Marker | null>(null);
  const lineRef = useRef<L.Polyline | null>(null);
  const lineGlowRef = useRef<L.Polyline | null>(null);
  const labelRef = useRef<L.Marker | null>(null);
  const icon = useMemo(buildIcon, []);

  // Crear / actualizar marcador.
  useEffect(() => {
    if (!spot) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      const m = L.marker([spot.lat, spot.lng], {
        icon,
        draggable: true,
        autoPan: true,
        keyboard: false,
        zIndexOffset: 1000,
      });
      m.on("dragend", () => {
        const ll = m.getLatLng();
        onMove(ll.lat, ll.lng);
      });
      m.addTo(map);
      markerRef.current = m;
    } else {
      markerRef.current.setLatLng([spot.lat, spot.lng]);
    }
  }, [spot, icon, map, onMove]);

  // Línea GPS → T1 + etiqueta con distancia, rumbo y ETA. Se recalcula en
  // cada cambio de posición GPS o del spot.
  useEffect(() => {
    // Limpiar todo si falta algo.
    const cleanup = () => {
      lineRef.current?.remove();
      lineGlowRef.current?.remove();
      labelRef.current?.remove();
      lineRef.current = null;
      lineGlowRef.current = null;
      labelRef.current = null;
    };
    if (!spot || !gpsPosition) {
      cleanup();
      return;
    }

    const a: [number, number] = [gpsPosition.lat, gpsPosition.lng];
    const b: [number, number] = [spot.lat, spot.lng];

    const distM = haversineM(a[0], a[1], b[0], b[1]);
    const distNm = distM / METERS_PER_NM;
    const brg = Math.round(bearingDeg(a[0], a[1], b[0], b[1]));
    const speedMs = gpsPosition.speed && gpsPosition.speed > 0.1 ? gpsPosition.speed : null;
    const etaStr = speedMs ? formatEta(distM / speedMs) : null;

    // Halo blanco + línea amarilla discontinua bien visible.
    if (!lineGlowRef.current) {
      lineGlowRef.current = L.polyline([a, b], {
        pane: "gpsPane",
        color: "#000000",
        weight: 7,
        opacity: 0.45,
        lineCap: "round",
      }).addTo(map);
    } else {
      lineGlowRef.current.setLatLngs([a, b]);
    }
    if (!lineRef.current) {
      lineRef.current = L.polyline([a, b], {
        pane: "gpsPane",
        color: "#fbbf24",
        weight: 3,
        opacity: 1,
        dashArray: "8 8",
        lineCap: "round",
      }).addTo(map);
    } else {
      lineRef.current.setLatLngs([a, b]);
    }

    // Etiqueta flotante a mitad de camino.
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const distLabel =
      distNm < 0.1
        ? `${Math.round(distM)} m`
        : distNm < 10
          ? `${distNm.toFixed(2)} MN`
          : `${distNm.toFixed(1)} MN`;
    const html = `
      <div style="
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        font-weight: 700;
        color: #fde68a;
        background: rgba(4,16,28,0.92);
        border: 1px solid rgba(251,191,36,0.6);
        padding: 3px 6px;
        border-radius: 6px;
        white-space: nowrap;
        box-shadow: 0 2px 6px rgba(0,0,0,0.6);
        transform: translate(-50%, -50%);
      ">
        GPS → T1: ${distLabel} · ${String(brg).padStart(3, "0")}°${etaStr ? ` · ${etaStr}` : ""}
      </div>`;
    const labelIcon = L.divIcon({
      html,
      className: "manual-top-spot-label",
      iconSize: [1, 1],
      iconAnchor: [0, 0],
    });
    if (!labelRef.current) {
      labelRef.current = L.marker(mid, {
        icon: labelIcon,
        pane: "gpsPane",
        interactive: false,
        keyboard: false,
      }).addTo(map);
    } else {
      labelRef.current.setLatLng(mid);
      labelRef.current.setIcon(labelIcon);
    }

    return cleanup;
  }, [spot, gpsPosition, map]);

  // Limpieza total al desmontar.
  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      lineRef.current?.remove();
      lineGlowRef.current?.remove();
      labelRef.current?.remove();
      markerRef.current = null;
      lineRef.current = null;
      lineGlowRef.current = null;
      labelRef.current = null;
    };
  }, []);

  // No-op JSX: todo se renderiza imperativamente para tener control fino del
  // drag. Exponemos `onClear` por API pero el botón vive fuera (route).
  void onClear;
  return null;
}

/** Pretty-print de coordenadas en grados/minutos/segundos. */
export function formatLatLngDMS(lat: number, lng: number) {
  return `${toDegMinSec(lat, "lat")} · ${toDegMinSec(lng, "lng")}`;
}

