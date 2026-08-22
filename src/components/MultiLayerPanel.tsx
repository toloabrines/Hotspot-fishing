import { useState } from "react";
import { LAYER_CONFIGS } from "./ocean-layers";
import type { LayerGroup, LayerType } from "./ocean-layers";
import { DEFAULT_ISOLINES, type IsolineSettings } from "./IsolineLayer.types";

export type SstBlendMode = "hue" | "normal" | "multiply";

export interface MultiLayerState {
  chlorophyll: { layer: LayerType; opacity: number; enabled: boolean };
  sst: { layer: LayerType; opacity: number; enabled: boolean };
  altimetry: { layer: LayerType; opacity: number; enabled: boolean };
  sstBlendMode?: SstBlendMode;
  streamlines: {
    enabled: boolean;
    opacity: number;
    intensity: "low" | "medium" | "high";
    depth: "surface" | 10 | 20 | 30 | 50 | 100 | "bottom";
  };
  /** Isolíneas blancas tipo carta oceanográfica sobre cada capa. */
  isolines: IsolineSettings;
  /** Cursor fijo en el centro con lectura en vivo de SST/CHL/ALT/profundidad. */
  centerCrosshair: boolean;
  /** FSLE — líneas finas de convergencia oceánica (opcional, OFF por defecto). */
  fsle?: { enabled: boolean };
}

export const DEFAULT_MULTI_LAYER: MultiLayerState = {
  chlorophyll: { layer: "chl", opacity: 0.78, enabled: false },
  sst: { layer: "sst_nrt", opacity: 0.52, enabled: false },
  altimetry: { layer: "alt_combined", opacity: 0.72, enabled: false },
  sstBlendMode: "normal",
  streamlines: { enabled: false, opacity: 0.9, intensity: "high", depth: "surface" },
  isolines: DEFAULT_ISOLINES,
  centerCrosshair: true,
  fsle: { enabled: false },
};

export type LayerPreset = "sst" | "chl" | "alt" | "combined" | "compare3";

export function applyLayerPreset(state: MultiLayerState, preset: LayerPreset): MultiLayerState {
  if (preset === "sst") {
    return {
      ...state,
      sst: { ...state.sst, enabled: true },
      chlorophyll: { ...state.chlorophyll, enabled: false },
      altimetry: { ...state.altimetry, enabled: false },
    };
  }
  if (preset === "chl") {
    return {
      ...state,
      sst: { ...state.sst, enabled: false },
      chlorophyll: { ...state.chlorophyll, enabled: true },
      altimetry: { ...state.altimetry, enabled: false },
    };
  }
  if (preset === "alt") {
    return {
      ...state,
      sst: { ...state.sst, enabled: false },
      chlorophyll: { ...state.chlorophyll, enabled: false },
      altimetry: { ...state.altimetry, enabled: true },
    };
  }
  if (preset === "compare3") {
    // Combinación cromáticamente disjunta: paletas que no se solapan en color
    // → ALT (Spectral pastel) + SST_HC (jet rojo/naranja) + CHL_HC (verde).
    // Opacidades calibradas para que las 3 sean legibles a la vez.
    return {
      ...state,
      altimetry: {
        ...state.altimetry,
        layer: "alt_combined" as LayerType,
        enabled: true,
        opacity: 0.95,
      },
      sst: { ...state.sst, layer: "sst_nrt_hc" as LayerType, enabled: true, opacity: 0.85 },
      chlorophyll: {
        ...state.chlorophyll,
        layer: "chl_hc" as LayerType,
        enabled: true,
        opacity: 0.85,
      },
    };
  }
  // combined → todas activas, con opacidades visibles para combinarlas
  return {
    ...state,
    sst: { ...state.sst, enabled: true, opacity: 0.52 },
    chlorophyll: { ...state.chlorophyll, enabled: true, opacity: 0.78 },
    altimetry: { ...state.altimetry, enabled: true, opacity: 0.72 },
  };
}

