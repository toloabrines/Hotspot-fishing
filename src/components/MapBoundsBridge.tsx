import { useEffect } from "react";
import { useMap, useMapEvents } from "react-leaflet";

/**
 * Pequeño componente que registra una función para obtener
 * los bounds visibles del mapa actual. Permite a la UI fuera
 * del mapa pedir "el área visible ahora mismo" sin tener que
 * mantener un estado en cada moveend.
 */
interface Props {
  onReady: (
    getBounds: () => {
      sw: { lat: number; lng: number };
      ne: { lat: number; lng: number };
      center: { lat: number; lng: number };
      zoom: number;
    },
  ) => void;
}

export function MapBoundsBridge({ onReady }: Props) {
  const map = useMap();

  useEffect(() => {
    onReady(() => {
      const b = map.getBounds();
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      const c = map.getCenter();
      return {
        sw: { lat: sw.lat, lng: sw.lng },
        ne: { lat: ne.lat, lng: ne.lng },
        center: { lat: c.lat, lng: c.lng },
        zoom: map.getZoom(),
      };
    });
  }, [map, onReady]);


  // No-op listener para que React-Leaflet considere el componente "vivo".
  useMapEvents({});

  return null;
}

