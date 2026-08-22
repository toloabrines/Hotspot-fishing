/**
 * «¿Dónde pesco hoy?» — asesor IA guiado por modalidad.
 *
 * Flujo: el cliente solo elige el tipo de pesca. La app recalcula todo con el
 * motor de esa modalidad, marca el Top 1 en la carta (mismo marcador de
 * siempre), centra el mapa y la IA explica por qué.
 *
 * La IA NO calcula nada: recibe los hotspots reales ya calculados por la app
 * (coordenadas, puntuación, profundidad y motivos) y solo elige y explica.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { askFishingAdvisor } from "../lib/ai-advisor.functions";
import {
  ADVISOR_MODE_LABEL,
  compassLabel,
  distanceNm,
  type AdvisorChoice,
  type AdvisorMode,
  type AdvisorPlanSpot,
  type AdvisorResponse,
  type AdvisorSpot,
} from "../lib/ai-advisor";
import { toDegMinSec, type FishingSpot } from "./FishingHotspots.types";
import { driftVector } from "../lib/drift-corridor";
import AiFishingChat from "./AiFishingChat";


interface Props {
  mode: AdvisorMode;
  spots: FishingSpot[];
  gps: { lat: number; lng: number } | null;
  dataDateIso: string | null;
  wind: { avgKn: number; gustKn: number; dirDeg: number } | null;
  current: { avgKn: number; dirDeg: number } | null;
  pressureHpa: number | null;
  pressureTrend: string | null;
  sstC?: number | null;
  activeLayers: string[];
  fsleActive: boolean;
  /** true mientras la app recalcula los hotspots de la modalidad elegida. */
  analyzing: boolean;
  /** true mientras el usuario está marcando los 3 puntos del triángulo. */
  drawing: boolean;
  /** true cuando ya hay un triángulo/zona de búsqueda definida. */
  hasSearchArea: boolean;
  /** Pide al usuario dibujar (o redibujar) el triángulo de búsqueda. */
  onRequestDrawArea: () => void;
  /** Borra el triángulo actual. */
  onClearArea: () => void;
  /** Cambia la modalidad y relanza TODO el análisis de la app. */
  onSelectMode: (mode: AdvisorMode) => void;
  onFlyTo: (lat: number, lng: number) => void;
  /** La IA marca Top 1/2/3, polígonos y deriva sobre la carta. */
  onPlan?: (plan: AdvisorPlanSpot[]) => void;
  /** Abre el registro de captura para un punto recomendado. */
  onLogCatch?: (spot: { lat: number; lng: number; depthM: number | null }) => void;
  onClose: () => void;
}


const MODE_BUTTONS: Array<{ mode: AdvisorMode; emoji: string; label: string }> = [
  { mode: "surface", emoji: "🌊", label: "Pesca de altura" },
  { mode: "bottom", emoji: "🪨", label: "Pesca de fondo" },
  { mode: "squid", emoji: "🦑", label: "Calamar" },
  { mode: "drift", emoji: "🎣", label: "Pesca a la deriva (fluixa)" },
];

/** Rumbo verdadero desde el barco hasta el punto. */
function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

