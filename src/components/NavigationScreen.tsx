/**
 * Pantalla de navegación a un destino (waypoint / zona de pesca).
 * 100 % visual: sin voz ni avisos sonoros. Números grandes y alto contraste
 * para leerse a pleno sol. Todo se actualiza con las lecturas del GPS.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { GpsPosition } from "./GpsTracker";
import {
  ALERT_THRESHOLDS,
  ARRIVAL_RADIUS_M,
  alertLabel,
  angleDelta,
  bearingDeg,
  cardinal,
  distanceM,
  formatArrivalClock,
  formatDistance,
  formatEta,
  etaSeconds,
  msToKnots,
  type NavTarget,
} from "../lib/navigation";

interface NavigationScreenProps {
  target: NavTarget;
  position: GpsPosition | null;
  track: GpsPosition[];
  gpsError?: string | null;
  onEnd: () => void;
  onBackToMap: () => void;
}

/** Course Over Ground real a partir de los dos últimos puntos del track. */
function courseOverGround(track: GpsPosition[], position: GpsPosition | null): number | null {
  const a = track[track.length - 2];
  const b = track[track.length - 1];
  if (a && b && distanceM(a, b) >= 5) return bearingDeg(a, b);
  if (position?.heading != null && !Number.isNaN(position.heading)) return position.heading;
  return null;
}

