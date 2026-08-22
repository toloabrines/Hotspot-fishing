import { useEffect } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";

import { MALLORCA_SHALLOW_BATHYMETRY } from "../data/mallorca-shallow-bathymetry";
import type { ShallowBathymetryLine } from "../data/mallorca-shallow-bathymetry";

const PANE_NAME = "shallow-bathy-vector-pane";
const MIN_ZOOM = 8;

const LINE_STYLE: Record<ShallowBathymetryLine["level"], { color: string; weight: number }> = {
  10: { color: "#050505", weight: 2.15 },
  20: { color: "#050505", weight: 2.15 },
  30: { color: "#050505", weight: 2.15 },
  40: { color: "#050505", weight: 2.15 },
};

function toLatLngs(coords: [number, number][]): L.LatLngExpression[] {
  return coords.map(([lng, lat]) => [lat, lng]);
}

function lineLength(coords: [number, number][]) {
  return coords.reduce((sum, coord, index) => {
    if (index === 0) return sum;
    const prev = coords[index - 1];
    return sum + Math.hypot(coord[0] - prev[0], coord[1] - prev[1]);
  }, 0);
}

function midpoint(coords: [number, number][]): L.LatLngExpression {
  const [lng, lat] = coords[Math.floor(coords.length / 2)];
  return [lat, lng];
}

export function ShallowBathymetryLayer() {
  const map = useMap();

  useEffect(() => {
    const pane = map.getPane(PANE_NAME) ?? map.createPane(PANE_NAME);
    pane.style.zIndex = "449";
    pane.style.pointerEvents = "none";
    pane.style.background = "transparent";

    const group = L.layerGroup([], { pane: PANE_NAME }).addTo(map);

    const labelCounts: Record<ShallowBathymetryLine["level"], number> = {
      10: 0,
      20: 0,
      30: 0,
      40: 0,
    };

    MALLORCA_SHALLOW_BATHYMETRY.forEach((line) => {
      const latLngs = toLatLngs(line.coords);
      const style = LINE_STYLE[line.level];

      L.polyline(latLngs, {
        pane: PANE_NAME,
        color: style.color,
        weight: style.weight,
        opacity: 1,
        lineCap: "round",
        lineJoin: "round",
        smoothFactor: 0.45,
        interactive: false,
      }).addTo(group);

      if (lineLength(line.coords) > 0.045 && labelCounts[line.level] < 10) {
        labelCounts[line.level] += 1;
        L.marker(midpoint(line.coords), {
          pane: PANE_NAME,
          interactive: false,
          icon: L.divIcon({
            className: "shallow-bathy-label",
            html: `${line.level} m`,
            iconSize: [34, 14],
            iconAnchor: [17, 7],
          }),
        }).addTo(group);
      }
    });

    const syncZoomVisibility = () => {
      const visible = map.getZoom() >= MIN_ZOOM;
      pane.style.display = visible ? "" : "none";
    };

    syncZoomVisibility();
    map.on("zoomend", syncZoomVisibility);

    return () => {
      map.off("zoomend", syncZoomVisibility);
      group.remove();
    };
  }, [map]);

  return null;
}

export const SHALLOW_BATHYMETRY_PANE = PANE_NAME;

