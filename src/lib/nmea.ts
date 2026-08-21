/**
 * Lectura de sonda + GPS en tiempo real desde electrónica náutica.
 *
 * Compatibilidad: cualquier equipo capaz de servir datos por Wi-Fi.
 *  - NMEA 0183 sobre TCP/UDP → pasarela Wi-Fi (Yacht Devices, Actisense,
 *    Digital Yacht, Vesper, Quark-elec…). Se conecta por WebSocket.
 *  - NMEA 2000 → cualquier gateway N2K→0183/Wi-Fi (Lowrance/Simrad GoFree,
 *    Garmin, Raymarine, B&G, Airmar WSB-100 / DST810).
 *  - Signal K (JSON delta): servidores Signal K a bordo (Raymarine, OpenPlotter).
 *
 * El navegador no puede abrir sockets TCP crudos: se usa WebSocket (ws://),
 * que es lo que exponen las pasarelas modernas y los servidores Signal K.
 */

export interface NmeaFix {
  lat: number;
  lng: number;
  /** Rumbo sobre el fondo (grados) si está disponible. */
  cog: number | null;
  /** Velocidad sobre el fondo (nudos). */
  sog: number | null;
  timestamp: number;
}

export interface NmeaSample {
  /** Profundidad bajo la superficie en metros (ya con offset aplicado). */
  depthM: number | null;
  /** Offset del transductor comunicado por el equipo (m). */
  offsetM: number | null;
  /** Temperatura del agua (°C) si la sonda la envía. */
  waterTempC: number | null;
  fix: NmeaFix | null;
  /** Calidad del fix: 0 = sin fix, 1 = GPS, 2 = DGPS/RTK. */
  fixQuality: number | null;
  /** Nº de satélites si se recibe. */
  satellites: number | null;
}

const EMPTY: NmeaSample = {
  depthM: null,
  offsetM: null,
  waterTempC: null,
  fix: null,
  fixQuality: null,
  satellites: null,
};

