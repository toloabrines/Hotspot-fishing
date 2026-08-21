/**
 * Panel UI "Frentes Productivos" — listado de zonas detectadas con
 * métricas (área km², longitud mn), botones de exportación (GPX/KML)
 * y activación del corredor de pesca zig-zag.
 */

import { useEffect, useMemo, useState } from "react";
import type { GradientZone } from "../lib/gradient-zones.types";
import type { LatLng } from "../lib/geo-area";
import type { SavedZoneSet } from "../hooks/use-saved-zones";
import { downloadAllGpxAndKml, downloadAllKml, downloadZoneKml } from "../lib/zone-export";
import { ZoneForecastBadges } from "./ZoneForecastBadges";

export interface GradientZonesControlProps {
  enabled: boolean;
  onToggle: () => void;
  zones: GradientZone[];
  corridors: Record<string, LatLng[] | undefined>;
  /** Puntos calientes marcados por zona. */
  hotPoints?: Record<string, LatLng | undefined>;
  loading: boolean;
  progress: number;
  error: string | null;
  onRecompute: () => void;
  onToggleCorridor: (zone: GradientZone) => void;
  onFocusZone: (zone: GradientZone) => void;
  /** Marca o desmarca el punto caliente exacto de una zona. */
  onToggleHotPoint?: (zone: GradientZone) => void;
  /** Fuerza un corredor detallado para una zona. */
  onToggleDetailedCorridor?: (zone: GradientZone) => void;
  /** Corredores calculados en modo detallado. */
  detailedCorridors?: Record<string, LatLng[] | undefined>;
  focusedId?: string | null;
  /** Snapshots persistidos en local. */
  savedSets: SavedZoneSet[];
  /** Guardar el análisis actual. */
  onSaveCurrent: () => void;
  onLoadSaved: (set: SavedZoneSet) => void;
  onDeleteSaved: (id: string) => void;
  onRenameSaved: (id: string, name: string) => void;
  /** Id del snapshot que se está visualizando (no es el análisis vivo). */
  viewingSavedId: string | null;
  /** Salir del modo "ver guardado" y volver al análisis en vivo. */
  onExitSavedView: () => void;
  /** Borrar zonas y corredores actuales del mapa. */
  onClear?: () => void;
}

function varLabel(v: string) {
  return v === "sst" ? "🌡 SST" : v === "chl" ? "🌿 CHL" : v === "alt" ? "🌊 ALT" : v;
}