export function detectPreset(state: MultiLayerState): LayerPreset {
  const s = state.sst.enabled,
    c = state.chlorophyll.enabled,
    a = state.altimetry.enabled;
  if (s && c && a) {
    if (
      state.sst.layer === "sst_nrt_hc" &&
      state.chlorophyll.layer === "chl_hc" &&
      state.altimetry.layer === "alt_combined"
    )
      return "compare3";
    return "combined";
  }
  if (s && !c && !a) return "sst";
  if (!s && c && !a) return "chl";
  if (!s && !c && a) return "alt";
  return "combined";
}

const GROUP_META: {
  key: LayerGroup;
  icon: string;
  title: string;
  color: string;
  layers: { key: LayerType; label: string }[];
}[] = [
  {
    key: "sst",
    icon: "🌡️",
    title: "Temperatura",
    color: "var(--ocean-warm)",
    layers: [
      { key: "sst_nrt", label: "SST Superficie (HR 1 km)" },
      { key: "sst_d10", label: "🌡️ T a 10 m (MEDSEA)" },
      { key: "sst_d20", label: "🌡️ T a 20 m (MEDSEA)" },
      { key: "sst_d30", label: "🌡️ T a 30 m (MEDSEA)" },
      { key: "sst_d50", label: "🌡️ T a 50 m (MEDSEA)" },
      { key: "sst_d100", label: "🌡️ T a 100 m (MEDSEA)" },
      { key: "sst_bottom", label: "🐟 T del fondo (MEDSEA)" },
      { key: "sst_nrt_hc", label: "SST Alto Contraste (16–26°C)" },
      { key: "sst_analysed", label: "SST Analizada" },
      { key: "sst_skin", label: "Skin Temp" },
      { key: "sst_error", label: "Error SST" },
      { key: "sst_ice", label: "Hielo Marino" },
    ],
  },
  {
    key: "chlorophyll",
    icon: "🌿",
    title: "Clorofila",
    color: "var(--ocean-green)",
    layers: [
      { key: "chl", label: "CHL diaria (0.03–3)" },
      { key: "chl_hc", label: "CHL Alto Contraste" },
      { key: "chl_monthly", label: "CHL mensual" },
      { key: "chl_micro", label: "Micro" },
      { key: "chl_nano", label: "Nano" },
      { key: "chl_pico", label: "Pico" },
      { key: "chl_bbp", label: "BBP" },
      { key: "chl_cdm", label: "CDM" },
    ],
  },
  {
    key: "altimetry",
    icon: "🌊",
    title: "Corrientes / Altimetría",
    color: "var(--ocean-cyan)",
    layers: [
      { key: "alt_combined", label: "Altimetría + corrientes" },
      { key: "alt_sla", label: "SLA" },
      { key: "alt_adt", label: "ADT (normal, científica)" },
      { key: "alt_adt_micro", label: "Altimetría Micro (alto contraste local)" },
      { key: "alt_ugos", label: "U geostr." },
      { key: "alt_vgos", label: "V geostr." },
      { key: "alt_eke", label: "EKE" },
    ],
  },
];

interface MultiLayerPanelProps {
  state: MultiLayerState;
  onChange: (state: MultiLayerState) => void;
}

