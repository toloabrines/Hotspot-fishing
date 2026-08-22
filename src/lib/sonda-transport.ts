/**
 * SONDA EN DIRECTO — capa de transporte
 * =====================================
 * Objetivo: recibir datos reales y continuos (profundidad, GPS, rumbo,
 * velocidad, temperatura) desde la electrónica de a bordo.
 *
 * Realidad técnica de cada transporte:
 *
 *  - WebSocket (ws://): único socket que un navegador/PWA puede abrir.
 *    Lo hablan los servidores Signal K, NO las pasarelas NMEA clásicas.
 *    Además, desde una página servida por HTTPS el navegador bloquea ws://
 *    por contenido mixto: solo funciona en app nativa o en origen local.
 *
 *  - TCP / UDP crudos (puerto 2000, 10110, 1456...): es lo que emiten las
 *    pasarelas NMEA 2000→Wi-Fi (Yacht Devices, Actisense, Digital Yacht…).
 *    El navegador NO puede abrir estos sockets: requiere el plugin nativo
 *    de Capacitor (iOS/Android). Si no está disponible, se informa.
 */

import { registerPlugin } from "@capacitor/core";
import { parseNmeaSentence, parseSignalKDelta, type NmeaSample } from "./nmea";

export type SondaProtocol = "tcp" | "udp" | "ws";
export type SondaStatus = "idle" | "connecting" | "connected" | "error" | "closed";

export interface SondaConfig {
  protocol: SondaProtocol;
  host: string;
  port: number;
  /** Ruta para WebSocket/Signal K (p. ej. /signalk/v1/stream?subscribe=all). */
  path: string;
}

export const DEFAULT_SONDA_CONFIG: SondaConfig = {
  protocol: "tcp",
  host: "192.168.1.1",
  port: 2000,
  path: "",
};

const CFG_KEY = "hf.sonda.config.v1";

export function loadSondaConfig(): SondaConfig {
  if (typeof window === "undefined") return DEFAULT_SONDA_CONFIG;
  try {
    const raw = window.localStorage.getItem(CFG_KEY);
    return raw ? { ...DEFAULT_SONDA_CONFIG, ...(JSON.parse(raw) as SondaConfig) } : DEFAULT_SONDA_CONFIG;
  } catch {
    return DEFAULT_SONDA_CONFIG;
  }
}

export function saveSondaConfig(cfg: SondaConfig) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* noop */
  }
}

/**
 * Plugin nativo de socket (se resuelve solo dentro de la app Capacitor).
 * Implementa: connect({protocol,host,port}) y evento "data" con líneas NMEA.
 */
