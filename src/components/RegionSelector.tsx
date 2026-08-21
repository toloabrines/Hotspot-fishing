import { useState } from "react";

export interface Region {
  key: string;
  label: string;
  icon: string;
  center: [number, number];
  zoom: number;
}

/**
 * Regiones — sin restricciones. "Mundo" es el default para que la app
 * funcione globalmente desde el primer arranque. Las demás son sólo
 * accesos rápidos para encuadrar el mapa, NO filtros geográficos.
 */
export const REGIONS: Region[] = [
  { key: "mallorca_full", label: "Mallorca completa", icon: "🏝️", center: [39.65, 3.05], zoom: 10 },
  { key: "bahia_alcudia", label: "Bahía de Alcúdia", icon: "🎣", center: [39.83, 3.15], zoom: 12 },
  { key: "bahia_palma", label: "Bahía de Palma", icon: "⚓", center: [39.5, 2.65], zoom: 12 },
  { key: "baleares", label: "Baleares", icon: "🗺️", center: [39.3, 2.5], zoom: 7 },
  { key: "mallorca", label: "N. Mallorca", icon: "📍", center: [39.95, 3.25], zoom: 9 },
  { key: "iberia_med", label: "Iberia + Med.", icon: "🌊", center: [36, -4], zoom: 5 },
  { key: "mediterraneo", label: "Mediterráneo O.", icon: "🏖️", center: [39, 4], zoom: 6 },
  { key: "atlantico_norte", label: "Atlántico Norte", icon: "🌐", center: [35, -25], zoom: 3 },
  { key: "mundo", label: "Mundo", icon: "🌍", center: [20, 0], zoom: 3 },
];

interface RegionSelectorProps {
  onSelect: (region: Region) => void;
  activeKey?: string;
}

export function RegionSelector({ onSelect, activeKey }: RegionSelectorProps) {
  const [open, setOpen] = useState(false);
  const active = REGIONS.find((r) => r.key === activeKey) ?? REGIONS[0];

  return (
    <div className="pointer-events-auto relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 items-center gap-1 rounded-lg border border-border bg-panel/90 px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary"
        title="Encuadrar mapa"
      >
        <span className="text-sm">{active.icon}</span>
        <span className="hidden sm:inline">{active.label}</span>
        <svg
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Cerrar"
            className="fixed inset-0 z-[1090]"
            onClick={() => setOpen(false)}
          />
          <div className="absolute top-full left-0 z-[1100] mt-1 flex min-w-44 flex-col gap-0.5 rounded-xl border border-border bg-panel/98 p-1.5 shadow-2xl">
            {REGIONS.map((r) => (
              <button
                type="button"
                key={r.key}
                onClick={() => {
                  onSelect(r);
                  setOpen(false);
                }}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                  active.key === r.key
                    ? "bg-secondary font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                }`}
              >
                <span className="text-sm">{r.icon}</span>
                <span>{r.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

