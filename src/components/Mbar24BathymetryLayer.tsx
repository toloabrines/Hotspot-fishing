import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import { useMap, useMapEvents } from "react-leaflet";

import { DemGrid, fetchDemGrid, snapBBox, type DemBBox } from "../lib/dem";
import { deviceTier } from "../lib/dem-perf";
import { upsampleDemGrid } from "../lib/dem-upsample";
import { contourSegments, renderDemImage } from "../lib/seafloor-render";
import { MBAR24_KNOWN_SHEETS, fetchMbar24Coverage, type Mbar24Coverage } from "../lib/mbar24";
import type { SeafloorSettings } from "../lib/seafloor.types";

/** Más allá de este zoom el dato de 16 m ya no aporta nada útil: se oculta. */
const MAX_USEFUL_ZOOM = 17;

/** Sobremuestreo bicúbico (sólo visual) según el zoom y la gama del móvil. */
function upsampleFactor(zoom: number): number {
  const tier = deviceTier();
  if (tier === "low") return zoom >= 15 ? 2 : 1;
  if (zoom >= 15) return tier === "mid" ? 2 : 3;
  if (zoom >= 13) return 2;
  return 1;
}

/** Malla ligera que se pinta primero para que la carta aparezca ya. */
function previewGridSize(zoom: number): number {
  if (zoom >= 14) return 384;
  if (zoom >= 12) return 320;
  return 256;
}

/**
 * Malla definitiva. La máxima resolución (que iguala los 16 m nativos) sólo
 * se pide a partir de z13; por debajo no aporta detalle visible.
 */
function fullGridSize(zoom: number): number {
  const tier = deviceTier();
  const cap = tier === "low" ? 720 : tier === "mid" ? 900 : 1280;
  const base =
    zoom >= 16
      ? 1280
      : zoom >= 15
        ? 1100
        : zoom >= 14
          ? 900
          : zoom >= 13
            ? 720
            : zoom >= 12
              ? 512
              : zoom >= 10
                ? 384
                : 256;
  return Math.min(base, zoom >= 13 ? cap : 512);
}



/**
 * Batimetría REAL MBAR24 / IHM (16 m) pintada sobre el mapa 2D principal.
 *
 * - Sólo actúa dentro de la cobertura oficial de las hojas conocidas
 *   (hoy ES400425 "Aproches de Alcúdia").
 * - Pide la malla ya fusionada a `/api/dem` (que prioriza las teselas MBAR24
 *   publicadas en `public/mbar24/`) y sólo pinta si `mbar24.loaded === true`.
 * - Nada de microrrelieve inventado: paleta + hillshade calculados con el dato.
 * - Fuera de cobertura, o si IHM falla, el componente no pinta nada y el mapa
 *   conserva exactamente el fallback EMODnet/GEBCO.
 */

export const MBAR24_RELIEF_PANE = "mbar24-relief-pane";

const renderSettings = (contrast: number, zoom = 12): SeafloorSettings => ({
  enabled: true,
  hillshade: true,
  // A partir de z14 se realza el sombreado y el contraste: mejor lectura del
  // mismo dato de 16 m, sin inventar microrrelieve.
  hillshadeIntensity: zoom >= 15 ? 1.15 : zoom >= 14 ? 1.05 : 0.95,
  reliefBoost: zoom >= 15 ? 3.1 : zoom >= 14 ? 2.9 : 2.6,
  contrast: zoom >= 14 ? Math.min(2, contrast * 1.2) : contrast,

  sunAzimuth: 315,
  sunAltitude: 45,
  contours: false,
  slope: false,
  roughness: false,
  structures: false,
  palette: "pesca",
  opacity: 1,
  focusGps: false,
  focusRadiusM: 800,
  microRelief: false,
});

export interface Mbar24Status2D {
  active: boolean;
  sheet: string | null;
  resolutionM: number | null;
  /** El viewport está totalmente dentro de la hoja (permite ocultar EMODnet). */
  fullyInside: boolean;
  /** La malla ya iguala la resolución nativa: más zoom no añade detalle real. */
  atNativeLimit: boolean;
}

