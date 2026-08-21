import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { DateSelector } from "./DateSelector";
import { GpsControl } from "./GpsControl";
import type { GpsPosition } from "./GpsTracker";
import type { GeolocationError } from "../hooks/use-geolocation";
import type { MultiLayerState } from "./MultiLayerPanel";
import type { LayerType } from "./ocean-layers";
import { useSubscriptions } from "../hooks/use-subscriptions";
import type { ModuleId } from "../lib/modules";

const MODE_MODULE: Record<"surface" | "bottom" | "squid" | "drift", ModuleId> = {
  surface: "superficie",
  bottom: "fondo",
  squid: "calamar",
  drift: "deriva",
};



/**
 * Menú lateral profesional estilo app náutica.
 * Reorganiza TODOS los controles dispersos del header en un solo panel
 * compacto, sin tocar lógica ni algoritmos.
 *
 * Secciones:
 *  - CAPAS:        ON/OFF + opacidad para SST, CHL, ALT/corrientes, Batimetría
 *  - MODO PESCA:   Superficie / Fondo
 *  - ZONA CALIENTE: Dibujar triángulo, Analizar, Mostrar Top 1, Borrar
 *  - FECHA:        Selector + estado última disponible
 *  - AJUSTES:      GPS, centrar, limpiar, ayuda
 */
export interface AppMenuProps {
  /** Panel de controles del fondo marino profesional. */
  seafloorPanel?: ReactNode;
  open: boolean;
  onClose: () => void;

  // CAPAS
  multiLayer: MultiLayerState;
  setMultiLayer: (next: MultiLayerState) => void;
  bathyRelief: boolean;
  setBathyRelief: (v: boolean) => void;
  bathyContours: boolean;
  setBathyContours: (v: boolean) => void;
  bathyIntensity: number;
  setBathyIntensity: (v: number) => void;

  // MODO PESCA
  fishingMode: "surface" | "bottom" | "squid" | "drift";
  onFishingModeChange: (mode: "surface" | "bottom" | "squid" | "drift") => void;


  // ZONA CALIENTE
  drawMode: "triangle" | "rect" | "polygon" | null;
  onDrawTriangle: () => void;
  hasSearchArea: boolean;
  hotZoneEnabled: boolean;
  onAnalyzeZone: () => void;
  onShowTop1: () => void;
  onClearZone: () => void;
  spotsLoading: boolean;

  // FECHA
  time: string | undefined;
  onTimeChange: (v: string | undefined) => void;
  resolvedStatus: "probing" | "fallback" | "ok" | "none";
  resolvedDate: string | null | undefined;
  daysBack: number;
  resolvedByLayer: Record<string, string | undefined>;
  layerKeys: { sst: LayerType; chl: LayerType; alt: LayerType };
  onUseLatest: () => void;

  // AJUSTES — GPS
  gpsActive: boolean;
  gpsFollow: boolean;
  gpsPosition: GpsPosition | null;
  gpsTrackLength: number;
  gpsError: GeolocationError | null;
  onToggleGps: () => void;
  onToggleFollow: () => void;
  onRecenterGps: () => void;
  onExportGpx: () => void;
  onClearGpsTrack: () => void;
  onSaveGpsTrack?: () => void;
  savedTracksSection?: ReactNode;
  // AJUSTES — extras
  onCenterMap: () => void;
  onClearMarkers: () => void;

  /** Sección adicional renderizada después de Zona Caliente (Frentes Productivos). */
  extraSection?: ReactNode;
}

