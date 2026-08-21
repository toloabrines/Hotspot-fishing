import { useEffect } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";

/**
 * Límite oficial del Parque Nacional Marítimo-Terrestre del
 * Archipiélago de Cabrera (ampliación BOE 2019, ~90.800 ha).
 * Coordenadas [lng, lat] del polígono oficial publicado.
 */
const CABRERA_BOUNDARY: [number, number][] = [
  [38.948808, 2.8322409],
  [38.9488103, 3.082247],
  [39.1988197, 3.3822503],
  [39.2821553, 3.2489122],
  [39.2238203, 3.1822452],
  [39.2238189, 2.9655751],
  [39.1654831, 2.8905741],
  [39.0988142, 2.8905747],
  [39.0988154, 3.0155773],
  [38.948808, 2.8322409],
];

const PANE_NAME = "cabrera-park-pane";

export function CabreraParkBoundary() {
  const map = useMap();

  useEffect(() => {
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = "648";
      pane.style.pointerEvents = "none";
    }

    const polygon = L.polygon(CABRERA_BOUNDARY, {
      pane: PANE_NAME,
      color: "#22c55e",
      weight: 1,
      opacity: 1,
      fill: false,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(map);

    return () => {
      polygon.remove();
    };
  }, [map]);

  return null;
}

