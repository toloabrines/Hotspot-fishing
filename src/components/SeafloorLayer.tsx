import { useEffect, useRef, useSyncExternalStore } from "react";
import { useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { applySoundingsToGrid, DemGrid, fetchDemGrid, snapBBox } from "../lib/dem";
import { getSonarDatasets, subscribeSonarDatasets } from "../lib/sonar-data";
import { contourLevels, contourSegments, isMasterLevel, renderDemImage } from "../lib/seafloor-render";
import { detectStructures, structureIcon, type SeafloorStructure } from "../lib/seafloor-structures";
import type { SeafloorSettings } from "../lib/seafloor.types";


export const SEAFLOOR_PANE = "seafloor-dem-pane";
export const SEAFLOOR_TOP_PANE = "seafloor-top-pane";

interface Props {
  settings: SeafloorSettings;
  /** Modo de selección: ficha de punto o extremos del perfil. */
  pickMode: "none" | "info" | "profile";
  profilePoints: { lat: number; lng: number }[];
  onPick?: (lat: number, lng: number) => void;
  onGridChange?: (grid: DemGrid | null) => void;
  onStructuresChange?: (list: SeafloorStructure[]) => void;
  onLoadingChange?: (loading: boolean) => void;
  /** Posición GPS actual (para el modo de máximo detalle centrado en el barco). */
  gpsPosition?: { lat: number; lng: number } | null;
}

export function SeafloorLayer({
  settings,
  pickMode,
  profilePoints,
  onPick,
  onGridChange,
  onStructuresChange,
  onLoadingChange,
  gpsPosition,
}: Props) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const srcRef = useRef<HTMLCanvasElement | null>(null);
  const gridRef = useRef<DemGrid | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const gpsRef = useRef(gpsPosition ?? null);
  gpsRef.current = gpsPosition ?? null;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const profileRef = useRef(profilePoints);
  profileRef.current = profilePoints;
  // Sondas propias del usuario: sustituyen a la batimetría pública donde existan.
  const sonar = useSyncExternalStore(
    subscribeSonarDatasets,
    getSonarDatasets,
    () => [] as ReturnType<typeof getSonarDatasets>,
  );
  const sonarRef = useRef(sonar);
  sonarRef.current = sonar;


  // ── Panes + canvas ──────────────────────────────────────────────
  useEffect(() => {
    const raster = map.getPane(SEAFLOOR_PANE) ?? map.createPane(SEAFLOOR_PANE);
    raster.style.zIndex = "345";
    raster.style.pointerEvents = "none";
    const top = map.getPane(SEAFLOOR_TOP_PANE) ?? map.createPane(SEAFLOOR_TOP_PANE);
    top.style.zIndex = "366";
    top.style.pointerEvents = "none";

    const canvas = L.DomUtil.create("canvas", "seafloor-canvas") as HTMLCanvasElement;
    canvas.style.position = "absolute";
    canvas.style.pointerEvents = "none";
    raster.appendChild(canvas);
    canvasRef.current = canvas;

    const group = L.layerGroup([], { pane: SEAFLOOR_TOP_PANE });
    group.addTo(map);
    markersRef.current = group;

    return () => {
      canvas.remove();
      canvasRef.current = null;
      group.remove();
      markersRef.current = null;
    };
  }, [map]);

  // ── Dibujo ──────────────────────────────────────────────────────
  const draw = useRef(() => {});
  draw.current = () => {
    const canvas = canvasRef.current;
    const grid = gridRef.current;
    if (!canvas) return;
    const size = map.getSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) {
      canvas.width = size.x * dpr;
      canvas.height = size.y * dpr;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    const s = settingsRef.current;
    if (!grid || !s.enabled) return;

    ctx.globalAlpha = Math.max(0.05, Math.min(1, s.opacity));

    // 1. Raster (paleta + hillshade + pendiente + rugosidad) fila a fila,
    //    para respetar la proyección Mercator.
    const src = srcRef.current;
    if (src) {
      ctx.imageSmoothingEnabled = true;
      const dLat = (grid.north - grid.south) / grid.rows;
      const leftX = map.latLngToContainerPoint([grid.north, grid.west]).x;
      const rightX = map.latLngToContainerPoint([grid.north, grid.east]).x;
      const w = rightX - leftX;
      const chunk = Math.max(8, Math.round(grid.rows / 48));
      for (let r = 0; r < grid.rows; r += chunk) {
        const rEnd = Math.min(grid.rows, r + chunk);
        const topLat = grid.north - r * dLat;
        const botLat = grid.north - rEnd * dLat;
        const y0 = map.latLngToContainerPoint([topLat, grid.west]).y;
        const y1 = map.latLngToContainerPoint([botLat, grid.west]).y;
        const h = Math.max(1, y1 - y0);
        if (y1 < -20 || y0 > size.y + 20) continue;
        ctx.drawImage(src, 0, r, grid.cols, rEnd - r, leftX, y0, w, h + 0.5);
      }

    }

    // 2. Isóbatas
    if (s.contours) {
      const range = grid.depthRange();
      const levels = contourLevels(range.min, range.max).slice(0, 60);
      ctx.lineCap = "round";
      for (const level of levels) {
        const master = isMasterLevel(level);
        const segs = contourSegments(grid, level);
        if (!segs.length) continue;
        ctx.beginPath();
        for (const seg of segs) {
          const a = map.latLngToContainerPoint([seg.a.lat, seg.a.lng]);
          const b = map.latLngToContainerPoint([seg.b.lat, seg.b.lng]);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.strokeStyle = master ? "rgba(6,32,58,0.85)" : "rgba(12,52,88,0.45)";
        ctx.lineWidth = master ? 1.6 : 0.8;
        ctx.stroke();

        if (master) {
          ctx.font = "600 10px system-ui, sans-serif";
          ctx.fillStyle = "rgba(4,26,48,0.9)";
          ctx.strokeStyle = "rgba(255,255,255,0.85)";
          ctx.lineWidth = 2.5;
          for (let i = 40; i < segs.length; i += 220) {
            const p = map.latLngToContainerPoint([segs[i].a.lat, segs[i].a.lng]);
            if (p.x < 10 || p.y < 10 || p.x > size.x - 20 || p.y > size.y - 10) continue;
            const label = `${Math.round(level)} m`;
            ctx.strokeText(label, p.x, p.y);
            ctx.fillText(label, p.x, p.y);
          }
        }
      }
    }

    // 3. Línea del perfil
    const pts = profileRef.current;
    if (pts.length >= 1) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#ff7a1a";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const cp = map.latLngToContainerPoint([p.lat, p.lng]);
        if (i === 0) ctx.moveTo(cp.x, cp.y);
        else ctx.lineTo(cp.x, cp.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of pts) {
        const cp = map.latLngToContainerPoint([p.lat, p.lng]);
        ctx.fillStyle = "#ff7a1a";
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  };

  // ── Carga del DEM según viewport ────────────────────────────────
  const loadRef = useRef<() => void>(() => {});
  const applyGrid = (g: DemGrid | null) => applyGridRef.current(g);
  loadRef.current = () => {
    if (!settings.enabled) {
      gridRef.current = null;
      srcRef.current = null;
      onGridChange?.(null);
      markersRef.current?.clearLayers();
      draw.current();
      return;
    }
    const gps = gpsRef.current;
    if (settingsRef.current.focusGps && gps) {
      // Zona de trabajo pequeña alrededor del barco → resolución máxima posible.
      const radius = Math.max(200, Math.min(4000, settingsRef.current.focusRadiusM || 800));
      const dLat = radius / 110540;
      const dLng = radius / (111320 * Math.max(0.2, Math.cos((gps.lat * Math.PI) / 180)));
      const round = (v: number) => Math.round(v * 2000) / 2000; // ~50 m: caché estable
      const focusBox = {
        south: round(gps.lat - dLat),
        north: round(gps.lat + dLat),
        west: round(gps.lng - dLng),
        east: round(gps.lng + dLng),
      };
      onLoadingChange?.(true);
      fetchDemGrid(focusBox, 640).then(applyGrid).finally(() => onLoadingChange?.(false));
      return;
    }
    const b = map.getBounds();
    const bbox = snapBBox(
      {
        south: b.getSouth(),
        west: b.getWest(),
        north: b.getNorth(),
        east: b.getEast(),
      },
      map.getZoom() >= 12 ? 0.008 : 0.04,
    );
    const z = map.getZoom();
    const size = z >= 13 ? 640 : z >= 12 ? 512 : z >= 10 ? 384 : z >= 8 ? 256 : 192;

    onLoadingChange?.(true);
    fetchDemGrid(bbox, size)
      .then(applyGrid)
      .finally(() => onLoadingChange?.(false));
  };

  /** Aplica una rejilla descargada: raster, estructuras y redibujado. */
  const applyGridRef = useRef<(grid: DemGrid | null) => void>(() => {});
  applyGridRef.current = (base: DemGrid | null) => {
    {
      {
        const grid =
          base && sonarRef.current.length ? applySoundingsToGrid(base, sonarRef.current) : base;
        gridRef.current = grid;
        onGridChange?.(grid ?? null);

        if (grid) {
          const img = renderDemImage(grid, settingsRef.current);
          const src = document.createElement("canvas");
          src.width = grid.cols;
          src.height = grid.rows;
          src.getContext("2d")?.putImageData(img, 0, 0);
          srcRef.current = src;

          if (settingsRef.current.structures) {
            const list = detectStructures(grid);
            onStructuresChange?.(list);
            const group = markersRef.current;
            if (group) {
              group.clearLayers();
              for (const st of list) {
                const icon = L.divIcon({
                  className: "seafloor-structure-icon",
                  html: `<div class="sf-struct sf-${st.kind}"><span>${structureIcon(st.kind)}</span><em>${st.label} · ${Math.round(st.depthM)} m</em></div>`,
                  iconSize: [18, 18],
                  iconAnchor: [9, 9],
                });
                L.marker([st.lat, st.lng], { icon, pane: SEAFLOOR_TOP_PANE, interactive: false }).addTo(
                  group,
                );
              }
            }
          } else {
            markersRef.current?.clearLayers();
            onStructuresChange?.([]);
          }
        } else {
          srcRef.current = null;
          markersRef.current?.clearLayers();
        }
        draw.current();
      }
    }
  };

  useEffect(() => {
    loadRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings.enabled,
    settings.hillshade,
    settings.hillshadeIntensity,
    settings.sunAzimuth,
    settings.sunAltitude,
    settings.slope,
    settings.roughness,
    settings.palette,
    settings.structures,
    settings.focusGps,
    settings.focusRadiusM,
    sonar,
  ]);


  useEffect(() => {
    draw.current();
  }, [settings.opacity, settings.contours, profilePoints]);

  // En modo GPS: el barco se mueve libremente dentro del relieve ya cargado y
  // sólo se recarga (y por tanto sólo "salta" la pantalla) cuando se acerca al
  // borde de la zona cargada (> 60 % desde el centro).
  useEffect(() => {
    if (!settings.focusGps || !gpsPosition) return;
    const g = gridRef.current;
    if (!g) {
      loadRef.current();
      return;
    }
    const cLat = (g.north + g.south) / 2;
    const cLng = (g.east + g.west) / 2;
    const halfLat = Math.max(1e-9, (g.north - g.south) / 2);
    const halfLng = Math.max(1e-9, (g.east - g.west) / 2);
    const offset = Math.max(
      Math.abs(gpsPosition.lat - cLat) / halfLat,
      Math.abs(gpsPosition.lng - cLng) / halfLng,
    );
    if (offset > 0.6) loadRef.current();
    else draw.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpsPosition?.lat, gpsPosition?.lng, settings.focusGps]);


  useMapEvents({
    // No recalcular raster + marching-squares durante cada píxel de arrastre.
    // El pane de Leaflet ya acompaña al mapa; se repinta una sola vez al parar.
    resize: () => draw.current(),
    moveend: () => loadRef.current(),
    zoomend: () => loadRef.current(),
    click: (e) => {
      if (pickMode === "none") return;
      onPick?.(e.latlng.lat, e.latlng.lng);
    },
  });

  return null;
}

