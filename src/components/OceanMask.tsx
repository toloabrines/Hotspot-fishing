import { useEffect, useRef } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";

const LAND_GEOJSON_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson";

const LAND_PANE = "land-pane";

let cachedLand: GeoJSON.FeatureCollection | null = null;
let cachedLandPromise: Promise<GeoJSON.FeatureCollection> | null = null;

async function loadLand(): Promise<GeoJSON.FeatureCollection> {
  if (cachedLand) return cachedLand;
  if (!cachedLandPromise) {
    cachedLandPromise = fetch(LAND_GEOJSON_URL)
      .then((res) => res.json() as Promise<GeoJSON.FeatureCollection>)
      .then((data) => {
        cachedLand = data;
        return data;
      })
      .catch((error) => {
        cachedLandPromise = null;
        throw error;
      });
  }
  return cachedLandPromise;
}

/**
 * Pinta los continentes en beige claro (estilo carta náutica) ENCIMA de los
 * datos Copernicus pero DEBAJO de las etiquetas. Así la tierra siempre se ve
 * con un color claro y consistente — independiente de si los tiles satélite
 * cargan o no, y sin depender de blend modes que fallan con preferCanvas.
 *
 * Props:
 *   - enabled: activa/desactiva por completo la máscara.
 *   - fillOpacity: 0–1 opacidad del relleno de tierra (1 = opaco, tapa
 *     cualquier cuadrado blanco que el WMTS pinte sobre islas).
 *   - strokeOpacity: 0–1 opacidad del borde costero.
 *   - strokeWeight: grosor en px del borde costero.
 *
 * El parámetro `targetPaneClass` se mantiene por compatibilidad con la API
 * anterior pero ya no se usa.
 */
export function OceanMask({
  targetPaneClass: _targetPaneClass,
  enabled = true,
  fillOpacity = 1,
  strokeOpacity = 0.85,
  strokeWeight = 0.6,
}: {
  targetPaneClass: string;
  enabled?: boolean;
  fillOpacity?: number;
  strokeOpacity?: number;
  strokeWeight?: number;
}) {
  const map = useMap();
  const layerRef = useRef<L.GeoJSON | null>(null);

  // Crear/destruir capa cuando cambia `enabled`.
  useEffect(() => {
    if (!enabled) return;
    if (!map.getPane(LAND_PANE)) {
      const pane = map.createPane(LAND_PANE);
      // 450 = encima de los tiles oceánicos (overlayPane=400) pero por
      // debajo de markerPane (600), tooltipPane (650) y popupPane (700),
      // para que los popups del Top 1 no queden ocultos bajo la tierra.
      pane.style.zIndex = "450";
      pane.style.pointerEvents = "none";
    }

    let cancelled = false;

    loadLand()
      .then((geo) => {
        if (cancelled) return;
        const options = {
          renderer: L.svg({ pane: LAND_PANE }),
          pane: LAND_PANE,
          interactive: false,
          style: {
            fillColor: "var(--map-land)",
            fillOpacity,
            color: "var(--map-coast)",
            opacity: strokeOpacity,
            weight: strokeWeight,
          },
        } as unknown as L.GeoJSONOptions;
        const layer = L.geoJSON(geo, options);
        layer.addTo(map);
        layerRef.current = layer;
      })
      .catch((err) => {
        console.warn("OceanMask: failed to load land geojson", err);
      });

    return () => {
      cancelled = true;
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
    };
  }, [enabled, map]);

  // Re-aplicar estilos en caliente cuando cambien los sliders sin recrear la capa.
  useEffect(() => {
    const layer = layerRef.current;
    if (!enabled || !layer) return;
    layer.setStyle({
      fillColor: "var(--map-land)",
      fillOpacity,
      color: "var(--map-coast)",
      opacity: strokeOpacity,
      weight: strokeWeight,
    });
  }, [enabled, fillOpacity, strokeOpacity, strokeWeight]);

  return null;
}

