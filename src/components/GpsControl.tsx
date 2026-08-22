import { useEffect, useState } from "react";
import type { GeolocationError } from "../hooks/use-geolocation";
import type { GpsPosition } from "./GpsTracker";
import { toDegMinSec } from "./FishingHotspots.types";

interface GpsControlProps {
  active: boolean;
  follow: boolean;
  position: GpsPosition | null;
  trackLength: number;
  error: GeolocationError | null;
  onToggleGps: () => void;
  onToggleFollow: () => void;
  onRecenter: () => void;
  onExportGpx: () => void;
  onClearTrack: () => void;
  onSaveTrack?: () => void;
  savedTracksCount?: number;
  onOpenSavedTracks?: () => void;
}

const ERROR_MESSAGES: Record<GeolocationError, string> = {
  permission_denied: "Permiso de ubicación denegado",
  position_unavailable: "GPS no disponible",
  timeout: "Tiempo de espera agotado",
  unsupported: "Geolocalización no soportada",
  insecure_context: "Requiere HTTPS",
  unknown: "Error de ubicación",
};

/**
 * Devuelve `true` SOLO tras hidratación + medición real del viewport como móvil.
 * Durante SSR y el primer render del cliente devuelve `false`, garantizando que
 * el HTML pintado coincide con el del servidor (sin mismatch de hidratación).
 */
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth < 640);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return isMobile;
}

export function GpsControl({
  active,
  follow,
  position,
  trackLength,
  error,
  onToggleGps,
  onToggleFollow,
  onRecenter,
  onExportGpx,
  onClearTrack,
  onSaveTrack,
  savedTracksCount,
  onOpenSavedTracks,
}: GpsControlProps) {
  // Hidratación segura: en el primer render (SSR + primer paint cliente) NO
  // sabemos si es móvil → siempre renderizamos el panel expandido. Tras montar,
  // si el viewport es móvil, colapsamos.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (hydrated && isMobile) setExpanded(false);
  }, [hydrated, isMobile]);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  const copyDms = () => {
    if (!position) return;
    const text = `${toDegMinSec(position.lat, "lat")}  ${toDegMinSec(position.lng, "lng")}`;
    navigator.clipboard?.writeText(text);
    setCopied(true);
  };

  // Compact mode: solo botón redondo (móvil colapsado y ya hidratado).
  if (hydrated && isMobile && !expanded) {
    return (
      <div className="pointer-events-auto flex flex-col items-end gap-1.5">
        <button
          onClick={() => setExpanded(true)}
          className={`flex h-10 w-10 items-center justify-center rounded-full border shadow-lg transition-all ${
            active
              ? "border-emerald-400/60 bg-emerald-500/30 text-foreground"
              : "border-border bg-panel/95 text-foreground"
          }`}
          title="Abrir panel GPS"
          aria-label="Abrir panel GPS"
        >
          <span className="relative flex h-3 w-3 items-center justify-center">
            <span
              className={`absolute h-2 w-2 rounded-full ${
                active ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground"
              }`}
            />
          </span>
        </button>
        {error && (
          <div className="rounded-md border border-destructive/50 bg-panel/95 px-2 py-1 text-[10px] text-foreground shadow-lg">
            ⚠
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="pointer-events-auto flex flex-col gap-1.5 rounded-xl border border-border bg-panel/95 p-2 shadow-lg">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={onToggleGps}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all ${
            active
              ? "border-emerald-400/60 bg-emerald-500/20 text-foreground"
              : "border-border bg-secondary/60 text-foreground hover:bg-secondary"
          }`}
          title={active ? "Desactivar GPS" : "Activar GPS"}
        >
          <span
            className={`h-2 w-2 rounded-full ${active ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground"}`}
          />
          {active ? "GPS ON" : "Activar GPS"}
        </button>

        <button
          onClick={onToggleFollow}
          disabled={!active || !position}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
            follow
              ? "border-cyan-400/60 bg-cyan-500/20 text-foreground"
              : "border-border bg-secondary/60 text-foreground hover:bg-secondary"
          }`}
          title="Seguir barco"
        >
          🎯 {follow ? "Siguiendo" : "Seguir"}
        </button>

        <button
          onClick={onRecenter}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary/60 px-2.5 py-1.5 text-xs font-medium text-foreground transition-all hover:bg-secondary"
          title={position ? "Ir a mi posición" : "Activar GPS y centrar"}
        >
          📍 Centrar
        </button>

        {isMobile && (
          <button
            onClick={() => setExpanded(false)}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-secondary/60 text-foreground hover:bg-secondary"
            title="Colapsar panel GPS"
            aria-label="Colapsar panel GPS"
          >
            ✕
          </button>
        )}
      </div>

      {position && (
        <div className="rounded-md bg-background/40 px-2 py-1.5 font-mono text-[10px] leading-tight text-muted-foreground">
          <div className="text-foreground">{toDegMinSec(position.lat, "lat")}</div>
          <div className="text-foreground">{toDegMinSec(position.lng, "lng")}</div>
          <div className="mt-0.5">
            <span className="text-foreground/80">±</span> {position.accuracy.toFixed(0)} m
            {position.speed != null && (
              <span className="ml-2">
                <span className="text-foreground/80">v:</span>{" "}
                {(position.speed * 1.94384).toFixed(1)} kn
              </span>
            )}
          </div>
          <button
            onClick={copyDms}
            className="mt-1.5 w-full rounded border border-border bg-secondary/70 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary"
            title="Copiar coordenadas en grados, minutos y segundos"
          >
            {copied ? "✓ Copiado" : "📋 Copiar GPS (DMS)"}
          </button>
        </div>
      )}

      {onSaveTrack && (
        <button
          onClick={onSaveTrack}
          disabled={trackLength < 2}
          className="rounded-md border border-emerald-400/50 bg-emerald-500/15 px-2 py-1 text-[10px] font-semibold text-foreground hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-40"
          title="Guardar el recorrido actual en este dispositivo"
        >
          💾 Guardar track{trackLength > 1 ? ` (${trackLength} pts)` : ""}
        </button>
      )}

      {onOpenSavedTracks && (savedTracksCount ?? 0) > 0 && (
        <button
          onClick={onOpenSavedTracks}
          className="rounded-md border border-border bg-secondary/60 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary"
          title="Ver tracks guardados"
        >
          📁 Tracks guardados ({savedTracksCount})
        </button>
      )}

      {trackLength > 1 && (
        <div className="flex items-center gap-1.5">
          <button
            onClick={onExportGpx}
            className="flex-1 rounded-md border border-border bg-secondary/60 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary"
            title="Exportar track GPX"
          >
            ⬇ GPX ({trackLength})
          </button>
          <button
            onClick={onClearTrack}
            className="rounded-md border border-border bg-secondary/60 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary"
            title="Borrar track"
          >
            ✕
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1 text-[10px] text-foreground">
          ⚠ {ERROR_MESSAGES[error]}
        </div>
      )}
    </div>
  );
}

