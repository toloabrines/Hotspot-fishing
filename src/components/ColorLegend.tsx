import { LAYER_CONFIGS } from "./ocean-layers";
import type { ViewportSstRanges } from "./ViewportAdaptiveContrast";
import type { LayerType } from "./ocean-layers";

const GRADIENTS: Record<string, string> = {
  // Clorofila: magma sin verde para que las diferencias no queden ocultas.
  chlorophyll:
    "linear-gradient(to right, #000004, #1b0c41, #4a0c6b, #781c6d, #a52c60, #cf4446, #ed6925, #fb9a06, #f7d13d, #fcffa4)",
  // SST: granate oscuro → rojo → salmón → blanco. Oscuro = frío, blanco = más caliente.
  sst: "linear-gradient(to right, #360008 0%, #8b0010 16%, #d62828 34%, #f06e32 52%, #f77f3c 68%, #fcbf49 84%, #fde79a 100%)",
  // Altimetría/corrientes: azul → blanco → rojo (RdBu_r), sin amarillos ni naranjas.
  altimetry:
    "linear-gradient(to right, #053061, #2166ac, #4393c3, #92c5de, #d1e5f0, #f7f7f7, #fddbc7, #f4a582, #d6604d, #b2182b, #67001f)",
  // Misma paleta RdBu_r para ADT cuando se muestra solo.
  altimetry_adt:
    "linear-gradient(to right, #053061, #2166ac, #4393c3, #92c5de, #d1e5f0, #f7f7f7, #fddbc7, #f4a582, #d6604d, #b2182b, #67001f)",
  // turbo: máximo contraste local para Altimetría Micro (azul/verde/amarillo/rojo).
  altimetry_micro:
    "linear-gradient(to right, #30123b, #4675ed, #1bcfd4, #61fc6c, #f3c63a, #f36315, #7a0403)",
  // turbo para velocidad de corrientes
  velocity:
    "linear-gradient(to right, #30123b, #4675ed, #1bcfd4, #61fc6c, #f3c63a, #f36315, #7a0403)",
  // inferno para EKE
  eke: "linear-gradient(to right, #000004, #1b0c41, #4a0c6b, #781c6d, #a52c60, #cf4446, #ed6925, #fb9a06, #f7d13d, #fcffa4)",
  // magma para error SST
  error: "linear-gradient(to right, #000004, #2c105c, #711f81, #b63679, #ee605e, #fdae78, #fcfdbf)",
  // Blues para hielo marino
  ice: "linear-gradient(to right, #f7fbff, #deebf7, #c6dbef, #9ecae1, #6baed6, #4292c6, #2171b5, #08519c, #08306b)",
};

const RANGE: Record<LayerType, { min: string; max: string }> = {
  chl: { min: "0.04", max: "0.30" },
  chl_hc: { min: "0.04", max: "0.10" },
  chl_monthly: { min: "0.01", max: "20" },
  chl_micro: { min: "0.01", max: "10" },
  chl_nano: { min: "0.01", max: "10" },
  chl_pico: { min: "0.01", max: "10" },
  chl_bbp: { min: "0.0005", max: "0.05" },
  chl_cdm: { min: "0.005", max: "2" },
  sst_analysed: { min: "15 °C", max: "23 °C" },
  sst_skin: { min: "-2 °C", max: "32 °C" },
  sst_error: { min: "0 °C", max: "2 °C" },
  sst_ice: { min: "0%", max: "100%" },
  sst_nrt: { min: "15 °C", max: "23 °C" },
  sst_nrt_hc: { min: "16 °C", max: "22 °C" },
  sst_bottom: { min: "12 °C (fondo)", max: "20 °C (fondo)" },
  sst_d10: { min: "15 °C", max: "26 °C" },
  sst_d20: { min: "14 °C", max: "25 °C" },
  sst_d30: { min: "13 °C", max: "23 °C" },
  sst_d50: { min: "12 °C", max: "20 °C" },
  sst_d100: { min: "12 °C", max: "18 °C" },
  alt_sla: { min: "-0.4 m", max: "0.4 m" },
  alt_adt: { min: "-1.2 m", max: "1.2 m" },
  alt_adt_micro: { min: "auto", max: "auto (±0.25 m)" },
  alt_ugos: { min: "-1.2 m/s", max: "1.2 m/s" },
  alt_vgos: { min: "-1.2 m/s", max: "1.2 m/s" },
  alt_ugosa: { min: "-0.5 m/s", max: "0.5 m/s" },
  alt_vgosa: { min: "-0.5 m/s", max: "0.5 m/s" },
  alt_eke: { min: "0.001", max: "1 m²/s²" },
  alt_combined: { min: "-1.2 m (ADT)", max: "1.2 m (ADT)" },
  alt_currents: { min: "0 m/s", max: "1.5 m/s" },
};

