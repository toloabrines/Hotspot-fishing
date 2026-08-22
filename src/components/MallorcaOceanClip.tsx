import { useEffect } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";
import { getMallorcaRings, loadMallorcaPolygon } from "../lib/mallorca-polygon";

/**
 * Recorta las capas raster oceanográficas (SST, clorofila, altimetría y
 * batimetría) al contorno EXACTO de Mallorca expandido con un buffer marino.
 *
 * Cómo funciona:
 *   - Carga la geometría OSM de alta resolución de Mallorca.
 *   - En cada zoomend/viewreset, proyecta el polígono a coordenadas de
 *     layer-point (sistema interno de Leaflet que se mueve con el mapa
 *     automáticamente cuando el usuario hace pan).
 *   - Construye un SVG inline con el polígono pintado en blanco + un stroke
 *     ancho ("stroke trick") que actúa como dilatación → así el clip incluye
 *     toda la zona marina alrededor de la isla, no solo la tierra.
 *   - Aplica ese SVG como `mask-image` a cada pane raster.
 *
 * Resultado: las capas SST/CHL/ALT/batimetría quedan visibles SOLO dentro
 * del contorno de Mallorca + buffer marino. Desaparecen los rectángulos
 * grises que se extendían hasta la península, África o el mar abierto.
 */

const TARGET_PANES = [
  // Copernicus oceanográficas
  "copernicus-sst-pane",
  "copernicus-chl-pane",
  "copernicus-alt-pane",
  "copernicus-pane",
  // Batimetría raster (relief, hillshade, slope)
  "bathy-gebco-base-pane",
  "bathy-pane",
  "bathy-coastal-relief-pane",
  "bathy-hillshade-pane",
  "bathy-slope-pane",
] as const;

// Buffer marino adaptativo según zoom. A zoom bajo (8) el contorno se ve
// pequeño y necesitamos un margen más generoso para incluir plataforma,
// veriles y cañones cercanos sin que parezca que la isla está "cortada".
// A zoom alto (≥12) el detalle es muy fino y un buffer demasiado grande
// llenaría la pantalla con tiles fuera de Mallorca → bajamos a ~0.25°.
function getBufferDeg(zoom: number): number {
  if (zoom <= 8) return 0.65; // ~70 km, cubre canales hacia Menorca/Ibiza
  if (zoom <= 9) return 0.55;
  if (zoom <= 10) return 0.45;
  if (zoom <= 11) return 0.35;
  if (zoom <= 12) return 0.3;
  return 0.25; // zoom alto: ceñido pero sin tocar la costa
}

function clearPaneMask(pane: HTMLElement) {
  pane.style.webkitMaskImage = "";
  pane.style.maskImage = "";
  pane.style.webkitMaskPosition = "";
  pane.style.maskPosition = "";
  pane.style.webkitMaskRepeat = "";
  pane.style.maskRepeat = "";
  pane.style.webkitMaskSize = "";
  pane.style.maskSize = "";
}

export function MallorcaOceanClip({ enabled = true }: { enabled?: boolean }) {
  const map = useMap();

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let rings: number[][][] | null = null;
    let frame: number | null = null;

    const rebuild = () => {
      frame = null;
      if (!rings || rings.length === 0) return;

      // Buffer en píxeles para la zoom actual: proyectamos un par de puntos
      // separados bufferDeg y medimos su distancia en píxeles.
      const bufferDeg = getBufferDeg(map.getZoom());
      const center = map.getCenter();
      const a = map.latLngToLayerPoint(center);
      const b = map.latLngToLayerPoint([center.lat, center.lng + bufferDeg]);
      const bufferPx = Math.max(8, Math.abs(b.x - a.x));

      // Proyectar todos los anillos a layer points
      const projRings: { x: number; y: number }[][] = rings.map((ring) =>
        ring.map(([lng, lat]) => {
          const p = map.latLngToLayerPoint([lat, lng]);
          return { x: p.x, y: p.y };
        }),
      );

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const ring of projRings) {
        for (const p of ring) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      }
      const pad = bufferPx + 4;
      minX -= pad;
      minY -= pad;
      maxX += pad;
      maxY += pad;
      const w = Math.ceil(maxX - minX);
      const h = Math.ceil(maxY - minY);
      if (w <= 0 || h <= 0) return;

      const d = projRings
        .map(
          (ring) =>
            "M" +
            ring.map((p) => `${(p.x - minX).toFixed(1)},${(p.y - minY).toFixed(1)}`).join("L") +
            "Z",
        )
        .join(" ");

      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'><path d='${d}' fill='white' stroke='white' stroke-width='${(bufferPx * 2).toFixed(1)}' stroke-linejoin='round' stroke-linecap='round'/></svg>`;
      const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
      const pos = `${minX}px ${minY}px`;
      const size = `${w}px ${h}px`;

      for (const paneName of TARGET_PANES) {
        const pane = map.getPane(paneName);
        if (!pane) continue;
        pane.style.webkitMaskImage = url;
        pane.style.maskImage = url;
        pane.style.webkitMaskPosition = pos;
        pane.style.maskPosition = pos;
        pane.style.webkitMaskSize = size;
        pane.style.maskSize = size;
        pane.style.webkitMaskRepeat = "no-repeat";
        pane.style.maskRepeat = "no-repeat";
      }
    };

    const scheduleRebuild = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(rebuild);
    };

    loadMallorcaPolygon().then((geo) => {
      if (cancelled || !geo) return;
      rings = getMallorcaRings(geo);
      rebuild();
    });

    // Leaflet puede cambiar el origen interno durante el arrastre; sincronizar
    // la máscara también en `move` evita que el recorte parezca desplazarse.
    map.on("zoomend", scheduleRebuild);
    map.on("viewreset", scheduleRebuild);
    map.on("resize", scheduleRebuild);
    map.on("move", scheduleRebuild);
    map.on("moveend", scheduleRebuild);

    return () => {
      cancelled = true;
      if (frame != null) window.cancelAnimationFrame(frame);
      map.off("zoomend", scheduleRebuild);
      map.off("viewreset", scheduleRebuild);
      map.off("resize", scheduleRebuild);
      map.off("move", scheduleRebuild);
      map.off("moveend", scheduleRebuild);
      // Limpia máscaras al desmontar para no afectar otras vistas.
      for (const paneName of TARGET_PANES) {
        const pane = map.getPane(paneName);
        if (pane) clearPaneMask(pane);
      }
    };
  }, [enabled, map]);

  return null;
}

