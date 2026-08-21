import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_AUTOBATHY,
  connectAutoBathy,
  disconnectAutoBathy,
  getAutoBathyServerState,
  getAutoBathyState,
  loadAutoBathyConfig,
  saveAutoBathyConfig,
  soundingsToCsv,
  soundingsToGeoJson,
  soundingsToGpx,
  startAutoBathyRecording,
  stopAutoBathyRecording,
  subscribeAutoBathy,
  type AutoBathyConfig,
} from "../lib/autobathy";
import { BRAND_HINTS } from "../lib/nmea";
import {
  getSonarDatasets,
  setSonarDatasets,
  subscribeSonarDatasets,
  type SonarDataset,
} from "../lib/sonar-data";
import { saveGeneratedFileToDevice } from "../lib/file-export";
import { saveSoundingSession, setSoundingSessionShared } from "../lib/autobathy.functions";

const STATUS_LABEL: Record<string, string> = {
  idle: "Sin conectar",
  connecting: "Conectando…",
  connected: "Conectado",
  error: "Error de conexión",
  closed: "Desconectado",
};

/**
 * AutoBatimetría: graba profundidad + GPS mientras navegas y construye tu
 * propia carta batimétrica, con prioridad sobre EMODnet/GEBCO.
 */
export function AutoBathyPanel() {
  const state = useSyncExternalStore(subscribeAutoBathy, getAutoBathyState, getAutoBathyServerState);
  const datasets = useSyncExternalStore(
    subscribeSonarDatasets,
    getSonarDatasets,
    () => [] as SonarDataset[],
  );
  const [cfg, setCfg] = useState<AutoBathyConfig>(DEFAULT_AUTOBATHY);
  const [open, setOpen] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setCfg(loadAutoBathyConfig()), []);

  const sessions = useMemo(() => datasets.filter((d) => d.kind === "auto"), [datasets]);
  const update = (patch: Partial<AutoBathyConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    saveAutoBathyConfig(next);
  };

  const exportSession = async (ds: SonarDataset, fmt: "csv" | "gpx" | "geojson") => {
    const content =
      fmt === "csv" ? soundingsToCsv(ds) : fmt === "gpx" ? soundingsToGpx(ds) : soundingsToGeoJson(ds);
    const mime =
      fmt === "csv" ? "text/csv" : fmt === "gpx" ? "application/gpx+xml" : "application/geo+json";
    await saveGeneratedFileToDevice({
      filename: `${ds.name.replace(/\s+/g, "_")}.${fmt === "geojson" ? "geojson" : fmt}`,
      mime,
      content,
      shareTitle: ds.name,
    });
  };

  const syncSession = async (ds: SonarDataset, shared?: boolean) => {
    setBusy(true);
    setMsg("Sincronizando…");
    try {
      const res = await saveSoundingSession({
        data: {
          cloudId: ds.cloudId ?? null,
          name: ds.name,
          startedAt: ds.startedAt ?? ds.createdAt,
          endedAt: ds.endedAt ?? Date.now(),
          spacingM: ds.spacingM,
          source: "nmea",
          isShared: shared === true,
          points: ds.points,
        },
      });
      setSonarDatasets(
        getSonarDatasets().map((d) => (d.id === ds.id ? { ...d, cloudId: res.id } : d)),
      );
      if (shared !== undefined && res.id) {
        await setSoundingSessionShared({ data: { id: res.id, shared } });
      }
      setMsg(`Guardado en la nube · ${res.points.toLocaleString("es-ES")} sondas`);
    } catch (e) {
      setMsg(
        String((e as Error)?.message ?? e).includes("Unauthorized")
          ? "Inicia sesión para sincronizar en la nube."
          : "No se ha podido sincronizar.",
      );
    } finally {
      setBusy(false);
    }
  };

  const removeSession = (ds: SonarDataset) => {
    setSonarDatasets(getSonarDatasets().filter((d) => d.id !== ds.id));
  };

  const connected = state.status === "connected";

  return (
    <div className="rounded-lg border border-border bg-card/60 p-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-[11px] font-semibold text-foreground"
      >
        <span>🛰️ AutoBatimetría {state.recording ? "· GRABANDO" : ""}</span>
        <span className="text-muted-foreground">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[10px] leading-snug text-muted-foreground">
            Crea tu propia carta mientras navegas con la profundidad de la sonda y el GPS. Tus datos
            sustituyen a EMODnet/GEBCO donde existan y el relieve mejora en cada pasada.
          </p>

          {/* Estado en vivo */}
          <div className="grid grid-cols-3 gap-1 text-center">
            <Live label="Sonda" value={state.depthM != null ? `${state.depthM.toFixed(1)} m` : "—"} />
            <Live
              label="Posición"
              value={state.lat != null ? `${state.lat.toFixed(4)}, ${state.lng?.toFixed(4)}` : "—"}
            />
            <Live label="Puntos" value={state.points.toLocaleString("es-ES")} />
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span
              className={
                connected ? "text-emerald-400" : state.status === "error" ? "text-red-400" : "text-muted-foreground"
              }
            >
              ● {STATUS_LABEL[state.status] ?? state.status}
              {state.detail ? ` · ${state.detail}` : ""}
            </span>
            {state.recording && (
              <span className="text-muted-foreground">
                {(state.distanceM / 1000).toFixed(2)} km ·{" "}
                {state.minDepthM != null ? `${state.minDepthM.toFixed(0)}–${state.maxDepthM?.toFixed(0)} m` : "—"}
              </span>
            )}
          </div>

          {/* Conexión */}
          <div className="flex gap-1">
            <input
              value={cfg.url}
              onChange={(e) => update({ url: e.target.value })}
              placeholder="ws://192.168.0.1:10110"
              className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-[10px]"
            />
            <button
              onClick={() => (connected ? disconnectAutoBathy() : connectAutoBathy(cfg))}
              className="rounded-md border border-border px-2 py-1 text-[10px] text-foreground"
            >
              {connected ? "Cortar" : "Conectar"}
            </button>
          </div>

          <div className="flex gap-1">
            <button
              onClick={() => (state.recording ? stopAutoBathyRecording() : startAutoBathyRecording(cfg))}
              className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold ${
                state.recording
                  ? "bg-red-500/20 text-red-300 border border-red-500/50"
                  : "bg-primary/20 text-foreground border border-primary/50"
              }`}
            >
              {state.recording ? "■ Detener grabación" : "● Grabar batimetría"}
            </button>
            <button
              onClick={() => setShowSetup((v) => !v)}
              className="rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground"
            >
              ⚙︎
            </button>
          </div>

          {showSetup && (
            <div className="space-y-2 rounded-md border border-border/70 bg-background/50 p-2">
              <Num
                label="Offset transductor (m)"
                value={cfg.transducerOffsetM}
                step={0.1}
                onChange={(v) => update({ transducerOffsetM: v })}
              />
              <Num
                label="Corrección marea (m)"
                value={cfg.tideOffsetM}
                step={0.1}
                onChange={(v) => update({ tideOffsetM: v })}
              />
              <Num
                label="Intervalo mínimo (s)"
                value={cfg.minIntervalMs / 1000}
                step={0.5}
                onChange={(v) => update({ minIntervalMs: Math.max(200, v * 1000) })}
              />
              <Num
                label="Distancia mínima (m)"
                value={cfg.minDistanceM}
                step={1}
                onChange={(v) => update({ minDistanceM: Math.max(0, v) })}
              />
              <label className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Usar GPS del móvil</span>
                <input
                  type="checkbox"
                  checked={cfg.useDeviceGps}
                  onChange={(e) => update({ useDeviceGps: e.target.checked })}
                />
              </label>
              <div className="space-y-1 border-t border-border/60 pt-1">
                <p className="text-[10px] font-semibold text-foreground">Equipos compatibles</p>
                {BRAND_HINTS.map((b) => (
                  <button
                    key={b.brand}
                    onClick={() => update({ url: b.example })}
                    className="block w-full rounded border border-border/60 px-1.5 py-1 text-left text-[9px] text-muted-foreground hover:border-primary/50"
                  >
                    <strong className="text-foreground">{b.brand}</strong> · {b.hint}
                    <br />
                    <code>{b.example}</code>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Sesiones */}
          {sessions.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-foreground">Mis batimetrías</p>
              {sessions.map((ds) => (
                <div key={ds.id} className="rounded-md border border-border/70 p-1.5">
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-[10px] text-foreground">{ds.name}</span>
                    <span className="shrink-0 text-[9px] text-muted-foreground">
                      {ds.points.length.toLocaleString("es-ES")} · ~{ds.spacingM} m
                      {ds.cloudId ? " · ☁︎" : ""}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(["csv", "gpx", "geojson"] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => exportSession(ds, f)}
                        className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground"
                      >
                        {f.toUpperCase()}
                      </button>
                    ))}
                    <button
                      disabled={busy}
                      onClick={() => syncSession(ds)}
                      className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground"
                    >
                      Nube
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => syncSession(ds, true)}
                      className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground"
                    >
                      Compartir
                    </button>
                    <button
                      onClick={() => removeSession(ds)}
                      className="ml-auto rounded border border-border px-1.5 py-0.5 text-[9px] text-red-300"
                    >
                      Borrar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {msg && <p className="text-[10px] text-muted-foreground">{msg}</p>}
        </div>
      )}
    </div>
  );
}

function Live({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-background/50 px-1 py-1">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-[11px] font-semibold text-foreground">{value}</div>
    </div>
  );
}

function Num({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="w-20 rounded border border-border bg-background px-1 py-0.5 text-right text-[10px] text-foreground"
      />
    </label>
  );
}

