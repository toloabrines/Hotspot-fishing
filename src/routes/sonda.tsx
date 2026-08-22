import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEMO_SENTENCES,
  DEFAULT_SONDA_CONFIG,
  GATEWAY_PRESETS,
  SondaLink,
  canUseRawSockets,
  isNativeRuntime,
  isSecureOrigin,
  loadSondaConfig,
  saveSondaConfig,
  type SondaConfig,
  type SondaStatus,
  type SondaTelemetry,
} from "@/lib/sonda-transport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/sonda")({
  component: SondaEnDirecto,
  head: () => ({
    meta: [
      { title: "Sonda en directo | Hotspot Fishing" },
      {
        name: "description",
        content:
          "Prueba técnica de conexión con la sonda: profundidad, GPS, rumbo, velocidad y temperatura en tiempo real desde tu electrónica de a bordo.",
      },
      { property: "og:title", content: "Sonda en directo | Hotspot Fishing" },
      {
        property: "og:description",
        content: "Comprueba qué datos reales recibe Hotspot Fishing desde tu Lowrance u otra pasarela NMEA.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const STATUS_LABEL: Record<SondaStatus, string> = {
  idle: "En espera",
  connecting: "Conectando…",
  connected: "Conectada",
  error: "Error",
  closed: "Desconectada",
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

function SondaEnDirecto() {
  const [cfg, setCfg] = useState<SondaConfig>(DEFAULT_SONDA_CONFIG);
  const [status, setStatus] = useState<SondaStatus>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [tel, setTel] = useState<SondaTelemetry | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const linkRef = useRef<SondaLink | null>(null);
  const [env, setEnv] = useState({ native: false, raw: false, https: false });

  useEffect(() => {
    setCfg(loadSondaConfig());
    setEnv({ native: isNativeRuntime(), raw: canUseRawSockets(), https: isSecureOrigin() });
    return () => {
      void linkRef.current?.close();
    };
  }, []);

  const connect = useCallback(() => {
    void linkRef.current?.close();
    saveSondaConfig(cfg);
    setLog([]);
    const link = new SondaLink(cfg, {
      onTelemetry: (t) => setTel({ ...t }),
      onStatus: (s, d) => {
        setStatus(s);
        setDetail(d ?? null);
      },
      onRaw: (line) => setLog((prev) => [line, ...prev].slice(0, 40)),
    });
    linkRef.current = link;
    void link.connect();
  }, [cfg]);

  const disconnect = useCallback(() => {
    void linkRef.current?.close();
  }, []);

  const demo = useCallback(() => {
    if (!linkRef.current) {
      const link = new SondaLink(cfg, {
        onTelemetry: (t) => setTel({ ...t }),
        onStatus: (s, d) => {
          setStatus(s);
          setDetail(d ?? null);
        },
        onRaw: (line) => setLog((prev) => [line, ...prev].slice(0, 40)),
      });
      linkRef.current = link;
    }
    DEMO_SENTENCES.forEach((s) => linkRef.current?.ingest(s));
    setDetail("Sentencias de prueba inyectadas (no es hardware real)");
  }, [cfg]);

  const fix = tel?.fix ?? null;
  const stale = tel?.lastAt ? Date.now() - tel.lastAt > 5000 : true;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Sonda en directo</h1>
        <Link to="/" className="text-sm text-primary underline">
          Volver al mapa
        </Link>
      </div>

      <section className="mb-6 rounded-lg border border-border bg-card p-4">
        <h2 className="mb-2 text-base font-medium">Qué se puede leer de una Lowrance Elite FS 9</h2>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">Wi-Fi interno de la Lowrance: no sirve.</strong> En la serie
            Elite FS el Wi-Fi es para actualizaciones, cartografía C-MAP/Genesis y la app Lowrance (control
            remoto de pantalla). No publica NMEA para apps de terceros.
          </li>
          <li>
            <strong className="text-foreground">Ethernet: tampoco.</strong> El puerto Ethernet usa el protocolo
            propietario de red Navico entre plotters/módulos, no un flujo NMEA abierto.
          </li>
          <li>
            <strong className="text-foreground">NMEA 2000 + pasarela Wi-Fi: sí, es la vía válida.</strong> La
            Elite FS publica en el bus N2K la profundidad (PGN 128267), posición (129029/129025), rumbo y
            velocidad sobre el fondo (129026) y temperatura del agua (130316/130310). Una pasarela
            NMEA 2000→Wi-Fi convierte esos PGN a NMEA 0183 (DPT/DBT, GGA, RMC, VTG, MTW) y los sirve por
            TCP/UDP en la red local del barco, sin internet.
          </li>
          <li>
            <strong className="text-foreground">Qué comprar:</strong> Yacht Devices YDWG-02 (o YDEN-02 si
            prefieres Ethernet+Wi-Fi), Digital Yacht NavLink2 o Actisense W2K-2, más un latiguillo drop N2K y
            una T. Cualquiera de las tres vale; se configuran desde el navegador.
          </li>
          <li>
            <strong className="text-foreground">Frecuencia real:</strong> profundidad ~1–2 Hz, posición y
            velocidad 1–10 Hz, temperatura ~0,5–1 Hz. Suficiente para batimetría continua.
          </li>
          <li>
            <strong className="text-foreground">Limitación del navegador:</strong> una PWA no puede abrir
            sockets TCP/UDP y, sirviéndose por HTTPS, tampoco puede abrir ws:// hacia la pasarela. Por eso la
            lectura TCP/UDP se hace en la app nativa de Capacitor (iOS/Android). En web solo funciona un
            servidor Signal K por WebSocket.
          </li>
        </ul>
        <div className="mt-3 rounded-md bg-muted p-3 text-xs">
          Este dispositivo: {env.native ? "app nativa" : "navegador / PWA"} · sockets TCP-UDP{" "}
          {env.raw ? "disponibles" : "no disponibles"} · origen {env.https ? "HTTPS" : "HTTP"}
        </div>
      </section>

      <section className="mb-6 rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-base font-medium">Conexión</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          {GATEWAY_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setCfg(p.cfg)}
              title={p.note}
              className="rounded-full border border-border px-3 py-1 text-xs hover:bg-accent"
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="text-xs text-muted-foreground">
            Protocolo
            <select
              value={cfg.protocol}
              onChange={(e) => setCfg({ ...cfg, protocol: e.target.value as SondaConfig["protocol"] })}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
            >
              <option value="tcp">TCP (nativo)</option>
              <option value="udp">UDP (nativo)</option>
              <option value="ws">WebSocket / Signal K</option>
            </select>
          </label>
          <label className="text-xs text-muted-foreground">
            IP
            <Input
              className="mt-1"
              value={cfg.host}
              onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Puerto
            <Input
              className="mt-1"
              inputMode="numeric"
              value={String(cfg.port)}
              onChange={(e) => setCfg({ ...cfg, port: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Ruta (Signal K)
            <Input
              className="mt-1"
              value={cfg.path}
              onChange={(e) => setCfg({ ...cfg, path: e.target.value })}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={connect}>Conectar</Button>
          <Button variant="secondary" onClick={disconnect}>
            Desconectar
          </Button>
          <Button variant="outline" onClick={demo}>
            Probar parser con datos de ejemplo
          </Button>
        </div>
      </section>

      <section className="mb-6 rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-base font-medium">Datos recibidos</h2>
        <Row label="Estado" value={STATUS_LABEL[status]} />
        <Row
          label="Conexión"
          value={`${cfg.protocol.toUpperCase()} ${cfg.host}:${cfg.port}${cfg.path || ""}`}
        />
        <Row label="Protocolo de datos" value={cfg.protocol === "ws" ? "Signal K / NMEA 0183" : "NMEA 0183"} />
        <Row
          label="Profundidad"
          value={tel?.depthM != null && !stale ? `${tel.depthM.toFixed(1)} m` : "Sin datos de profundidad"}
        />
        <Row
          label="Posición GPS"
          value={fix ? `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}` : "—"}
        />
        <Row label="Rumbo (COG)" value={tel?.cog != null ? `${tel.cog.toFixed(0)}°` : "—"} />
        <Row label="Velocidad (SOG)" value={tel?.sog != null ? `${tel.sog.toFixed(1)} kn` : "—"} />
        <Row
          label="Temperatura agua"
          value={tel?.waterTempC != null ? `${tel.waterTempC.toFixed(1)} °C` : "—"}
        />
        <Row
          label="Calidad del fix"
          value={tel?.fixQuality != null ? `${tel.fixQuality} · ${tel.satellites ?? "?"} sat.` : "—"}
        />
        <Row label="Frecuencia" value={tel?.hz ? `${tel.hz} sentencias/s` : "—"} />
        <Row
          label="Última lectura"
          value={tel?.lastAt ? new Date(tel.lastAt).toLocaleTimeString("es-ES") : "—"}
        />
        {detail && <p className="mt-3 text-xs text-muted-foreground">{detail}</p>}
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-2 text-base font-medium">Tráfico crudo</h2>
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed">
          {log.length ? log.join("\n") : "Sin tráfico todavía."}
        </pre>
      </section>
    </main>
  );
}

