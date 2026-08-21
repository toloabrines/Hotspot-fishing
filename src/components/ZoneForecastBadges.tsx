/**
 * Badges por zona de frente productivo: viento (próx. 6h), solunar
 * (ventana mayor/menor + fase lunar) y probabilidad combinada de pesca.
 *
 * Fórmula de probabilidad (0-100):
 *   prob = confianza_oceanográfica × factor_solunar × factor_viento × factor_lunar
 */

import { useWindForecast } from "../hooks/use-wind-forecast";
import { useSolunar } from "../hooks/use-solunar";
import type { GradientZone } from "../lib/gradient-zones.types";

interface Props {
  zone: GradientZone;
}

function fmtMin(mins: number): string {
  if (mins <= 0) return "ahora";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h}h ${m}m`;
}

function solunarFactor(active: boolean, minutesUntil: number): number {
  if (active) return 1;
  if (minutesUntil <= 60) return 0.85;
  if (minutesUntil <= 180) return 0.7;
  return 0.55;
}

function windFactor(level: string | undefined): number {
  switch (level) {
    case "calmo":
    case "ok":
      return 1;
    case "moderado":
      return 0.75;
    case "fuerte":
      return 0.4;
    case "muy fuerte":
      return 0.15;
    default:
      return 0.85; // sin dato → no penaliza demasiado
  }
}

function lunarFactor(phase: number, illum: number): number {
  // Nueva (0) y llena (0.5) → mareas vivas, mejor actividad.
  const c = Math.abs(Math.cos(2 * Math.PI * phase));
  return 0.85 + 0.15 * c * (0.5 + 0.5 * illum); // 0.85..1.0
}

function probClass(p: number): string {
  if (p >= 65) return "bg-emerald-500/30 text-emerald-100 border-emerald-400/60";
  if (p >= 45) return "bg-yellow-500/25 text-yellow-100 border-yellow-400/50";
  if (p >= 25) return "bg-orange-500/25 text-orange-100 border-orange-400/50";
  return "bg-muted/40 text-muted-foreground border-border";
}

function windClass(level: string | undefined): string {
  if (level === "fuerte" || level === "muy fuerte") return "bg-red-500/25 text-red-100";
  if (level === "moderado") return "bg-yellow-500/20 text-yellow-100";
  return "bg-emerald-500/20 text-emerald-100";
}

function moonGlyph(phase: number): string {
  if (phase < 0.0625 || phase >= 0.9375) return "🌑";
  if (phase < 0.1875) return "🌒";
  if (phase < 0.3125) return "🌓";
  if (phase < 0.4375) return "🌔";
  if (phase < 0.5625) return "🌕";
  if (phase < 0.6875) return "🌖";
  if (phase < 0.8125) return "🌗";
  return "🌘";
}

export function ZoneForecastBadges({ zone }: Props) {
  const lat = zone.axis.centroid.lat;
  const lng = zone.axis.centroid.lng;
  const { wind, loading: windLoading } = useWindForecast(lat, lng);
  const solunar = useSolunar(lat, lng);

  const base = zone.confidence / 100;
  const sF = solunar ? solunarFactor(solunar.active, solunar.minutesUntil) : 0.7;
  const wF = windFactor(wind?.level);
  const lF = solunar ? lunarFactor(solunar.moonPhase, solunar.moonIllumination) : 0.9;
  const prob = Math.round(base * sF * wF * lF * 100);

  return (
    <div className="mt-1 pl-[26px]">
      <div
        className={`mb-1 flex items-center gap-1.5 rounded border px-1.5 py-1 ${probClass(prob)}`}
        title="Probabilidad combinada: oceanografía × solunar × viento × luna"
      >
        <span className="text-[9px] font-semibold uppercase tracking-wide opacity-80">
          🎯 Prob. pesca
        </span>
        <span className="ml-auto font-mono text-[11px] font-bold tabular-nums">{prob}%</span>
      </div>
      <div className="grid grid-cols-2 gap-1 text-[9px]">
        {/* Viento */}
        <div className={`rounded px-1.5 py-1 ${windClass(wind?.level)}`}>
          <div className="flex items-center gap-1">
            <span>💨</span>
            <span className="font-semibold uppercase opacity-80">Viento</span>
          </div>
          {windLoading && !wind ? (
            <div className="font-mono opacity-70">…</div>
          ) : wind ? (
            <div className="font-mono tabular-nums">
              {wind.avgKn.toFixed(1)} kn · ráf {wind.gustKn.toFixed(1)}
              <span className="ml-1 opacity-80">({wind.level})</span>
            </div>
          ) : (
            <div className="font-mono opacity-70">sin dato</div>
          )}
        </div>

        {/* Solunar */}
        <div className="rounded bg-indigo-500/20 px-1.5 py-1 text-indigo-100">
          <div className="flex items-center gap-1">
            <span>{solunar ? moonGlyph(solunar.moonPhase) : "🌙"}</span>
            <span className="font-semibold uppercase opacity-80">Solunar</span>
          </div>
          {solunar?.next ? (
            <div className="font-mono tabular-nums leading-tight">
              {solunar.active ? (
                <span className="font-bold">activa · {solunar.next.kind}</span>
              ) : (
                <>
                  {solunar.next.kind} en {fmtMin(solunar.minutesUntil)}
                </>
              )}
              <div className="opacity-80">luna {Math.round(solunar.moonIllumination * 100)}%</div>
            </div>
          ) : (
            <div className="font-mono opacity-70">…</div>
          )}
        </div>
      </div>
    </div>
  );
}