interface NmeaSocketPlugin {
  connect(opts: { protocol: string; host: string; port: number }): Promise<{ id: string }>;
  disconnect(): Promise<void>;
  addListener(
    event: "data",
    cb: (payload: { data: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

let nativePlugin: NmeaSocketPlugin | null = null;
function getNative(): NmeaSocketPlugin | null {
  if (nativePlugin) return nativePlugin;
  try {
    nativePlugin = registerPlugin<NmeaSocketPlugin>("NmeaSocket");
    return nativePlugin;
  } catch {
    return null;
  }
}

export function isNativeRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

/** ¿Puede este entorno abrir sockets crudos TCP/UDP? */
export function canUseRawSockets(): boolean {
  return isNativeRuntime();
}

/** ¿Está la página en HTTPS (que bloquearía ws:// por contenido mixto)? */
export function isSecureOrigin(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "https:";
}

export interface SondaTelemetry extends NmeaSample {
  /** Sentencias por segundo recibidas (media móvil). */
  hz: number;
  /** Marca de tiempo de la última lectura válida. */
  lastAt: number | null;
  /** Rumbo sobre el fondo (grados). */
  cog: number | null;
  /** Velocidad sobre el fondo (nudos). */
  sog: number | null;
}

export interface SondaEvents {
  onTelemetry: (t: SondaTelemetry) => void;
  onStatus: (status: SondaStatus, detail?: string) => void;
  onRaw?: (line: string) => void;
}

const EMPTY: SondaTelemetry = {
  depthM: null,
  offsetM: null,
  waterTempC: null,
  fix: null,
  fixQuality: null,
  satellites: null,
  hz: 0,
  lastAt: null,
  cog: null,
  sog: null,
};

export class SondaLink {
  private ws: WebSocket | null = null;
  private removeNative: (() => Promise<void>) | null = null;
  private stopped = false;
  private state: SondaTelemetry = { ...EMPTY };
  private stamps: number[] = [];
  private hzTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly cfg: SondaConfig,
    private readonly ev: SondaEvents,
  ) {}

  get snapshot(): SondaTelemetry {
    return this.state;
  }

  async connect() {
    this.stopped = false;
    this.ev.onStatus("connecting");
    this.hzTimer = setInterval(() => {
      const cut = Date.now() - 5000;
      this.stamps = this.stamps.filter((t) => t > cut);
      this.push({ hz: Math.round((this.stamps.length / 5) * 10) / 10 });
    }, 1000);

    if (this.cfg.protocol === "ws") return this.connectWs();
    return this.connectNative();
  }

  private connectWs() {
    if (typeof window === "undefined") return;
    if (isSecureOrigin() && !isNativeRuntime()) {
      this.ev.onStatus(
        "error",
        "El navegador bloquea ws:// desde una página HTTPS (contenido mixto). Usa la app nativa.",
      );
      return;
    }
    const url = `ws://${this.cfg.host}:${this.cfg.port}${this.cfg.path || ""}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.ev.onStatus("error", String((e as Error)?.message ?? e));
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.ev.onStatus("connected", url);
    ws.onerror = () => this.ev.onStatus("error", `No se ha podido conectar con ${url}`);
    ws.onclose = () => this.ev.onStatus(this.stopped ? "closed" : "error", "Conexión cerrada");
    ws.onmessage = (m) => this.ingest(String(m.data ?? ""));
  }

  private async connectNative() {
    if (!canUseRawSockets()) {
      this.ev.onStatus(
        "error",
        "TCP/UDP no está disponible en el navegador. Esta conexión requiere la app nativa (iOS/Android).",
      );
      return;
    }
    const plugin = getNative();
    if (!plugin) {
      this.ev.onStatus("error", "Plugin de socket nativo no encontrado en esta build.");
      return;
    }
    try {
      const handle = await plugin.addListener("data", (p) => this.ingest(p?.data ?? ""));
      this.removeNative = () => handle.remove();
      await plugin.connect({
        protocol: this.cfg.protocol,
        host: this.cfg.host,
        port: this.cfg.port,
      });
      this.ev.onStatus("connected", `${this.cfg.protocol.toUpperCase()} ${this.cfg.host}:${this.cfg.port}`);
    } catch (e) {
      this.ev.onStatus("error", String((e as Error)?.message ?? e));
    }
  }

  /** Procesa datos crudos (NMEA 0183 en texto o delta JSON de Signal K). */
  ingest(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let patches: Partial<NmeaSample>[] = [];
    if (trimmed.startsWith("{")) {
      this.ev.onRaw?.(trimmed.slice(0, 200));
      try {
        const p = parseSignalKDelta(JSON.parse(trimmed));
        if (p) patches = [p];
      } catch {
        /* ignora */
      }
    } else {
      const lines = trimmed.split(/[\r\n]+/).filter(Boolean);
      lines.forEach((l) => this.ev.onRaw?.(l));
      patches = lines
        .map((l) => parseNmeaSentence(l))
        .filter((p): p is Partial<NmeaSample> => !!p);
    }
    if (!patches.length) return;

    const now = Date.now();
    this.stamps.push(now);
    const next: Partial<SondaTelemetry> = { lastAt: now };
    for (const p of patches) {
      if (p.fix && Number.isFinite(p.fix.lat) && Number.isFinite(p.fix.lng)) next.fix = p.fix;
      if (p.fix?.cog != null) next.cog = p.fix.cog;
      if (p.fix?.sog != null) next.sog = p.fix.sog;
      if (p.depthM != null) next.depthM = p.depthM;
      if (p.offsetM != null) next.offsetM = p.offsetM;
      if (p.waterTempC != null) next.waterTempC = p.waterTempC;
      if (p.fixQuality != null) next.fixQuality = p.fixQuality;
      if (p.satellites != null) next.satellites = p.satellites;
    }
    this.push(next);
  }

  private push(patch: Partial<SondaTelemetry>) {
    this.state = { ...this.state, ...patch };
    this.ev.onTelemetry(this.state);
  }

  async close() {
    this.stopped = true;
    if (this.hzTimer) clearInterval(this.hzTimer);
    this.hzTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
    if (this.removeNative) {
      try {
        await this.removeNative();
        await getNative()?.disconnect();
      } catch {
        /* noop */
      }
      this.removeNative = null;
    }
    this.ev.onStatus("closed");
  }
}

/** Presets de conexión habituales para pasarelas compatibles con Lowrance. */
export const GATEWAY_PRESETS: {
  id: string;
  name: string;
  note: string;
  cfg: SondaConfig;
}[] = [
  {
    id: "ydwg",
    name: "Yacht Devices YDWG-02 / YDEN-02",
    note: "Pasarela NMEA 2000 → Wi-Fi. Servidor en modo NMEA 0183, UDP recomendado.",
    cfg: { protocol: "udp", host: "0.0.0.0", port: 2000, path: "" },
  },
  {
    id: "navlink2",
    name: "Digital Yacht NavLink2",
    note: "TCP 192.168.1.1:2000 en modo punto de acceso; UDP 0.0.0.0:2000 en red del barco.",
    cfg: { protocol: "tcp", host: "192.168.1.1", port: 2000, path: "" },
  },
  {
    id: "w2k2",
    name: "Actisense W2K-2",
    note: "Convierte NMEA 2000 a NMEA 0183 y lo sirve por TCP/UDP.",
    cfg: { protocol: "tcp", host: "192.168.4.1", port: 2000, path: "" },
  },
  {
    id: "signalk",
    name: "Servidor Signal K (Raspberry / OpenPlotter)",
    note: "Único transporte que funciona también en la web (WebSocket).",
    cfg: { protocol: "ws", host: "192.168.1.50", port: 3000, path: "/signalk/v1/stream?subscribe=all" },
  },
  {
    id: "generic0183",
    name: "Pasarela NMEA 0183 genérica",
    note: "Puerto TCP clásico 10110.",
    cfg: { protocol: "tcp", host: "192.168.0.1", port: 10110, path: "" },
  },
];

/** Sentencias de ejemplo para validar el parser sin hardware. */
export const DEMO_SENTENCES = [
  "$SDDPT,23.4,0.5,*44",
  "$GPRMC,101530.00,A,3934.1234,N,00251.4321,E,5.2,142.7,060826,,,A*6A",
  "$SDMTW,21.3,C*07",
  "$GPGGA,101530.00,3934.1234,N,00251.4321,E,1,09,0.9,0.0,M,48.0,M,,*5B",
];