export function NavigationScreen({
  target,
  position,
  track,
  gpsError,
  onEnd,
  onBackToMap,
}: NavigationScreenProps) {
  const distance = position ? distanceM(position, target) : null;
  const desired = position ? bearingDeg(position, target) : null;
  const cog = courseOverGround(track, position);
  const delta = cog != null && desired != null ? angleDelta(cog, desired) : null;
  const speedKn = position?.speed != null ? Math.max(0, msToKnots(position.speed)) : null;
  const eta = distance != null ? etaSeconds(distance, position?.speed ?? null) : null;

  const arrived = distance != null && distance <= ARRIVAL_RADIUS_M;

  // Mientras la navegación esté abierta: cerrar y ocultar popups, tooltips y
  // paneles flotantes del mapa. Se restauran al salir.
  useEffect(() => {
    document.body.classList.add("navigation-active");
    document
      .querySelectorAll(".leaflet-popup-close-button")
      .forEach((el) => (el as HTMLElement).click());
    return () => {
      document.body.classList.remove("navigation-active");
    };
  }, []);

  // Avisos visuales al cruzar 1 NM, 500 m y 100 m (una sola vez cada uno).
  const firedRef = useRef<Set<number>>(new Set());
  const [alert, setAlert] = useState<string | null>(null);
  useEffect(() => {
    if (distance == null) return;
    for (const th of ALERT_THRESHOLDS) {
      if (distance <= th && !firedRef.current.has(th)) {
        firedRef.current.add(th);
        setAlert(alertLabel(th));
        break;
      }
    }
  }, [distance]);
  useEffect(() => {
    if (!alert) return;
    const t = setTimeout(() => setAlert(null), 12000);
    return () => clearTimeout(t);
  }, [alert]);

  const dist = useMemo(
    () => (distance == null ? null : formatDistance(distance)),
    [distance],
  );

  // Flecha: babor (rojo), estribor (verde) o mantener rumbo.
  const HOLD_DEG = 8;
  const side: "port" | "starboard" | "hold" | null =
    delta == null ? null : Math.abs(delta) <= HOLD_DEG ? "hold" : delta < 0 ? "port" : "starboard";

  const sideColor =
    side === "port" ? "#ef4444" : side === "starboard" ? "#22c55e" : "#e2e8f0";

  return (
    <div className="fixed inset-0 z-[2600] flex flex-col bg-black text-white" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      {/* Cabecera */}
      <div className="flex items-center gap-2 border-b border-white/20 px-3 py-2">
        <span className="text-xl">🧭</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-black uppercase tracking-wide">{target.name}</div>
          <div className="font-mono text-[11px] text-white/70">
            {target.lat.toFixed(5)}, {target.lng.toFixed(5)}
          </div>
        </div>
      </div>

      {/* Avisos */}
      {arrived ? (
        <div className="m-2 rounded-xl border-4 border-emerald-400 bg-emerald-500/25 px-3 py-4 text-center">
          <div className="text-2xl font-black leading-tight text-emerald-200">
            HAS LLEGADO A LA ZONA DE PESCA
          </div>
        </div>
      ) : alert ? (
        <div className="m-2 rounded-xl border-4 border-amber-400 bg-amber-500/25 px-3 py-3 text-center">
          <div className="text-xl font-black uppercase leading-tight text-amber-100">{alert}</div>
        </div>
      ) : null}

      {!position && (
        <div className="m-2 rounded-lg border-2 border-cyan-400/60 bg-cyan-500/15 px-3 py-2 text-center text-sm font-bold text-cyan-100">
          {gpsError ? "GPS no disponible — revisa los permisos" : "Buscando señal GPS…"}
        </div>
      )}

      {/* Datos grandes */}
      <div className="grid grid-cols-2 gap-2 px-2">
        <Metric label="DISTANCIA" value={dist ? dist.value : "--"} unit={dist ? dist.unit : "NM"} />
        <Metric label="LLEGADA" value={formatEta(eta)} unit={eta != null ? formatArrivalClock(eta) : ""} />
        <Metric
          label="VELOCIDAD"
          value={speedKn != null ? speedKn.toFixed(1) : "--"}
          unit="kn"
        />
        <Metric
          label="RUMBO ACTUAL"
          value={cog != null ? `${Math.round(cog)}°` : "--"}
          unit={cog != null ? cardinal(cog) : ""}
        />
      </div>

      {/* Brújula de navegación: carretera + flecha de corrección */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-2">
        <svg viewBox="0 0 200 200" className="h-[38vh] max-h-[300px] w-auto" aria-hidden>
          {/* Aro exterior */}
          <circle cx="100" cy="100" r="96" fill="#0b0b0b" stroke="#ffffff" strokeWidth="3" opacity="0.95" />
          <circle cx="100" cy="100" r="88" fill="none" stroke="#ffffff" strokeWidth="1" opacity="0.35" />

          {/* Carreleta de grados: gira con el rumbo actual para que el rumbo quede arriba */}
          <g transform={`rotate(${cog != null ? -cog : 0} 100 100)`} style={{ transition: "transform 600ms ease-out" }}>
            {/* Marcas cardinales */}
            <text x="100" y="14" textAnchor="middle" fill="#ef4444" fontSize="13" fontWeight="900">N</text>
            <text x="100" y="190" textAnchor="middle" fill="#e2e8f0" fontSize="11" fontWeight="800">S</text>
            <text x="190" y="104" textAnchor="middle" fill="#e2e8f0" fontSize="11" fontWeight="800">E</text>
            <text x="10" y="104" textAnchor="middle" fill="#e2e8f0" fontSize="11" fontWeight="800">O</text>

            {/* Ticks y números cada 30° */}
            {Array.from({ length: 36 }, (_, i) => i * 10).map((deg) => {
              const major = deg % 90 === 0;
              const medium = deg % 30 === 0;
              const rad = ((deg - 90) * Math.PI) / 180;
              const r1 = major ? 96 : medium ? 94 : 92;
              const r2 = major ? 84 : medium ? 86 : 89;
              const x1 = 100 + r1 * Math.cos(rad);
              const y1 = 100 + r1 * Math.sin(rad);
              const x2 = 100 + r2 * Math.cos(rad);
              const y2 = 100 + r2 * Math.sin(rad);
              return (
                <g key={deg}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#ffffff" strokeWidth={major ? 2.5 : medium ? 1.5 : 0.75} opacity={major ? 1 : medium ? 0.9 : 0.55} />
                  {medium && !major && (
                    <text
                      x={100 + 78 * Math.cos(rad)}
                      y={100 + 78 * Math.sin(rad) + 3.5}
                      textAnchor="middle"
                      fill="#ffffff"
                      fontSize="8"
                      fontWeight="700"
                      opacity={0.9}
                    >
                      {deg}
                    </text>
                  )}
                </g>
              );
            })}
          </g>

          {/* Flecha de corrección de rumbo (siempre apunta al rumbo recomendado relativo) */}
          <g
            transform={`rotate(${side === "hold" || delta == null ? 0 : Math.max(-90, Math.min(90, delta))} 100 100)`}
            style={{ transition: "transform 400ms ease-out" }}
          >
            <path
              d="M100 22 L150 140 L100 116 L50 140 Z"
              fill={sideColor}
              stroke="#000000"
              strokeWidth="4"
              strokeLinejoin="round"
            />
            <circle cx="100" cy="100" r="7" fill={sideColor} stroke="#000000" strokeWidth="2" />
          </g>

          {/* Punto central fijo */}
          <circle cx="100" cy="100" r="3" fill="#ffffff" />
        </svg>
        <div
          className="mt-1 text-center text-3xl font-black uppercase leading-none"
          style={{ color: sideColor }}
        >
          {side === "port"
            ? `◀ BABOR ${Math.abs(Math.round(delta!))}°`
            : side === "starboard"
              ? `ESTRIBOR ${Math.abs(Math.round(delta!))}° ▶`
              : side === "hold"
                ? "MANTENER RUMBO"
                : "SIN RUMBO"}
        </div>
        <div className="mt-1 text-lg font-bold text-white/85">
          Rumbo recomendado: {desired != null ? `${Math.round(desired)}° ${cardinal(desired)}` : "--"}
        </div>
      </div>

      {/* Botones */}
      <div className="grid grid-cols-2 gap-2 px-2 pb-2 pt-1">
        <button
          type="button"
          onClick={onBackToMap}
          className="rounded-xl border-4 border-cyan-300 bg-cyan-500/25 px-3 py-4 text-lg font-black uppercase text-cyan-50 active:bg-cyan-500/40"
        >
          Volver al mapa
        </button>
        <button
          type="button"
          onClick={onEnd}
          className="rounded-xl border-4 border-red-400 bg-red-500/25 px-3 py-4 text-lg font-black uppercase text-red-50 active:bg-red-500/40"
        >
          Finalizar navegación
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded-xl border-2 border-white/35 bg-white/10 px-2 py-1.5">
      <div className="text-[11px] font-bold uppercase tracking-wider text-white/70">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className="text-4xl font-black tabular-nums leading-none">{value}</span>
        <span className="text-sm font-bold text-white/80">{unit}</span>
      </div>
    </div>
  );
}

