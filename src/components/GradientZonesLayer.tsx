/**
 * Capa Leaflet — modo "Frentes Productivos" (corredores de pesca a la deriva).
 *
 * Renderiza los frentes oceanográficos más relevantes tras combinar SST,
 * clorofila, altimetría, convergencia de corrientes, FSLE (proxy) y
 * batimetría. El objetivo de pesca es la LÍNEA NARANJA del frente; el
 * círculo numerado es solo el punto de inicio/referencia.
 *
 * Si el usuario pulsa "Línea del frente" para una zona concreta, se sigue dibujando
 * ese corredor (compatibilidad con el flujo existente).
 */

import { useEffect, useRef, useState } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import type { GradientZone, GradientVariable } from "../lib/gradient-zones.types";
import type { LatLng } from "../lib/geo-area";
import { bufferCorridor } from "../lib/fishing-corridor";

interface CorridorPointLike extends LatLng {
  vars?: GradientVariable[];
  widthMeters?: number;
  score?: number;
  grads?: Partial<Record<GradientVariable, number>>;
}

interface GradientZonesLayerProps {
  zones: GradientZone[];
  corridors: Record<string, CorridorPointLike[] | undefined>;
  /** Puntos calientes marcados por zona. */
  hotPoints?: Record<string, LatLng | undefined>;
  focusedId?: string | null;
}

const PANE = "gradient-zones-pane";
const MAX_HOTSPOTS = 5;
const MIN_CONFIDENCE = 60; // Sólo "buenas". Si nadie llega, mostramos top 3.

function confidenceColor(c: number): string {
  if (c >= 75) return "#ef4444"; // rojo: frente premium
  if (c >= 60) return "#f97316"; // naranja: muy buena
  return "#facc15"; // amarillo: decente
}

function latLngDistM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

