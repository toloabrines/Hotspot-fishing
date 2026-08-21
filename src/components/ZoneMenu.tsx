import type { DrawMode } from "./SearchAreaLayer";

interface ZoneMenuProps {
  drawMode: DrawMode;
  setDrawMode: (m: DrawMode) => void;
  searchInsideArea: () => void;
  clearAll: () => void;
  hasSearchArea: boolean;
  /** No se usa (kept for compatibility) */
  useVisibleScreenAsArea?: () => void;
  lockFavoriteArea?: () => void;
  hotZoneOnly?: boolean;
}

/**
 * Selector de zona simplificado: SOLO triángulo.
 * El usuario pidió eliminar rectángulo y polígono porque introducían
 * inestabilidad (conflictos con panning del mapa, parpadeos, etc.).
 */
export function ZoneMenu({ drawMode, setDrawMode, hasSearchArea, clearAll }: ZoneMenuProps) {
  const active = drawMode === "triangle";

  return (
    <button
      type="button"
      onClick={() => {
        // Si ya hay zona dibujada y se vuelve a pulsar → limpiar.
        if (hasSearchArea && !active) {
          clearAll();
          return;
        }
        setDrawMode(active ? null : "triangle");
      }}
      title="Dibujar zona triangular: 3 clics sobre el mapa"
      className={`pointer-events-auto flex h-8 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium text-white transition-colors ${
        active
          ? "border-cyan-400 bg-cyan-600/90 hover:bg-cyan-500"
          : "border-neutral-700 bg-black/80 hover:bg-neutral-900"
      }`}
    >
      △ <span className="hidden sm:inline">Triángulo</span>
    </button>
  );
}

