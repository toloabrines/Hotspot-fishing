/**
 * AUTOBATIMETRÍA
 * ==============
 * Crea tu propio mapa batimétrico mientras navegas: registra profundidad de la
 * sonda + posición GPS, y esos datos sustituyen a la batimetría pública
 * (EMODnet / GEBCO) allí donde existan.
 *
 * - Fuente de datos: pasarela Wi-Fi NMEA 0183/2000 o Signal K (src/lib/nmea.ts).
 *   Alternativamente, GPS del móvil + profundidad de la sonda por NMEA.
 * - Registro: un punto cada N segundos o cada N metros recorridos.
 * - Almacenamiento local: se guarda como dataset propio (src/lib/sonar-data.ts),
 *   con lo que la fusión con el DEM, las curvas de nivel, la detección de
 *   estructuras y la vista 3D funcionan automáticamente.
 * - Nube: sincronización opcional por usuario (tabla sounding_sessions), con
 *   marca "compartida" preparada para una batimetría colaborativa futura.
 */

import {
  getSonarDatasets,
  makeDataset,
  setSonarDatasets,
  type SonarDataset,
  type Sounding,
} from "./sonar-data";
import { NmeaClient, type NmeaSample, type NmeaStatus } from "./nmea";

export interface AutoBathyConfig {
  /** URL WebSocket de la pasarela (ws://ip:puerto). */
  url: string;
  /** Distancia del transductor a la superficie (m), se suma a la lectura. */
  transducerOffsetM: number;
  /** Corrección de marea (m); positivo = restar altura de marea. */
  tideOffsetM: number;
  /** Intervalo mínimo entre puntos (ms). */
  minIntervalMs: number;
  /** Distancia mínima entre puntos (m). */
  minDistanceM: number;
  /** Usar el GPS del dispositivo en vez del GPS de la pasarela. */
  useDeviceGps: boolean;
  /** Sincronizar automáticamente con la nube al detener la grabación. */
  autoCloudSync: boolean;
}

export const DEFAULT_AUTOBATHY: AutoBathyConfig = {
  url: "ws://192.168.0.1:10110",
  transducerOffsetM: 0,
  tideOffsetM: 0,
  minIntervalMs: 1000,
  minDistanceM: 3,
  useDeviceGps: false,
  autoCloudSync: true,
};

const CONFIG_KEY = "hf.autobathy.config.v1";

export function loadAutoBathyConfig(): AutoBathyConfig {
  if (typeof window === "undefined") return DEFAULT_AUTOBATHY;
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY);
    return raw ? { ...DEFAULT_AUTOBATHY, ...(JSON.parse(raw) as AutoBathyConfig) } : DEFAULT_AUTOBATHY;
  } catch {
    return DEFAULT_AUTOBATHY;
  }
}

export function saveAutoBathyConfig(cfg: AutoBathyConfig) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    /* cuota llena: se mantiene en memoria */
  }
}

export interface AutoBathyState {
  recording: boolean;
  status: NmeaStatus;
  detail: string | null;
  /** Última lectura recibida. */
  depthM: number | null;
  waterTempC: number | null;
  lat: number | null;
  lng: number | null;
  sog: number | null;
  fixQuality: number | null;
  /** Puntos registrados en la sesión actual. */
  points: number;
  minDepthM: number | null;
  maxDepthM: number | null;
  distanceM: number;
  startedAt: number | null;
  /** Id del dataset local de la sesión en curso. */
  datasetId: string | null;
  lastPointAt: number | null;
}

const INITIAL: AutoBathyState = {
  recording: false,
  status: "idle",
  detail: null,
  depthM: null,
  waterTempC: null,
  lat: null,
  lng: null,
  sog: null,
  fixQuality: null,
  points: 0,
  minDepthM: null,
  maxDepthM: null,
  distanceM: 0,
  startedAt: null,
  datasetId: null,
  lastPointAt: null,
};

const LAT_M = 110540;
const LNG_M = 111320;

function distM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lng - a.lng) * LNG_M * Math.cos(midLat);
  const dy = (b.lat - a.lat) * LAT_M;
  return Math.hypot(dx, dy);
}

// ───────────────────────── Motor (singleton) ─────────────────────────

let state: AutoBathyState = { ...INITIAL };
const listeners = new Set<() => void>();
let client: NmeaClient | null = null;
let geoWatch: number | null = null;
let devicePos: { lat: number; lng: number; acc: number } | null = null;
let buffer: Sounding[] = [];
let pending: Sounding[] = [];
let lastPoint: Sounding | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let config: AutoBathyConfig = DEFAULT_AUTOBATHY;