export function GradientZonesControl({
  enabled,
  onToggle,
  zones,
  corridors,
  hotPoints,
  loading,
  progress,
  error,
  onRecompute,
  onToggleCorridor,
  onFocusZone,
  onToggleHotPoint,
  onToggleDetailedCorridor,
  detailedCorridors,
  focusedId,
  savedSets,
  onSaveCurrent,
  onLoadSaved,
  onDeleteSaved,
  onRenameSaved,
  viewingSavedId,
  onExitSavedView,
  onClear,
}: GradientZonesControlProps) {
  const totalArea = useMemo(() => zones.reduce((s, z) => s + z.areaKm2, 0), [zones]);
  const totalLen = useMemo(() => zones.reduce((s, z) => s + z.lengthNm, 0), [zones]);

  const allCorridors = useMemo(
    () =>
      Object.entries(corridors)
        .filter(([, r]) => r && r.length >= 2)
        .map(([zoneId, r]) => ({ zoneId, route: r as LatLng[] })),
    [corridors],
  );
  const [exporting, setExporting] = useState<"earth" | "all" | null>(null);

  const handleDownloadEarth = async () => {
    if (zones.length === 0) {
      window.alert("No hay frentes productivos para exportar.");
      return;
    }
    setExporting("earth");
    await downloadAllKml(zones, allCorridors);
    setExporting(null);
  };

  const handleDownloadAll = async () => {
    if (zones.length === 0) {
      window.alert("No hay frentes productivos para exportar.");
      return;
    }
    setExporting("all");
    await downloadAllGpxAndKml(zones, allCorridors);
    setExporting(null);
  };

  return (
    <div
      className={`rounded-lg border p-2 transition-colors ${
        enabled ? "border-fuchsia-400/60 bg-fuchsia-500/10" : "border-border bg-card/40"
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm">🎣</span>
        <span className="flex-1 text-xs font-semibold text-foreground">Frentes Productivos</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {enabled ? (loading ? `${Math.round(progress * 100)}%` : `${zones.length} frentes`) : "OFF"}
        </span>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? "Desactivar" : "Activar"}
          onClick={onToggle}
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
            enabled ? "border-fuchsia-400/70 bg-fuchsia-500/70" : "border-border bg-secondary"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {enabled && (
        <>
          {/* Resumen */}
          <div className="mb-2 grid grid-cols-2 gap-1 text-[10px]">
            <div className="rounded bg-background/40 px-1.5 py-1">
              <div className="text-muted-foreground">Superficie</div>
              <div className="font-mono font-semibold tabular-nums text-foreground">
                {totalArea.toFixed(1)} km²
              </div>
            </div>
            <div className="rounded bg-background/40 px-1.5 py-1">
              <div className="text-muted-foreground">Línea frontal</div>
              <div className="font-mono font-semibold tabular-nums text-foreground">
                {totalLen.toFixed(1)} mn
              </div>
            </div>
          </div>

          {/* Leyenda visual para que no haya confusión entre punto y línea. */}
          <div className="mb-2 rounded border border-amber-400/30 bg-amber-400/10 p-2 text-[9px] leading-snug text-amber-100">
            <div className="mb-1.5 font-semibold text-amber-50">Leyenda en el mapa</div>
            <div className="flex items-center gap-2">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-slate-950 bg-orange-500 text-[8px] font-extrabold text-slate-950">
                1
              </div>
              <span className="flex-1">
                <strong>Inicio del frente</strong> — punto de referencia, no el objetivo.
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="flex h-1.5 w-8 shrink-0 rounded-full bg-orange-500" />
              <span className="flex-1">
                <strong>Línea naranja</strong> — aquí es donde pescar a la deriva.
              </span>
            </div>
            <div className="mt-1.5 rounded border border-amber-300/20 bg-amber-400/10 px-1.5 py-0.5 text-[8px] text-amber-100/90">
              💡 Regla: navega hasta el círculo y pesca la línea naranja, no el punto.
            </div>
          </div>

          <div className="mb-2 flex items-center gap-1.5">
            <button
              onClick={onRecompute}
              disabled={loading}
              className="flex-1 rounded-md border border-border bg-secondary/70 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? `🛰 Analizando… ${Math.round(progress * 100)}%` : "🔄 Reanalizar vista"}
            </button>
            <button
              onClick={onSaveCurrent}
              disabled={zones.length === 0 || !!viewingSavedId}
              className="rounded-md border border-fuchsia-400/60 bg-fuchsia-500/20 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-fuchsia-500/30 disabled:cursor-not-allowed disabled:opacity-40"
              title="Guardar este análisis (fecha + coordenadas) para verlo otro día"
            >
              💾 Guardar
            </button>
            {onClear && (
              <button
                onClick={onClear}
                disabled={zones.length === 0 && Object.keys(corridors).length === 0}
                className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                title="Borrar frentes y corredores del mapa"
              >
                🗑️ Limpiar
              </button>
            )}
            <button
              onClick={handleDownloadEarth}
              disabled={!!exporting || zones.length === 0}
              className="rounded-md border border-emerald-400/60 bg-emerald-500/20 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40"
              title="Compartir el KML para abrirlo directamente con Google Earth"
            >
              {exporting === "earth" ? "Abriendo…" : "🌍 Google Earth"}
            </button>
            <button
              onClick={handleDownloadAll}
              disabled={!!exporting || zones.length === 0}
              className="rounded-md border border-sky-400/60 bg-sky-500/20 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-40"
              title="Descargar GPX (plotter/GPS) y KML"
            >
              {exporting === "all" ? "Descargando…" : "📥 GPX + KML"}
            </button>
          </div>

          {viewingSavedId && (
            <div className="mb-1.5 flex items-center gap-1.5 rounded border border-yellow-400/60 bg-yellow-400/10 px-2 py-1 text-[10px] text-yellow-100">
              <span className="flex-1">📂 Viendo análisis guardado</span>
              <button
                onClick={onExitSavedView}
                className="rounded border border-yellow-400/50 px-1.5 py-0.5 text-[9px] hover:bg-yellow-400/20"
              >
                Volver al actual
              </button>
            </div>
          )}

          {error && (
            <div className="mb-1.5 rounded border border-red-500/50 bg-red-500/10 p-1.5 text-[10px] text-red-200">
              {error}
            </div>
          )}

          {loading && zones.length === 0 && (
            <p className="rounded bg-background/40 px-2 py-2 text-[10px] leading-tight text-muted-foreground">
              Analizando toda la vista visible. Las zonas y el botón Corredor aparecerán al
              terminar.
            </p>
          )}

          {/* Lista de zonas */}
          {zones.length === 0 && !loading && !error && (
            <p className="rounded bg-background/40 px-2 py-2 text-[10px] leading-tight text-muted-foreground">
              No se detectaron frentes significativos en la vista actual. Prueba a mover/zoomar el
              mapa o pulsa Reanalizar.
            </p>
          )}

          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto pr-0.5">
            {zones.map((z, idx) => {
              const hasCorridor = !!corridors[z.id];
              const focused = focusedId === z.id;
              return (
                <li
                  key={z.id}
                  className={`rounded-md border p-1.5 transition-colors ${
                    focused
                      ? "border-fuchsia-400/70 bg-fuchsia-500/15"
                      : "border-border/60 bg-background/40"
                  }`}
                >
                  <button
                    onClick={() => onFocusZone(z)}
                    className="flex w-full items-center gap-1.5 text-left"
                  >
                    <span className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-full bg-fuchsia-600 text-[9px] font-bold text-white">
                      {idx + 1}
                    </span>
                    <span className="flex-1 truncate text-[10px] font-semibold text-foreground">
                      Frente {idx + 1}
                    </span>
                    <span
                      className={`rounded px-1 text-[9px] font-bold tabular-nums ${
                        z.confidence >= 70
                          ? "bg-emerald-500/30 text-emerald-100"
                          : z.confidence >= 45
                            ? "bg-yellow-500/25 text-yellow-100"
                            : "bg-muted/40 text-muted-foreground"
                      }`}
                      title="Confianza 0-100 (calidad oceanográfica)"
                    >
                      {Math.round(z.confidence)}
                    </span>
                  </button>
                  <p className="mt-1 pl-[26px] text-[9px] leading-tight text-muted-foreground">
                    {z.reason}
                  </p>
                  <div className="mt-1 grid grid-cols-3 gap-1 pl-[26px] font-mono text-[9px] text-muted-foreground">
                    <span title="Gradiente SST">
                      SST {Math.round((z.gradMeans.sst ?? 0) * 100)}
                    </span>
                    <span title="Gradiente clorofila">
                      CHL {Math.round((z.gradMeans.chl ?? 0) * 100)}
                    </span>
                    <span title="Gradiente altimetría">
                      ALT {Math.round((z.gradMeans.alt ?? 0) * 100)}
                    </span>
                  </div>
                  <div className="mt-0.5 grid grid-cols-3 gap-1 pl-[26px] font-mono text-[9px] text-muted-foreground">
                    <span>{z.areaKm2.toFixed(1)} km²</span>
                    <span>{z.lengthNm.toFixed(1)} mn</span>
                    <span title="Pendiente batimétrica / distancia al veril">
                      {z.depthSlope != null ? `${Math.round(z.depthSlope)} m/km` : "— talud"}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1 pl-[26px]">
                    {z.vars.map((v) => (
                      <span
                        key={v}
                        className="rounded bg-secondary/60 px-1 text-[8px] text-foreground"
                      >
                        {varLabel(v)}
                      </span>
                    ))}
                    {z.nearestVerilKm != null && (
                      <span className="rounded bg-cyan-500/20 px-1 text-[8px] text-cyan-100">
                        Veril ≈ {z.nearestVerilKm.toFixed(1)} km
                      </span>
                    )}
                  </div>
                  <ZoneForecastBadges zone={z} />

                  <div className="mt-1 flex flex-wrap gap-1 pl-[26px]">
                    <button
                      onClick={() => onToggleCorridor(z)}
                      className={`flex-1 rounded border px-1.5 py-0.5 text-[9px] font-semibold transition-colors ${
                        hasCorridor
                          ? "border-orange-400/80 bg-orange-500/25 text-orange-100"
                          : "border-border bg-secondary/60 text-foreground hover:bg-secondary"
                      }`}
                      title="Mostrar u ocultar la línea del frente en el mapa"
                    >
                      🎣 Línea del frente {hasCorridor ? "ON" : ""}
                    </button>
                    {onToggleHotPoint && (
                      <button
                        onClick={() => onToggleHotPoint(z)}
                        className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold transition-colors ${
                          hotPoints?.[z.id]
                            ? "border-rose-400/70 bg-rose-500/20 text-rose-100"
                            : "border-border bg-secondary/60 text-foreground hover:bg-secondary"
                        }`}
                        title="Marcar el punto exacto más productivo del frente"
                      >
                        📍 Punto exacto {hotPoints?.[z.id] ? "ON" : ""}
                      </button>
                    )}
                    {onToggleDetailedCorridor && (
                      <button
                        onClick={() => onToggleDetailedCorridor(z)}
                        className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold transition-colors ${
                          detailedCorridors?.[z.id]
                            ? "border-sky-400/70 bg-sky-500/20 text-sky-100"
                            : "border-border bg-secondary/60 text-foreground hover:bg-secondary"
                        }`}
                        title="Corredor con menos suavizado, más fiel a la cresta"
                      >
                        🔍 Más detalle {detailedCorridors?.[z.id] ? "ON" : ""}
                      </button>
                    )}
                    <button
                      onClick={() => downloadZoneKml(z, idx, corridors[z.id])}
                      className="rounded border border-emerald-400/60 bg-emerald-500/20 px-1.5 py-0.5 text-[9px] text-foreground hover:bg-emerald-500/30"
                      title="Abrir este KML con Google Earth"
                    >
                      🌍 Earth
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {savedSets.length > 0 && (
            <div className="mt-2 border-t border-border/60 pt-1.5">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="text-[10px] font-semibold text-foreground">
                  📂 Guardados ({savedSets.length})
                </span>
              </div>
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto pr-0.5">
                {savedSets.map((s) => {
                  const active = viewingSavedId === s.id;
                  return (
                    <li
                      key={s.id}
                      className={`rounded-md border p-1.5 ${
                        active
                          ? "border-yellow-400/70 bg-yellow-400/10"
                          : "border-border/60 bg-background/40"
                      }`}
                    >
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onLoadSaved(s)}
                          className="flex-1 truncate text-left text-[10px] font-semibold text-foreground hover:underline"
                          title="Cargar este análisis"
                        >
                          {s.name}
                        </button>
                        <button
                          onClick={() => {
                            const n = window.prompt("Nuevo nombre:", s.name);
                            if (n && n.trim()) onRenameSaved(s.id, n.trim());
                          }}
                          className="rounded border border-border bg-secondary/60 px-1 text-[9px] text-foreground hover:bg-secondary"
                          title="Renombrar"
                        >
                          ✏️
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`¿Borrar "${s.name}"?`)) onDeleteSaved(s.id);
                          }}
                          className="rounded border border-red-500/40 bg-red-500/10 px-1 text-[9px] text-red-200 hover:bg-red-500/20"
                          title="Borrar"
                        >
                          🗑
                        </button>
                      </div>
                      <div className="mt-0.5 font-mono text-[9px] text-muted-foreground">
                        {s.zones.length} zonas · {new Date(s.savedAt).toLocaleDateString()}
                        {s.dataDate ? ` · datos ${s.dataDate.slice(0, 10)}` : ""}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <p className="mt-1.5 text-[9px] leading-tight text-muted-foreground">
            Detecta franjas con gradiente fuerte en al menos 2 variables (SST + CHL + ALT). Los
            colores indican qué combinación de variables genera cada frente.
          </p>
        </>
      )}
    </div>
  );
}

