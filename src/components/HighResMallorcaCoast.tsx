import { useEffect, useRef } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";
import { loadMallorcaPolygon } from "../lib/mallorca-polygon";

/**
 * High-resolution Mallorca coastline. Ver `loadMallorcaPolygon` para la
 * carga/caché del polígono OSM. Aquí pintamos SOLO la línea de costa
 * (z=462, sobre SST/CHL/ALT/batimetría). No rellenamos tierra para evitar
 * que una masa gris tape el mar o las capas oceanográficas.
 */

const COAST_PANE = "hr-mallorca-coast-pane";

export function HighResMallorcaCoast({ enabled = true }: { enabled?: boolean }) {
  const map = useMap();
  const layersRef = useRef<L.Layer[]>([]);

  useEffect(() => {
    if (!enabled) return;

    // Coastline pane: encima de SST/CHL/ALT y de la batimetría, para que el
    // contorno de la isla siempre se lea nítido (estilo carta náutica).
    const coastPane = map.getPane(COAST_PANE) ?? map.createPane(COAST_PANE);
    coastPane.style.zIndex = "462";
    coastPane.style.pointerEvents = "none";

    let cancelled = false;

    loadMallorcaPolygon().then((geo) => {
      if (cancelled || !geo) return;
      const feature: GeoJSON.Feature = { type: "Feature", geometry: geo, properties: {} };

      const coast = L.geoJSON(feature, {
        pane: COAST_PANE,
        interactive: false,
        style: {
          fillOpacity: 0,
          color: "var(--map-coast)",
          weight: 1.4,
          opacity: 0.9,
          lineJoin: "round",
          lineCap: "round",
        },
      } as L.GeoJSONOptions).addTo(map);

      layersRef.current = [coast];
    });

    return () => {
      cancelled = true;
      for (const l of layersRef.current) {
        try {
          map.removeLayer(l);
        } catch {
          /* noop */
        }
      }
      layersRef.current = [];
    };
  }, [enabled, map]);

  return null;
}

