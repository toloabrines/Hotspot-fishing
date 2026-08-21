/**
 * FishingDirectionArrow — pinta una flecha DENTRO de cada zona amarilla
 * (GradientZone) indicando la MEJOR dirección de pesca / deriva
 * recomendada. Combina:
 *   - Corriente superficial (Open-Meteo Marine): factor principal. El pez
 *     se orienta de cara a la corriente, así que la deriva natural lleva
 *     el cebo "como una presa de verdad" en sentido del flujo.
 *   - Viento (Open-Meteo): factor secundario para predecir la deriva real
 *     del barco. Se mezcla con peso 0.75 corriente / 0.25 viento.
 *
 * Si la zona no tiene corriente ni viento, no se pinta nada.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import {
  fetchCopernicusCurrentVector,
  currentSpeedKnots,
  type CurrentVectorResult,
} from "../lib/copernicus-currents";
import { useWindForecast } from "../hooks/use-wind-forecast";
import type { GradientZone } from "../lib/gradient-zones.types";
import type { CurrentDepth } from "../lib/copernicus-currents";

interface Props {
  /** Spot manual / Top 1 — sigue mostrando flecha si se pasa. */
  spot?: { lat: number; lng: number } | null;
  /** Zonas amarillas: una flecha por zona, en su centroide. */
  zones?: GradientZone[];
  /** Profundidad seleccionada para corrientes (coincide con el panel). */
  depth?: CurrentDepth;
}

const CARDINALS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
function toCardinal(deg: number): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return CARDINALS[i];
}

function blendBearings(bearings: Array<{ deg: number; weight: number }>): number | null {
  let x = 0;
  let y = 0;
  let wsum = 0;
  for (const b of bearings) {
    if (!Number.isFinite(b.deg) || b.weight <= 0) continue;
    const r = (b.deg * Math.PI) / 180;
    x += Math.sin(r) * b.weight;
    y += Math.cos(r) * b.weight;
    wsum += b.weight;
  }
  if (wsum === 0 || (x === 0 && y === 0)) return null;
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

function SingleArrow({
  point,
  zoomTick,
  axisBearing,
  depth,
}: {
  point: { lat: number; lng: number };
  zoomTick: number;
  /** Rumbo del eje del frente (grados). Si se pasa, la flecha se alinea PARALELA al frente. */
  axisBearing?: number | null;
  depth: CurrentDepth;
}) {
  const map = useMap();
  const [current, setCurrent] = useState<CurrentVectorResult | null>(null);
  const { wind } = useWindForecast(point.lat, point.lng);

  useEffect(() => {
    const ctrl = new AbortController();
    const zoom = Math.min(Math.max(map.getZoom(), 3), 9);
    fetchCopernicusCurrentVector({
      lat: point.lat,
      lng: point.lng,
      zoom,
      depth,
      signal: ctrl.signal,
    })
      .then((r) => {
        if (!ctrl.signal.aborted) setCurrent(r);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [map, point.lat, point.lng, depth]);

  const currentKn = current ? currentSpeedKnots(current.speed) : 0;

  const bestBearing = useMemo<number | null>(() => {
    const parts: Array<{ deg: number; weight: number }> = [];
    if (current && Number.isFinite(current.dirDeg)) {
      const w = Math.max(0.5, Math.min(1.5, currentKn * 1.5));
      // current.dirDeg es procedencia; la flecha de pesca apunta hacia
      // donde realmente nos lleva la deriva (sentido del flujo).
      parts.push({ deg: (current.dirDeg + 180) % 360, weight: w * 0.75 });
    }
    if (wind && Number.isFinite(wind.dirDeg)) {
      const windTo = (wind.dirDeg + 180) % 360;
      const w = Math.max(0.3, Math.min(1, wind.avgKn / 15));
      parts.push({ deg: windTo, weight: w * 0.25 });
    }
    const blended = blendBearings(parts);
    if (blended == null) return axisBearing ?? null;
    if (axisBearing != null && Number.isFinite(axisBearing)) {
      const a = ((axisBearing % 360) + 360) % 360;
      const b = (a + 180) % 360;
      const diff = (x: number, y: number) => {
        const d = Math.abs(((x - y + 540) % 360) - 180);
        return d;
      };
      return diff(blended, a) <= diff(blended, b) ? a : b;
    }
    return blended;
  }, [current, currentKn, wind, axisBearing]);

  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (bestBearing == null) {
      if (layerRef.current) {
        layerRef.current.remove();
        layerRef.current = null;
      }
      return;
    }

    const origin = L.latLng(point.lat, point.lng);
    const rad = (bestBearing * Math.PI) / 180;

    const color = "#22d3ee";

    const arrowHtml = `
      <div style="transform: translate(-50%,-50%) rotate(${bestBearing}deg); transform-origin:center;">
        <svg width="24" height="24" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.6));">
          <path d="M14 2 L24 22 L14 17 L4 22 Z" fill="${color}" stroke="#0b1220" stroke-width="1.8" stroke-linejoin="round"/>
        </svg>
      </div>`;
    const head = L.marker(origin, {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: "fishing-direction-arrow-head",
        html: arrowHtml,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      }),
    });

    const cardinal = toCardinal(bestBearing);
    const deg = Math.round(bestBearing).toString().padStart(3, "0");
    const knots = current ? `${currentKn.toFixed(2)} kn` : "—";
    const labelHtml = `
      <div style="
        background:rgba(8,15,26,0.85);
        color:#e0f2fe;
        border:1px solid #22d3ee;
        border-radius:6px;
        padding:2px 6px;
        font:600 10px/1.2 ui-sans-serif,system-ui;
        white-space:nowrap;
        box-shadow:0 2px 6px rgba(0,0,0,0.5);
        pointer-events:none;
      ">
        🎣 ${cardinal} ${deg}° · ${knots}
      </div>`;
    const label = L.marker(origin, {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: "fishing-direction-arrow-label",
        html: labelHtml,
        iconSize: [0, 0],
        iconAnchor: [-8 + Math.round(-Math.sin(rad) * 4), -8 + Math.round(Math.cos(rad) * 4)],
      }),
    });

    const group = L.layerGroup([head, label]).addTo(map);
    layerRef.current = group;

    return () => {
      group.remove();
      if (layerRef.current === group) layerRef.current = null;
    };
  }, [map, point.lat, point.lng, bestBearing, currentKn, wind?.avgKn, zoomTick]);

  return null;
}