/** Texto curvado a lo largo de una polilínea para etiquetar el frente. */
function addCorridorLabel(map: L.Map, group: L.LayerGroup, points: LatLng[], text: string, color: string) {
  if (points.length < 4) return;
  const midIdx = Math.floor(points.length / 2);
  const p = points[midIdx];
  const prev = points[midIdx - 1];
  const next = points[midIdx + 1];
  if (!prev || !next) return;
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  const dx1 = (prev.lng - p.lng) * cosLat;
  const dy1 = prev.lat - p.lat;
  const bearing = ((Math.atan2(dx1, dy1) * 180) / Math.PI + 360) % 360;
  const icon = L.divIcon({
    className: "gradient-corridor-label",
    html: `<div style="
      transform:translate(-50%,-50%) rotate(${bearing}deg);
      color:${color};font:700 10px system-ui,sans-serif;
      white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.9);
      padding:1px 4px;border-radius:4px;background:rgba(15,23,42,.75);
      border:1px solid ${color};pointer-events:none;letter-spacing:.3px;
    ">${text}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
  L.marker([p.lat, p.lng], { pane: PANE, icon, interactive: false, keyboard: false }).addTo(group);
}

function bar(label: string, value: number, pass: boolean, suffix?: string): string {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  const color = pass ? "#22c55e" : "#64748b";
  const check = pass ? "✓" : "·";
  return `
    <div style="display:flex;align-items:center;gap:6px;margin:2px 0;">
      <span style="width:12px;color:${color};font-weight:700;">${check}</span>
      <span style="width:64px;font-size:11px;opacity:.9;">${label}</span>
      <span style="flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden;">
        <span style="display:block;height:100%;width:${pct}%;background:${color};"></span>
      </span>
      <span style="width:32px;text-align:right;font-size:10px;font-variant-numeric:tabular-nums;opacity:.85;">${pct}%</span>
      ${suffix ? `<span style="font-size:10px;opacity:.7;">${suffix}</span>` : ""}
    </div>
  `;
}

function buildHotspotPopup(zone: GradientZone, rank: number): string {
  const f = zone.factors ?? {};
  const PASS = 0.3;
  const conf = Math.round(zone.confidence);
  const color = confidenceColor(zone.confidence);
  const count = zone.passCount ?? 0;
  const depthInfo =
    zone.meanDepthM != null
      ? `${Math.round(zone.meanDepthM)} m${
          zone.depthSlope != null ? ` · talud ${Math.round(zone.depthSlope)} m/km` : ""
        }`
      : zone.depthSlope != null
        ? `Talud ${Math.round(zone.depthSlope)} m/km`
        : "Sin dato de profundidad";

  return `
    <div style="font:12px/1.4 system-ui,-apple-system,sans-serif;min-width:230px;color:#f1f5f9;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="display:inline-flex;align-items:center;justify-content:center;
                     width:22px;height:22px;border-radius:50%;background:${color};
                     color:#0f172a;font-weight:800;font-size:12px;">${rank}</span>
        <span style="flex:1;font-weight:700;font-size:13px;">Frente #${rank}</span>
        <span style="background:${color};color:#0f172a;padding:1px 6px;border-radius:8px;
                     font-weight:700;font-size:11px;">${conf}%</span>
      </div>
      <div style="font-size:11px;opacity:.85;margin-bottom:4px;">
        Punto de entrada · pesca la <strong style="color:${color};">línea del frente</strong>, no este círculo.
      </div>
      <div style="border-top:1px solid rgba(255,255,255,.12);padding-top:4px;">
        ${bar("SST", f.sst ?? 0, (f.sst ?? 0) >= PASS, "frente térmico")}
        ${bar("Clorofila", f.chl ?? 0, (f.chl ?? 0) >= PASS, "cambio bio.")}
        ${bar("Corrientes", f.conv ?? 0, (f.conv ?? 0) >= PASS, "convergencia")}
        ${bar("FSLE", f.fsle ?? 0, (f.fsle ?? 0) >= PASS, "filamento")}
        ${bar("Altimetría", f.alt ?? 0, (f.alt ?? 0) >= PASS, "mesoescala")}
      </div>
      <div style="margin-top:5px;padding-top:4px;border-top:1px solid rgba(255,255,255,.12);
                  display:flex;justify-content:space-between;font-size:11px;opacity:.85;">
        <span>📊 ${count}/5 capas coinciden</span>
        <span>🌊 ${depthInfo}</span>
      </div>
    </div>
  `;
}

function pickHotspots(zones: GradientZone[]): GradientZone[] {
  const sorted = zones.slice().sort((a, b) => b.confidence - a.confidence);
  const strong = sorted.filter((z) => z.confidence >= MIN_CONFIDENCE && (z.passCount ?? 0) >= 3);
  if (strong.length > 0) return strong.slice(0, MAX_HOTSPOTS);
  // Fallback: nada cumple el umbral → mostramos los 3 mejores aunque flojos,
  // para que el usuario siempre tenga referencia.
  return sorted.slice(0, 3);
}

export function GradientZonesLayer({ zones, corridors, hotPoints, focusedId }: GradientZonesLayerProps) {
  const map = useMap();
  const layerRef = useRef<L.LayerGroup | null>(null);
  const [viewBounds, setViewBounds] = useState<L.LatLngBounds | null>(() => {
    try {
      return map.getBounds();
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let pane = map.getPane(PANE);
    if (!pane) {
      pane = map.createPane(PANE);
      pane.style.zIndex = "660"; // por encima de SST/CHL/FSLE
    }
    pane.style.pointerEvents = "auto";
    const group = L.layerGroup([], { pane: PANE });
    group.addTo(map);
    layerRef.current = group;
    const update = () => setViewBounds(map.getBounds());
    update();
    map.on("moveend zoomend", update);
    return () => {
      map.off("moveend zoomend", update);
      group.remove();
      layerRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    const group = layerRef.current;
    if (!group) return;
    group.clearLayers();

    const inView = (p: { lat: number; lng: number }) =>
      !viewBounds || viewBounds.contains(L.latLng(p.lat, p.lng));

    const hotspots = pickHotspots(zones);

    hotspots.forEach((z, idx) => {
      const rank = idx + 1;
      const focused = z.id === focusedId;
      const centroid = z.axis.centroid;
      if (!inView(centroid)) return;

      const color = confidenceColor(z.confidence);
      const popupHtml = buildHotspotPopup(z, rank);

      // Halo exterior pulsante: ahora más discreto para que no eclipse al frente.
      L.circleMarker([centroid.lat, centroid.lng], {
        pane: PANE,
        radius: focused ? 18 : 14,
        color,
        weight: 1.5,
        opacity: 0.45,
        fillColor: color,
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(group);

      // Núcleo sólido con número: ahora es el punto de inicio/entrada,
      // NO el objetivo de pesca. Lo hacemos más pequeño para que la línea
      // del frente sea el elemento protagonista.
      const marker = L.circleMarker([centroid.lat, centroid.lng], {
        pane: PANE,
        radius: focused ? 12 : 9,
        color: "#0f172a",
        weight: 2,
        opacity: 1,
        fillColor: color,
        fillOpacity: 0.95,
        interactive: true,
      });
      marker.bindTooltip(
        `Inicio · Frente #${rank} · confianza ${Math.round(z.confidence)}%`,
        {
          direction: "top",
          offset: [0, -8],
        },
      );
      marker.bindPopup(popupHtml, {
        closeButton: true,
        autoPan: true,
        maxWidth: 280,
        className: "hotspot-popup-dark",
      });
      marker.on("click", () => marker.openPopup());
      marker.addTo(group);

      // Número del ranking como divIcon encima del marcador.
      const numberIcon = L.divIcon({
        className: "hotspot-rank-number",
        html: `<div style="
          color:#0f172a;font:800 10px system-ui,sans-serif;
          text-align:center;line-height:1;
          pointer-events:none;text-shadow:0 1px 2px rgba(255,255,255,.4);
        ">${rank}</div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 5],
      });
      L.marker([centroid.lat, centroid.lng], {
        pane: PANE,
        icon: numberIcon,
        interactive: false,
        keyboard: false,
      }).addTo(group);

      // Contorno tenue de la zona sólo si está enfocada (clic).
      if (focused && z.outline.length >= 2) {
        const visibleOutline = z.outline.filter(inView);
        if (visibleOutline.length >= 3) {
          L.polygon(visibleOutline.map((p) => [p.lat, p.lng]) as L.LatLngExpression[], {
            pane: PANE,
            color,
            weight: 1.5,
            opacity: 0.85,
            fillColor: color,
            fillOpacity: 0.18,
            dashArray: "4,6",
            interactive: false,
          }).addTo(group);
        }
      }

      // El corredor de pesca (línea naranja) es el protagonista: lo dibujamos
      // grueso, con flechas de dirección y una etiqueta "Frente" para que no
      // haya duda de dónde hay que pescar a la deriva.
      const corridor = corridors[z.id];
      if (corridor && corridor.length >= 2) {
        const visible = corridor.filter(inView);
        if (visible.length >= 2) {
          const band = bufferCorridor(visible as LatLng[], 2200).filter(inView);
          if (band.length >= 3) {
            L.polygon(band.map((p) => [p.lat, p.lng]) as L.LatLngExpression[], {
              pane: PANE,
              color,
              weight: 0,
              fillColor: color,
              fillOpacity: 0.12,
              smoothFactor: 0,
              interactive: false,
            }).addTo(group);
          }
          L.polyline(visible.map((p) => [p.lat, p.lng]) as L.LatLngExpression[], {
            pane: PANE,
            color,
            weight: focused ? 6 : 4,
            opacity: 0.95,
            lineCap: "round",
            lineJoin: "round",
            interactive: false,
          }).addTo(group);

          // Flechas de dirección cada ~3 km para mostrar el sentido del corredor.
          const arrowIntervalM = 3000;
          let distSince = 0;
          for (let i = 1; i < visible.length; i++) {
            const a = visible[i - 1];
            const b = visible[i];
            distSince += latLngDistM(a, b);
            if (distSince >= arrowIntervalM) {
              const cosLat = Math.cos(((a.lat + b.lat) / 2 * Math.PI) / 180);
              const dx = (b.lng - a.lng) * cosLat;
              const dy = b.lat - a.lat;
              const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
              const mid: LatLng = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
              const arrowIcon = L.divIcon({
                className: "gradient-corridor-arrow",
                html: `<div style="
                  color:${color};font:700 10px system-ui,sans-serif;
                  transform:translate(-50%,-50%) rotate(${bearing}deg);
                  text-shadow:0 0 3px rgba(0,0,0,.9);pointer-events:none;
                ">▶</div>`,
                iconSize: [0, 0],
                iconAnchor: [0, 0],
              });
              L.marker([mid.lat, mid.lng], { pane: PANE, icon: arrowIcon, interactive: false, keyboard: false }).addTo(group);
              distSince = 0;
            }
          }

          addCorridorLabel(map, group, visible as LatLng[], "FRENTE", color);
        }
      }

      // Punto caliente exacto marcado por el usuario.
      const hot = hotPoints?.[z.id];
      if (hot) {
        L.circleMarker([hot.lat, hot.lng], {
          pane: PANE,
          radius: focused ? 14 : 11,
          color: "#f43f5e",
          weight: 2.5,
          opacity: 1,
          fillColor: "#f43f5e",
          fillOpacity: 0.35,
          interactive: true,
        })
          .bindTooltip(`Punto exacto · Frente ${rank}`, {
            direction: "top",
            offset: [0, -8],
          })
          .addTo(group);

        const pinIcon = L.divIcon({
          className: "hotspot-hot-point-pin",
          html: `<div style="
            color:#f43f5e;font:800 14px system-ui,sans-serif;
            text-align:center;line-height:1;pointer-events:none;
            text-shadow:0 0 4px rgba(0,0,0,.8);
          ">📍</div>`,
          iconSize: [18, 18],
          iconAnchor: [9, 18],
        });
        L.marker([hot.lat, hot.lng], {
          pane: PANE,
          icon: pinIcon,
          interactive: false,
          keyboard: false,
        }).addTo(group);
      }
    });
  }, [zones, corridors, hotPoints, focusedId, viewBounds]);

  return null;
}