export function MultiLayerPanel({ state, onChange }: MultiLayerPanelProps) {
  const [expandedGroup, setExpandedGroup] = useState<LayerGroup | null>(null);
  const currentPreset = detectPreset(state);

  const setPreset = (p: LayerPreset) => onChange(applyLayerPreset(state, p));

  const isHighContrast = state.sst.layer === "sst_nrt_hc" || state.chlorophyll.layer === "chl_hc";

  const toggleHighContrast = () => {
    onChange({
      ...state,
      sst: {
        ...state.sst,
        layer: (isHighContrast ? "sst_nrt" : "sst_nrt_hc") as LayerType,
      },
      chlorophyll: {
        ...state.chlorophyll,
        layer: (isHighContrast ? "chl" : "chl_hc") as LayerType,
      },
    });
  };

  const presetButtons: { key: LayerPreset; label: string; icon: string }[] = [
    { key: "sst", label: "SST", icon: "🌡️" },
    { key: "chl", label: "Clorofila", icon: "🌿" },
    { key: "alt", label: "Corrientes", icon: "🌊" },
    { key: "combined", label: "Combinado", icon: "✨" },
  ];
  const compare3Active = currentPreset === "compare3";

  const update = (
    group: LayerGroup,
    patch: Partial<{ layer: LayerType; opacity: number; enabled: boolean }>,
  ) => {
    onChange({ ...state, [group]: { ...state[group], ...patch } });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Modo rápido — presets de capas */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Modo rápido
        </div>
        <div className="grid grid-cols-4 gap-1">
          {presetButtons.map((p) => {
            const active = currentPreset === p.key;
            return (
              <button
                key={p.key}
                onClick={() => setPreset(p.key)}
                className={`flex flex-col items-center gap-0.5 rounded-md border px-1 py-1.5 text-[10px] font-medium transition-colors ${
                  active
                    ? "border-accent bg-accent/15 text-foreground"
                    : "border-border bg-card/40 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                }`}
                title={p.label}
              >
                <span className="text-sm leading-none">{p.icon}</span>
                <span className="truncate leading-tight">{p.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Preset destacado: Comparar 3 capas con paletas disjuntas */}
      <button
        onClick={() => setPreset("compare3")}
        title="Activa ALT + SST contraste alto + CHL contraste alto con opacidades calibradas para distinguir las 3 capas a la vez"
        className={`flex items-center justify-between gap-2 rounded-md border px-2 py-2 text-[11px] font-semibold transition-colors ${
          compare3Active
            ? "border-fuchsia-400/70 bg-fuchsia-500/20 text-fuchsia-100"
            : "border-fuchsia-400/40 bg-fuchsia-500/10 text-fuchsia-200 hover:bg-fuchsia-500/20"
        }`}
      >
        <span className="flex items-center gap-1.5">
          <span className="text-base leading-none">🎨</span>
          <span>Comparar 3 capas (colores disjuntos)</span>
        </span>
        {compare3Active && <span className="text-[10px]">✓ activo</span>}
      </button>

      {/* Selector de modo de mezcla SST — útil para ajustar a la zona del
          Mediterráneo (frentes vs T absoluta vs masas frías). */}
      {state.sst.enabled && (state.chlorophyll.enabled || state.altimetry.enabled) && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Mezcla SST 🌡️
          </div>
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                {
                  key: "hue",
                  label: "Tono",
                  hint: "Solo transfiere tono térmico. Mejor para microfrentes y filamentos (Mar Balear, Alborán).",
                },
                {
                  key: "normal",
                  label: "Normal",
                  hint: "Color térmico puro encima. Mejor para identificar T absoluta (golfo de León, mar Tirreno).",
                },
                {
                  key: "multiply",
                  label: "Multiplicar",
                  hint: "SST oscurece las capas inferiores. Resalta masas frías y upwellings.",
                },
              ] as { key: SstBlendMode; label: string; hint: string }[]
            ).map((m) => {
              const active = (state.sstBlendMode ?? "hue") === m.key;
              return (
                <button
                  key={m.key}
                  onClick={() => onChange({ ...state, sstBlendMode: m.key })}
                  title={m.hint}
                  className={`rounded-md border px-1 py-1.5 text-[10px] font-medium transition-colors ${
                    active
                      ? "border-accent bg-accent/15 text-foreground"
                      : "border-border bg-card/40 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Modo contraste alto — para zonas con poca variación térmica */}
      <button
        onClick={toggleHighContrast}
        title="Rango más estrecho (16–26°C / CHL 0.05–1) para resaltar microfrentes"
        className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors ${
          isHighContrast
            ? "border-orange-400/70 bg-orange-500/15 text-orange-100"
            : "border-border bg-card/40 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
        }`}
      >
        <span className="flex items-center gap-1.5">
          <span>🔥</span>
          <span>Modo contraste alto</span>
        </span>
        <span
          className={`relative h-4 w-7 shrink-0 rounded-full border transition-colors ${
            isHighContrast ? "border-orange-400 bg-orange-500/80" : "border-border bg-secondary"
          }`}
        >
          <span
            className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform ${
              isHighContrast ? "translate-x-[14px]" : "translate-x-0.5"
            }`}
          />
        </span>
      </button>

      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Ajuste fino — opacidad por capa
      </div>
      {GROUP_META.map((g) => {
        const groupState = state[g.key];
        const config = LAYER_CONFIGS[groupState.layer];
        const isExpanded = expandedGroup === g.key;
        const isOn = groupState.enabled;

        return (
          <div
            key={g.key}
            className={`rounded-lg border p-2 transition-colors ${
              isOn ? "border-border bg-card/60" : "border-border/40 bg-card/30 opacity-70"
            }`}
          >
            {/* Group header con toggle ON/OFF */}
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm">{g.icon}</span>
              <span className="flex-1 text-xs font-semibold text-foreground">{g.title}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {isOn ? `${Math.round(groupState.opacity * 100)}%` : "OFF"}
              </span>
              {/* Switch */}
              <button
                role="switch"
                aria-checked={isOn}
                aria-label={`${isOn ? "Desactivar" : "Activar"} ${g.title}`}
                onClick={() => update(g.key, { enabled: !isOn })}
                className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
                  isOn ? "border-accent bg-accent/80" : "border-border bg-secondary"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                    isOn ? "translate-x-[18px]" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>

            {/* Opacity slider — disabled when off */}
            <div className="relative mb-2 flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(groupState.opacity * 100)}
                disabled={!isOn}
                onChange={(e) => update(g.key, { opacity: Number(e.target.value) / 100 })}
                className="ocean-slider h-2 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>

            {/* Layer selector */}
            <button
              onClick={() => setExpandedGroup(isExpanded ? null : g.key)}
              className="flex w-full items-center gap-1 rounded-md border border-border/50 bg-secondary/50 px-2 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-secondary"
            >
              <span className="flex-1 truncate">{config.label}</span>
              <svg
                className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isExpanded && (
              <div className="mt-1 flex flex-col gap-0.5">
                {g.layers.map((l) => (
                  <button
                    key={l.key}
                    onClick={() => {
                      // Al elegir una capa también la activamos automáticamente.
                      // Altimetría Micro recomienda 40–50 % de opacidad para no
                      // tapar el resto de capas con su paleta turbo saturada.
                      const patch: Partial<{
                        layer: LayerType;
                        enabled: boolean;
                        opacity: number;
                      }> = { layer: l.key, enabled: true };
                      if (l.key === "alt_adt_micro") patch.opacity = 0.45;
                      update(g.key, patch);
                      setExpandedGroup(null);
                    }}
                    className={`rounded-md px-2 py-1 text-left text-[11px] transition-colors ${
                      groupState.layer === l.key
                        ? "bg-secondary font-semibold text-foreground"
                        : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Isolíneas blancas tipo carta + cursor central */}
      <IsolinesControl
        isolines={state.isolines}
        centerCrosshair={state.centerCrosshair}
        onIsolinesChange={(patch) =>
          onChange({ ...state, isolines: { ...state.isolines, ...patch } })
        }
        onCrosshairChange={(v) => onChange({ ...state, centerCrosshair: v })}
      />

      {/* Corrientes visuales / Streamlines — capa animada U/V geostr. */}
      <StreamlinesControl
        enabled={state.streamlines.enabled}
        opacity={state.streamlines.opacity}
        intensity={state.streamlines.intensity}
        depth={state.streamlines.depth}
        onChange={(patch) =>
          onChange({ ...state, streamlines: { ...state.streamlines, ...patch } })
        }
      />

      {/* FSLE / LCS reales: el endpoint /api/public/fsle integra trayectorias
          con RK4 sobre uo/vo de Copernicus MEDSEA y extrae crestas del campo
          FSLE. NO es AVISO-FSLE oficial; es FSLE lagrangiano cinemático
          (campo congelado del día seleccionado) calculado por la app. */}
      <button
        onClick={() =>
          onChange({
            ...state,
            fsle: { enabled: !(state.fsle?.enabled ?? false) },
          })
        }
        title="FSLE real aproximado — RK4 sobre campo geostrófico Copernicus congelado. No es AVISO-FSLE oficial: es FSLE lagrangiano calculado por la app con RK4 sobre uo/vo del día seleccionado."
        className={`flex flex-col items-stretch gap-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors ${
          state.fsle?.enabled
            ? "border-cyan-400/70 bg-cyan-500/15 text-cyan-100"
            : "border-border bg-card/40 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
        }`}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <span>🧬</span>
            <span>FSLE / LCS — Líneas reales</span>
          </span>
          <span
            className={`relative h-4 w-7 shrink-0 rounded-full border transition-colors ${
              state.fsle?.enabled ? "border-cyan-400 bg-cyan-500/80" : "border-border bg-secondary"
            }`}
          >
            <span
              className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform ${
                state.fsle?.enabled ? "translate-x-[14px]" : "translate-x-0.5"
              }`}
            />
          </span>
        </span>
        <span className="text-[9px] font-normal leading-tight opacity-70">
          FSLE real aproximado — RK4 sobre campo geostrófico Copernicus congelado.
          No es AVISO-FSLE oficial.
        </span>
      </button>
    </div>
  );
}

interface IsolinesControlProps {
  isolines: IsolineSettings;
  centerCrosshair: boolean;
  onIsolinesChange: (patch: Partial<IsolineSettings>) => void;
  onCrosshairChange: (v: boolean) => void;
}

function IsolinesControl({
  isolines,
  centerCrosshair,
  onIsolinesChange,
  onCrosshairChange,
}: IsolinesControlProps) {
  return (
    <div
      className={`rounded-lg border p-2 transition-colors ${
        isolines.enabled ? "border-white/40 bg-card/60" : "border-border/40 bg-card/30 opacity-70"
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm">🗺️</span>
        <span className="flex-1 text-xs font-semibold text-foreground">
          Isolíneas (carta oceanográfica)
        </span>
        <button
          role="switch"
          aria-checked={isolines.enabled}
          onClick={() => onIsolinesChange({ enabled: !isolines.enabled })}
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
            isolines.enabled ? "border-white/70 bg-white/70" : "border-border bg-secondary"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-slate-900 shadow-sm transition-transform ${
              isolines.enabled ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      <div className="mb-2 grid grid-cols-3 gap-1">
        {(
          [
            { k: "sst", label: "🌡️ SST" },
            { k: "chlorophyll", label: "🌿 CHL" },
            { k: "altimetry", label: "🌊 ALT" },
          ] as const
        ).map(({ k, label }) => {
          const active = isolines[k];
          return (
            <button
              key={k}
              disabled={!isolines.enabled}
              onClick={() => onIsolinesChange({ [k]: !active } as Partial<IsolineSettings>)}
              className={`rounded-md border px-1 py-1 text-[10px] font-medium transition-colors disabled:opacity-40 ${
                active
                  ? "border-white/60 bg-white/15 text-foreground"
                  : "border-border bg-card/40 text-muted-foreground hover:bg-secondary/60"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="mb-2 flex items-center gap-2">
        <span className="w-14 text-[10px] text-muted-foreground">Densidad</span>
        <input
          type="range"
          min={1}
          max={5}
          value={isolines.density}
          disabled={!isolines.enabled}
          onChange={(e) => onIsolinesChange({ density: Number(e.target.value) })}
          className="ocean-slider h-2 w-full cursor-pointer disabled:opacity-40"
        />
        <span className="w-4 text-right text-[10px] tabular-nums text-muted-foreground">
          {isolines.density}
        </span>
      </div>

      <button
        disabled={!isolines.enabled}
        onClick={() => onIsolinesChange({ highlightGradients: !isolines.highlightGradients })}
        className={`mb-2 flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-40 ${
          isolines.highlightGradients
            ? "border-yellow-400/60 bg-yellow-500/15 text-yellow-100"
            : "border-border bg-card/40 text-muted-foreground hover:bg-secondary/60"
        }`}
      >
        <span>⚡ Mostrar gradientes (frentes)</span>
        <span>{isolines.highlightGradients ? "✓" : ""}</span>
      </button>

      <button
        onClick={() => onCrosshairChange(!centerCrosshair)}
        className={`flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-colors ${
          centerCrosshair
            ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-100"
            : "border-border bg-card/40 text-muted-foreground hover:bg-secondary/60"
        }`}
      >
        <span>✛ Cursor central en vivo</span>
        <span>{centerCrosshair ? "✓" : ""}</span>
      </button>

      <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
        Líneas blancas finas siguiendo los cambios reales del campo. Sólo a partir de zoom 7 para no
        saturar el mapa. El cursor central actualiza los valores bajo la cruz al mover el mapa.
      </p>
    </div>
  );
}

type CurrentDepthUI = "surface" | 10 | 20 | 30 | 50 | 100 | "bottom";

interface StreamlinesControlProps {
  enabled: boolean;
  opacity: number;
  intensity: "low" | "medium" | "high";
  depth: CurrentDepthUI;
  onChange: (
    patch: Partial<{
      enabled: boolean;
      opacity: number;
      intensity: "low" | "medium" | "high";
      depth: CurrentDepthUI;
    }>,
  ) => void;
}

function StreamlinesControl({ enabled, opacity, intensity, depth, onChange }: StreamlinesControlProps) {
  const depthOptions: { value: CurrentDepthUI; label: string }[] = [
    { value: "surface", label: "Sup." },
    { value: 10, label: "10 m" },
    { value: 20, label: "20 m" },
    { value: 30, label: "30 m" },
    { value: 50, label: "50 m" },
    { value: 100, label: "100 m" },
    { value: "bottom", label: "Fondo" },
  ];
  return (
    <div
      className={`rounded-lg border p-2 transition-colors ${
        enabled ? "border-accent/50 bg-card/60" : "border-border/40 bg-card/30 opacity-70"
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm">🌀</span>
        <span className="flex-1 text-xs font-semibold text-foreground">Corrientes por profundidad</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {enabled ? `${Math.round(opacity * 100)}%` : "OFF"}
        </span>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? "Desactivar" : "Activar"} corrientes visuales`}
          onClick={() => onChange({ enabled: !enabled })}
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
            enabled ? "border-accent bg-accent/80" : "border-border bg-secondary"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      <div className="relative mb-2 flex items-center gap-2">
        <input
          type="range"
          min={10}
          max={100}
          value={Math.round(opacity * 100)}
          disabled={!enabled}
          onChange={(e) => onChange({ opacity: Number(e.target.value) / 100 })}
          className="ocean-slider h-2 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
        />
      </div>

      <div className="mb-1.5 flex gap-1">
        {(["low", "medium", "high"] as const).map((lvl) => (
          <button
            key={lvl}
            disabled={!enabled}
            onClick={() => onChange({ intensity: lvl })}
            className={`flex-1 rounded-md px-1.5 py-1 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              intensity === lvl
                ? "bg-accent/80 text-accent-foreground"
                : "bg-secondary text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
            }`}
          >
            {lvl === "low" ? "Baja" : lvl === "medium" ? "Media" : "Alta"}
          </button>
        ))}
      </div>

      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Profundidad
      </div>
      <div className="mb-1 grid grid-cols-4 gap-1">
        {depthOptions.map((d) => (
          <button
            key={String(d.value)}
            disabled={!enabled}
            onClick={() => onChange({ depth: d.value })}
            className={`rounded-md px-1 py-1 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              depth === d.value
                ? "bg-accent/80 text-accent-foreground"
                : "bg-secondary text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      <p className="text-[10px] leading-snug text-muted-foreground">
        {depth === "surface"
          ? "Superficie: corrientes geostróficas globales (Copernicus NRT)."
          : depth === "bottom"
            ? "Fondo (MEDSEA 4 km): uo/vo cerca del sedimento — sólo Mediterráneo."
            : `${depth} m (MEDSEA 4 km): uo/vo al nivel indicado — sólo Mediterráneo.`}
      </p>
    </div>
  );
}


