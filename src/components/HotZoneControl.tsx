import { useEffect, useState } from "react";
import type { SavedWaypoint } from "../hooks/use-saved-waypoints";
import {
  downloadSpotsGpx,
  toDegMinSec,
  type FishingSpot,
  type SpotsGpxExportResult,
} from "./FishingHotspots.types";

interface HotZoneControlProps {
  enabled: boolean;
  intensity: number;
  onToggle: () => void;
  onIntensityChange: (v: number) => void;
  /** Waypoints generados automáticamente al activar la zona caliente. */
  spots?: FishingSpot[];
  routes?: FishingSpot[][];
  isLoading?: boolean;
  onRecompute?: () => void;
  onClearDetected?: () => void;
  onFlyToSpot?: (s: FishingSpot) => void;
  /** Waypoints fijados por el usuario (persisten). */
  savedWaypoints?: SavedWaypoint[];
  onSaveSpot?: (s: FishingSpot) => void;
  isSpotSaved?: (s: { lat: number; lng: number }) => boolean;
  onRemoveSaved?: (id: string) => void;
  onRenameSaved?: (id: string, name: string) => void;
  onClearSaved?: () => void;
  onFlyToSaved?: (w: SavedWaypoint) => void;
}

/**
 * Panel "Zona Caliente":
 *  - Switch ON/OFF + slider de intensidad + leyenda de calor.
 *  - Lista de waypoints GPS generados automáticamente sobre frentes detectados.
 *  - Botón "📌 Fijar" para convertir cualquier punto en un waypoint GPS FIJO
 *    (lat/lng absolutos, persisten en localStorage y no cambian al mover el mapa).
 *  - Lista de waypoints fijos con renombrar, borrar y exportar GPX.
 */
