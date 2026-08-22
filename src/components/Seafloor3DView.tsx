import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DemGrid } from "../lib/dem";
import { toDegMinSec } from "./FishingHotspots.types";

/**
 * Visor 3D profesional del fondo marino (Hotspot Fishing).
 *
 * Arquitectura de dos lienzos:
 *  - `terrainRef`  → relieve (caro, se repinta con LOD: baja calidad mientras
 *                    se mueve la cámara, máxima calidad al detenerse).
 *  - `overlayRef`  → barco en directo, estela, rumbo, puntos Top, waypoints,
 *                    leyenda, escala, brújula y ficha del punto tocado.
 *                    Es barato, así que puede refrescarse a ~15 fps sin
 *                    recalcular el terreno.
 *
 * Nada de esto toca los cálculos de pesca: solo visualización.
 * La versión anterior queda guardada en `Seafloor3DView.legacy.tsx.bak`.
 */

export interface Seafloor3DSpot {
  lat: number;
  lng: number;
  score?: number;
  rank?: number;
  depth?: number | null;
}

export interface Seafloor3DWaypoint {
  lat: number;
  lng: number;
  name?: string;
}

interface Props {
  grid: DemGrid | null;
  onClose: () => void;
  /** Posición GPS para marcar el barco sobre el relieve. */
  gpsPosition?: {
    lat: number;
    lng: number;
    heading?: number | null;
    speed?: number | null;
  } | null;
  /** El relieve se recarga centrado en el barco mientras navega. */
  followGps?: boolean;
  /** Alterna el seguimiento del barco (lo gestiona el mapa). */
  onToggleFollowGps?: (next: boolean) => void;
  /** Puntos de pesca calculados (Top 1..3 destacados). */
  spots?: Seafloor3DSpot[];
  /** Waypoints guardados por el usuario. */
  waypoints?: Seafloor3DWaypoint[];
}

type RGB = [number, number, number];
type ColorMode = "profundidad" | "relieve" | "combinado";
type ExagMode = "auto" | 1 | 2 | 3 | 5;

const PALETTE: { d: number; c: RGB }[] = [
  { d: 0, c: [238, 229, 202] },
  { d: 10, c: [206, 214, 190] },
  { d: 25, c: [150, 196, 194] },
  { d: 50, c: [104, 170, 196] },
  { d: 90, c: [72, 138, 182] },
  { d: 150, c: [52, 106, 161] },
  { d: 300, c: [38, 79, 133] },
  { d: 600, c: [26, 55, 101] },
  { d: 1200, c: [16, 36, 74] },
  { d: 2500, c: [9, 21, 48] },
];

function rampColor(depth: number): RGB {
  if (depth <= PALETTE[0].d) return PALETTE[0].c;
  const last = PALETTE[PALETTE.length - 1];
  if (depth >= last.d) return last.c;
  for (let i = 1; i < PALETTE.length; i++) {
    if (depth <= PALETTE[i].d) {
      const a = PALETTE[i - 1];
      const b = PALETTE[i];
      const t = (depth - a.d) / Math.max(1e-6, b.d - a.d);
      return [
        a.c[0] + (b.c[0] - a.c[0]) * t,
        a.c[1] + (b.c[1] - a.c[1]) * t,
        a.c[2] + (b.c[2] - a.c[2]) * t,
      ];
    }
  }
  return last.c;
}