function Row({
  enabled,
  onToggle,
  opacity,
  onOpacityChange,
  icon,
  label,
  hint,
  hideOpacity,
  children,
}: {
  enabled: boolean;
  onToggle: () => void;
  opacity?: number;
  onOpacityChange?: (v: number) => void;
  icon: string;
  label: string;
  hint?: string;
  hideOpacity?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-2 transition-colors ${
        enabled ? "border-cyan-400/50 bg-cyan-500/5" : "border-border bg-card/30"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm">{icon}</span>
        <span className="flex-1 truncate text-[11.5px] font-semibold text-foreground">{label}</span>
        <button
          role="switch"
          aria-checked={enabled}
          onClick={onToggle}
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
            enabled ? "border-cyan-400/70 bg-cyan-500/70" : "border-border bg-secondary"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
              enabled ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      {!hideOpacity && opacity !== undefined && onOpacityChange && (
        <div className={`mt-1.5 ${enabled ? "" : "opacity-40 pointer-events-none"}`}>
          <div className="mb-0.5 flex items-center justify-between text-[9.5px] text-muted-foreground">
            <span>Opacidad</span>
            <span className="tabular-nums">{Math.round(opacity * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(opacity * 100)}
            onChange={(e) => onOpacityChange(Number(e.target.value) / 100)}
            className="ocean-slider h-1.5 w-full cursor-pointer"
          />
        </div>
      )}
      {hint && <div className="mt-1 text-[9px] leading-tight text-muted-foreground">{hint}</div>}
      {children}
    </div>
  );
}

/** Fila bloqueada: enlaza a precios en lugar de activar la función. */
function LockedRow({
  icon,
  label,
  hint,
  onClose,
}: {
  icon: string;
  label: string;
  hint: string;
  onClose: () => void;
}) {
  return (
    <Link
      to="/precios"
      onClick={onClose}
      className="flex items-center gap-2 rounded-lg border border-border bg-card/30 px-2.5 py-2 opacity-70 transition-colors hover:bg-secondary/60"
      title="Módulo no contratado · 5 €/mes"
    >
      <span className="text-[11px] font-bold">{icon}</span>
      <span className="flex-1">
        <span className="block text-[11.5px] font-semibold text-foreground">{label}</span>
        <span className="block text-[10px] leading-snug text-muted-foreground">{hint}</span>
      </span>
      <span className="text-[11px]">🔒</span>
    </Link>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-3 mb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-cyan-300/80">
      {children}
    </h3>
  );
}

/** Sección plegable del menú: cabecera con icono, título, resumen y contenido. */
function Section({
  id,
  icon,
  title,
  summary,
  openIds,
  toggle,
  children,
}: {
  id: string;
  icon: string;
  title: string;
  summary?: string;
  openIds: Record<string, boolean>;
  toggle: (id: string) => void;
  children: React.ReactNode;
}) {
  const open = !!openIds[id];
  return (
    <section className="mb-2 overflow-hidden rounded-xl border border-border/70 bg-card/25">
      <button
        type="button"
        onClick={() => toggle(id)}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors ${
          open ? "bg-cyan-500/10" : "hover:bg-secondary/40"
        }`}
      >
        <span className="text-[13px] leading-none">{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[11px] font-bold uppercase tracking-[0.1em] text-cyan-100">
            {title}
          </span>
          {summary && (
            <span className="block truncate text-[9.5px] leading-tight text-muted-foreground">
              {summary}
            </span>
          )}
        </span>
        <span
          className={`text-[10px] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▶
        </span>
      </button>
      {open && <div className="border-t border-border/60 px-2.5 py-2">{children}</div>}
    </section>
  );
}


export function AppMenu(props: AppMenuProps) {
  const { open, onClose } = props;
  const { hasModule, hasAny } = useSubscriptions();
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({
    modo: true,
    capas: true,
  });
  const toggle = (id: string) =>
    setOpenIds((prev) => ({ ...prev, [id]: !prev[id] }));




  // Cerrar con ESC
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Helper: formato fecha corto
  const fmtDate = (iso?: string | null) => {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
  };

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden={!open}
        onClick={onClose}
        className={`pointer-events-${open ? "auto" : "none"} fixed inset-0 z-[1190] bg-black/40 backdrop-blur-[1px] transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      {/* Drawer */}
      <aside
        role="dialog"
        aria-label="Menú principal"
        aria-hidden={!open}
        data-app-menu-open={open ? "true" : "false"}
        className={`fixed top-0 right-0 z-[1200] flex h-full w-[75vw] max-w-[320px] flex-col border-l border-cyan-500/30 bg-black/92 text-foreground shadow-[0_0_30px_rgba(0,0,0,0.6)] backdrop-blur-md transition-transform duration-250 ease-out sm:w-72 sm:max-w-none ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        style={{ pointerEvents: open ? "auto" : "none" }}
      >
        {/* Header del menú */}
        <div className="flex items-center justify-between gap-2 border-b border-cyan-500/20 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-base">🛰️</span>
            <span className="text-xs font-bold tracking-tight text-cyan-100">Hotspot Fishing</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar menú"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-card/40 text-foreground hover:bg-secondary"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {/* ───────────── FRENTES PRODUCTIVOS ───────────── */}
          {props.extraSection && (
            <Section
              id="frentes"
              icon="🌐"
              title="Frentes productivos"
              summary="Gradientes y zonas de convergencia"
              openIds={openIds}
              toggle={toggle}
            >
              {props.extraSection}
            </Section>
          )}

          {/* ───────────── MODO DE PESCA ───────────── */}
          <Section
            id="modo"
            icon="🎣"
            title="Modo de pesca"
            summary="Fondo · Calamar · Altura · Deriva"
            openIds={openIds}
            toggle={toggle}
          >
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  { id: "bottom", emoji: "🎣", label: "Fondo", active: "border-amber-400 bg-amber-600/80 text-white shadow-[0_0_10px_rgba(245,158,11,0.4)]" },
                  { id: "squid", emoji: "🦑", label: "Calamar", active: "border-fuchsia-400 bg-fuchsia-600/80 text-white shadow-[0_0_10px_rgba(217,70,239,0.4)]" },
                  { id: "surface", emoji: "🌊", label: "Altura", active: "border-cyan-400 bg-cyan-500/80 text-white shadow-[0_0_10px_rgba(6,182,212,0.4)]" },
                  { id: "drift", emoji: "🚤", label: "Deriva", active: "border-emerald-400 bg-emerald-600/80 text-white shadow-[0_0_10px_rgba(16,185,129,0.4)]" },
                ] as const
              ).map((m) => {
                const unlocked = hasModule(MODE_MODULE[m.id]);
                const selected = props.fishingMode === m.id;
                const cls = `relative flex flex-col items-center gap-0.5 rounded-lg border px-2 py-2 text-[11px] font-bold uppercase tracking-wide transition-all ${
                  selected && unlocked
                    ? m.active
                    : "border-border bg-card/40 text-muted-foreground hover:bg-secondary/60"
                } ${unlocked ? "" : "opacity-60"}`;
                if (!unlocked) {
                  return (
                    <Link key={m.id} to="/precios" onClick={onClose} className={cls} title="Módulo no contratado · 5 €/mes">
                      <span className="text-base">{m.emoji}</span>
                      <span>{m.label}</span>
                      <span className="absolute right-1 top-1 text-[10px]">🔒</span>
                    </Link>
                  );
                }
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => props.onFishingModeChange(m.id)}
                    className={cls}
                    title={
                      m.id === "squid"
                        ? "Potera: 30–150 m, fondos mixtos"
                        : m.id === "drift"
                          ? "Fluixa: deriva en bahías y costa (8–60 m)"
                          : m.id === "surface"
                            ? "Pesca de altura: atún, albacora, bacoreta, llampuga"
                            : undefined
                    }
                  >
                    <span className="text-base">{m.emoji}</span>
                    <span>{m.label}</span>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* ───────────── CAPAS ───────────── */}
          <Section
            id="capas"
            icon="🗂️"
            title="Capas del mapa"
            summary="Temperatura, clorofila, altimetría, corrientes"
            openIds={openIds}
            toggle={toggle}
          >
          <button
            type="button"
            onClick={() =>
              props.setMultiLayer({
                ...props.multiLayer,
                sst: { ...props.multiLayer.sst, enabled: false },
                chlorophyll: { ...props.multiLayer.chlorophyll, enabled: false },
                altimetry: { ...props.multiLayer.altimetry, enabled: true, opacity: 1 },
                streamlines: { ...props.multiLayer.streamlines, enabled: true },
              })
            }
            className="mb-2 flex w-full items-center justify-between gap-2 rounded-lg border border-fuchsia-400/60 bg-fuchsia-500/15 px-2.5 py-2 text-[11.5px] font-semibold text-fuchsia-100 transition-all hover:bg-fuchsia-500/30"
            title="Apaga SST y CHL y muestra solo ADT + corrientes para ver con claridad la altimetría"
          >
            <span>🎯 Solo Altimetría</span>
            <span className="text-[9px] uppercase tracking-wider text-fuchsia-200/80">
              ADT puro
            </span>
          </button>
          <div className="flex flex-col gap-1.5">
            <Row
              icon="🌡️"
              label="SST · Temperatura"
              enabled={props.multiLayer.sst.enabled}
              onToggle={() =>
                props.setMultiLayer({
                  ...props.multiLayer,
                  sst: { ...props.multiLayer.sst, enabled: !props.multiLayer.sst.enabled },
                })
              }
              opacity={props.multiLayer.sst.opacity}
              onOpacityChange={(v) =>
                props.setMultiLayer({
                  ...props.multiLayer,
                  sst: { ...props.multiLayer.sst, opacity: v },
                })
              }
            >
              <div
                className={`mt-3 rounded-lg border border-cyan-300/70 bg-cyan-400/12 p-2.5 shadow-[0_0_14px_rgba(6,182,212,0.3)] ${props.multiLayer.sst.enabled ? "" : "opacity-55"}`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-black uppercase tracking-[0.13em] text-cyan-50">
                    Modo mezcla SST
                  </span>
                  <span className="rounded-full border border-cyan-300/60 bg-cyan-300/20 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-cyan-50">
                    {props.multiLayer.sstBlendMode ?? "hue"}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { key: "hue", label: "Tono" },
                      { key: "normal", label: "Normal" },
                      { key: "multiply", label: "Multiply" },
                    ] as const
                  ).map((m) => {
                    const active = (props.multiLayer.sstBlendMode ?? "hue") === m.key;
                    return (
                      <button
                        key={m.key}
                        type="button"
                        disabled={!props.multiLayer.sst.enabled}
                        onClick={() =>
                          props.setMultiLayer({ ...props.multiLayer, sstBlendMode: m.key })
                        }
                        className={`h-12 rounded-lg border text-[12px] font-black transition-colors disabled:cursor-not-allowed ${
                          active
                            ? "border-cyan-100 bg-cyan-300 text-black shadow-[0_0_12px_rgba(103,232,249,0.55)]"
                            : "border-cyan-500/60 bg-black/55 text-cyan-50 hover:bg-cyan-400/15"
                        }`}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div
                className={`mt-2 rounded-lg border border-orange-300/60 bg-orange-500/10 p-2.5 ${props.multiLayer.sst.enabled ? "" : "opacity-55"}`}
              >
                <div className="mb-1 text-[11px] font-black uppercase tracking-[0.13em] text-orange-100">
                  Profundidad de temperatura
                </div>
                <div className="grid grid-cols-4 gap-1">
                  {([
                    { value: "sst_nrt" as LayerType, label: "Sup." },
                    { value: "sst_d10" as LayerType, label: "10 m" },
                    { value: "sst_d20" as LayerType, label: "20 m" },
                    { value: "sst_d30" as LayerType, label: "30 m" },
                    { value: "sst_d50" as LayerType, label: "50 m" },
                    { value: "sst_d100" as LayerType, label: "100 m" },
                    { value: "sst_bottom" as LayerType, label: "Fondo" },
                  ]).map((d) => {
                    const active = props.multiLayer.sst.layer === d.value;
                    return (
                      <button
                        key={d.value}
                        type="button"
                        disabled={!props.multiLayer.sst.enabled}
                        onClick={() =>
                          props.setMultiLayer({
                            ...props.multiLayer,
                            sst: { ...props.multiLayer.sst, layer: d.value, enabled: true },
                          })
                        }
                        className={`h-9 rounded-md border text-[11px] font-black transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          active
                            ? "border-orange-100 bg-orange-300 text-black shadow-[0_0_10px_rgba(251,146,60,0.55)]"
                            : "border-orange-500/60 bg-black/55 text-orange-50 hover:bg-orange-400/15"
                        }`}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[10px] leading-snug text-orange-100/80">
                  {props.multiLayer.sst.layer === "sst_bottom"
                    ? "T del fondo real (Copernicus MEDSEA 4 km, bottomT)."
                    : props.multiLayer.sst.layer === "sst_nrt" || props.multiLayer.sst.layer === "sst_nrt_hc" || props.multiLayer.sst.layer === "sst_analysed" || props.multiLayer.sst.layer === "sst_skin"
                      ? "SST superficial (Copernicus HR 1 km)."
                      : "T a profundidad (MEDSEA 4 km, thetao) — sólo Mediterráneo."}
                </p>
              </div>
            </Row>
            <Row
              icon="🌿"
              label="CHL · Clorofila"
              enabled={props.multiLayer.chlorophyll.enabled}
              onToggle={() =>
                props.setMultiLayer({
                  ...props.multiLayer,
                  chlorophyll: {
                    ...props.multiLayer.chlorophyll,
                    enabled: !props.multiLayer.chlorophyll.enabled,
                  },
                })
              }
              opacity={props.multiLayer.chlorophyll.opacity}
              onOpacityChange={(v) =>
                props.setMultiLayer({
                  ...props.multiLayer,
                  chlorophyll: { ...props.multiLayer.chlorophyll, opacity: v },
                })
              }
            />
            <Row
              icon="🌀"
              label="ALT · Altimetría"
              enabled={props.multiLayer.altimetry.enabled}
              onToggle={() =>
                props.setMultiLayer({
                  ...props.multiLayer,
                  altimetry: {
                    ...props.multiLayer.altimetry,
                    enabled: !props.multiLayer.altimetry.enabled,
                  },
                })
              }
              opacity={props.multiLayer.altimetry.opacity}
              onOpacityChange={(v) =>
                props.setMultiLayer({
                  ...props.multiLayer,
                  altimetry: { ...props.multiLayer.altimetry, opacity: v },
                })
              }
            />
            <Row
              icon="➰"
              label="Corrientes"
              enabled={props.multiLayer.streamlines.enabled}
              onToggle={() =>
                props.setMultiLayer({
                  ...props.multiLayer,
                  streamlines: {
                    ...props.multiLayer.streamlines,
                    enabled: !props.multiLayer.streamlines.enabled,
                  },
                })
              }
              opacity={props.multiLayer.streamlines.opacity}
              onOpacityChange={(v) =>
                props.setMultiLayer({
                  ...props.multiLayer,
                  streamlines: { ...props.multiLayer.streamlines, opacity: v },
                })
              }
            />
            {props.multiLayer.streamlines.enabled && (
              <div className="rounded-lg border border-border/60 bg-card/40 p-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Profundidad de las corrientes
                </div>
                <div className="grid grid-cols-4 gap-1">
                  {([
                    { value: "surface", label: "Sup." },
                    { value: 10, label: "10 m" },
                    { value: 20, label: "20 m" },
                    { value: 30, label: "30 m" },
                    { value: 50, label: "50 m" },
                    { value: 100, label: "100 m" },
                    { value: "bottom", label: "Fondo" },
                  ] as { value: "surface" | 10 | 20 | 30 | 50 | 100 | "bottom"; label: string }[]).map((d) => {
                    const active = (props.multiLayer.streamlines.depth ?? "surface") === d.value;
                    return (
                      <button
                        key={String(d.value)}
                        onClick={() =>
                          props.setMultiLayer({
                            ...props.multiLayer,
                            streamlines: { ...props.multiLayer.streamlines, depth: d.value },
                          })
                        }
                        className={`rounded-md px-1 py-1.5 text-[10px] font-semibold transition-colors ${
                          active
                            ? "bg-accent/80 text-accent-foreground"
                            : "bg-secondary text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
                        }`}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
                  {(props.multiLayer.streamlines.depth ?? "surface") === "surface"
                    ? "Superficie: corrientes geostróficas globales."
                    : (props.multiLayer.streamlines.depth === "bottom")
                      ? "Fondo (MEDSEA 4 km): uo/vo cerca del sedimento — sólo Mediterráneo."
                      : `${props.multiLayer.streamlines.depth} m (MEDSEA 4 km) — sólo Mediterráneo.`}
                </p>
              </div>
            )}
            {hasModule("superficie") ? (
              <Row
                icon="FSLE"
                label="FSLE · Líneas de convergencia"
                enabled={!!props.multiLayer.fsle?.enabled}
                onToggle={() =>
                  props.setMultiLayer({
                    ...props.multiLayer,
                    fsle: { enabled: !props.multiLayer.fsle?.enabled },
                  })
                }
                hideOpacity
                hint="Líneas finas y transparentes para frentes, filamentos y concentración de alimento."
              />
            ) : (
              <LockedRow
                icon="FSLE"
                label="FSLE · Líneas de convergencia"
                hint="Incluido en Pesca de Superficie · 5 €/mes"
                onClose={onClose}
              />
            )}

            <Row
              icon="🗻"
              label="Batimetría"
              enabled={props.bathyRelief || props.bathyContours}
              onToggle={() => {
                const on = !(props.bathyRelief || props.bathyContours);
                props.setBathyRelief(on);
                props.setBathyContours(on);
              }}
              opacity={props.bathyIntensity}
              onOpacityChange={props.setBathyIntensity}
              hint="Relieve + isobatas del fondo"
            />
          </div>
          </Section>

          {/* ───────────── FONDO MARINO PROFESIONAL ───────────── */}
          {props.seafloorPanel && (
            <Section
              id="fondo"
              icon="🗺️"
              title="Fondo marino"
              summary="Relieve, veriles y vista 3D"
              openIds={openIds}
              toggle={toggle}
            >
              {hasModule("fondo") ? (
                props.seafloorPanel
              ) : (
                <LockedRow
                  icon="🗺"
                  label="Fondo marino profesional"
                  hint="Incluido en Pesca de Fondo · 5 €/mes"
                  onClose={onClose}
                />
              )}
            </Section>
          )}


          {/* ───────────── ZONA CALIENTE ───────────── */}
          <Section
            id="zona"
            icon="🔥"
            title="Zona caliente"
            summary="Dibujar, analizar y ver el mejor punto"
            openIds={openIds}
            toggle={toggle}
          >
          <div className="flex flex-col gap-1.5">
            {hasAny ? (
              <button
                type="button"
                onClick={props.onDrawTriangle}
                className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-[11.5px] font-semibold transition-all ${
                  props.drawMode === "triangle"
                    ? "border-cyan-400 bg-cyan-600/80 text-white"
                    : "border-border bg-card/40 text-foreground hover:bg-secondary/60"
                }`}
              >
                <span>△ Dibujar triángulo</span>
                {props.drawMode === "triangle" && <span className="text-[10px]">3 clics…</span>}
              </button>
            ) : (
              <LockedRow
                icon="△"
                label="Dibujar triángulo"
                hint="Requiere un módulo activo · 5 €/mes"
                onClose={onClose}
              />
            )}
            <button
              type="button"
              onClick={props.onAnalyzeZone}
              disabled={props.spotsLoading}
              className="flex items-center justify-between gap-2 rounded-lg border border-orange-400/60 bg-orange-500/15 px-2.5 py-2 text-[11.5px] font-semibold text-foreground transition-all hover:bg-orange-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span>🔍 Analizar zona</span>
              {props.spotsLoading && (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              )}
            </button>
            <button
              type="button"
              onClick={props.onShowTop1}
              className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-[11.5px] font-semibold transition-all ${
                props.hotZoneEnabled
                  ? "border-amber-400 bg-amber-500/30 text-white shadow-[0_0_10px_rgba(245,158,11,0.4)]"
                  : "border-border bg-card/40 text-foreground hover:bg-secondary/60"
              }`}
            >
              <span>🏆 Mostrar Top 1</span>
              {props.hotZoneEnabled && <span className="text-[10px]">ON</span>}
            </button>
            <button
              type="button"
              onClick={props.onClearZone}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/40 px-2.5 py-2 text-[11.5px] font-semibold text-foreground transition-all hover:border-red-500/60 hover:bg-red-600/20"
            >
              <span>✕ Borrar zona</span>
            </button>
          </div>
          </Section>

          {/* ───────────── FECHA ───────────── */}
          <Section
            id="fecha"
            icon="📅"
            title="Fecha de los datos"
            summary="Día mostrado y última disponibilidad"
            openIds={openIds}
            toggle={toggle}
          >
          <div className="rounded-lg border border-border bg-card/40 p-2">
            <DateSelector value={props.time} onChange={(value) => props.onTimeChange(value)} />
            <div className="mt-2 space-y-0.5 border-t border-border/60 pt-1.5 text-[10px] font-mono">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">SST:</span>
                <span className="tabular-nums text-cyan-200">
                  {fmtDate(props.resolvedByLayer[props.layerKeys.sst])}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">CHL:</span>
                <span className="tabular-nums text-cyan-200">
                  {fmtDate(props.resolvedByLayer[props.layerKeys.chl])}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">ALT:</span>
                <span className="tabular-nums text-cyan-200">
                  {fmtDate(props.resolvedByLayer[props.layerKeys.alt])}
                </span>
              </div>
              {props.daysBack > 0 && (
                <div className="text-[9px] text-amber-300">
                  Último dato: −{props.daysBack} día(s)
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={props.onUseLatest}
              disabled={props.resolvedStatus === "probing"}
              className="mt-2 w-full rounded-md border border-cyan-500/50 bg-cyan-500/10 px-2 py-1.5 text-[10.5px] font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50"
            >
              {props.resolvedStatus === "probing" ? "Buscando…" : "↻ Usar último dato disponible"}
            </button>
          </div>
          </Section>

          {/* ───────────── NAVEGACIÓN / GPS ───────────── */}
          <Section
            id="gps"
            icon="🛥️"
            title="Navegación y GPS"
            summary="Posición, rumbo y tracks guardados"
            openIds={openIds}
            toggle={toggle}
          >
            <div className="rounded-lg border border-border bg-card/30 p-1.5">
              <GpsControl
                active={props.gpsActive}
                follow={props.gpsFollow}
                position={props.gpsPosition}
                trackLength={props.gpsTrackLength}
                error={props.gpsError}
                onToggleGps={props.onToggleGps}
                onToggleFollow={props.onToggleFollow}
                onRecenter={props.onRecenterGps}
                onExportGpx={props.onExportGpx}
                onClearTrack={props.onClearGpsTrack}
                onSaveTrack={props.onSaveGpsTrack}
              />
            </div>
            {props.savedTracksSection && (
              <>
                <SectionTitle>Tracks guardados</SectionTitle>
                {props.savedTracksSection}
              </>
            )}
          </Section>

          {/* ───────────── HERRAMIENTAS Y CUENTA ───────────── */}
          <Section
            id="cuenta"
            icon="⚙️"
            title="Herramientas y cuenta"
            summary="Mapa, guía, planes y perfil"
            openIds={openIds}
            toggle={toggle}
          >
          <div className="grid grid-cols-1 gap-1.5">
            <button
              type="button"
              onClick={props.onCenterMap}
              className="flex items-center gap-2 rounded-lg border border-border bg-card/40 px-2.5 py-2 text-[11.5px] font-medium text-foreground hover:bg-secondary/60"
            >
              <span>🎯</span>
              <span>Centrar mapa</span>
            </button>
            <button
              type="button"
              onClick={props.onClearMarkers}
              className="flex items-center gap-2 rounded-lg border border-border bg-card/40 px-2.5 py-2 text-[11.5px] font-medium text-foreground hover:border-red-500/60 hover:bg-red-600/20"
            >
              <span>🧹</span>
              <span>Limpiar marcadores</span>
            </button>
            <Link
              to="/guia"
              onClick={props.onClose}
              className="flex items-center gap-2 rounded-lg border border-cyan-400/40 bg-cyan-500/10 px-2.5 py-2 text-[11.5px] font-semibold text-cyan-100 hover:bg-cyan-500/20"
            >
              <span>📘</span>
              <span>Guía de la aplicación</span>
            </Link>
            <Link
              to="/precios"
              onClick={props.onClose}
              className="flex items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2.5 py-2 text-[11.5px] font-semibold text-amber-100 hover:bg-amber-500/20"
            >
              <span>⭐</span>
              <span>Planes y suscripción</span>
            </Link>
            <Link
              to="/cuenta"
              onClick={props.onClose}
              className="flex items-center gap-2 rounded-lg border border-border bg-card/40 px-2.5 py-2 text-[11.5px] font-medium text-foreground hover:bg-secondary"
            >
              <span>👤</span>
              <span>Mi cuenta</span>
            </Link>
          </div>
          </Section>

          <div className="h-4" />
        </div>

        <div className="border-t border-border/40 px-3 py-1.5 text-center text-[9px] text-muted-foreground">
          Datos: E.U. Copernicus Marine Service
        </div>
      </aside>
    </>
  );
}

