import { useEffect, useState } from "react";
import {
  downloadSpotsGpx,
  toDegMinSec,
  type FishingSpot,
  type SpotsGpxExportResult,
} from "./FishingHotspots.types";

interface FishingHotspotsControlProps {
  enabled: boolean;
  spots: FishingSpot[];
  routes: FishingSpot[][];
  minDepth: number;
  maxDepth: number;
  onToggle: () => void;
  onDepthRangeChange: (min: number, max: number) => void;
  onRecompute: () => void;
  onFlyToSpot: (spot: FishingSpot) => void;
  isLoading?: boolean;
  /** Si hay un área manual activa, el mensaje vacío cambia. */
  hasSearchArea?: boolean;
}

/**
 * Panel del detector de spots GPS pescables.
 * Compacto, encaja en la sidebar de capas o como bloque flotante.
 */
export function FishingHotspotsControl({
  enabled,
  spots,
  routes,
  minDepth,
  maxDepth,
  onToggle,
  onDepthRangeChange,
  onRecompute,
  onFlyToSpot,
  isLoading = false,
  hasSearchArea = false,
}: FishingHotspotsControlProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedTop, setCopiedTop] = useState(false);
  const [exportStatus, setExportStatus] = useState<SpotsGpxExportResult | "exporting" | null>(null);

  useEffect(() => {
    if (!copiedId) return;
    const id = setTimeout(() => setCopiedId(null), 1500);
    return () => clearTimeout(id);
  }, [copiedId]);

  useEffect(() => {
    if (!copiedTop) return;
    const id = setTimeout(() => setCopiedTop(false), 1800);
    return () => clearTimeout(id);
  }, [copiedTop]);

  useEffect(() => {
    if (!exportStatus || exportStatus === "exporting") return;
    const id = setTimeout(() => setExportStatus(null), 3200);
    return () => clearTimeout(id);
  }, [exportStatus]);

  const exportLabel = {
    exporting: "Preparando GPX…",
    shared: "Compartido",
    downloaded: "Descargado",
    opened: "Abierto para guardar",
    copied: "GPX copiado",
    empty: "Sin spots",
    cancelled: "Cancelado",
  }[exportStatus ?? "downloaded"];

  const handleExportGpx = async () => {
    setExportStatus("exporting");
    const result = await downloadSpotsGpx(spots, routes);
    setExportStatus(result);
  };

  const copy = (s: FishingSpot) => {
    navigator.clipboard?.writeText(`${toDegMinSec(s.lat, "lat")}  ${toDegMinSec(s.lng, "lng")}`);
    setCopiedId(s.id);
  };

  const copyTop5 = () => {
    const top = spots
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (top.length === 0) return;
    const text = top
      .map(
        (s, i) =>
          `${i + 1}. ${toDegMinSec(s.lat, "lat")}  ${toDegMinSec(s.lng, "lng")}   (${Math.round(s.score * 100)}%)`,
      )
      .join("\n");
    navigator.clipboard?.writeText(text);
    setCopiedTop(true);
  };

  return (
    <div
      className={`rounded-lg border p-2 transition-colors ${
        enabled ? "border-orange-400/60 bg-orange-500/10" : "border-border bg-card/40"
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm">🎣</span>
        <span className="flex-1 text-xs font-semibold text-foreground">Spots pescables</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {enabled ? `${spots.length} pts` : "OFF"}
        </span>
        <button
          role="switch"
          aria-checked={enabled}
          onClick={onToggle}
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
            enabled ? "border-orange-400/70 bg-orange-500/70" : "border-border bg-secondary"
          }`}
          aria-label={enabled ? "Desactivar spots" : "Activar spots"}
        >
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Prof. mín
          </span>
          <input
            type="number"
            min={0}
            max={5000}
            step={50}
            value={minDepth}
            disabled={!enabled}
            onChange={(e) => onDepthRangeChange(Number(e.target.value), maxDepth)}
            className="rounded border border-border bg-background/60 px-1.5 py-1 font-mono text-[11px] text-foreground disabled:opacity-40"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Prof. máx
          </span>
          <input
            type="number"
            min={0}
            max={6000}
            step={50}
            value={maxDepth}
            disabled={!enabled}
            onChange={(e) => onDepthRangeChange(minDepth, Number(e.target.value))}
            className="rounded border border-border bg-background/60 px-1.5 py-1 font-mono text-[11px] text-foreground disabled:opacity-40"
          />
        </label>
      </div>

      <div className="mb-2 flex items-center gap-1.5">
        <button
          onClick={onRecompute}
          disabled={!enabled || isLoading}
          className="flex-1 rounded-md border border-border bg-secondary/70 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isLoading ? "Cargando…" : "🔄 Re-analizar"}
        </button>
        <button
          onClick={handleExportGpx}
          disabled={!enabled || exportStatus === "exporting"}
          className="flex-1 rounded-md border border-border bg-secondary/70 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
          title="Exportar waypoints + rutas en GPX"
        >
          {exportStatus ? exportLabel : "⬇ GPX"}
        </button>
      </div>

      {exportStatus && exportStatus !== "exporting" && exportStatus !== "cancelled" && (
        <div className="mb-2 rounded-md border border-orange-400/30 bg-background/40 px-2 py-1 text-[10px] leading-tight text-muted-foreground">
          {exportLabel}
        </div>
      )}

      <button
        onClick={copyTop5}
        disabled={!enabled || spots.length === 0}
        className="mb-2 w-full rounded-md border border-orange-400/60 bg-orange-500/20 px-2 py-1.5 text-[11px] font-semibold text-foreground hover:bg-orange-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        title="Copia los 5 mejores spots en grados, minutos y segundos al portapapeles"
      >
        {copiedTop ? "✓ 5 mejores copiados" : "📋 Copiar 5 mejores (GG°MM'SS\")"}
      </button>

      {enabled && spots.length === 0 && (
        <div className="rounded-md border border-orange-400/30 bg-background/40 px-2 py-2 text-[10px] leading-tight text-muted-foreground">
          {hasSearchArea
            ? "No hay zonas destacadas dentro del área seleccionada. Amplía la zona o cambia las capas SST/clorofila — no se busca fuera del área."
            : "Sin spots en la vista actual. Mueve el mapa o activa SST/clorofila."}
        </div>
      )}

      {enabled && spots.length > 0 && (
        <div className="max-h-44 overflow-y-auto pr-0.5">
          <ul className="flex flex-col gap-1">
            {spots
              .slice()
              .sort((a, b) => b.score - a.score)
              .map((s, idx) => {
                // Top 1/2/3 explícito basado en el orden cruzando todas las capas
                const rank = s.rank ?? idx + 1;
                const isTop = rank <= 3;
                const topColors = [
                  { bg: "linear-gradient(135deg,#fbbf24,#f59e0b)", label: "TOP 1" },
                  { bg: "linear-gradient(135deg,#cbd5e1,#94a3b8)", label: "TOP 2" },
                  { bg: "linear-gradient(135deg,#fb923c,#c2410c)", label: "TOP 3" },
                ];
                return (
                  <li
                    key={s.id}
                    className={`rounded-md border p-1.5 ${
                      rank === 1
                        ? "border-amber-400/70 bg-amber-500/10"
                        : isTop
                          ? "border-orange-400/40 bg-orange-500/5"
                          : "border-border/60 bg-background/40"
                    }`}
                  >
                    {isTop && (
                      <div
                        className="mb-1 inline-block rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-white"
                        style={{ background: topColors[rank - 1].bg }}
                      >
                        🏆 {topColors[rank - 1].label}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5">
                      <span
                        className="inline-flex h-5 min-w-[34px] items-center justify-center rounded-full text-[10px] font-bold text-white"
                        style={{
                          background:
                            s.score > 0.75
                              ? "linear-gradient(135deg,#ef4444,#f97316)"
                              : s.score > 0.55
                                ? "linear-gradient(135deg,#f97316,#fbbf24)"
                                : "linear-gradient(135deg,#fbbf24,#84cc16)",
                        }}
                      >
                        {Math.round(s.score * 100)}
                      </span>
                      <button
                        onClick={() => onFlyToSpot(s)}
                        className="flex-1 truncate text-left font-mono text-[9px] leading-tight text-foreground hover:underline"
                        title="Centrar en este spot"
                      >
                        <div>{toDegMinSec(s.lat, "lat")}</div>
                        <div>{toDegMinSec(s.lng, "lng")}</div>
                      </button>
                      <button
                        onClick={() => copy(s)}
                        className="rounded border border-border bg-secondary/70 px-1.5 py-0.5 text-[9px] text-foreground hover:bg-secondary"
                        title="Copiar GPS"
                      >
                        {copiedId === s.id ? "✓" : "📋"}
                      </button>
                    </div>
                    <div className="mt-0.5 pl-[42px] text-[9px] leading-tight text-muted-foreground">
                      {s.reason}
                    </div>
                  </li>
                );
              })}
          </ul>
          {routes.length > 0 && (
            <div className="mt-2 rounded-md border border-orange-400/30 bg-orange-500/10 px-2 py-1 text-[10px] leading-tight text-foreground">
              <span className="font-semibold">
                🧭 {routes.length} ruta{routes.length === 1 ? "" : "s"} de curricán
              </span>{" "}
              <span className="text-muted-foreground">trazadas siguiendo el frente</span>
            </div>
          )}
        </div>
      )}

      <p className="mt-1.5 text-[9px] leading-tight text-muted-foreground">
        Ranking cruzado de las 4 capas: SST · clorofila · altimetría · batimetría. Cada Top combina
        frentes, bordes, corrientes y relieve de fondo.
      </p>
    </div>
  );
}