function niceStep(range: number): number {
  const raw = range / 6;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  const n = raw / pow;
  const m = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return m * pow;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 12;
const MIN_TILT = 5;
// Mantiene la cámara sobre el fondo, pero permite una vista casi cenital.
const MAX_TILT = 88;
const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
const clampTilt = (t: number) => Math.max(MIN_TILT, Math.min(MAX_TILT, t));

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

interface Scene {
  project: (u: number, v: number, h: number) => { x: number; y: number; z: number };
  hAt: (u: number, v: number) => number;
  depthAt: (u: number, v: number) => number | null;
  slopeAt: (u: number, v: number) => number | null;
  colsN: number;
  rowsN: number;
  minDepth: number;
  maxDepth: number;
  step: number;
  exag: number;
  pxPerMeter: number;
  north: number;
  south: number;
  east: number;
  west: number;
}

export function Seafloor3DView({
  grid,
  onClose,
  gpsPosition,
  followGps = false,
  onToggleFollowGps,
  spots = [],
  waypoints = [],
}: Props) {
  const terrainRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const [yaw, setYaw] = useState(0);
  const [tilt, setTilt] = useState(70);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragMode, setDragMode] = useState<"mover" | "girar">("girar");
  const [exagMode, setExagMode] = useState<ExagMode>("auto");
  const [colorMode, setColorMode] = useState<ColorMode>("combinado");
  const [sunAz, setSunAz] = useState(315);
  const [contours, setContours] = useState(true);
  const [slopeShade, setSlopeShade] = useState(false);
  const [microRelief, setMicroRelief] = useState(true);
  const [detailStrength, setDetailStrength] = useState(1.2);
  const [showSpots, setShowSpots] = useState(true);
  const [showWaypoints, setShowWaypoints] = useState(true);
  const [showTrail, setShowTrail] = useState(true);
  const [showControls, setShowControls] = useState(false);
  const [showHud, setShowHud] = useState(false);

  /** Calidad/procedencia real del DEM: manda sobre lo que se puede dibujar. */
  const demQuality = useMemo(() => (grid ? grid.quality() : null), [grid]);
  /** Nunca inventamos piedras si la resolución del dato no las soporta. */
  const microAllowed = demQuality?.allowMicroRelief ?? false;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [sensitivity, setSensitivity] = useState(1);
  const [clipMin, setClipMin] = useState<number | null>(null);
  const [clipMax, setClipMax] = useState<number | null>(null);
  const [pick, setPick] = useState<{
    lat: number;
    lng: number;
    depth: number | null;
    slope: number | null;
    distM: number | null;
  } | null>(null);
  const [target, setTarget] = useState<{ lat: number; lng: number; label: string } | null>(null);
  const [portrait, setPortrait] = useState(false);

  const dragModeRef = useRef(dragMode);
  dragModeRef.current = dragMode;
  const sensRef = useRef(sensitivity);
  sensRef.current = sensitivity;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;

  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ distance: number; x: number; y: number } | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const gpsScreenRef = useRef<{ x: number; y: number; inside: boolean } | null>(null);
  const viewSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const resizeFrameRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const hiTimerRef = useRef<number | null>(null);
  const interactingRef = useRef(false);
  const trailRef = useRef<{ lat: number; lng: number }[]>([]);
  const smoothGpsRef = useRef<{ lat: number; lng: number; hdg: number } | null>(null);

  // ---------- Estadísticas robustas del grid ----------
  const stats = useMemo(() => {
    if (!grid) return null;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let n = 0;
    const samples: number[] = [];
    const stride = Math.max(1, Math.floor(grid.elev.length / 12000));
    for (let i = 0; i < grid.elev.length; i++) {
      const v = grid.elev[i];
      if (!Number.isFinite(v) || v >= 0) continue;
      n++;
      if (i % stride === 0) samples.push(v);
      if (v < minZ) minZ = v;
      if (v > maxZ) maxZ = v;
    }
    if (!n || !Number.isFinite(minZ)) return null;
    samples.sort((a, b) => a - b);
    const p02 = samples[Math.floor((samples.length - 1) * 0.02)] ?? minZ;
    const p98 = samples[Math.floor((samples.length - 1) * 0.98)] ?? maxZ;
    return { minDepth: -maxZ, maxDepth: -minZ, minZ, maxZ, robustMinZ: p02, robustMaxZ: p98 };
  }, [grid]);

  // Exageración vertical efectiva: en automático se adapta al desnivel real de
  // la zona y al zoom (poco relieve → más realce; grandes simas → menos).
  const exag = useMemo(() => {
    if (exagMode !== "auto") return exagMode * 1.6;
    if (!stats) return 3;
    const span = Math.max(2, stats.robustMaxZ - stats.robustMinZ);
    // Realce contenido: los veriles se ven, pero el fondo no se convierte
    // en una cordillera irreal (en Alcúdia, con ~90 m de desnivel → ×1.7).
    const base = Math.max(1.1, Math.min(5.5, 150 / span));

    return base * (1 + Math.min(0.6, Math.log2(Math.max(1, zoom)) * 0.18));
  }, [exagMode, stats, zoom]);

  const setAnchoredZoom = useCallback((nextZoom: number, anchorX: number, anchorY: number) => {
    const canvas = terrainRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const currentZoom = zoomRef.current;
    const currentPan = panRef.current;
    const next = clampZoom(nextZoom);
    const k = next / Math.max(0.001, currentZoom);
    const localX = anchorX - rect.left;
    const localY = anchorY - rect.top;
    const nextPan = {
      x: localX - cx - (localX - cx - currentPan.x) * k,
      y: localY - cy - (localY - cy - currentPan.y) * k,
    };
    zoomRef.current = next;
    panRef.current = nextPan;
    setZoom(next);
    setPan(nextPan);
  }, []);

  // ============================ TERRENO ============================
  const drawTerrain = useCallback(
    (targetRes: number) => {
      const canvas = terrainRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      if (W < 2 || H < 2) return;
      viewSizeRef.current = { w: W, h: H };
      const nextW = Math.max(1, Math.round(W * dpr));
      const nextH = Math.max(1, Math.round(H * dpr));
      if (canvas.width !== nextW) canvas.width = nextW;
      if (canvas.height !== nextH) canvas.height = nextH;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#06182a");
      bg.addColorStop(0.5, "#04111e");
      bg.addColorStop(1, "#01070e");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      const halo = ctx.createRadialGradient(
        W / 2,
        H * 0.52,
        10,
        W / 2,
        H * 0.52,
        Math.max(W, H) * 0.62,
      );
      halo.addColorStop(0, "rgba(56,132,180,0.20)");
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, W, H);

      if (!grid || !stats) {
        sceneRef.current = null;
        ctx.fillStyle = "rgba(125,211,252,0.85)";
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText("Sin datos de fondo en esta zona", 16, 28);
        return;
      }

      // --- Remuestreo por media de bloque (antialias del relieve) ---
      const colsN = Math.max(2, Math.min(targetRes, grid.cols));
      const rowsN = Math.max(2, Math.min(targetRes, grid.rows));
      const stepC = grid.cols / colsN;
      const stepR = grid.rows / rowsN;

      const raw = new Float32Array(rowsN * colsN);
      for (let r = 0; r < rowsN; r++) {
        const r0 = Math.floor(r * stepR);
        const r1 = Math.max(r0 + 1, Math.floor((r + 1) * stepR));
        for (let c = 0; c < colsN; c++) {
          const c0 = Math.floor(c * stepC);
          const c1 = Math.max(c0 + 1, Math.floor((c + 1) * stepC));
          let sum = 0;
          let n = 0;
          for (let rr = r0; rr < r1 && rr < grid.rows; rr++) {
            for (let cc = c0; cc < c1 && cc < grid.cols; cc++) {
              const v = grid.elev[rr * grid.cols + cc];
              if (!Number.isFinite(v)) continue;
              // La tierra emergida se aplana a la línea de costa (0 m): antes
              // se descartaba y dejaba agujeros que el relieve convertía en
              // cortinas y pinchos verticales.
              sum += v < 0 ? v : 0;
              n++;
            }
          }
          raw[r * colsN + c] = n ? sum / n : NaN;

        }
      }

      // Relleno de huecos pequeños: evita agujeros negros artificiales sin
      // inventar fondo donde no hay datos (solo 1 celda de radio).
      const filled = Float32Array.from(raw);
      for (let r = 0; r < rowsN; r++) {
        for (let c = 0; c < colsN; c++) {
          const i = r * colsN + c;
          if (Number.isFinite(raw[i])) continue;
          let s = 0;
          let n = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr;
              const cc = c + dc;
              if (rr < 0 || cc < 0 || rr >= rowsN || cc >= colsN) continue;
              const v = raw[rr * colsN + cc];
              if (Number.isFinite(v)) {
                s += v;
                n++;
              }
            }
          }
          if (n >= 5) filled[i] = s / n;
        }
      }

      // Anti-picos: una celda no puede alejarse más de 3 desviaciones robustas
      // de la mediana de su vecindario. Elimina los pinchos y agujeros del DEM
      // sin tocar veriles ni cambios reales de profundidad (que son continuos).
      {
        const src = Float32Array.from(filled);
        const buf: number[] = [];
        for (let r = 0; r < rowsN; r++) {
          for (let c = 0; c < colsN; c++) {
            const i = r * colsN + c;
            const v = src[i];
            if (!Number.isFinite(v)) continue;
            buf.length = 0;
            for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                const rr = r + dr;
                const cc = c + dc;
                if (rr < 0 || cc < 0 || rr >= rowsN || cc >= colsN) continue;
                if (dr === 0 && dc === 0) continue;
                const nv = src[rr * colsN + cc];
                if (Number.isFinite(nv)) buf.push(nv);
              }
            }
            if (buf.length < 4) continue;
            buf.sort((a, b) => a - b);
            const med = buf[buf.length >> 1];
            let acc = 0;
            for (const nv of buf) acc += Math.abs(nv - med);
            const mad = acc / buf.length;
            const lim = Math.max(0.6, mad * 3);
            if (Math.abs(v - med) > lim) filled[i] = med + Math.sign(v - med) * lim;
          }
        }
      }


      const K = [1, 2, 1];
      const smoothed = new Float32Array(rowsN * colsN);
      for (let r = 0; r < rowsN; r++) {
        for (let c = 0; c < colsN; c++) {
          const i = r * colsN + c;
          if (!Number.isFinite(filled[i])) {
            smoothed[i] = NaN;
            continue;
          }
          let s = 0;
          let w = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr;
              const cc = c + dc;
              if (rr < 0 || cc < 0 || rr >= rowsN || cc >= colsN) continue;
              const v = filled[rr * colsN + cc];
              if (!Number.isFinite(v)) continue;
              const k = K[dr + 1] * K[dc + 1];
              s += v * k;
              w += k;
            }
          }
          smoothed[i] = w ? s / w : filled[i];
        }
      }

      const zArr = Float32Array.from(smoothed);
      const detail = new Float32Array(rowsN * colsN);

      if (microRelief && microAllowed) {
        const broad = new Float32Array(rowsN * colsN);
        const R = 3;
        for (let r = 0; r < rowsN; r++) {
          for (let c = 0; c < colsN; c++) {
            const i = r * colsN + c;
            if (!Number.isFinite(zArr[i])) {
              broad[i] = NaN;
              continue;
            }
            let s2 = 0;
            let n2 = 0;
            for (let dr = -R; dr <= R; dr++) {
              for (let dc = -R; dc <= R; dc++) {
                const rr = r + dr;
                const cc = c + dc;
                if (rr < 0 || cc < 0 || rr >= rowsN || cc >= colsN) continue;
                const v = zArr[rr * colsN + cc];
                if (!Number.isFinite(v)) continue;
                s2 += v;
                n2++;
              }
            }
            broad[i] = n2 ? s2 / n2 : zArr[i];
          }
        }
        const deltas: number[] = [];
        for (let i = 0; i < zArr.length; i++) {
          if (!Number.isFinite(zArr[i]) || !Number.isFinite(broad[i])) continue;
          const d = zArr[i] - broad[i];
          detail[i] = d;
          deltas.push(Math.abs(d));
        }
        deltas.sort((a, b) => a - b);
        const mad = deltas.length ? deltas[Math.floor(deltas.length * 0.5)] : 0;
        const gate = mad * 0.9;
        const robustSpan = Math.max(4, stats.robustMaxZ - stats.robustMinZ);
        const maxEnhancement = Math.max(1, Math.min(6, robustSpan * 0.04));
        for (let i = 0; i < zArr.length; i++) {
          if (!Number.isFinite(zArr[i]) || !Number.isFinite(broad[i])) continue;
          const measured = detail[i];
          const mag = Math.abs(measured);
          if (mag <= gate) continue;
          const soft = Math.sign(measured) * (mag - gate);
          zArr[i] += Math.max(-maxEnhancement, Math.min(maxEnhancement, soft * detailStrength));
        }
        const tmp = Float32Array.from(zArr);
        for (let r = 0; r < rowsN; r++) {
          for (let c = 0; c < colsN; c++) {
            const i = r * colsN + c;
            if (!Number.isFinite(tmp[i])) continue;
            let s = 0;
            let w = 0;
            for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                const rr = r + dr;
                const cc = c + dc;
                if (rr < 0 || cc < 0 || rr >= rowsN || cc >= colsN) continue;
                const v = tmp[rr * colsN + cc];
                if (!Number.isFinite(v)) continue;
                const k = K[dr + 1] * K[dc + 1];
                s += v * k;
                w += k;
              }
            }
            if (w) zArr[i] = s / w;
          }
        }
      }

      const manualMaxZ = clipMin != null ? -clipMin : null;
      const manualMinZ = clipMax != null ? -clipMax : null;
      const displayMinZ = manualMinZ ?? stats.robustMinZ;
      let displayMaxZ = manualMaxZ ?? stats.robustMaxZ;
      if (displayMaxZ - displayMinZ < 1) displayMaxZ = displayMinZ + 1;
      const span = Math.max(4, displayMaxZ - displayMinZ);
      const manual = manualMinZ != null || manualMaxZ != null;
      const lo = manual ? displayMinZ : displayMinZ - span * 0.08;
      const hi = manual ? displayMaxZ : displayMaxZ + span * 0.08;
      const vScale = 0.105 * exag;
      const hOf = (i: number) =>
        ((Math.max(lo, Math.min(hi, zArr[i])) - displayMinZ) / span) * vScale;

      // Oclusión ambiental barata (media de vecindario amplio).
      const RAD = 3;
      const ao = new Float32Array(rowsN * colsN);
      for (let r = 0; r < rowsN; r++) {
        for (let c = 0; c < colsN; c++) {
          const i = r * colsN + c;
          if (!Number.isFinite(zArr[i])) continue;
          let s = 0;
          let n = 0;
          for (let dr = -RAD; dr <= RAD; dr++) {
            for (let dc = -RAD; dc <= RAD; dc++) {
              const rr = r + dr;
              const cc = c + dc;
              if (rr < 0 || cc < 0 || rr >= rowsN || cc >= colsN) continue;
              const v = zArr[rr * colsN + cc];
              if (!Number.isFinite(v)) continue;
              s += v;
              n++;
            }
          }
          if (!n) continue;
          ao[i] = Math.max(-1, Math.min(1, ((zArr[i] - s / n) / span) * 34));
        }
      }

      const yawR = (yaw * Math.PI) / 180;
      const tiltR = (clampTilt(tilt) * Math.PI) / 180;
      const dist = 3.1;
      // Encuadre: el relieve llena la pantalla desde el primer momento.
      const focal = Math.min(W, H) * 2.05 * zoom;

      const aspectRatio = colsN / rowsN;
      const sx = aspectRatio >= 1 ? 1 : aspectRatio;
      const sy = aspectRatio >= 1 ? 1 / aspectRatio : 1;
      const panX = pan.x;
      const panY = pan.y;

      const project = (u: number, v: number, h: number) => {
        const x = u * sx * Math.cos(yawR) - v * sy * Math.sin(yawR);
        const y = u * sx * Math.sin(yawR) + v * sy * Math.cos(yawR);
        const yc = y * Math.cos(tiltR) - h * Math.sin(tiltR);
        const zc = y * Math.sin(tiltR) + h * Math.cos(tiltR) + dist;
        const k = focal / Math.max(0.35, zc);
        return { x: W / 2 + panX + x * k, y: H * 0.52 + panY + yc * k, z: zc };
      };

      const azR = ((90 - sunAz) * Math.PI) / 180;
      const altR = (40 * Math.PI) / 180;
      const L = {
        x: Math.cos(altR) * Math.cos(azR),
        y: -Math.cos(altR) * Math.sin(azR),
        z: Math.sin(altR),
      };

      const du = 1 / (colsN - 1);
      const dv = 1 / (rowsN - 1);
      const baseH = -0.07;

      // Escala métrica de la celda → pendientes reales en grados.
      const midLat = (grid.north + grid.south) / 2;
      const widthMeters =
        Math.abs(grid.east - grid.west) * 111320 * Math.cos((midLat * Math.PI) / 180);
      const heightMeters = Math.abs(grid.north - grid.south) * 110540;
      const cellXm = widthMeters / Math.max(1, colsN - 1);
      const cellYm = heightMeters / Math.max(1, rowsN - 1);

      const nX = new Float32Array(rowsN * colsN);
      const nY = new Float32Array(rowsN * colsN);
      const nZ = new Float32Array(rowsN * colsN);
      const slopeDeg = new Float32Array(rowsN * colsN);
      const dxW = du * sx;
      const dyW = dv * sy;
      for (let r = 0; r < rowsN; r++) {
        for (let c = 0; c < colsN; c++) {
          const i = r * colsN + c;
          if (!Number.isFinite(zArr[i])) {
            slopeDeg[i] = NaN;
            continue;
          }
          const iL = c > 0 ? r * colsN + (c - 1) : i;
          const iR = c < colsN - 1 ? r * colsN + (c + 1) : i;
          const iU = r > 0 ? (r - 1) * colsN + c : i;
          const iD = r < rowsN - 1 ? (r + 1) * colsN + c : i;
          const hL = Number.isFinite(zArr[iL]) ? hOf(iL) : hOf(i);
          const hR = Number.isFinite(zArr[iR]) ? hOf(iR) : hOf(i);
          const hU = Number.isFinite(zArr[iU]) ? hOf(iU) : hOf(i);
          const hD = Number.isFinite(zArr[iD]) ? hOf(iD) : hOf(i);
          const ax = -(hR - hL) / (2 * dxW);
          const ay = -(hD - hU) / (2 * dyW);
          const len = Math.hypot(ax, ay, 1) || 1;
          nX[i] = ax / len;
          nY[i] = ay / len;
          nZ[i] = 1 / len;
          // Pendiente real (m/m), sin exageración vertical.
          const zL = Number.isFinite(zArr[iL]) ? zArr[iL] : zArr[i];
          const zR = Number.isFinite(zArr[iR]) ? zArr[iR] : zArr[i];
          const zU = Number.isFinite(zArr[iU]) ? zArr[iU] : zArr[i];
          const zD = Number.isFinite(zArr[iD]) ? zArr[iD] : zArr[i];
          const gx = (zR - zL) / (2 * Math.max(1, cellXm));
          const gy = (zD - zU) / (2 * Math.max(1, cellYm));
          slopeDeg[i] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
        }
      }

      type Quad = {
        z: number;
        pts: { x: number; y: number }[];
        fill: string;
        lines?: { a: { x: number; y: number }; b: { x: number; y: number }; master: boolean }[];
      };
      const quads: Quad[] = [];

      const levels: number[] = [];
      const step = niceStep(stats.maxDepth - stats.minDepth);
      if (contours) {
        for (let d = Math.ceil(stats.minDepth / step) * step; d <= stats.maxDepth; d += step) {
          levels.push(d);
        }
      }
      const masterEvery = step * 5;
      const fogCol: RGB = [8, 26, 44];

      for (let r = 0; r < rowsN - 1; r++) {
        for (let c = 0; c < colsN - 1; c++) {
          const i00 = r * colsN + c;
          const i01 = r * colsN + c + 1;
          const i11 = (r + 1) * colsN + c + 1;
          const i10 = (r + 1) * colsN + c;
          if (
            !Number.isFinite(zArr[i00]) ||
            !Number.isFinite(zArr[i01]) ||
            !Number.isFinite(zArr[i11]) ||
            !Number.isFinite(zArr[i10])
          ) {
            continue;
          }

          const u0 = c * du - 0.5;
          const u1 = (c + 1) * du - 0.5;
          const v0 = r * dv - 0.5;
          const v1 = (r + 1) * dv - 0.5;

          const p00 = project(u0, v0, hOf(i00));
          const p01 = project(u1, v0, hOf(i01));
          const p11 = project(u1, v1, hOf(i11));
          const p10 = project(u0, v1, hOf(i10));

          let nx = (nX[i00] + nX[i01] + nX[i11] + nX[i10]) / 4;
          let ny = (nY[i00] + nY[i01] + nY[i11] + nY[i10]) / 4;
          let nz = (nZ[i00] + nZ[i01] + nZ[i11] + nZ[i10]) / 4;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl;
          ny /= nl;
          nz /= nl;

          const lambert = Math.max(0, nx * L.x + ny * L.y + nz * L.z);
          const rim = Math.max(0, nx * -L.y + ny * L.x + nz * 0.18);
          const sky = 0.5 + 0.5 * nz;
          const occ = 1 + 0.28 * ((ao[i00] + ao[i01] + ao[i11] + ao[i10]) / 4);
          const spec = Math.pow(lambert, 30) * 0.13;
          const localDetail = (detail[i00] + detail[i01] + detail[i11] + detail[i10]) / 4;
          const detailTone = Math.max(
            -0.3,
            Math.min(0.3, (localDetail / Math.max(0.5, span * 0.012)) * 0.2),
          );
          const shade =
            (0.2 + 0.17 * sky + 0.83 * lambert + 0.3 * rim + detailTone) * Math.max(0.46, occ);

          const dp = -(zArr[i00] + zArr[i01] + zArr[i11] + zArr[i10]) / 4;
          let base: RGB;
          if (colorMode === "relieve") {
            base = [176, 186, 196];
          } else if (colorMode === "profundidad") {
            base = rampColor(dp);
          } else {
            base = rampColor(dp);
          }

          // Mapa de pendientes opcional (verde → amarillo → rojo).
          if (slopeShade) {
            const sl = (slopeDeg[i00] + slopeDeg[i01] + slopeDeg[i11] + slopeDeg[i10]) / 4;
            if (Number.isFinite(sl)) {
              const t = Math.max(0, Math.min(1, sl / 22));
              const sc: RGB =
                t < 0.5
                  ? [90 + 300 * t, 190, 110]
                  : [240, 190 - 150 * (t - 0.5) * 2, 90 - 40 * (t - 0.5) * 2];
              base = [
                base[0] * 0.35 + sc[0] * 0.65,
                base[1] * 0.35 + sc[1] * 0.65,
                base[2] * 0.35 + sc[2] * 0.65,
              ];
            }
          }

          // En modo "profundidad" el sombreado es suave (color puro y legible);
          // en "relieve" y "combinado" manda la iluminación.
          const shadeMix = colorMode === "profundidad" ? 0.35 + 0.65 * Math.min(1, shade) : shade;
          let rr = base[0] * shadeMix + 255 * spec;
          let gg = base[1] * shadeMix + 255 * spec;
          let bb = base[2] * shadeMix + 255 * spec;

          const zc = (p00.z + p01.z + p11.z + p10.z) / 4;
          const fog = Math.max(0, Math.min(0.55, (zc - dist * 0.72) * 0.34));
          rr = rr + (fogCol[0] - rr) * fog;
          gg = gg + (fogCol[1] - gg) * fog;
          bb = bb + (fogCol[2] - bb) * fog;

          const q: Quad = {
            z: zc,
            pts: [p00, p01, p11, p10],
            fill: `rgb(${Math.max(0, Math.min(255, rr)) | 0},${Math.max(0, Math.min(255, gg)) | 0},${
              Math.max(0, Math.min(255, bb)) | 0
            })`,
          };

          if (levels.length) {
            const d00 = -zArr[i00];
            const d01 = -zArr[i01];
            const d11 = -zArr[i11];
            const d10 = -zArr[i10];
            const dmin = Math.min(d00, d01, d11, d10);
            const dmax = Math.max(d00, d01, d11, d10);
            for (const lv of levels) {
              if (lv < dmin || lv > dmax) continue;
              const pts: { x: number; y: number }[] = [];
              const edge = (
                da: number,
                db: number,
                pa: { x: number; y: number },
                pb: { x: number; y: number },
              ) => {
                if (da === db) return;
                const t = (lv - da) / (db - da);
                if (t < 0 || t > 1) return;
                pts.push({ x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t });
              };
              edge(d00, d01, p00, p01);
              edge(d01, d11, p01, p11);
              edge(d11, d10, p11, p10);
              edge(d10, d00, p10, p00);
              if (pts.length >= 2) {
                (q.lines ||= []).push({
                  a: pts[0],
                  b: pts[1],
                  master: Math.abs(lv % masterEvery) < 1e-6,
                });
              }
            }
          }

          quads.push(q);

          const wall = (
            pa: { x: number; y: number; z: number },
            pb: { x: number; y: number; z: number },
            ua: number,
            va: number,
            ub: number,
            vb: number,
            tone: number,
          ) => {
            const ba = project(ua, va, baseH);
            const bb2 = project(ub, vb, baseH);
            quads.push({
              z: (pa.z + pb.z) / 2 + 0.0015,
              pts: [pa, pb, bb2, ba],
              fill: `rgb(${(12 * tone) | 0},${(30 * tone) | 0},${(50 * tone) | 0})`,
            });
          };
          if (r === 0) wall(p00, p01, u0, v0, u1, v0, 1.15);
          if (r === rowsN - 2) wall(p10, p11, u0, v1, u1, v1, 0.75);
          if (c === 0) wall(p00, p10, u0, v0, u0, v1, 0.95);
          if (c === colsN - 2) wall(p01, p11, u1, v0, u1, v1, 1.05);
        }
      }

      if (!quads.length) {
        sceneRef.current = null;
        ctx.fillStyle = "rgba(125,211,252,0.85)";
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText("Zona sin fondo marino", 16, 28);
        return;
      }

      quads.sort((a, b) => b.z - a.z);
      for (const q of quads) {
        ctx.beginPath();
        ctx.moveTo(q.pts[0].x, q.pts[0].y);
        for (let i = 1; i < q.pts.length; i++) ctx.lineTo(q.pts[i].x, q.pts[i].y);
        ctx.closePath();
        ctx.fillStyle = q.fill;
        ctx.fill();
        ctx.strokeStyle = q.fill;
        ctx.lineWidth = 0.35;
        ctx.stroke();
      }
      for (const q of quads) {
        if (!q.lines) continue;
        for (const ln of q.lines) {
          ctx.beginPath();
          ctx.moveTo(ln.a.x, ln.a.y);
          ctx.lineTo(ln.b.x, ln.b.y);
          ctx.strokeStyle = ln.master ? "rgba(6,18,32,0.62)" : "rgba(10,28,46,0.30)";
          ctx.lineWidth = ln.master ? 1.05 : 0.6;
          ctx.stroke();
        }
      }

      // Muestreo bilineal para la capa de overlay.
      const sample = (arr: Float32Array, u: number, v: number): number => {
        const x = Math.max(0, Math.min(colsN - 1, u * (colsN - 1)));
        const y = Math.max(0, Math.min(rowsN - 1, v * (rowsN - 1)));
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(colsN - 1, x0 + 1);
        const y1 = Math.min(rowsN - 1, y0 + 1);
        const tx = x - x0;
        const ty = y - y0;
        const vals = [
          arr[y0 * colsN + x0],
          arr[y0 * colsN + x1],
          arr[y1 * colsN + x0],
          arr[y1 * colsN + x1],
        ];
        if (vals.some((n) => !Number.isFinite(n))) {
          const f = vals.find((n) => Number.isFinite(n));
          return f ?? NaN;
        }
        const a = vals[0] + (vals[1] - vals[0]) * tx;
        const b = vals[2] + (vals[3] - vals[2]) * tx;
        return a + (b - a) * ty;
      };

      const pA = project(-0.5, 0, 0);
      const pB = project(0.5, 0, 0);
      const pxPerMeter = Math.hypot(pB.x - pA.x, pB.y - pA.y) / Math.max(1, widthMeters);

      sceneRef.current = {
        project,
        hAt: (u, v) => {
          const x = Math.max(0, Math.min(colsN - 1, Math.round(u * (colsN - 1))));
          const y = Math.max(0, Math.min(rowsN - 1, Math.round(v * (rowsN - 1))));
          const i = y * colsN + x;
          return Number.isFinite(zArr[i]) ? hOf(i) : 0;
        },
        depthAt: (u, v) => {
          const z = sample(zArr, u, v);
          return Number.isFinite(z) ? -z : null;
        },
        slopeAt: (u, v) => {
          const s = sample(slopeDeg, u, v);
          return Number.isFinite(s) ? s : null;
        },
        colsN,
        rowsN,
        minDepth: stats.minDepth,
        maxDepth: stats.maxDepth,
        step,
        exag,
        pxPerMeter,
        north: grid.north,
        south: grid.south,
        east: grid.east,
        west: grid.west,
      };
    },
    [
      grid,
      stats,
      yaw,
      tilt,
      exag,
      sunAz,
      zoom,
      pan,
      contours,
      microRelief,
      microAllowed,

      detailStrength,
      clipMin,
      clipMax,
      colorMode,
      slopeShade,
    ],
  );

  // ============================ OVERLAY ============================
  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (W < 2 || H < 2) return;
    const nw = Math.round(W * dpr);
    const nh = Math.round(H * dpr);
    if (canvas.width !== nw) canvas.width = nw;
    if (canvas.height !== nh) canvas.height = nh;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const sc = sceneRef.current;
    if (!sc) return;
    const mono = (s: number) => `${s}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const toUV = (lat: number, lng: number) => ({
      u: (lng - sc.west) / Math.max(1e-9, sc.east - sc.west),
      v: (sc.north - lat) / Math.max(1e-9, sc.north - sc.south),
    });
    const projLL = (lat: number, lng: number, lift = 0) => {
      const { u, v } = toUV(lat, lng);
      const cu = Math.max(0, Math.min(1, u));
      const cv = Math.max(0, Math.min(1, v));
      const h = sc.hAt(cu, cv);
      const p = sc.project(cu - 0.5, cv - 0.5, h + lift);
      return { ...p, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1, u: cu, v: cv, h };
    };

    const boat = smoothGpsRef.current;

    // ---- Estela del recorrido ----
    if (showTrail && trailRef.current.length > 1) {
      ctx.beginPath();
      trailRef.current.forEach((p, i) => {
        const q = projLL(p.lat, p.lng, 0.004);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
      ctx.strokeStyle = "rgba(45,212,191,0.55)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // ---- Línea barco → punto objetivo ----
    if (boat && target) {
      const a = projLL(boat.lat, boat.lng, 0.02);
      const b = projLL(target.lat, target.lng, 0.02);
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = "rgba(250,204,21,0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---- Puntos Top y waypoints (siempre por encima del terreno) ----
    const drawPin = (
      lat: number,
      lng: number,
      color: string,
      label: string,
      big: boolean,
    ) => {
      const p = projLL(lat, lng, 0);
      if (!p.inside) return;
      const top = sc.project(p.u - 0.5, p.v - 0.5, p.h + (big ? 0.13 : 0.09));
      ctx.strokeStyle = color;
      ctx.lineWidth = big ? 2 : 1.4;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, big ? 6 : 4, big ? 2.6 : 1.8, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(top.x, top.y, big ? 6 : 4.2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "rgba(2,10,19,0.9)";
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.font = mono(big ? 10 : 9);
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(2,12,22,0.7)";
      ctx.fillRect(top.x + 8, top.y - 8, tw + 8, 14);
      ctx.fillStyle = "rgba(232,248,255,0.95)";
      ctx.fillText(label, top.x + 12, top.y + 2);
    };

    if (showSpots) {
      const top = [...spots]
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 12);
      top.forEach((s, i) => {
        const rank = s.rank ?? i + 1;
        const isTop = rank <= 3;
        drawPin(
          s.lat,
          s.lng,
          isTop ? ["#f97316", "#facc15", "#a3e635"][rank - 1] : "rgba(148,197,255,0.85)",
          isTop ? `TOP ${rank}` : "",
          isTop,
        );
      });
    }
    if (showWaypoints) {
      for (const w of waypoints.slice(0, 40)) {
        drawPin(w.lat, w.lng, "#c084fc", w.name ?? "", false);
      }
    }

    // ---- Barco en directo ----
    gpsScreenRef.current = null;
    if (boat) {
      const p = projLL(boat.lat, boat.lng, 0);
      const top = sc.project(p.u - 0.5, p.v - 0.5, p.h + 0.16);
      gpsScreenRef.current = { x: p.x, y: p.y, inside: p.inside };
      const color = p.inside ? "#22d3ee" : "#f59e0b";
      ctx.strokeStyle = p.inside ? "rgba(34,211,238,0.9)" : "rgba(245,158,11,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
      for (const rad of [7, 15, 24]) {
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, rad, rad * 0.42, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(34,211,238,${rad === 7 ? 0.8 : 0.28})`;
        ctx.lineWidth = rad === 7 ? 1.6 : 1;
        ctx.stroke();
      }
      // Proa: flecha orientada al rumbo real, proyectada sobre el plano.
      const hdg = boat.hdg;
      if (Number.isFinite(hdg)) {
        const dLat = Math.cos((hdg * Math.PI) / 180) * 0.0016;
        const dLng =
          (Math.sin((hdg * Math.PI) / 180) * 0.0016) /
          Math.max(0.2, Math.cos((boat.lat * Math.PI) / 180));
        const q = projLL(boat.lat + dLat, boat.lng + dLng, 0);
        const ang = Math.atan2(q.y - p.y, q.x - p.x);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(20, 0);
        ctx.lineTo(-8, 8);
        ctx.lineTo(-3, 0);
        ctx.lineTo(-8, -8);
        ctx.closePath();
        ctx.fillStyle = "rgba(34,211,238,0.95)";
        ctx.fill();
        ctx.strokeStyle = "rgba(2,12,22,0.85)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(top.x, top.y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "rgba(2,10,19,0.9)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      const gd = sc.depthAt(p.u, p.v);
      const label = p.inside
        ? gd != null
          ? `Barco · ${gd.toFixed(1)} m`
          : "Barco"
        : "Barco fuera de la zona";
      ctx.font = mono(10);
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(2,12,22,0.65)";
      ctx.fillRect(top.x + 7, top.y - 8, tw + 8, 14);
      ctx.fillStyle = "rgba(226,244,255,0.95)";
      ctx.fillText(label, top.x + 11, top.y + 2);
    }

    // ---- Punto tocado ----
    if (pick) {
      const p = projLL(pick.lat, pick.lng, 0.01);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - 11, p.y);
      ctx.lineTo(p.x + 11, p.y);
      ctx.moveTo(p.x, p.y - 11);
      ctx.lineTo(p.x, p.y + 11);
      ctx.stroke();
    }

    // ---------------- HUD ----------------
    const pad = 14;
    if (showHud) {
    const legX = pad;
    const legY = pad + 6;
    const legW = 9;
    const legH = Math.max(70, Math.min(150, H - 130));
    const grad = ctx.createLinearGradient(0, legY, 0, legY + legH);
    for (let i = 0; i <= 12; i++) {
      const d = sc.minDepth + ((sc.maxDepth - sc.minDepth) * i) / 12;
      const cc = rampColor(d);
      grad.addColorStop(i / 12, `rgb(${cc[0] | 0},${cc[1] | 0},${cc[2] | 0})`);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(legX, legY, legW, legH);
    ctx.strokeStyle = "rgba(226,244,255,0.30)";
    ctx.lineWidth = 1;
    ctx.strokeRect(legX + 0.5, legY + 0.5, legW, legH);
    ctx.font = mono(9);
    for (let i = 0; i <= 4; i++) {
      const y = legY + (legH * i) / 4;
      const d = sc.minDepth + ((sc.maxDepth - sc.minDepth) * i) / 4;
      ctx.beginPath();
      ctx.moveTo(legX + legW, y);
      ctx.lineTo(legX + legW + 4, y);
      ctx.strokeStyle = "rgba(226,244,255,0.45)";
      ctx.stroke();
      ctx.fillStyle = "rgba(226,244,255,0.80)";
      ctx.fillText(`${Math.round(d)}`, legX + legW + 7, y + 3);
    }
    ctx.fillStyle = "rgba(226,244,255,0.55)";
    ctx.fillText("PROF. (m)", legX, legY - 6);

    // Escala horizontal.
    if (Number.isFinite(sc.pxPerMeter) && sc.pxPerMeter > 0) {
      const targetPx = Math.min(150, W * 0.22);
      const rawKm = targetPx / sc.pxPerMeter / 1000;
      const p10 = Math.pow(10, Math.floor(Math.log10(Math.max(0.05, rawKm))));
      const nk = rawKm / p10;
      const km = (nk < 1.5 ? 1 : nk < 3.5 ? 2 : nk < 7.5 ? 5 : 10) * p10;
      const barPx = km * 1000 * sc.pxPerMeter;
      const bx = pad;
      const by = H - pad - 8;
      ctx.strokeStyle = "rgba(226,244,255,0.85)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + barPx, by);
      ctx.stroke();
      ctx.lineWidth = 1;
      for (const x of [bx, bx + barPx]) {
        ctx.beginPath();
        ctx.moveTo(x, by - 4);
        ctx.lineTo(x, by + 4);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(226,244,255,0.85)";
      ctx.font = mono(10);
      ctx.fillText(km >= 1 ? `${km} km` : `${Math.round(km * 1000)} m`, bx, by - 8);
    }
    }



    // Brújula.
    const cx = W - pad - 22;
    const cy = pad + 22;
    const nrm = sc.project(0, -0.5, 0);
    const ctr = sc.project(0, 0, 0);
    let ang = Math.atan2(nrm.y - ctr.y, nrm.x - ctr.x);
    if (!Number.isFinite(ang)) ang = -Math.PI / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = "rgba(226,244,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 17, 0, Math.PI * 2);
    ctx.stroke();
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(13, 0);
    ctx.lineTo(-6, 5.5);
    ctx.lineTo(-2.5, 0);
    ctx.lineTo(-6, -5.5);
    ctx.closePath();
    ctx.fillStyle = "rgba(232,248,255,0.92)";
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "rgba(226,244,255,0.70)";
    ctx.font = mono(9);
    ctx.fillText("N", cx - 3, cy + 29);

    if (showHud) {
      ctx.fillStyle = "rgba(226,244,255,0.55)";
      ctx.font = mono(9);
      ctx.fillText(
        [
          `${Math.round(sc.minDepth)}–${Math.round(sc.maxDepth)} m`,
          contours ? `isóbatas ${Math.round(sc.step)} m` : "sin isóbatas",
          `×${sc.exag.toFixed(1)} relieve${exagMode === "auto" ? " (auto)" : ""}`,
          `${sc.colsN}×${sc.rowsN}`,
        ].join("   ·   "),
        pad,
        H - pad - 26,
      );
    }
  }, [
    spots,
    waypoints,
    showSpots,
    showWaypoints,
    showTrail,
    target,
    pick,
    contours,
    exagMode,
    showHud,
  ]);

  // ---------- Interpolación suave del barco ----------
  useEffect(() => {
    if (!gpsPosition) return;
    const last = trailRef.current[trailRef.current.length - 1];
    if (!last || haversineM(last, gpsPosition) > 5) {
      trailRef.current = [...trailRef.current, { lat: gpsPosition.lat, lng: gpsPosition.lng }].slice(
        -600,
      );
    }
    if (!smoothGpsRef.current) {
      smoothGpsRef.current = {
        lat: gpsPosition.lat,
        lng: gpsPosition.lng,
        hdg: gpsPosition.heading ?? 0,
      };
      drawOverlay();
      return;
    }
    let raf = 0;
    const start = performance.now();
    const from = { ...smoothGpsRef.current };
    const toHdg = gpsPosition.heading ?? from.hdg;
    let dh = ((toHdg - from.hdg + 540) % 360) - 180;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 900);
      const e = t * (2 - t);
      smoothGpsRef.current = {
        lat: from.lat + (gpsPosition.lat - from.lat) * e,
        lng: from.lng + (gpsPosition.lng - from.lng) * e,
        hdg: (from.hdg + dh * e + 360) % 360,
      };
      drawOverlay();
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [gpsPosition, drawOverlay]);

  // ---------- Render con LOD ----------
  const scheduleTerrain = useCallback(() => {
    const mobile = Math.min(window.innerWidth, window.innerHeight) < 700;
    const fast = interactingRef.current ? 64 : mobile ? 110 : 150;
    requestAnimationFrame(() => {
      drawTerrain(fast);
      drawOverlay();
    });
    if (hiTimerRef.current != null) window.clearTimeout(hiTimerRef.current);
    hiTimerRef.current = window.setTimeout(() => {
      hiTimerRef.current = null;
      // Máxima calidad solo cuando la cámara está quieta.
      if (interactingRef.current) return;
      // Canvas 2D: 420²–640² celdas generaban cientos de miles de polígonos,
      // bloqueando Safari móvil varios segundos. Este límite conserva detalle
      // visible sin saturar el hilo principal.
      drawTerrain(mobile ? 180 : 260);
      drawOverlay();
    }, 280);
  }, [drawTerrain, drawOverlay]);

  useEffect(() => {
    scheduleTerrain();
    return () => {
      if (hiTimerRef.current != null) window.clearTimeout(hiTimerRef.current);
    };
  }, [scheduleTerrain]);

  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  // Redibuja al cambiar el tamaño / rotación del móvil.
  useEffect(() => {
    const canvas = terrainRef.current;
    const repaint = (res = 160) => {
      if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        drawTerrain(res);
        drawOverlay();
      });
    };
    const onResize = () => {
      repaint(110);
      if (resizeTimerRef.current != null) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        const mobile = Math.min(window.innerWidth, window.innerHeight) < 700;
        drawTerrain(mobile ? 180 : 260);
        drawOverlay();
      }, 500);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    const ro =
      typeof ResizeObserver !== "undefined" && canvas ? new ResizeObserver(() => repaint()) : null;
    if (ro && canvas) ro.observe(canvas);
    return () => {
      if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
      if (resizeTimerRef.current != null) window.clearTimeout(resizeTimerRef.current);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [drawTerrain, drawOverlay]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const check = () =>
      setPortrait(window.innerHeight > window.innerWidth && window.innerWidth < 900);
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);

  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    let idle: number | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      const intensity = e.ctrlKey ? 0.00045 : 0.00024;
      // Mientras rueda la rueda/pellizco se dibuja en baja resolución: sin esto
      // cada evento lanzaba un repintado a máxima calidad y la vista se congelaba.
      interactingRef.current = true;
      if (idle != null) window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        idle = null;
        interactingRef.current = false;
        scheduleTerrain();
      }, 180);
      setAnchoredZoom(zoomRef.current * Math.exp(-dy * intensity), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      if (idle != null) window.clearTimeout(idle);
      el.removeEventListener("wheel", onWheel);
    };
  }, [setAnchoredZoom, scheduleTerrain]);


  // ---------- Selección de punto del fondo ----------
  const pickAt = useCallback(
    (clientX: number, clientY: number) => {
      const sc = sceneRef.current;
      const canvas = overlayRef.current;
      if (!sc || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      let best: { u: number; v: number; d: number } | null = null;
      const N = 96;
      for (let r = 0; r <= N; r++) {
        const v = r / N;
        for (let c = 0; c <= N; c++) {
          const u = c / N;
          const p = sc.project(u - 0.5, v - 0.5, sc.hAt(u, v));
          const d = (p.x - px) ** 2 + (p.y - py) ** 2;
          if (!best || d < best.d) best = { u, v, d };
        }
      }
      if (!best || best.d > 60 * 60) return;
      const lat = sc.north - best.v * (sc.north - sc.south);
      const lng = sc.west + best.u * (sc.east - sc.west);
      const boat = smoothGpsRef.current;
      setPick({
        lat,
        lng,
        depth: sc.depthAt(best.u, best.v),
        slope: sc.slopeAt(best.u, best.v),
        distM: boat ? haversineM(boat, { lat, lng }) : null,
      });
    },
    [],
  );

  const centerOnBoat = useCallback(() => {
    const g = gpsScreenRef.current;
    const { w, h } = viewSizeRef.current;
    if (!g || !w || !h) return;
    const next = {
      x: panRef.current.x + (w / 2 - g.x),
      y: panRef.current.y + (h * 0.52 - g.y),
    };
    panRef.current = next;
    setPan(next);
  }, []);

  const resetCamera = useCallback(() => {
    setYaw(0);
    setTilt(70);
    setZoom(1);
    zoomRef.current = 1;
    setPan({ x: 0, y: 0 });
    panRef.current = { x: 0, y: 0 };
    setSensitivity(1);
    setPick(null);
  }, []);

  // Distancia / rumbo / ETA hasta el punto objetivo.
  const nav = useMemo(() => {
    const b = gpsPosition;
    if (!b || !target) return null;
    const distM = haversineM(b, target);
    const brg = bearingDeg(b, target);
    const sp = b.speed && b.speed > 0.2 ? b.speed : null;
    return {
      distM,
      brg,
      etaMin: sp ? distM / sp / 60 : null,
      kn: b.speed != null ? b.speed * 1.94384 : null,
    };
  }, [gpsPosition, target]);

  const btn =
    "h-9 w-9 rounded-full border border-white/15 bg-black/45 text-sm text-white backdrop-blur hover:bg-black/65 disabled:opacity-40";

  return (
    <div className="pointer-events-auto fixed inset-0 z-[100000] h-[100dvh] w-screen overflow-hidden bg-[#020a13]">
      <canvas ref={terrainRef} className="absolute inset-0 h-full w-full" style={{ display: "block" }} />
      <canvas
        ref={overlayRef}
        className="absolute inset-0 h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        style={{ display: "block" }}
        onPointerDown={(e) => {
          pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          interactingRef.current = true;
          if (pointersRef.current.size === 2) {
            const [a, b] = [...pointersRef.current.values()];
            pinchRef.current = {
              distance: Math.hypot(a.x - b.x, a.y - b.y),
              x: (a.x + b.x) / 2,
              y: (a.y + b.y) / 2,
            };
            dragRef.current = null;
          } else {
            dragRef.current = { x: e.clientX, y: e.clientY };
            movedRef.current = false;
          }
        }}
        onPointerMove={(e) => {
          if (pointersRef.current.has(e.pointerId)) {
            pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          }
          // Dos dedos: zoom + desplazar + inclinar (según el gesto dominante).
          if (pointersRef.current.size === 2 && pinchRef.current != null) {
            const [a, b] = [...pointersRef.current.values()];
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            const midX = (a.x + b.x) / 2;
            const midY = (a.y + b.y) / 2;
            if (pinchRef.current.distance > 0) {
              const ratio = dist / pinchRef.current.distance;
              const k = 1 + (ratio - 1) * 0.35;
              const dMid = midY - pinchRef.current.y;
              const before = panRef.current;
              setAnchoredZoom(zoomRef.current * k, midX, midY);
              // Gesto vertical con dos dedos casi paralelos → inclinar.
              if (Math.abs(ratio - 1) < 0.015 && Math.abs(dMid) > 3) {
                setTilt((t) => clampTilt(t - dMid * 0.12 * sensRef.current));

              } else {
                const movedPan = {
                  x: panRef.current.x + (midX - pinchRef.current.x),
                  y: panRef.current.y + dMid,
                };
                if (Math.hypot(movedPan.x - before.x, movedPan.y - before.y) > 0.35) {
                  panRef.current = movedPan;
                  setPan(movedPan);
                }
              }
            }
            pinchRef.current = { distance: dist, x: midX, y: midY };
            return;
          }
          const d = dragRef.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.hypot(dx, dy) < 1.5) return;
          movedRef.current = true;
          // Limita saltos bruscos pero mantiene la relación 1:1 con el dedo.
          const cap = (v: number) => Math.sign(v) * Math.min(Math.abs(v), 24);
          const cdx = cap(dx);
          const cdy = cap(dy);
          if (dragModeRef.current === "mover") {
            const next = { x: panRef.current.x + cdx, y: panRef.current.y + cdy };
            panRef.current = next;
            setPan(next);
          } else {
            const k = sensRef.current;
            // Bloqueo de eje: horizontal = giro, vertical = inclinación.
            // Evita que la cámara gire e incline a la vez y se pierda el control.
            const horizontal = Math.abs(cdx) >= Math.abs(cdy);
            if (horizontal) {
              setYaw((r) => {
                const next = r + cdx * 0.2 * k;
                return (((next + 180) % 360) + 360) % 360 - 180;
              });
            } else {
              setTilt((t) => clampTilt(t - cdy * 0.12 * k));
            }
          }
          dragRef.current = { x: e.clientX, y: e.clientY };

        }}
        onPointerUp={(e) => {
          pointersRef.current.delete(e.pointerId);
          if (pointersRef.current.size < 2) pinchRef.current = null;
          if (pointersRef.current.size === 0) {
            interactingRef.current = false;
            scheduleTerrain();
          }
          if (!movedRef.current) pickAt(e.clientX, e.clientY);
          dragRef.current = null;
        }}
        onPointerCancel={(e) => {
          pointersRef.current.delete(e.pointerId);
          pinchRef.current = null;
          dragRef.current = null;
          if (pointersRef.current.size === 0) interactingRef.current = false;
        }}
        onDoubleClick={(e) => setAnchoredZoom(zoomRef.current * 1.35, e.clientX, e.clientY)}
      />

      {/* Volver al visor 2D */}
      <button
        onClick={onClose}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="Cerrar vista 3D"
        className="pointer-events-auto absolute left-3 z-[100010] flex items-center gap-1.5 rounded-full border border-white/25 bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground shadow-lg backdrop-blur active:scale-95"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
      >
        <span aria-hidden>←</span> Cerrar 3D
      </button>

      {/* Indicador de calidad/procedencia del dato batimétrico */}
      {demQuality && (
        <div
          className="pointer-events-none absolute left-3 z-[100005] max-w-[62vw] rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-[10px] text-white/85 backdrop-blur"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 56px)" }}
          title={`${demQuality.detailNote} — ${demQuality.attribution}`}
        >
          <span
            className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
            style={{ background: demQuality.color }}
          />
          {demQuality.label}
          {demQuality.minFeatureM != null && (
            <span className="text-white/50"> · detalle real ≥{demQuality.minFeatureM} m</span>
          )}
          <span className="block truncate text-white/45">{demQuality.attribution}</span>
          {grid?.mbar24?.expected && !grid.mbar24.loaded && (
            <span className="block text-amber-300">
              ⚠ MBAR24 16 m no cargado{grid.mbar24.sheet ? ` (${grid.mbar24.sheet})` : ""} — se
              muestra batimetría pública
            </span>
          )}
        </div>
      )}




      {/* Botonera de cámara */}
      <div
        className="absolute right-3 flex flex-col gap-2"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
      >
        <button
          aria-label="Acercar"
          onClick={() => {
            const rect = overlayRef.current?.getBoundingClientRect();
            if (rect)
              setAnchoredZoom(
                zoomRef.current * 1.12,
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              );
          }}
          className={btn}
        >
          +
        </button>
        <button
          aria-label="Alejar"
          onClick={() => {
            const rect = overlayRef.current?.getBoundingClientRect();
            if (rect)
              setAnchoredZoom(
                zoomRef.current / 1.12,
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              );
          }}
          className={btn}
        >
          −
        </button>
        <button aria-label="Vista norte" onClick={() => setYaw(0)} className={btn}>
          N
        </button>
        <button
          aria-label="Vista aérea"
          onClick={() => {
            setTilt(84);
            setYaw(0);
          }}
          className={btn}
        >
          ⬒
        </button>
        <button
          aria-label="Vista desde el barco"
          onClick={() => {
            setTilt(24);
            const hdg = smoothGpsRef.current?.hdg;
            if (Number.isFinite(hdg)) setYaw(-(hdg as number));
            setZoom((z) => clampZoom(Math.max(z, 2.2)));
            zoomRef.current = clampZoom(Math.max(zoomRef.current, 2.2));
            requestAnimationFrame(() => centerOnBoat());
          }}
          disabled={!gpsPosition}
          className={btn}
        >
          👁
        </button>
        <button
          aria-label="Centrar en mi barco"
          onClick={centerOnBoat}
          disabled={!gpsPosition}
          className={btn}
        >
          ⛵
        </button>
        <button
          aria-label="Seguir el barco"
          onClick={() => onToggleFollowGps?.(!followGps)}
          className={`${btn} ${followGps ? "!bg-primary/70" : ""}`}
        >
          ⌖
        </button>
        <button aria-label="Restablecer cámara" onClick={resetCamera} className={btn}>
          ⟲
        </button>
        <button
          aria-label={dragMode === "mover" ? "Modo mover" : "Modo girar"}
          onClick={() => setDragMode((m) => (m === "mover" ? "girar" : "mover"))}
          className={btn}
        >
          {dragMode === "mover" ? "✋" : "⟳"}
        </button>
        <button
          aria-label={showHud ? "Ocultar datos en pantalla" : "Mostrar datos en pantalla"}
          onClick={() => setShowHud((v) => !v)}
          className={`${btn} ${showHud ? "!bg-primary/70" : ""}`}
        >
          {showHud ? "𝍢" : "◻"}
        </button>
        <button
          aria-label="Ajustes de la vista 3D"
          onClick={() => setShowControls((v) => !v)}
          className={`${btn} ${showControls ? "!bg-primary/70" : ""}`}
        >
          ⚙
        </button>
      </div>

      {portrait && (
        <div
          className="absolute left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/55 px-3 py-1 text-[11px] text-white backdrop-blur"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 58px)" }}
        >
          Gira el móvil en horizontal para más visión
        </div>
      )}

      {/* Panel de navegación (barco en directo) */}
      {(showHud || nav) && (gpsPosition || nav) && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-xl border border-white/12 bg-black/55 px-3 py-1.5 text-[11px] text-white backdrop-blur">
          {gpsPosition && (
            <span className="mr-3">
              SOG {gpsPosition.speed != null ? (gpsPosition.speed * 1.94384).toFixed(1) : "--"} kn ·
              COG {gpsPosition.heading != null ? Math.round(gpsPosition.heading) : "--"}°
            </span>
          )}
          {nav && (
            <span className="text-amber-300">
              → {target?.label}: {(nav.distM / 1852).toFixed(2)} NM · {Math.round(nav.brg)}°
              {nav.etaMin != null ? ` · ETA ${Math.round(nav.etaMin)} min` : ""}
            </span>
          )}
        </div>
      )}

      {/* Ficha del punto tocado */}
      {pick && (
        <div className="absolute bottom-16 right-3 w-[190px] rounded-xl border border-white/12 bg-black/60 p-2.5 text-[11px] text-white backdrop-blur">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold">Punto del fondo</span>
            <button onClick={() => setPick(null)} className="text-white/60">
              ✕
            </button>
          </div>
          <div className="font-mono text-[10px] leading-relaxed text-white/85">
            {toDegMinSec(pick.lat, "lat")}
            <br />
            {toDegMinSec(pick.lng, "lng")}
            <br />
            Prof.: {pick.depth != null ? `${pick.depth.toFixed(1)} m` : "--"}
            <br />
            Pendiente: {pick.slope != null ? `${pick.slope.toFixed(1)}°` : "--"}
            <br />
            Del barco: {pick.distM != null ? `${(pick.distM / 1852).toFixed(2)} NM` : "--"}
          </div>
          <button
            onClick={() =>
              setTarget({ lat: pick.lat, lng: pick.lng, label: "Punto" })
            }
            className="mt-2 w-full rounded border border-amber-300/40 bg-amber-400/15 py-1 text-[10px] text-amber-200"
          >
            Trazar rumbo hasta aquí
          </button>
        </div>
      )}

      {showControls && (
        <div
          className="absolute right-16 max-h-[80vh] w-[248px] overflow-y-auto rounded-xl border border-white/12 bg-black/65 p-3 text-white backdrop-blur"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
        >
          <div className="mb-2">
            <div className="mb-1 text-[10px] text-white/60">Exageración vertical</div>
            <div className="flex gap-1">
              {(["auto", 1, 2, 3, 5] as ExagMode[]).map((m) => (
                <button
                  key={String(m)}
                  onClick={() => setExagMode(m)}
                  className={`flex-1 rounded border px-1 py-1 text-[10px] ${
                    exagMode === m
                      ? "border-primary bg-primary/40"
                      : "border-white/15 bg-black/30 text-white/75"
                  }`}
                >
                  {m === "auto" ? "auto" : `×${m}`}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-2">
            <div className="mb-1 text-[10px] text-white/60">Color del fondo</div>
            <div className="flex gap-1">
              {(["profundidad", "relieve", "combinado"] as ColorMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setColorMode(m)}
                  className={`flex-1 rounded border px-1 py-1 text-[9px] capitalize ${
                    colorMode === m
                      ? "border-primary bg-primary/40"
                      : "border-white/15 bg-black/30 text-white/75"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <label className="mb-2 flex items-center gap-2 text-[10px] text-white/70">
            Luz
            <input
              type="range"
              min={0}
              max={360}
              step={5}
              value={sunAz}
              onChange={(e) => setSunAz(parseFloat(e.target.value))}
              className="flex-1 accent-primary"
            />
          </label>
          <label className="mb-2 flex items-center gap-2 text-[10px] text-white/70">
            Giro
            <input
              type="range"
              min={-180}
              max={180}
              step={0.5}
              value={yaw}
              onChange={(e) => setYaw(parseFloat(e.target.value))}
              className="flex-1 accent-primary"
            />
          </label>
          <label className="mb-2 flex items-center gap-2 text-[10px] text-white/70">
            Inclinación
            <input
              type="range"
              min={MIN_TILT}
              max={MAX_TILT}
              step={0.5}
              value={tilt}
              onChange={(e) => setTilt(clampTilt(parseFloat(e.target.value)))}
              className="flex-1 accent-primary"
            />
          </label>
          <label className="mb-2 flex items-center gap-2 text-[10px] text-white/70">
            Sensib.
            <input
              type="range"
              min={0.5}
              max={4}
              step={0.1}
              value={sensitivity}
              onChange={(e) => setSensitivity(parseFloat(e.target.value))}
              className="flex-1 accent-primary"
            />
            <span className="w-7 text-right">×{sensitivity.toFixed(1)}</span>
          </label>

          <div className="mb-2 mt-2 border-t border-white/10 pt-2">
            <div className="mb-1 flex items-center justify-between text-[10px] text-white/70">
              <span>Recorte de profundidad</span>
              <button
                onClick={() => {
                  setClipMin(null);
                  setClipMax(null);
                }}
                className="rounded border border-white/15 px-1.5 py-0.5 text-[9px] text-white/80"
              >
                Auto
              </button>
            </div>
            <div className="flex items-center gap-1 text-[10px] text-white/70">
              <label className="flex flex-1 items-center gap-1">
                Mín
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder={stats ? String(Math.round(stats.minDepth)) : "0"}
                  value={clipMin ?? ""}
                  onChange={(e) =>
                    setClipMin(
                      e.target.value === "" ? null : Math.max(0, parseFloat(e.target.value)),
                    )
                  }
                  className="w-full rounded border border-white/15 bg-black/40 px-1 py-0.5 text-[10px] text-white"
                />
              </label>
              <label className="flex flex-1 items-center gap-1">
                Máx
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder={stats ? String(Math.round(stats.maxDepth)) : "0"}
                  value={clipMax ?? ""}
                  onChange={(e) =>
                    setClipMax(
                      e.target.value === "" ? null : Math.max(1, parseFloat(e.target.value)),
                    )
                  }
                  className="w-full rounded border border-white/15 bg-black/40 px-1 py-0.5 text-[10px] text-white"
                />
              </label>
              <span className="text-white/50">m</span>
            </div>
          </div>

          {demQuality && (
            <div className="mt-2 rounded-lg border border-white/10 bg-black/30 p-2 text-[10px] leading-relaxed text-white/70">
              <div className="font-semibold" style={{ color: demQuality.color }}>
                Calidad del dato: {demQuality.label}
              </div>
              <div>{demQuality.detailNote}</div>
              <div className="mt-1 text-white/45">Fuente: {demQuality.attribution}</div>
            </div>
          )}

          <div className="mt-2 space-y-1.5 border-t border-white/10 pt-2 text-[10px] text-white/75">
            {(
              [
                ["Isóbatas", contours, setContours, true],
                ["Mapa de pendientes / veriles", slopeShade, setSlopeShade, true],
                ["Microrelieve (piedras)", microRelief, setMicroRelief, microAllowed],
                ["Puntos Top de pesca", showSpots, setShowSpots, true],
                ["Waypoints guardados", showWaypoints, setShowWaypoints, true],
                ["Recorrido del barco", showTrail, setShowTrail, true],
              ] as [string, boolean, (v: boolean) => void, boolean][]
            ).map(([label, val, set, enabled]) => (
              <label
                key={label}
                className={`flex items-center gap-2 ${enabled ? "" : "opacity-45"}`}
                title={enabled ? undefined : "No disponible: la resolución del dato no lo sostiene"}
              >
                <input
                  type="checkbox"
                  checked={val && enabled}
                  disabled={!enabled}
                  onChange={(e) => set(e.target.checked)}
                  className="accent-primary"
                />
                {label}
                {!enabled && <span className="text-white/40">· sin datos suficientes</span>}
              </label>
            ))}
          </div>

          {microRelief && microAllowed && (
            <label className="mt-2 flex items-center gap-2 text-[10px] text-white/70">
              Definición
              <input
                type="range"
                min={0.2}
                max={3}
                step={0.1}
                value={detailStrength}
                onChange={(e) => setDetailStrength(parseFloat(e.target.value))}
                className="flex-1 accent-primary"
              />
            </label>
          )}


          <button
            onClick={() => {
              trailRef.current = [];
              drawOverlay();
            }}
            className="mt-3 w-full rounded border border-white/15 py-1 text-[10px] text-white/80"
          >
            Borrar recorrido
          </button>
        </div>
      )}
    </div>
  );
}

