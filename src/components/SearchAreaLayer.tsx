import { useEffect, useRef, useState } from "react";
import { useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { SearchArea } from "../lib/geo-area";

/**
 * Modo de dibujo. Solo se admite "triangle" (a petición del usuario:
 * el rectángulo y el polígono libre causaban inestabilidad y parpadeo).
 * Se mantiene el tipo unión por compatibilidad con el resto del código.
 */
export type DrawMode = "triangle" | "rect" | "polygon" | null;

interface SearchAreaLayerProps {
  mode: DrawMode;
  area: SearchArea | null;
  onAreaChange: (area: SearchArea | null) => void;
  onDrawEnd: () => void;
}

const PANE_NAME = "search-area-pane";
const COLOR = "#22d3ee";
const FILL = "#22d3ee";

export function SearchAreaLayer({ mode, area, onAreaChange, onDrawEnd }: SearchAreaLayerProps) {
  const map = useMap();
  const layerRef = useRef<L.Layer | null>(null);
  const drawingRef = useRef<{
    points: L.LatLng[];
    preview?: L.Layer;
    markers: L.CircleMarker[];
  }>({ points: [], markers: [] });
  const [, force] = useState(0);

  // Forzamos siempre triángulo si llega cualquier modo activo.
  const isDrawing = mode != null;

  // Pane dedicado
  useEffect(() => {
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = "645";
      pane.style.pointerEvents = "none";
    }
  }, [map]);

  // Render del área activa
  useEffect(() => {
    if (layerRef.current) {
      layerRef.current.remove();
      layerRef.current = null;
    }
    if (!area) return;

    const style: L.PathOptions = {
      pane: PANE_NAME,
      color: COLOR,
      weight: 2.5,
      opacity: 0.95,
      fillColor: FILL,
      fillOpacity: 0.14,
      dashArray: "6,4",
    };

    if (area.kind === "rect") {
      const [sw, ne] = area.bounds;
      layerRef.current = L.rectangle(
        L.latLngBounds([sw.lat, sw.lng], [ne.lat, ne.lng]),
        style,
      ).addTo(map);
    } else {
      layerRef.current = L.polygon(
        area.points.map((p) => [p.lat, p.lng] as [number, number]),
        style,
      ).addTo(map);
    }
  }, [area, map]);

  // Cursor + estado del mapa durante el dibujo
  useEffect(() => {
    const container = map.getContainer();
    if (isDrawing) {
      container.style.cursor = "crosshair";
      map.doubleClickZoom.disable();
    } else {
      container.style.cursor = "";
      map.doubleClickZoom.enable();
      drawingRef.current.preview?.remove();
      drawingRef.current.markers.forEach((m) => m.remove());
      drawingRef.current = { points: [], markers: [] };
      force((n) => n + 1);
    }
    return () => {
      container.style.cursor = "";
      map.doubleClickZoom.enable();
    };
  }, [isDrawing, map]);

  const clearPreview = () => {
    drawingRef.current.preview?.remove();
    drawingRef.current.preview = undefined;
    drawingRef.current.markers.forEach((m) => m.remove());
    drawingRef.current.markers = [];
  };

  const finishWith = (a: SearchArea) => {
    clearPreview();
    drawingRef.current = { points: [], markers: [] };
    onAreaChange(a);
    onDrawEnd();
  };

  const addVertexMarker = (ll: L.LatLng) => {
    const m = L.circleMarker(ll, {
      pane: PANE_NAME,
      radius: 4,
      color: "#fff",
      weight: 2,
      fillColor: COLOR,
      fillOpacity: 1,
    }).addTo(map);
    drawingRef.current.markers.push(m);
  };

  const previewPolygon = (pts: L.LatLng[]) => {
    drawingRef.current.preview?.remove();
    drawingRef.current.preview = L.polygon(pts, {
      pane: PANE_NAME,
      color: COLOR,
      weight: 2,
      opacity: 0.9,
      fillColor: FILL,
      fillOpacity: 0.1,
      dashArray: "5,4",
    }).addTo(map);
  };

  // Solo dibujamos por clics → 3 clics cierran el triángulo automáticamente.
  // Sin mousedown/mouseup/drag → no se interfiere con el panning del mapa.
  useMapEvents({
    mousemove: (e) => {
      if (!isDrawing) return;
      if (drawingRef.current.points.length > 0) {
        previewPolygon([...drawingRef.current.points, e.latlng]);
      }
    },
    click: (e) => {
      if (!isDrawing) return;
      drawingRef.current.points.push(e.latlng);
      addVertexMarker(e.latlng);
      previewPolygon(drawingRef.current.points);
      if (drawingRef.current.points.length === 3) {
        const pts = drawingRef.current.points.map((p) => ({
          lat: p.lat,
          lng: p.lng,
        }));
        finishWith({ kind: "polygon", points: pts });
      }
    },
  });

  return null;
}

