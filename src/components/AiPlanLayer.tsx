/**
 * Capa de la carta con el plan de pesca de la IA:
 * Top 1/2/3, polígono de trabajo de cada zona y línea/flecha de deriva.
 */
import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import type { AdvisorPlanSpot } from "../lib/ai-advisor";

const PANE_NAME = "ai-plan-pane";
const COLORS = ["#f97316", "#38bdf8", "#a78bfa"];

interface Props {
  plan: AdvisorPlanSpot[] | null;
}

export function AiPlanLayer({ plan }: Props) {
  const map = useMap();
  const groupRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = "648";
    }
  }, [map]);

  useEffect(() => {
    groupRef.current?.remove();
    groupRef.current = null;
    if (!plan || plan.length === 0) return;

    const group = L.layerGroup([], { pane: PANE_NAME }).addTo(map);
    groupRef.current = group;

    plan.forEach((s) => {
      const color = COLORS[(s.rank - 1) % COLORS.length];

      L.polygon(
        s.polygon.map((p) => [p.lat, p.lng] as [number, number]),
        {
          pane: PANE_NAME,
          color,
          weight: 2,
          opacity: 0.95,
          fillColor: color,
          fillOpacity: 0.12,
        },
      ).addTo(group);

      if (s.driftLine && s.driftLine.length === 2) {
        L.polyline(
          s.driftLine.map((p) => [p.lat, p.lng] as [number, number]),
          { pane: PANE_NAME, color, weight: 3, opacity: 0.9, dashArray: "8,6" },
        ).addTo(group);
        const end = s.driftLine[1]!;
        L.marker([end.lat, end.lng], {
          pane: PANE_NAME,
          icon: L.divIcon({
            className: "",
            html: `<div style="transform:rotate(${s.driftBearingDeg ?? 0}deg);color:${color};font-size:18px;line-height:18px">➤</div>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          }),
        }).addTo(group);
      }

      L.marker([s.lat, s.lng], {
        pane: PANE_NAME,
        icon: L.divIcon({
          className: "",
          html:
            `<div style="background:${color};color:#000;font-weight:800;border-radius:9999px;` +
            `padding:2px 7px;font-size:11px;border:2px solid rgba(0,0,0,.5)">TOP ${s.rank}</div>`,
          iconSize: [52, 20],
          iconAnchor: [26, 10],
        }),
      })
        .bindTooltip(
          `<b>Top ${s.rank}</b> · ${s.scorePct}/100 · confianza ${s.confidence}<br/>` +
            `${s.depthM != null ? `${Math.round(s.depthM)} m` : "prof. n/d"}` +
            `${s.distanceNm != null ? ` · ${s.distanceNm.toFixed(1)} nm` : ""}` +
            `${s.bearingDeg != null ? ` · rumbo ${Math.round(s.bearingDeg)}°` : ""}`,
          { direction: "top", opacity: 0.95 },
        )
        .addTo(group);
    });

    return () => {
      group.remove();
    };
  }, [plan, map]);

  return null;
}

export default AiPlanLayer;