function intersectSheet(
  b: L.LatLngBounds,
  sheets: { sheet: string; south: number; west: number; north: number; east: number }[],
): { sheet: string; box: DemBBox; fully: boolean } | null {
  for (const sh of sheets) {
    const south = Math.max(sh.south, b.getSouth());
    const north = Math.min(sh.north, b.getNorth());
    const west = Math.max(sh.west, b.getWest());
    const east = Math.min(sh.east, b.getEast());
    if (north - south <= 0.0005 || east - west <= 0.0005) continue;
    const fully =
      b.getSouth() >= sh.south &&
      b.getNorth() <= sh.north &&
      b.getWest() >= sh.west &&
      b.getEast() <= sh.east;
    return { sheet: sh.sheet, box: { south, west, north, east }, fully };
  }
  return null;
}


/** Intervalo de isóbatas adaptado al zoom (m). */
function contourStep(zoom: number): number {
  if (zoom >= 14) return 2;
  if (zoom >= 13) return 5;
  if (zoom >= 12) return 10;
  if (zoom >= 11) return 20;
  return 50;
}

/** Cada cuántos niveles se dibuja una curva maestra (siempre ~10 m o múltiplo). */
function masterEveryFor(step: number): number {
  if (step < 10) return Math.max(1, Math.round(10 / step));
  return 2;
}



interface Props {
  showRelief: boolean;
  showContours: boolean;
  /** Opacidad del relieve IHM (0–1). */
  opacity?: number;
  /** Contraste / definición de la carta (0.5 = suave, 2 = muy marcado). */
  contrast?: number;
  onStatusChange?: (s: Mbar24Status2D) => void;
}

