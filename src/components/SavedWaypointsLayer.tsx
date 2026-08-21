import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import type { SavedWaypoint } from "../hooks/use-saved-waypoints";
import { toDegMinSec } from "./FishingHotspots.types";

interface SavedWaypointsLayerProps {
  waypoints: SavedWaypoint[];
  onRemove?: (id: string) => void;
}

/**
 * Renderiza chinchetas FIJAS en el mapa para cada waypoint guardado.
 * Las coordenadas son absolutas (lat/lng) → la posición no cambia al
 * mover, hacer zoom o cambiar de capa.
 *
 * Usamos un LayerGroup sobre el markerPane estándar de Leaflet para que
 * las transformaciones de pan/zoom las gestione la propia librería y los
 * marcadores no se "muevan" respecto al terreno.
 */
export function SavedWaypointsLayer({ waypoints, onRemove }: SavedWaypointsLayerProps) {
  const map = useMap();
  const groupRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());

  // Crear el LayerGroup una vez.
  useEffect(() => {
    if (!groupRef.current) {
      groupRef.current = L.layerGroup().addTo(map);
    }
    return () => {
      if (groupRef.current) {
        groupRef.current.remove();
        groupRef.current = null;
      }
      markersRef.current.clear();
    };
  }, [map]);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const current = markersRef.current;
    const nextIds = new Set(waypoints.map((w) => w.id));

    // Quitar marcadores que ya no existen
    for (const [id, marker] of current.entries()) {
      if (!nextIds.has(id)) {
        group.removeLayer(marker);
        current.delete(id);
      }
    }

    // Añadir/actualizar
    waypoints.forEach((w) => {
      let marker = current.get(w.id);
      const html = `
        <div style="position:relative;width:92px;height:58px;display:flex;align-items:flex-start;justify-content:center;filter:drop-shadow(0 2px 3px rgba(0,0,0,0.55));">
          <svg width="30" height="38" viewBox="0 0 30 38" xmlns="http://www.w3.org/2000/svg">
            <path d="M15 1 C7 1 2 7 2 14 C2 22 15 36 15 36 C15 36 28 22 28 14 C28 7 23 1 15 1 Z"
              fill="#dc2626" stroke="#fff" stroke-width="1.5"/>
            <circle cx="15" cy="14" r="5.5" fill="#fff"/>
            <text x="15" y="17.5" text-anchor="middle" font-size="9" font-weight="bold" fill="#dc2626" font-family="ui-sans-serif,system-ui">📌</text>
          </svg>
          <div style="position:absolute;top:36px;left:50%;transform:translateX(-50%);max-width:90px;border:1px solid rgba(255,255,255,0.75);background:rgba(127,29,29,0.94);color:white;border-radius:5px;padding:2px 5px;font:700 10px ui-sans-serif,system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(w.name)}</div>
        </div>`;
      const icon = L.divIcon({
        html,
        className: "saved-waypoint-icon",
        iconSize: [92, 58],
        iconAnchor: [46, 36],
        popupAnchor: [0, -32],
      });

      if (!marker) {
        // Usamos el markerPane estándar de Leaflet (sin pane custom) para
        // garantizar que la posición geográfica permanece fija al pan/zoom.
        marker = L.marker([w.lat, w.lng], { icon, keyboard: false, riseOnHover: true });
        group.addLayer(marker);
        current.set(w.id, marker);
      } else {
        marker.setIcon(icon);
        marker.setLatLng([w.lat, w.lng]);
      }

      const dms = `${toDegMinSec(w.lat, "lat")}<br/>${toDegMinSec(w.lng, "lng")}`;
      const depth = w.depth != null ? `${Math.round(w.depth)} m` : "N/D";
      const popupHtml = `
        <div style="font-family:ui-sans-serif,system-ui;min-width:170px">
          <div style="font-weight:700;font-size:12px;margin-bottom:4px;color:#dc2626">📌 ${escapeHtml(w.name)}</div>
          <div style="font-family:ui-monospace,monospace;font-size:11px;line-height:1.35">${dms}</div>
          <div style="font-size:10px;color:#666;margin-top:4px">Fondo: ${depth} · ${Math.round(w.score * 100)}%</div>
          <button data-remove-id="${w.id}" style="margin-top:6px;width:100%;padding:4px;font-size:10px;border:1px solid #dc2626;background:#fee2e2;color:#dc2626;border-radius:4px;cursor:pointer;font-weight:600">🗑 Eliminar waypoint</button>
        </div>`;
      marker.bindPopup(popupHtml, { autoClose: true, closeButton: true });

      marker.off("popupopen");
      marker.on("popupopen", (ev) => {
        const popupEl = (ev as L.PopupEvent).popup.getElement();
        const btn = popupEl?.querySelector<HTMLButtonElement>("[data-remove-id]");
        if (btn && onRemove) {
          btn.onclick = () => {
            onRemove(w.id);
            marker?.closePopup();
          };
        }
      });
    });
  }, [waypoints, onRemove]);

  return null;
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