export function FishingDirectionArrow({ spot, zones, depth = "surface" }: Props) {
  const map = useMap();
  const [zoomTick, setZoomTick] = useState(0);

  useEffect(() => {
    if (!map) return;
    const handler = () => setZoomTick((n) => n + 1);
    map.on("zoomend", handler);
    return () => {
      map.off("zoomend", handler);
    };
  }, [map]);

  const points = useMemo(() => {
    const out: Array<{ key: string; lat: number; lng: number; axisBearing?: number | null }> = [];
    if (zones && zones.length) {
      for (const z of zones) {
        const c = z.axis?.centroid;
        if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
          let axisBearing: number | null = null;
          const d = z.axis?.dir;
          if (
            d &&
            Number.isFinite(d.lat) &&
            Number.isFinite(d.lng) &&
            (d.lat !== 0 || d.lng !== 0)
          ) {
            // dir está en lat/lng (deltas). Bearing = atan2(dLng·cos(lat), dLat)
            const cosLat = Math.cos((c.lat * Math.PI) / 180);
            axisBearing = ((Math.atan2(d.lng * cosLat, d.lat) * 180) / Math.PI + 360) % 360;
          }
          out.push({ key: `z:${z.id}`, lat: c.lat, lng: c.lng, axisBearing });
        }
      }
    }
    if (spot && Number.isFinite(spot.lat) && Number.isFinite(spot.lng)) {
      out.push({
        key: `s:${spot.lat.toFixed(4)},${spot.lng.toFixed(4)}`,
        lat: spot.lat,
        lng: spot.lng,
      });
    }
    return out;
  }, [spot?.lat, spot?.lng, zones]);

  return (
    <>
      {points.map((p) => (
        <SingleArrow
          key={p.key}
          point={{ lat: p.lat, lng: p.lng }}
          zoomTick={zoomTick}
          axisBearing={p.axisBearing}
          depth={depth}
        />
      ))}
    </>
  );
}