export function HotZoneControl({
  enabled,
  intensity,
  onToggle,
  onIntensityChange,
  spots = [],
  routes = [],
  isLoading = false,
  onRecompute,
  onClearDetected,
  onFlyToSpot,
  savedWaypoints = [],
  onSaveSpot,
  isSpotSaved,
  onRemoveSaved,
  onRenameSaved,
  onClearSaved,
  onFlyToSaved,
}: HotZoneControlProps) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [savedOpen, setSavedOpen] = useState(true);
  const [detectedExportStatus, setDetectedExportStatus] = useState<
    SpotsGpxExportResult | "exporting" | null
  >(null);
  const [savedExportStatus, setSavedExportStatus] = useState<
    SpotsGpxExportResult | "exporting" | null
  >(null);

  useEffect(() => {
    if (!copiedAll) return;
    const t = setTimeout(() => setCopiedAll(false), 1800);
    return () => clearTimeout(t);
  }, [copiedAll]);

  useEffect(() => {
    if (!copiedId) return;
    const t = setTimeout(() => setCopiedId(null), 1500);
    return () => clearTimeout(t);
  }, [copiedId]);

  useEffect(() => {
    if (!detectedExportStatus || detectedExportStatus === "exporting") return;
    const t = setTimeout(() => setDetectedExportStatus(null), 3200);
    return () => clearTimeout(t);
  }, [detectedExportStatus]);

  useEffect(() => {
    if (!savedExportStatus || savedExportStatus === "exporting") return;
    const t = setTimeout(() => setSavedExportStatus(null), 3200);
    return () => clearTimeout(t);
  }, [savedExportStatus]);

  const sorted = spots.slice().sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, Math.max(3, Math.min(8, sorted.length)));

  const copyAll = () => {
    if (top.length === 0) return;
    const text = top
      .map(
        (s, i) =>
          `${i + 1}. ${toDegMinSec(s.lat, "lat")}  ${toDegMinSec(s.lng, "lng")}   (${Math.round(
            s.score * 100,
          )}%)`,
      )
      .join("\n");
    navigator.clipboard?.writeText(text);
    setCopiedAll(true);
  };

  const copyOne = (s: { id: string; lat: number; lng: number }) => {
    navigator.clipboard?.writeText(`${toDegMinSec(s.lat, "lat")}  ${toDegMinSec(s.lng, "lng")}`);
    setCopiedId(s.id);
  };

  const statusLabel = (status: SpotsGpxExportResult | "exporting" | null, fallback: string) => {
    if (!status) return fallback;
    return {
      exporting: "Preparando…",
      shared: "Compartido",
      downloaded: "Descargado",
      opened: "Abierto",
      copied: "Copiado",
      empty: "Sin puntos",
      cancelled: "Cancelado",
    }[status];
  };

  const exportDetectedGpx = async () => {
    setDetectedExportStatus("exporting");
    const result = await downloadSpotsGpx(spots, routes);
    setDetectedExportStatus(result);
  };

  const exportSavedGpx = async () => {
    if (savedWaypoints.length === 0) {
      setSavedExportStatus("empty");
      return;
    }
    const asSpots: FishingSpot[] = savedWaypoints.map((w) => ({
      id: w.id,
      lat: w.lat,
      lng: w.lng,
      score: w.score,
      depth: w.depth,
      reason: w.name,
    }));
    setSavedExportStatus("exporting");
    const result = await downloadSpotsGpx(asSpots, []);
    setSavedExportStatus(result);
  };

  const startRename = (w: SavedWaypoint) => {
    setEditingId(w.id);
    setEditingName(w.name);
  };
  const commitRename = () => {
    if (editingId && editingName.trim()) {
      onRenameSaved?.(editingId, editingName.trim());
    }
    setEditingId(null);
    setEditingName("");
  };

  return (
    <div
      className={`rounded-lg border p-2 transition-colors ${
        enabled ? "border-orange-400/60 bg-orange-500/10" : "border-border bg-card/40"
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm">🔥</span>
        <span className="flex-1 text-xs font-semibold text-foreground">Zona Caliente</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {enabled
            ? spots.length > 0
              ? `${spots.length} pts`
              : `${Math.round(intensity * 100)}%`
            : "OFF"}
        </span>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? "Desactivar Zona Caliente" : "Activar Zona Caliente"}
          onClick={onToggle}
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
            enabled ? "border-orange-400/70 bg-orange-500/70" : "border-border bg-secondary"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(intensity * 100)}
        disabled={!enabled}
        onChange={(e) => onIntensityChange(Number(e.target.value) / 100)}
        className="ocean-slider h-2 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
      />

      <div className="mt-2">
        <div
          className="h-2 w-full rounded-sm"
          style={{
            background:
              "linear-gradient(to right, rgba(30,90,200,0.0), rgba(30,140,220,0.6), rgba(40,200,210,0.8), rgba(250,220,60,0.9), rgba(235,40,40,1))",
          }}
        />
        <div className="mt-0.5 flex justify-between text-[9px] text-muted-foreground">
          <span>floja</span>
          <span>interesante</span>
          <span>muy buena</span>
        </div>
      </div>

      {/* Acciones de waypoints */}
      <div className="mt-2 flex items-center gap-1.5">
        <button
          onClick={onRecompute}
          disabled={!enabled || isLoading}
          className="flex-1 rounded-md border border-border bg-secondary/70 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
          title="Volver a analizar la vista actual"
        >
          {isLoading ? "Cargando…" : "🔄 Re-analizar"}
        </button>
        <button
          onClick={exportDetectedGpx}
          disabled={!enabled || detectedExportStatus === "exporting"}
          className="flex-1 rounded-md border border-border bg-secondary/70 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
          title="Exportar waypoints detectados + rutas a GPX"
        >
          {statusLabel(detectedExportStatus, "⬇ GPX detectados")}
        </button>
        <button
          onClick={onClearDetected}
          disabled={spots.length === 0}
          className="rounded-md border border-border bg-secondary/70 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
          title="Borrar los puntos detectados de zona caliente"
        >
          🗑
        </button>
      </div>

      {detectedExportStatus &&
        detectedExportStatus !== "exporting" &&
        detectedExportStatus !== "cancelled" && (
          <div className="mt-1.5 rounded-md border border-orange-400/30 bg-background/40 px-2 py-1 text-[10px] leading-tight text-muted-foreground">
            {statusLabel(detectedExportStatus, "GPX listo")}
          </div>
        )}

      <button
        onClick={copyAll}
        disabled={!enabled || top.length === 0}
        className="mt-1.5 w-full rounded-md border border-orange-400/60 bg-orange-500/20 px-2 py-1.5 text-[11px] font-semibold text-foreground hover:bg-orange-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        title="Copia los waypoints en grados, minutos y segundos al portapapeles"
      >
        {copiedAll ? "✓ Copiados" : "📋 Copiar waypoints (GG°MM'SS\")"}
      </button>

      {/* Lista de waypoints generados */}
      {enabled && top.length > 0 && (
        <div className="mt-2 max-h-44 overflow-y-auto pr-0.5">
          <div className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground">
            Detectados ({top.length}) — pulsa 📌 para fijar
          </div>
          <ul className="flex flex-col gap-1">
            {top.map((s, idx) => {
              const saved = isSpotSaved?.(s) ?? false;
              return (
                <li
                  key={s.id}
                  className="rounded-md border border-border/60 bg-background/40 p-1.5"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-flex h-5 min-w-[24px] items-center justify-center rounded-full text-[9px] font-bold text-white"
                      style={{
                        background:
                          s.score > 0.75
                            ? "linear-gradient(135deg,#ef4444,#f97316)"
                            : s.score > 0.55
                              ? "linear-gradient(135deg,#f97316,#fbbf24)"
                              : "linear-gradient(135deg,#fbbf24,#84cc16)",
                      }}
                    >
                      {idx + 1}
                    </span>
                    <button
                      onClick={() => onFlyToSpot?.(s)}
                      className="flex-1 truncate text-left font-mono text-[10px] text-foreground hover:underline"
                      title="Centrar en este waypoint"
                    >
                      {toDegMinSec(s.lat, "lat")} {toDegMinSec(s.lng, "lng")}
                    </button>
                    <button
                      onClick={() => onSaveSpot?.(s)}
                      disabled={saved}
                      className={`rounded border px-1.5 py-0.5 text-[9px] font-bold transition-colors ${
                        saved
                          ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300 cursor-default"
                          : "border-red-500/60 bg-red-500/15 text-red-200 hover:bg-red-500/30"
                      }`}
                      title={saved ? "Ya está fijado" : "Fijar como waypoint permanente"}
                    >
                      {saved ? "✓📌" : "📌"}
                    </button>
                    <button
                      onClick={() => copyOne(s)}
                      className="rounded border border-border bg-secondary/70 px-1.5 py-0.5 text-[9px] text-foreground hover:bg-secondary"
                      title="Copiar GPS"
                    >
                      {copiedId === s.id ? "✓" : "📋"}
                    </button>
                  </div>
                  <div className="mt-0.5 pl-[30px] text-[9px] leading-tight text-muted-foreground">
                    {Math.round(s.score * 100)}% · {s.reason}
                  </div>
                </li>
              );
            })}
          </ul>
          {routes.length > 0 && (
            <div className="mt-1.5 rounded-md border border-orange-400/30 bg-orange-500/10 px-2 py-1 text-[10px] leading-tight text-foreground">
              🧭 {routes.length} ruta{routes.length === 1 ? "" : "s"} de curricán siguiendo el
              frente
            </div>
          )}
        </div>
      )}

      {enabled && spots.length === 0 && (
        <div className="mt-2 rounded-md bg-background/40 px-2 py-2 text-[10px] leading-tight text-muted-foreground">
          Analizando capas… si no aparecen waypoints, mueve el mapa o activa SST/clorofila.
        </div>
      )}

      {/* ─────────── Waypoints FIJOS guardados ─────────── */}
      <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/5">
        <button
          onClick={() => setSavedOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
          title="Waypoints fijos guardados (persisten al mover el mapa)"
        >
          <span className="text-sm">📌</span>
          <span className="flex-1 text-[11px] font-semibold text-foreground">
            Mis waypoints fijos
          </span>
          <span className="rounded-full bg-red-500/30 px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-foreground">
            {savedWaypoints.length}
          </span>
          <span className="text-[10px] text-muted-foreground">{savedOpen ? "▾" : "▸"}</span>
        </button>

        {savedOpen && (
          <div className="border-t border-red-500/20 px-2 py-1.5">
            {savedWaypoints.length === 0 ? (
              <p className="py-1 text-[10px] leading-tight text-muted-foreground">
                Aún no has fijado ningún waypoint. Pulsa 📌 en cualquier punto detectado para
                guardarlo de forma permanente.
              </p>
            ) : (
              <>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <button
                    onClick={exportSavedGpx}
                    disabled={savedExportStatus === "exporting"}
                    className="flex-1 rounded-md border border-red-500/60 bg-red-500/20 px-2 py-1 text-[10px] font-semibold text-foreground hover:bg-red-500/30"
                    title="Exportar SOLO los waypoints fijos a GPX"
                  >
                    {statusLabel(savedExportStatus, "⬇ GPX fijos")}
                  </button>
                  <button
                    type="button"
                    onClick={() => onClearSaved?.()}
                    className="rounded-md border border-red-500/60 bg-red-500/20 px-2 py-1 text-[10px] font-semibold text-red-200 hover:bg-red-500/40"
                    title="Borrar TODOS los waypoints fijos"
                  >
                    🗑 Borrar todos
                  </button>
                </div>
                {savedExportStatus &&
                  savedExportStatus !== "exporting" &&
                  savedExportStatus !== "cancelled" && (
                    <div className="mb-1.5 rounded-md border border-red-500/30 bg-background/40 px-2 py-1 text-[10px] leading-tight text-muted-foreground">
                      {statusLabel(savedExportStatus, "GPX listo")}
                    </div>
                  )}
                <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto pr-0.5">
                  {savedWaypoints.map((w, idx) => (
                    <li
                      key={w.id}
                      className="rounded-md border border-red-500/30 bg-background/60 p-1.5"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-600 text-[9px] font-bold text-white">
                          {idx + 1}
                        </span>
                        {editingId === w.id ? (
                          <input
                            value={editingName}
                            autoFocus
                            onChange={(e) => setEditingName(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename();
                              if (e.key === "Escape") {
                                setEditingId(null);
                                setEditingName("");
                              }
                            }}
                            className="flex-1 rounded border border-border bg-background px-1 py-0.5 text-[10px] text-foreground"
                          />
                        ) : (
                          <button
                            onClick={() => onFlyToSaved?.(w)}
                            onDoubleClick={() => startRename(w)}
                            className="flex-1 truncate text-left text-[10px] font-semibold text-foreground hover:underline"
                            title="Click: ir al punto · Doble click: renombrar"
                          >
                            {w.name}
                          </button>
                        )}
                        <button
                          onClick={() => copyOne(w)}
                          className="rounded border border-border bg-secondary/70 px-1.5 py-0.5 text-[9px] text-foreground hover:bg-secondary"
                          title="Copiar GPS"
                        >
                          {copiedId === w.id ? "✓" : "📋"}
                        </button>
                        <button
                          onClick={() => startRename(w)}
                          className="rounded border border-border bg-secondary/70 px-1.5 py-0.5 text-[9px] text-foreground hover:bg-secondary"
                          title="Renombrar"
                        >
                          ✏
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemoveSaved?.(w.id)}
                          className="rounded border border-red-500/50 bg-red-500/20 px-1.5 py-0.5 text-[9px] text-red-200 hover:bg-red-500/40"
                          title="Eliminar waypoint"
                        >
                          🗑
                        </button>
                      </div>
                      <div className="mt-0.5 pl-[26px] font-mono text-[9px] leading-tight text-muted-foreground">
                        {toDegMinSec(w.lat, "lat")} {toDegMinSec(w.lng, "lng")}
                      </div>
                      <div className="pl-[26px] text-[9px] leading-tight text-muted-foreground">
                        {w.depth != null ? `${Math.round(w.depth)} m` : "Prof. N/D"} ·{" "}
                        {Math.round(w.score * 100)}%
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      <p className="mt-1.5 text-[9px] leading-tight text-muted-foreground">
        Detecta frentes térmicos (SST), gradientes de clorofila y cizalla de corrientes. Los
        waypoints fijos se guardan en este dispositivo y mantienen su posición GPS aunque cambies de
        capa o muevas el mapa.
      </p>
    </div>
  );
}