function emit(patch: Partial<AutoBathyState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

export function subscribeAutoBathy(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAutoBathyState(): AutoBathyState {
  return state;
}

export function getAutoBathyServerState(): AutoBathyState {
  return INITIAL;
}

/** Vuelca los puntos pendientes al almacén local (dispara el redibujado del DEM). */
function flush() {
  if (!pending.length || !state.datasetId) return;
  const all = getSonarDatasets();
  const idx = all.findIndex((d) => d.id === state.datasetId);
  pending = [];
  const points = buffer.slice();
  const base = makeDataset(sessionName(), points);
  if (!base) return;
  const next: SonarDataset = {
    ...base,
    id: state.datasetId,
    kind: "auto",
    recording: state.recording,
    startedAt: state.startedAt ?? base.createdAt,
    endedAt: state.recording ? undefined : Date.now(),
    cloudId: idx >= 0 ? (all[idx]?.cloudId ?? null) : null,
  };
  const list = idx >= 0 ? all.map((d, i) => (i === idx ? next : d)) : [...all, next];
  setSonarDatasets(list);
}

function sessionName(): string {
  const d = new Date(state.startedAt ?? Date.now());
  return `AutoBatimetría ${d.toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
  })} ${d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`;
}

function onSample(sample: NmeaSample) {
  const fixFromGateway = sample.fix && Number.isFinite(sample.fix.lat) ? sample.fix : null;
  const pos = config.useDeviceGps && devicePos ? devicePos : fixFromGateway;
  const rawDepth = sample.depthM;
  const depth =
    rawDepth == null ? null : rawDepth + (config.transducerOffsetM || 0) - (config.tideOffsetM || 0);

  emit({
    depthM: depth,
    waterTempC: sample.waterTempC,
    lat: pos ? pos.lat : state.lat,
    lng: pos ? pos.lng : state.lng,
    sog: fixFromGateway?.sog ?? state.sog,
    fixQuality: sample.fixQuality ?? state.fixQuality,
  });

  if (!state.recording || !pos || depth == null || !(depth > 0.2) || depth > 6000) return;

  const now = Date.now();
  if (state.lastPointAt && now - state.lastPointAt < config.minIntervalMs) return;
  const step = lastPoint ? distM(lastPoint, pos) : Infinity;
  if (lastPoint && step < config.minDistanceM) return;

  const point: Sounding = {
    lat: pos.lat,
    lng: pos.lng,
    depthM: Math.round(depth * 100) / 100,
    t: now,
    q: sample.fixQuality ?? undefined,
  };
  buffer.push(point);
  pending.push(point);
  const prev = lastPoint;
  lastPoint = point;

  emit({
    points: buffer.length,
    lastPointAt: now,
    minDepthM: state.minDepthM == null ? point.depthM : Math.min(state.minDepthM, point.depthM),
    maxDepthM: state.maxDepthM == null ? point.depthM : Math.max(state.maxDepthM, point.depthM),
    distanceM: prev ? state.distanceM + Math.min(step, 500) : state.distanceM,
  });

  if (pending.length >= 20) flush();
}

/** Conecta con la pasarela sin empezar a grabar (prueba de conexión). */
export function connectAutoBathy(cfg: AutoBathyConfig) {
  config = cfg;
  saveAutoBathyConfig(cfg);
  disconnectAutoBathy(true);
  client = new NmeaClient({
    url: cfg.url,
    onSample,
    onStatus: (status, detail) => emit({ status, detail: detail ?? null }),
  });
  client.connect();
  if (cfg.useDeviceGps && typeof navigator !== "undefined" && navigator.geolocation) {
    geoWatch = navigator.geolocation.watchPosition(
      (p) => {
        devicePos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
        emit({ lat: devicePos.lat, lng: devicePos.lng });
      },
      () => emit({ detail: "GPS del dispositivo no disponible" }),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
  }
}

export function disconnectAutoBathy(keepRecording = false) {
  client?.close();
  client = null;
  if (geoWatch != null && typeof navigator !== "undefined") {
    navigator.geolocation.clearWatch(geoWatch);
    geoWatch = null;
  }
  if (!keepRecording) emit({ status: "idle", detail: null });
}

export function startAutoBathyRecording(cfg: AutoBathyConfig) {
  buffer = [];
  pending = [];
  lastPoint = null;
  const startedAt = Date.now();
  emit({
    ...INITIAL,
    recording: true,
    startedAt,
    datasetId: `auto-${startedAt.toString(36)}`,
    status: state.status,
  });
  if (!client) connectAutoBathy(cfg);
  else config = cfg;
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(flush, 10000);
}

export function stopAutoBathyRecording(): SonarDataset | null {
  emit({ recording: false });
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  pending = buffer.slice();
  flush();
  const id = state.datasetId;
  return getSonarDatasets().find((d) => d.id === id) ?? null;
}

/** Inyecta una lectura manual (pruebas o sondas sin Wi-Fi). */
export function pushManualSample(sample: Partial<NmeaSample>) {
  onSample({
    depthM: null,
    offsetM: null,
    waterTempC: null,
    fix: null,
    fixQuality: null,
    satellites: null,
    ...sample,
  });
}

/** Alimenta el motor con una línea NMEA cruda (útil para pruebas). */
export function ingestNmeaLine(line: string) {
  client?.ingest(line);
}

// ───────────────────────── Exportación ─────────────────────────

export function soundingsToCsv(ds: SonarDataset): string {
  const rows = ["lat,lon,depth_m,timestamp,quality"];
  for (const p of ds.points) {
    rows.push(
      [
        p.lat.toFixed(6),
        p.lng.toFixed(6),
        p.depthM.toFixed(2),
        p.t ? new Date(p.t).toISOString() : "",
        p.q ?? "",
      ].join(","),
    );
  }
  return rows.join("\n");
}

export function soundingsToGeoJson(ds: SonarDataset): string {
  return JSON.stringify({
    type: "FeatureCollection",
    properties: { name: ds.name, spacingM: ds.spacingM, source: "Hotspot Fishing AutoBatimetría" },
    features: ds.points.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: {
        depth_m: p.depthM,
        time: p.t ? new Date(p.t).toISOString() : null,
        quality: p.q ?? null,
      },
    })),
  });
}

export function soundingsToGpx(ds: SonarDataset): string {
  const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
  const pts = ds.points
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"><ele>${(-p.depthM).toFixed(
          2,
        )}</ele>${p.t ? `<time>${new Date(p.t).toISOString()}</time>` : ""}<desc>${p.depthM.toFixed(
          1,
        )} m</desc></trkpt>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Hotspot Fishing" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${esc(ds.name)}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>`;
}

