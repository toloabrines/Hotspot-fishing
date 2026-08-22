import { useState } from "react";
import { LAYER_CONFIGS } from "./ocean-layers";
import type { LayerGroup, LayerType } from "./ocean-layers";

interface GroupMeta {
  key: LayerGroup;
  icon: string;
  title: string;
  description: string;
  glowClass: string;
  borderClass: string;
  textClass: string;
  layers: { key: LayerType; shortLabel: string }[];
}

const GROUPS: GroupMeta[] = [
  {
    key: "chlorophyll",
    icon: "🌿",
    title: "Clorofila / Óptica",
    description: "Fitoplancton, retrodispersión y materia orgánica",
    glowClass: "glow-green",
    borderClass: "border-ocean-green",
    textClass: "text-ocean-green",
    layers: [
      { key: "chl", shortLabel: "CHL diaria" },
      { key: "chl_monthly", shortLabel: "CHL mensual" },
      { key: "chl_micro", shortLabel: "Micro" },
      { key: "chl_nano", shortLabel: "Nano" },
      { key: "chl_pico", shortLabel: "Pico" },
      { key: "chl_bbp", shortLabel: "BBP" },
      { key: "chl_cdm", shortLabel: "CDM" },
    ],
  },
  {
    key: "sst",
    icon: "🌡️",
    title: "Temperatura",
    description: "Superficie, profundidad y fondo MEDSEA",
    glowClass: "glow-warm",
    borderClass: "border-ocean-warm",
    textClass: "text-ocean-warm",
    layers: [
      { key: "sst_nrt", shortLabel: "Superficie" },
      { key: "sst_d10", shortLabel: "10 m" },
      { key: "sst_d20", shortLabel: "20 m" },
      { key: "sst_d30", shortLabel: "30 m" },
      { key: "sst_d50", shortLabel: "50 m" },
      { key: "sst_d100", shortLabel: "100 m" },
      { key: "sst_bottom", shortLabel: "Fondo" },
      { key: "sst_analysed", shortLabel: "SST Analizada" },
      { key: "sst_skin", shortLabel: "Skin Temp" },
      { key: "sst_error", shortLabel: "Error SST" },
      { key: "sst_ice", shortLabel: "Hielo Marino" },
    ],
  },
  {
    key: "altimetry",
    icon: "🌊",
    title: "Altimetría",
    description: "Nivel del mar, corrientes y energía cinética",
    glowClass: "glow-cyan",
    borderClass: "border-ocean-cyan",
    textClass: "text-ocean-cyan",
    layers: [
      { key: "alt_sla", shortLabel: "SLA" },
      { key: "alt_adt", shortLabel: "ADT" },
      { key: "alt_ugos", shortLabel: "U geostr." },
      { key: "alt_vgos", shortLabel: "V geostr." },
      { key: "alt_ugosa", shortLabel: "U anom." },
      { key: "alt_vgosa", shortLabel: "V anom." },
      { key: "alt_eke", shortLabel: "EKE" },
      { key: "alt_combined", shortLabel: "Corrientes + Altura" },
      { key: "alt_currents", shortLabel: "🌊 Corrientes (anim.)" },
    ],
  },
];

interface LayerSelectorProps {
  activeLayer: LayerType;
  onLayerChange: (layer: LayerType) => void;
}

export function LayerSelector({ activeLayer, onLayerChange }: LayerSelectorProps) {
  const activeGroup = LAYER_CONFIGS[activeLayer].group;
  const [expandedGroup, setExpandedGroup] = useState<LayerGroup | null>(activeGroup);

  return (
    <div className="flex flex-col gap-2">
      {GROUPS.map((group) => {
        const isGroupActive = activeGroup === group.key;
        const isExpanded = expandedGroup === group.key;

        return (
          <div key={group.key}>
            <button
              onClick={() => {
                if (isExpanded) {
                  setExpandedGroup(null);
                } else {
                  setExpandedGroup(group.key);
                  if (!isGroupActive) {
                    onLayerChange(group.layers[0].key);
                  }
                }
              }}
              className={`
                w-full flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all duration-200
                ${
                  isGroupActive
                    ? `${group.borderClass} ${group.glowClass} bg-secondary`
                    : "border-border bg-card hover:bg-secondary hover:border-muted-foreground/30"
                }
              `}
            >
              <span className="text-base">{group.icon}</span>
              <div className="min-w-0 flex-1">
                <div
                  className={`text-sm font-semibold ${isGroupActive ? group.textClass : "text-foreground"}`}
                >
                  {group.title}
                </div>
                <div className="truncate text-xs text-muted-foreground">{group.description}</div>
              </div>
              <svg
                className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isExpanded && (
              <div className="mt-1 ml-8 flex max-h-[200px] flex-col gap-1 overflow-y-auto pr-1">
                {group.layers.map((sub) => {
                  const isActive = activeLayer === sub.key;

                  return (
                    <button
                      key={sub.key}
                      onClick={() => onLayerChange(sub.key)}
                      className={`
                        flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition-all duration-150
                        ${
                          isActive
                            ? `${group.borderClass} bg-secondary/80 ${group.textClass} font-semibold`
                            : "border-border/50 bg-card/60 text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                        }
                      `}
                    >
                      <div
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? "bg-current" : "bg-muted-foreground/40"}`}
                      />
                      <span className="truncate">{sub.shortLabel}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {LAYER_CONFIGS[sub.key].unit}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