export default function AiFishingAdvisor({
  mode,
  spots,
  gps,
  dataDateIso,
  wind,
  current,
  pressureHpa,
  pressureTrend,
  sstC = null,
  activeLayers,
  fsleActive,
  analyzing,
  drawing,
  hasSearchArea,
  onRequestDrawArea,
  onClearArea,
  onSelectMode,

  onFlyTo,
  onPlan,
  onLogCatch,
  onClose,
}: Props) {
  const ask = useServerFn(askFishingAdvisor);
  const [tab, setTab] = useState<"chat" | "quick">("chat");
  const [minimized, setMinimized] = useState(false);
  const [chosenMode, setChosenMode] = useState<AdvisorMode | null>(null);


  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<AdvisorResponse | null>(null);
  const [showSecond, setShowSecond] = useState(false);
  const [copied, setCopied] = useState(false);

  const advisorSpots = useMemo<AdvisorSpot[]>(
    () =>
      spots
        .slice()
        .sort((a, b) => b.score - a.score)
        .map((s, i) => ({
          id: s.id,
          rank: s.rank ?? i + 1,
          lat: s.lat,
          lng: s.lng,
          scorePct: Math.round(s.score * 100),
          depthM: s.depth,
          distanceNm: gps ? distanceNm(gps, s) : null,
          reason: s.reason,
          // Valores medidos en la coordenada exacta del hotspot (no del cursor).
          sstC: s.sstC ?? null,
          chlMgM3: s.chlMgM3 ?? null,
          adtM: s.adtM ?? null,
          currentKn: s.currentKn ?? null,
          bottomTempC: s.bottomTempC ?? null,
        }))
        .slice(0, 12),
    [spots, gps],
  );

  const run = useCallback(
    async (runMode: AdvisorMode, list: AdvisorSpot[]) => {
      setLoading(true);
      setShowSecond(false);
      setRes(null);
      try {
        const out = await ask({
          data: {
            mode: runMode,
            species: null,
            whenIso: new Date().toISOString(),
            dataDateIso,
            user: gps,
            maxDistanceNm: null,
            spots: list,
            env: {
              windKn: wind?.avgKn ?? null,
              windGustKn: wind?.gustKn ?? null,
              windDirDeg: wind?.dirDeg ?? null,
              currentKn: current?.avgKn ?? null,
              currentDirDeg: current?.dirDeg ?? null,
              pressureHpa,
              pressureTrend,
              sstC,
              bottomTempC: null,
              chlMgM3: null,
              fsleActive,
              activeLayers,
            },
          },
        });
        setRes(out);
        const top = list.find((s) => s.id === out.answer?.primary.spotId) ?? list[0];
        if (out.ok && top) onFlyTo(top.lat, top.lng);
      } catch {
        setRes({
          ok: false,
          answer: null,
          code: "provider_error",
          message: "No se pudo completar la consulta. Revisa tu conexión e inténtalo de nuevo.",
          usedToday: 0,
          dailyLimit: 10,
        });
      } finally {
        setLoading(false);
      }
    },
    [
      ask,
      dataDateIso,
      gps,
      wind,
      current,
      pressureHpa,
      pressureTrend,
      sstC,
      fsleActive,
      activeLayers,
      onFlyTo,
    ],
  );

  // Flujo: modalidad → triángulo (3 clics) → análisis de la app → IA.
  const [pending, setPending] = useState(false);
  const [armed, setArmed] = useState(false);

  // Cuando el triángulo queda cerrado, armamos la espera del recálculo.
  useEffect(() => {
    if (!chosenMode || !pending || drawing || !hasSearchArea) return;
    if (armed) return;
    const t = setTimeout(() => setArmed(true), 1200);
    return () => clearTimeout(t);
  }, [chosenMode, pending, drawing, hasSearchArea, armed]);

  // Cuando la app termina de recalcular con la modalidad elegida, lanzamos la IA
  // automáticamente una sola vez.
  useEffect(() => {
    if (!chosenMode || !pending || !armed) return;
    if (drawing || !hasSearchArea) return;
    if (analyzing || mode !== chosenMode) return;
    if (advisorSpots.length === 0) return;
    setPending(false);
    void run(chosenMode, advisorSpots);
  }, [chosenMode, pending, armed, drawing, hasSearchArea, analyzing, mode, advisorSpots, run]);

  const startFlow = useCallback(
    (m: AdvisorMode) => {
      setRes(null);
      setChosenMode(m);
      setPending(true);
      setArmed(false);
      onSelectMode(m);
      // Siempre pedimos triángulo nuevo antes de calcular.
      onRequestDrawArea();
    },
    [onSelectMode, onRequestDrawArea],
  );

  const pickMode = startFlow;

  const redrawArea = useCallback(() => {
    if (!chosenMode) return;
    setRes(null);
    setPending(true);
    setArmed(false);
    onRequestDrawArea();
  }, [chosenMode, onRequestDrawArea]);

  const deleteArea = useCallback(() => {
    setRes(null);
    setPending(false);
    setArmed(false);
    onClearArea();
  }, [onClearArea]);


  const choice: AdvisorChoice | null = res?.answer
    ? showSecond && res.answer.secondary
      ? res.answer.secondary
      : res.answer.primary
    : null;
  const spot = choice ? (advisorSpots.find((s) => s.id === choice.spotId) ?? null) : null;

  // Punto de inicio de la pasada (solo deriva/fluixa), con el módulo real
  // de deriva de la app: corriente + 3 % del viento.
  const driftStart = useMemo(() => {
    if (chosenMode !== "drift" || !spot) return null;
    const v = driftVector({
      currentSpeedMs: current ? current.avgKn / 1.94384 : null,
      // current.dirDeg es procedencia; driftVector espera sentido del flujo.
      currentDirDeg: current?.dirDeg != null ? (current.dirDeg + 180) % 360 : null,
      windKn: wind?.avgKn ?? null,
      windFromDeg: wind?.dirDeg ?? null,
    });
    if (!v || v.kn < 0.05) return null;
    const nm = v.kn * 0.25;
    const upwind = (v.dirDeg + 180) % 360;
    const r = (upwind * Math.PI) / 180;
    const dLat = (nm / 60) * Math.cos(r);
    const dLng = ((nm / 60) * Math.sin(r)) / Math.cos((spot.lat * Math.PI) / 180);
    return { lat: spot.lat + dLat, lng: spot.lng + dLng, kn: v.kn, dirDeg: v.dirDeg };
  }, [chosenMode, spot, current, wind]);

  const copyCoords = useCallback(() => {
    if (!spot) return;
    void navigator.clipboard?.writeText(`${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [spot]);

  const busy = loading || (chosenMode != null && !drawing && (analyzing || pending));

  // Escape cierra el asistente siempre, aunque algo quede por encima.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Importante: NO desmontamos el panel al minimizar ni al dibujar el triángulo,
  // solo lo ocultamos. Así la conversación con la IA se mantiene entera.
  const hiddenPanel = drawing || minimized;

  // Mientras el asistente está visible ocultamos los paneles flotantes del
  // mapa (lectura oceanográfica, popups, controles, botones) para que nada
  // se superponga. Se restauran al cerrar o contraer.
  useEffect(() => {
    if (hiddenPanel) return;
    document.body.classList.add("ai-advisor-active");
    document
      .querySelectorAll(".leaflet-popup-close-button")
      .forEach((el) => (el as HTMLElement).click());
    return () => {
      document.body.classList.remove("ai-advisor-active");
    };
  }, [hiddenPanel]);




  return (
    <>
      {drawing && (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-[2400] flex justify-center px-3">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-cyan-400/60 bg-card/95 px-3 py-1.5 text-xs font-semibold text-card-foreground shadow-lg">
            △ Marca 3 puntos en la carta
            <button
              onClick={deleteArea}
              className="rounded-full px-2 py-0.5 text-[11px] font-normal text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {!drawing && minimized && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[2400] flex justify-center px-3">
          <button
            onClick={() => setMinimized(false)}
            className="pointer-events-auto flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg active:scale-95"
          >
            <span>💬</span>
            <span>Asistente de pesca</span>
            <span className="rounded-full bg-primary-foreground/20 px-1.5 py-0.5 text-[10px]">▲</span>
          </button>
        </div>
      )}

    <div
      className={`${hiddenPanel ? "hidden" : "flex"} pointer-events-none fixed inset-0 z-[2400] items-end justify-center sm:items-center`}
    >
      {/* Cierre siempre accesible, por encima de cualquier cosa */}
      <button
        onClick={onClose}
        aria-label="Cerrar asistente"
        className="pointer-events-auto fixed right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[2450] flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-card-foreground shadow-xl active:scale-95"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>
      </button>

      <div className="pointer-events-auto flex h-[100dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-card text-card-foreground shadow-2xl sm:h-auto sm:max-h-[92vh] sm:max-w-lg sm:rounded-2xl">

        {/* Header fijo con controles siempre visibles */}
        <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:pt-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-lg">🤖</div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold leading-tight">La IA analiza el mar por ti</h2>
              <p className="truncate text-xs text-muted-foreground">
                {chosenMode
                  ? ADVISOR_MODE_LABEL[chosenMode]
                  : "Elige la modalidad y la app hace el resto"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMinimized(true)}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground hover:bg-muted/80"
              aria-label="Contraer"
              title="Contraer"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/></svg>
            </button>
            <button
              onClick={onClose}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground hover:bg-muted/80"
              aria-label="Cerrar"
              title="Cerrar"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>
            </button>
          </div>
        </div>


        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-4">

        <div className="mb-3 flex gap-1 rounded-lg border border-border bg-muted/30 p-1">
          {(
            [
              { id: "chat", label: "💬 Asistente" },
              { id: "quick", label: "⚡ Top 1 rápido" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold ${
                tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "chat" ? (
          <AiFishingChat
            mode={mode}
            spots={advisorSpots}
            gps={gps}
            dataDateIso={dataDateIso}
            wind={wind}
            current={current}
            pressureHpa={pressureHpa}
            pressureTrend={pressureTrend}
            sstC={sstC}
            activeLayers={activeLayers}
            fsleActive={fsleActive}
            analyzing={analyzing}
            hasSearchArea={hasSearchArea}
            onRequestDrawArea={onRequestDrawArea}
            onSelectMode={onSelectMode}
            onFlyTo={onFlyTo}
            onPlan={onPlan}
            onLogCatch={onLogCatch}
          />
        ) : (
          <>

        <p className="text-sm font-medium">¿Qué tipo de pesca vas a realizar hoy?</p>

        <div className="mt-2 grid grid-cols-2 gap-2">
          {MODE_BUTTONS.map((b) => (
            <button
              key={b.mode}
              onClick={() => pickMode(b.mode)}
              disabled={busy}
              className={`rounded-lg border px-3 py-2.5 text-left text-sm font-semibold transition-colors disabled:opacity-60 ${
                chosenMode === b.mode
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-muted/40 hover:bg-muted"
              }`}
            >
              <span className="mr-1">{b.emoji}</span>
              {b.label}
            </button>
          ))}
        </div>

        {chosenMode && (
          <div className="mt-3 rounded-lg border border-border bg-muted/20 p-2">
            <div className="text-xs font-semibold">
              {hasSearchArea
                ? "△ Triángulo de búsqueda activo — el análisis usa solo su interior"
                : "△ Marca 3 puntos en la carta para definir la zona de búsqueda"}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                onClick={redrawArea}
                className="rounded-md border border-border px-3 py-1.5 text-xs"
              >
                {hasSearchArea ? "✏️ Redibujar triángulo" : "△ Dibujar triángulo"}
              </button>
              {hasSearchArea && (
                <button
                  onClick={deleteArea}
                  className="rounded-md border border-border px-3 py-1.5 text-xs"
                >
                  🗑 Borrar triángulo
                </button>
              )}
            </div>
          </div>
        )}

        {busy && (
          <p className="mt-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
            {analyzing || pending
              ? "Actualizando datos y calculando el Top 1 dentro del triángulo…"
              : "La IA está analizando los datos reales…"}
          </p>
        )}

        {!busy && chosenMode && !res && hasSearchArea && advisorSpots.length === 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            No hay hotspots dentro del triángulo. Redibújalo más amplio o sobre otra zona.
          </p>
        )}


        {res && !res.ok && (
          <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            {res.message}
          </div>
        )}

        {res?.ok && choice && spot && (
          <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3">
            <div className="text-sm font-semibold">
              {showSecond ? "Segunda opción" : "Yo iría a pescar aquí"}
            </div>

            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <div className="col-span-2 font-medium">Hotspot Top {spot.rank}</div>
              <div className="col-span-2 font-mono text-xs">
                {toDegMinSec(spot.lat, "lat")} {toDegMinSec(spot.lng, "lng")}
              </div>
              <div>
                Distancia:{" "}
                <b>{spot.distanceNm != null ? `${spot.distanceNm.toFixed(1)} nm` : "—"}</b>
              </div>
              <div>
                Rumbo: <b>{gps ? compassLabel(bearingDeg(gps, spot)) : "—"}</b>
              </div>
              <div>
                Profundidad: <b>{spot.depthM != null ? `${Math.round(spot.depthM)} m` : "—"}</b>
              </div>
              <div>
                Temperatura: <b>{spot.sstC != null ? `${spot.sstC.toFixed(1)} °C` : "—"}</b>
              </div>
              <div>
                Clorofila:{" "}
                <b>{spot.chlMgM3 != null ? `${spot.chlMgM3.toFixed(2)} mg/m³` : "—"}</b>
              </div>
              <div>
                Corriente:{" "}
                <b>
                  {spot.currentKn != null
                    ? `${spot.currentKn.toFixed(1)} kn${current ? ` de ${compassLabel(current.dirDeg)}` : ""}`
                    : current
                      ? `${current.avgKn.toFixed(1)} kn de ${compassLabel(current.dirDeg)}`
                      : "—"}
                </b>
              </div>
              <div>
                Puntuación: <b>{spot.scorePct}/100</b>
              </div>
              <div>
                Confianza: <b>{choice.confidence}</b>
              </div>
            </div>

            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {choice.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>

            {res.answer?.missingData && (
              <p className="mt-2 text-xs text-amber-500">⚠️ {res.answer.missingData}</p>
            )}

            {chosenMode === "drift" && (
              <div className="mt-2 rounded-lg border border-border bg-background p-2 text-xs">
                {driftStart ? (
                  <>
                    <div className="font-semibold">Inicio de la pasada (deriva real)</div>
                    <div className="font-mono">
                      {toDegMinSec(driftStart.lat, "lat")} {toDegMinSec(driftStart.lng, "lng")}
                    </div>
                    <div className="text-muted-foreground">
                      Deriva {driftStart.kn.toFixed(1)} kn hacia {compassLabel(driftStart.dirDeg)} ·
                      pasada de ~15 min sobre el hotspot
                    </div>
                    <button
                      onClick={() => onFlyTo(driftStart.lat, driftStart.lng)}
                      className="mt-1 rounded-md border border-border px-2 py-1"
                    >
                      Ver inicio en el mapa
                    </button>
                  </>
                ) : (
                  <span>No hay información suficiente para calcular el inicio de la deriva</span>
                )}
              </div>
            )}

            <p className="mt-2 text-xs text-muted-foreground">
              Datos actualizados: {dataDateIso ? new Date(dataDateIso).toLocaleString("es-ES") : "—"}
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => {
                  onFlyTo(spot.lat, spot.lng);
                  onClose();
                }}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
              >
                🧭 Llévame allí
              </button>
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-border px-3 py-1.5 text-xs"
              >
                Navegar hasta el punto
              </a>
              <button
                onClick={copyCoords}
                className="rounded-md border border-border px-3 py-1.5 text-xs"
              >
                {copied ? "¡Copiadas!" : "Copiar coordenadas"}
              </button>
              {res.answer?.secondary && (
                <button
                  onClick={() => setShowSecond((v) => !v)}
                  className="rounded-md border border-border px-3 py-1.5 text-xs"
                >
                  {showSecond ? "Ver primera opción" : "Ver segunda opción"}
                </button>
              )}
            </div>

            <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
              Recomendación orientativa basada en datos oceanográficos y predicciones. Comprueba
              siempre el estado real de la mar y la normativa aplicable.
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {res.unlimited
                ? "Consultas de IA: ilimitadas (administrador)"
                : `Te quedan ${Math.max(0, res.dailyLimit - res.usedToday)} de ${res.dailyLimit} consultas de IA hoy`}
            </p>
          </div>
        )}
          </>
        )}
      </div>
    </div>

    </div>
    </>
  );
}


