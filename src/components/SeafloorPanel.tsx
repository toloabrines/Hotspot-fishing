import type { SeafloorSettings } from "../lib/seafloor.types";
import { AutoBathyPanel } from "./AutoBathyPanel";
import { SonarImportPanel } from "./SonarImportPanel";


interface Props {
  settings: SeafloorSettings;
  onChange: (next: SeafloorSettings) => void;
  pickMode: "none" | "info" | "profile";
  onPickModeChange: (mode: "none" | "info" | "profile") => void;
  show3d: boolean;
  onToggle3d: () => void;
  loading?: boolean;
  structuresCount?: number;
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-left text-xs transition ${
        checked
          ? "border-primary/50 bg-primary/15 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground"
      }`}
    >
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-[10px] opacity-70">{hint}</span>}
      </span>
      <span
        className={`ml-2 h-4 w-7 shrink-0 rounded-full transition ${checked ? "bg-primary" : "bg-border"}`}
      >
        <span
          className={`block h-4 w-4 rounded-full bg-background shadow transition ${checked ? "translate-x-3" : ""}`}
        />
      </span>
    </button>
  );
}

/** Panel de control de la capa profesional de fondo marino. */
export function SeafloorPanel({
  settings,
  onChange,
  pickMode,
  onPickModeChange,
  show3d,
  onToggle3d,
  loading,
  structuresCount = 0,
}: Props) {
  const set = <K extends keyof SeafloorSettings>(key: K, value: SeafloorSettings[K]) =>
    onChange({ ...settings, [key]: value });

  return (
    <div className="space-y-2">
      <Toggle
        label="Fondo marino profesional"
        hint={loading ? "Cargando relieve…" : "Relieve propio de alta resolución"}
        checked={settings.enabled}
        onChange={(v) => set("enabled", v)}
      />

      {settings.enabled && (
        <div className="space-y-2 rounded-lg border border-border bg-background/60 p-2">
          <Toggle
            label="Sombreado 3D (hillshade)"
            checked={settings.hillshade}
            onChange={(v) => set("hillshade", v)}
          />
          {settings.hillshade && (
            <>
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                Intensidad
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.hillshadeIntensity}
                  onChange={(e) => set("hillshadeIntensity", parseFloat(e.target.value))}
                  className="flex-1 accent-primary"
                />
              </label>
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                Luz
                <input
                  type="range"
                  min={0}
                  max={359}
                  step={5}
                  value={settings.sunAzimuth}
                  onChange={(e) => set("sunAzimuth", parseFloat(e.target.value))}
                  className="flex-1 accent-primary"
                />
              </label>
            </>
          )}

          <Toggle
            label="Curvas batimétricas"
            hint="5 m / 10 m / 25 m / 50 m según profundidad"
            checked={settings.contours}
            onChange={(v) => set("contours", v)}
          />
          <Toggle
            label="Mapa de pendientes"
            hint="Verde llano · amarillo medio · rojo veril"
            checked={settings.slope}
            onChange={(v) => set("slope", v)}
          />
          <Toggle
            label="Mapa de rugosidad"
            hint="Roca, grietas y relieve complejo"
            checked={settings.roughness}
            onChange={(v) => set("roughness", v)}
          />
          <Toggle
            label="Detección de estructuras"
            hint={
              structuresCount > 0
                ? `${structuresCount} bajos / veriles / cañones detectados`
                : "Bajos, veriles, cimas, cañones, mesetas"
            }
            checked={settings.structures}
            onChange={(v) => set("structures", v)}
          />

          <Toggle
            label="Máximo detalle sobre mi GPS"
            hint="Malla 640 px centrada en el barco (se sigue al navegar)"
            checked={settings.focusGps}
            onChange={(v) => set("focusGps", v)}
          />
          {settings.focusGps && (
            <div className="flex gap-1">
              {([400, 800, 1500, 3000] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => set("focusRadiusM", r)}
                  className={`flex-1 rounded-md border px-1 py-1 text-[10px] ${
                    (settings.focusRadiusM ?? 800) === r
                      ? "border-primary/60 bg-primary/15 text-foreground"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {r >= 1000 ? `${r / 1000} km` : `${r} m`}
                </button>
              ))}
            </div>
          )}


          <AutoBathyPanel />

          <SonarImportPanel />

          <div className="flex gap-1">

            {(["pesca", "clasica"] as const).map((p) => (
              <button
                key={p}
                onClick={() => set("palette", p)}
                className={`flex-1 rounded-md border px-2 py-1 text-[11px] ${
                  settings.palette === p
                    ? "border-primary/60 bg-primary/15 text-foreground"
                    : "border-border text-muted-foreground"
                }`}
              >
                {p === "pesca" ? "Paleta pesca" : "Paleta clásica"}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            Transparencia
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={settings.opacity}
              onChange={(e) => set("opacity", parseFloat(e.target.value))}
              className="flex-1 accent-primary"
            />
            <span className="w-8 text-right">{Math.round(settings.opacity * 100)}%</span>
          </label>

          <div className="grid grid-cols-3 gap-1 pt-1">
            <button
              onClick={() => onPickModeChange(pickMode === "info" ? "none" : "info")}
              className={`rounded-md border px-1.5 py-1 text-[11px] ${
                pickMode === "info"
                  ? "border-primary/60 bg-primary/15 text-foreground"
                  : "border-border text-muted-foreground"
              }`}
            >
              Ficha punto
            </button>
            <button
              onClick={() => onPickModeChange(pickMode === "profile" ? "none" : "profile")}
              className={`rounded-md border px-1.5 py-1 text-[11px] ${
                pickMode === "profile"
                  ? "border-primary/60 bg-primary/15 text-foreground"
                  : "border-border text-muted-foreground"
              }`}
            >
              Perfil 2 pts
            </button>
            <button
              onClick={onToggle3d}
              className={`rounded-md border px-1.5 py-1 text-[11px] ${
                show3d
                  ? "border-primary/60 bg-primary/15 text-foreground"
                  : "border-border text-muted-foreground"
              }`}
            >
              Vista 3D
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