function gradientFor(layer: LayerType, group: string): string {
  if (layer === "alt_currents") return GRADIENTS.velocity;
  if (layer === "alt_adt_micro") return GRADIENTS.altimetry_micro;
  if (layer === "alt_adt" || layer === "alt_combined") return GRADIENTS.altimetry_adt;
  if (layer === "alt_eke") return GRADIENTS.eke;
  if (layer === "sst_error") return GRADIENTS.error;
  if (layer === "sst_ice") return GRADIENTS.ice;
  return GRADIENTS[group] || GRADIENTS.altimetry;
}

interface ColorLegendProps {
  activeLayer?: LayerType;
  layers?: LayerType[];
  sstRanges?: ViewportSstRanges;
}

// Etiquetas cortas estilo carta oceanográfica profesional para la leyenda flotante.
const SHORT_LABELS: Partial<Record<LayerType, string>> = {
  sst_nrt: "SST",
  sst_nrt_hc: "SST (alto contraste)",
  sst_bottom: "Temperatura de fondo",
  sst_d10: "Temperatura 10 m",
  sst_d20: "Temperatura 20 m",
  sst_d30: "Temperatura 30 m",
  sst_d50: "Temperatura 50 m",
  sst_d100: "Temperatura 100 m",
  sst_analysed: "SST",
  sst_skin: "SST",
  chl: "Clorofila-a",
  chl_hc: "Clorofila-a (alto contraste)",
  chl_monthly: "Clorofila-a (mensual)",
  alt_combined: "Corrientes + altura del mar",
  alt_currents: "Corrientes + altura del mar",
  alt_adt: "Altura del mar (ADT)",
  alt_adt_micro: "Altimetría Micro",
  alt_sla: "Anomalía nivel del mar",
};

function LegendBar({ layer, sstRanges }: { layer: LayerType; sstRanges?: ViewportSstRanges }) {
  const config = LAYER_CONFIGS[layer];
  const baseLabels = RANGE[layer];
  const gradient = gradientFor(layer, config.group);
  const title = SHORT_LABELS[layer] ?? config.label;

  // Si hay rango dinámico (modo Auto) para esta capa SST, lo mostramos.
  const dyn = sstRanges?.[layer];
  const labels = dyn
    ? {
        min: `${dyn.minC.toFixed(1)} °C`,
        max: `${dyn.maxC.toFixed(1)} °C`,
      }
    : baseLabels;

  return (
    <div className="animate-fade-in-up">
      <div className="mb-1 text-[13px] font-semibold text-foreground leading-tight">
        {title} <span className="text-[11px] font-normal text-foreground/70">({config.unit})</span>
        {dyn && (
          <span className="ml-1 rounded bg-primary/20 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-primary">
            Auto
          </span>
        )}
      </div>
      <div
        className="h-3 w-full rounded-sm shadow-inner ring-1 ring-white/10"
        style={{ background: gradient }}
      />
      <div className="mt-1 flex justify-between">
        <span className="font-mono text-[11px] font-medium text-foreground/85">{labels.min}</span>
        <span className="font-mono text-[11px] font-medium text-foreground/85">{labels.max}</span>
      </div>
    </div>
  );
}

export function ColorLegend({ activeLayer, layers, sstRanges }: ColorLegendProps) {
  const list = layers && layers.length > 0 ? layers : activeLayer ? [activeLayer] : [];
  if (list.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {list.map((l) => (
        <LegendBar key={l} layer={l} sstRanges={sstRanges} />
      ))}
    </div>
  );
}