export function Mbar24BathymetryLayer({
  showRelief,
  showContours,
  opacity = 0.95,
  contrast = 1.4,
  onStatusChange,
}: Props) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const srcRef = useRef<HTMLCanvasElement | null>(null);
  const gridRef = useRef<DemGrid | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coverageRef = useRef<Mbar24Coverage[]>(
    MBAR24_KNOWN_SHEETS.map((s) => ({ ...s })) as Mbar24Coverage[],
  );
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<Mbar24Status2D>({
    active: false,
    sheet: null,
    resolutionM: null,
    fullyInside: false,
    atNativeLimit: false,
  });
  const propsRef = useRef({ showRelief, showContours, opacity, contrast });
  propsRef.current = { showRelief, showContours, opacity, contrast };

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  // ── Pane + canvas ───────────────────────────────────────────────
  useEffect(() => {
    const pane = map.getPane(MBAR24_RELIEF_PANE) ?? map.createPane(MBAR24_RELIEF_PANE);
    // Por encima de las isóbatas EMODnet (362/363) para que el dato real
    // tape las líneas generalizadas dentro de la cobertura IHM.
    pane.style.zIndex = "364";
    pane.style.pointerEvents = "none";

    const canvas = L.DomUtil.create("canvas", "mbar24-canvas") as HTMLCanvasElement;
    canvas.style.position = "absolute";
    canvas.style.pointerEvents = "none";
    pane.appendChild(canvas);
    canvasRef.current = canvas;
    return () => {
      canvas.remove();
      canvasRef.current = null;
    };
  }, [map]);

  // ── Dibujo ──────────────────────────────────────────────────────
  const draw = useRef(() => {});
  draw.current = () => {
    const canvas = canvasRef.current;
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

    const grid = gridRef.current;
    const p = propsRef.current;
    if (!grid) return;

    // 1. Relieve real (paleta batimétrica + hillshade sobre el dato IHM).
    const src = srcRef.current;
    if (src && p.showRelief) {
      ctx.globalAlpha = Math.max(0.1, Math.min(1, p.opacity));
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      const leftX = map.latLngToContainerPoint([grid.north, grid.west]).x;
      const rightX = map.latLngToContainerPoint([grid.north, grid.east]).x;
      const w = rightX - leftX;
      // Un único `drawImage` para toda la malla: al dibujar por tiras el
      // redondeo de cada bloque dejaba franjas verticales/horizontales.
      const topY = map.latLngToContainerPoint([grid.north, grid.west]).y;
      const botY = map.latLngToContainerPoint([grid.south, grid.west]).y;
      // Aclarado visual suave de MBAR24: mejora la lectura en iPhone sin
      // modificar profundidades, hillshade, resolución ni datos de la hoja.
      ctx.filter = "brightness(1.12) saturate(1.04)";
      ctx.drawImage(src, 0, 0, grid.cols, grid.rows, leftX, topY, w, botY - topY);
      ctx.filter = "none";

      ctx.globalAlpha = 1;
    }

    // 2. Isóbatas del propio DEM IHM, densidad según zoom.
    if (p.showContours) {
      const zoom = map.getZoom();
      // En móviles de gama media/baja se simplifican las isóbatas (paso
      // mayor) sin perder piedras, bajos ni cambios fuertes de profundidad.
      const tier = deviceTier();
      const step = contourStep(zoom) * (tier === "low" ? 2 : 1);
      const range = grid.depthRange();
      const minD = Math.max(step, Math.floor(range.min / step) * step);
      const maxD = Math.min(1200, Math.ceil(range.max / step) * step);
      const levels: number[] = [];
      for (let d = minD; d <= maxD; d += step) levels.push(d);
      const maxLevels = tier === "low" ? 60 : tier === "mid" ? 110 : 160;
      if (levels.length > maxLevels) levels.length = maxLevels;

      const masterEvery = masterEveryFor(step);

      // Rejilla de ocupación para que las etiquetas no se amontonen.
      const cell = 90;
      const taken = new Set<string>();

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const level of levels) {
        const master = Math.round(level / step) % masterEvery === 0;
        const segs = contourSegments(grid, level);
        if (!segs.length) continue;
        ctx.beginPath();
        for (const seg of segs) {
          const a = map.latLngToContainerPoint([seg.a.lat, seg.a.lng]);
          const b = map.latLngToContainerPoint([seg.b.lat, seg.b.lng]);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        const k = Math.max(0.5, Math.min(2, p.contrast));
        ctx.strokeStyle = master
          ? `rgba(2,14,28,${Math.min(1, 0.7 * k)})`
          : `rgba(4,26,50,${Math.min(0.8, 0.3 * k)})`;
        ctx.lineWidth = master ? Math.min(1.3, 0.78 * k) : Math.min(0.8, 0.42 * k);
        ctx.stroke();

        if (!master) continue;
        ctx.font = "700 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(3,22,42,0.95)";
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 3;
        let labelled = 0;
        for (let i = 0; i < segs.length && labelled < 2; i += 12) {
          const pt = map.latLngToContainerPoint([segs[i].a.lat, segs[i].a.lng]);
          if (pt.x < 30 || pt.y < 20 || pt.x > size.x - 30 || pt.y > size.y - 20) continue;
          const key = `${Math.floor(pt.x / cell)}:${Math.floor(pt.y / cell)}`;
          if (taken.has(key)) continue;
          taken.add(key);
          labelled++;
          // Profundidad positiva sólo para la etiqueta.
          const label = `${Math.round(level)} m`;
          ctx.strokeText(label, pt.x, pt.y);
          ctx.fillText(label, pt.x, pt.y);
        }

      }
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }
  };

  // ── Carga (sólo al terminar el gesto, con cancelación) ──────────
  /** Pinta una malla ya descargada. */
  const applyGrid = useRef<(g: DemGrid, zoom: number, fully: boolean, sheet: string) => void>(
    () => {},
  );
  applyGrid.current = (grid, zoom, fully, sheet) => {
    // Sobremuestreo bicúbico: sólo mejora la representación (sin píxeles ni
    // contornos escalonados); las profundidades son las del GeoTIFF original.
    const rgrid = upsampleDemGrid(grid, upsampleFactor(zoom));
    gridRef.current = rgrid;
    const img = renderDemImage(rgrid, renderSettings(propsRef.current.contrast, zoom));
    const c = document.createElement("canvas");
    c.width = rgrid.cols;
    c.height = rgrid.rows;
    c.getContext("2d")?.putImageData(img, 0, 0);
    srcRef.current = c;
    const midLat = ((grid.north + grid.south) / 2) * (Math.PI / 180);
    const cellM = ((grid.east - grid.west) * 111320 * Math.cos(midLat)) / Math.max(1, grid.cols);
    const nativeM = grid.resolutionM ?? 16;
    setStatus({
      active: true,
      sheet: grid.mbar24?.sheet ?? sheet,
      resolutionM: grid.resolutionM ?? null,
      fullyInside: fully,
      atNativeLimit: cellM <= nativeM * 1.05,
    });
    draw.current();
  };

  const load = useRef(() => {});
  load.current = () => {
    const p = propsRef.current;
    // Cancela de inmediato lo pendiente de la zona anterior.
    abortRef.current?.abort();
    const clear = () => {
      gridRef.current = null;
      srcRef.current = null;
      setLoading(false);
      setStatus({
        active: false,
        sheet: null,
        resolutionM: null,
        fullyInside: false,
        atNativeLimit: false,
      });
      draw.current();
    };
    if (!p.showRelief && !p.showContours) return clear();

    const zoom = map.getZoom();
    const hit = intersectSheet(map.getBounds(), coverageRef.current);
    // Por debajo de z9 no aporta y por encima de MAX_USEFUL_ZOOM se supera la
    // escala útil del dato de 16 m: se oculta la capa en vez de ampliarla.
    if (!hit || zoom < 9 || zoom > MAX_USEFUL_ZOOM) return clear();

    const bbox = snapBBox(
      hit.box,
      zoom >= 15 ? 0.001 : zoom >= 14 ? 0.002 : zoom >= 13 ? 0.004 : zoom >= 11 ? 0.008 : 0.02,
    );
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);

    // Vista previa ligera primero (respuesta inmediata, sin pantalla en
    // blanco); la máxima resolución sólo a partir de z13.
    const preview = previewGridSize(zoom);
    const full = fullGridSize(zoom);

    const finish = () => {
      if (!ctrl.signal.aborted) setLoading(false);
    };

    const loadFull = () =>
      fetchDemGrid(bbox, full, ctrl.signal)
        .then((grid) => {
          if (ctrl.signal.aborted) return;
          if (!grid || !grid.mbar24?.loaded) {
            if (!gridRef.current) clear();
            return;
          }
          applyGrid.current(grid, zoom, hit.fully, hit.sheet);
        })
        .catch(() => {
          /* cancelado o error → se conserva la carta anterior */
        })
        .finally(finish);

    if (preview < full) {
      fetchDemGrid(bbox, preview, ctrl.signal)
        .then((grid) => {
          if (ctrl.signal.aborted || !grid || !grid.mbar24?.loaded) return;
          applyGrid.current(grid, Math.min(zoom, 12), hit.fully, hit.sheet);
        })
        .catch(() => {})
        .finally(() => {
          if (!ctrl.signal.aborted) loadFull();
        });
    } else {
      loadFull();
    }
  };


  const schedule = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    // En Android/gama baja se espera algo más: evita recargas encadenadas
    // mientras el usuario sigue moviendo la carta.
    const t = deviceTier();
    timerRef.current = setTimeout(() => load.current(), t === "low" ? 320 : t === "mid" ? 240 : 180);
  };

  useEffect(() => {
    load.current();
    return () => {
      abortRef.current?.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRelief, showContours]);

  // Cobertura real publicada (index.json): incorpora hojas nuevas sin recompilar.
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    fetchMbar24Coverage(ctrl.signal)
      .then((cov) => {
        if (!alive || cov.length === 0) return;
        coverageRef.current = cov;
        load.current();
      })
      .catch(() => {});
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, []);

  useEffect(() => {
    draw.current();
  }, [opacity]);

  // Cambiar el contraste sólo repinta: no vuelve a pedir datos.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const img = renderDemImage(grid, renderSettings(contrast, map.getZoom()));
    const c = document.createElement("canvas");
    c.width = grid.cols;
    c.height = grid.rows;
    c.getContext("2d")?.putImageData(img, 0, 0);
    srcRef.current = c;
    draw.current();
  }, [contrast]);


  useMapEvents({
    resize: () => draw.current(),
    moveend: () => schedule(),
    zoomend: () => schedule(),
  });

  if (!status.active && !loading) return null;
  return createPortal(
    <>
      {status.active && (
        <div className="mbar24-attrib">
          IHM MBAR24 · {Math.round(status.resolutionM ?? 16)} m · No válido para navegación
        </div>
      )}
      {loading && <div className="mbar24-loading">Cargando batimetría…</div>}
    </>,

    map.getContainer(),
  );
}