function num(v: string | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** ddmm.mmmm + hemisferio → grados decimales. */
function coord(value: string | undefined, hemi: string | undefined): number | null {
  const raw = num(value);
  if (raw == null || !hemi) return null;
  const deg = Math.floor(Math.abs(raw) / 100);
  const min = Math.abs(raw) - deg * 100;
  const dec = deg + min / 60;
  return hemi === "S" || hemi === "W" ? -dec : dec;
}

/**
 * Parsea una sentencia NMEA 0183 y devuelve los campos reconocidos.
 * Sentencias soportadas: DPT, DBT, DBS, DBK, GGA, RMC, GLL, VTG, MTW.
 */
export function parseNmeaSentence(line: string): Partial<NmeaSample> | null {
  const clean = line.trim().replace(/^[^$!]*/, "");
  if (!clean.startsWith("$") && !clean.startsWith("!")) return null;
  const body = clean.slice(1).split("*")[0] ?? "";
  const f = body.split(",");
  const type = (f[0] ?? "").slice(-3).toUpperCase();

  switch (type) {
    case "DPT": {
      // $--DPT,<profundidad bajo transductor>,<offset>,<rango máx>
      const d = num(f[1]);
      const off = num(f[2]);
      if (d == null) return null;
      return { depthM: d + (off ?? 0), offsetM: off };
    }
    case "DBT": {
      // metros en el campo 3
      const m = num(f[3]);
      const ft = num(f[1]);
      const d = m ?? (ft != null ? ft * 0.3048 : null);
      return d == null ? null : { depthM: d };
    }
    case "DBS":
    case "DBK": {
      const m = num(f[3]);
      return m == null ? null : { depthM: m };
    }
    case "MTW": {
      const t = num(f[1]);
      return t == null ? null : { waterTempC: t };
    }
    case "GGA": {
      const lat = coord(f[2], f[3]);
      const lng = coord(f[4], f[5]);
      if (lat == null || lng == null) return null;
      return {
        fix: { lat, lng, cog: null, sog: null, timestamp: Date.now() },
        fixQuality: num(f[6]),
        satellites: num(f[7]),
      };
    }
    case "RMC": {
      if ((f[2] ?? "").toUpperCase() === "V") return null;
      const lat = coord(f[3], f[4]);
      const lng = coord(f[5], f[6]);
      if (lat == null || lng == null) return null;
      return {
        fix: { lat, lng, sog: num(f[7]), cog: num(f[8]), timestamp: Date.now() },
      };
    }
    case "GLL": {
      const lat = coord(f[1], f[2]);
      const lng = coord(f[3], f[4]);
      if (lat == null || lng == null) return null;
      return { fix: { lat, lng, cog: null, sog: null, timestamp: Date.now() } };
    }
    case "VTG": {
      const cog = num(f[1]);
      const sog = num(f[5]);
      if (cog == null && sog == null) return null;
      return { fix: { lat: NaN, lng: NaN, cog, sog, timestamp: Date.now() } };
    }
    default:
      return null;
  }
}

/** Delta JSON de Signal K → campos reconocidos. */
export function parseSignalKDelta(payload: unknown): Partial<NmeaSample> | null {
  const root = payload as { updates?: { values?: { path?: string; value?: unknown }[] }[] };
  if (!Array.isArray(root?.updates)) return null;
  const out: Partial<NmeaSample> = {};
  for (const upd of root.updates) {
    for (const v of upd?.values ?? []) {
      const path = v?.path ?? "";
      const value = v?.value;
      if (path === "environment.depth.belowSurface" && typeof value === "number") {
        out.depthM = value;
      } else if (path === "environment.depth.belowTransducer" && typeof value === "number") {
        out.depthM = out.depthM ?? value;
      } else if (path === "environment.depth.surfaceToTransducer" && typeof value === "number") {
        out.offsetM = value;
      } else if (path === "environment.water.temperature" && typeof value === "number") {
        out.waterTempC = value > 150 ? value - 273.15 : value;
      } else if (path === "navigation.position" && value && typeof value === "object") {
        const p = value as { latitude?: number; longitude?: number };
        if (typeof p.latitude === "number" && typeof p.longitude === "number") {
          out.fix = {
            lat: p.latitude,
            lng: p.longitude,
            cog: null,
            sog: null,
            timestamp: Date.now(),
          };
        }
      }
    }
  }
  return Object.keys(out).length ? out : null;
}

export type NmeaStatus = "idle" | "connecting" | "connected" | "error" | "closed";

interface NmeaClientOptions {
  url: string;
  onSample: (sample: NmeaSample) => void;
  onStatus?: (status: NmeaStatus, detail?: string) => void;
  /** Reconexión automática (por defecto sí). */
  autoReconnect?: boolean;
}

/**
 * Cliente WebSocket que mantiene el último estado conocido de sonda y GPS.
 * Acepta tanto texto NMEA 0183 (una o varias sentencias por mensaje) como
 * deltas JSON de Signal K.
 */
export class NmeaClient {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private state: NmeaSample = { ...EMPTY };
  private readonly opts: NmeaClientOptions;

  constructor(opts: NmeaClientOptions) {
    this.opts = opts;
  }

  get snapshot(): NmeaSample {
    return this.state;
  }

  connect() {
    if (typeof window === "undefined") return;
    this.stopped = false;
    this.opts.onStatus?.("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.opts.onStatus?.("error", String((e as Error)?.message ?? e));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.opts.onStatus?.("connected");
    ws.onerror = () => this.opts.onStatus?.("error", "No se ha podido conectar con la pasarela");
    ws.onclose = () => {
      this.opts.onStatus?.(this.stopped ? "closed" : "error", "Conexión cerrada");
      this.scheduleReconnect();
    };
    ws.onmessage = (ev) => this.ingest(String(ev.data ?? ""));
  }

  /** Procesa un mensaje crudo (texto NMEA o JSON Signal K). */
  ingest(raw: string) {
    let patches: Partial<NmeaSample>[] = [];
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        const p = parseSignalKDelta(JSON.parse(trimmed));
        if (p) patches = [p];
      } catch {
        /* ignora JSON inválido */
      }
    } else {
      patches = trimmed
        .split(/[\r\n]+/)
        .map((l) => parseNmeaSentence(l))
        .filter((p): p is Partial<NmeaSample> => !!p);
    }
    if (!patches.length) return;

    let next = { ...this.state };
    for (const p of patches) {
      if (p.fix && Number.isFinite(p.fix.lat) && Number.isFinite(p.fix.lng)) {
        next.fix = { ...p.fix, cog: p.fix.cog ?? next.fix?.cog ?? null, sog: p.fix.sog ?? next.fix?.sog ?? null };
      } else if (p.fix && next.fix) {
        next.fix = { ...next.fix, cog: p.fix.cog ?? next.fix.cog, sog: p.fix.sog ?? next.fix.sog };
      }
      if (p.depthM != null) next.depthM = p.depthM;
      if (p.offsetM != null) next.offsetM = p.offsetM;
      if (p.waterTempC != null) next.waterTempC = p.waterTempC;
      if (p.fixQuality != null) next.fixQuality = p.fixQuality;
      if (p.satellites != null) next.satellites = p.satellites;
    }
    this.state = next;
    this.opts.onSample(next);
  }

  private scheduleReconnect() {
    if (this.stopped || this.opts.autoReconnect === false) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), 4000);
  }

  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
    this.opts.onStatus?.("closed");
  }
}

/** Ajustes típicos por marca, para ayudar al usuario a conectar. */
export const BRAND_HINTS: { brand: string; hint: string; example: string }[] = [
  {
    brand: "Lowrance / Simrad / B&G",
    hint: "Activa GoFree Wi-Fi y la salida NMEA 0183 TCP en el plotter.",
    example: "ws://192.168.0.1:10110",
  },
  {
    brand: "Garmin",
    hint: "Wi-Fi del plotter + pasarela NMEA 0183/2000 con salida TCP.",
    example: "ws://192.168.1.1:10110",
  },
  {
    brand: "Raymarine",
    hint: "Servidor Signal K a bordo (Axiom/OpenPlotter) o pasarela Wi-Fi.",
    example: "ws://192.168.1.50:3000/signalk/v1/stream?subscribe=all",
  },
  {
    brand: "Airmar (WSB-100, DST810)",
    hint: "Punto de acceso Wi-Fi propio con NMEA 0183 sobre TCP.",
    example: "ws://192.168.100.1:2000",
  },
  {
    brand: "Yacht Devices / Actisense / Digital Yacht",
    hint: "Pasarela NMEA 2000 → Wi-Fi en modo servidor TCP.",
    example: "ws://192.168.4.1:1456",
  },
];

