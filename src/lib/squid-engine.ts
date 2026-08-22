/**
 * MOTOR ESPECÍFICO DE CALAMAR
 * ===========================
 *
 * El calamar (Loligo vulgaris / Todarodes) NO responde a las mismas señales
 * que los demersales, así que ya no reutiliza el motor de fondo. Este motor
 * pondera lo que de verdad manda en la potera:
 *
 *   · Temperatura de fondo   → óptimo 13–16 °C
 *   · Corrientes moderadas   → 0.05–0.20 m/s
 *   · Tipo de fondo          → transición arena–roca (no roca pura, no fango)
 *   · Luz lunar              → poca luna = mejor concentración a la potera
 *   · Amanecer / atardecer   → crepúsculos = ventana de actividad
 *   · Profundidad            → 30–150 m
 *   · FSLE                   → frentes que concentran presa
 */

import SunCalc from "suncalc";
import { getWeights, weightedScore } from "./scoring-weights";
import { bottomTempFactor, bottomCurrentFactor } from "./bottom-field";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface SquidInputs {
  lat: number;
  lng: number;
  when: Date;
  depthM: number | null;
  bottomTempC: number | null;
  bottomSpeed: number | null;
  /** Rugosidad 3×3 en metros (relieve fino). */
  roughnessM: number;
  /** Rugosidad 5×5 en metros (relieve amplio). */
  roughness5x5M: number;
  /** Pendiente en m/km. */
  slopeMperKm: number;
  /** Proximidad a línea FSLE 0..1. */
  fsleProximity: number;
}

export interface SquidBreakdown {
  score: number; // 0..100
  factors: Record<string, number>;
  reasons: string[];
  main: string;
}

/**
 * Fondo MIXTO arena–roca: el calamar caza en el borde entre sustrato blando
 * y duro. Rugosidad media (2–7 m) puntúa alto; fango liso (≈0) y roca
 * escarpada (>12 m) puntúan bajo.
 */
export function mixedBottomFactor(roughnessM: number, roughness5x5M: number): number {
  const r = 0.65 * roughnessM + 0.35 * roughness5x5M;
  if (r < 0.8) return 0.15; // fango/arena plana pura
  if (r <= 2) return 0.15 + ((r - 0.8) / 1.2) * 0.6;
  if (r <= 7) return 1; // mosaico arena–roca: lo ideal
  if (r <= 14) return clamp01(1 - (r - 7) / 9);
  return 0.2;
}

/** Luz lunar: 1 con luna nueva, 0.25 con luna llena alta. */
export function moonLightFactor(when: Date, lat: number, lng: number): number {
  const illum = SunCalc.getMoonIllumination(when);
  const pos = SunCalc.getMoonPosition(when, lat, lng);
  const aboveHorizon = pos.altitude > 0;
  // Si la luna está bajo el horizonte, su iluminación no molesta.
  const effective = aboveHorizon ? illum.fraction : illum.fraction * 0.25;
  return clamp01(1 - effective * 0.75);
}

/** Cercanía al crepúsculo (±90 min de orto/ocaso solar). */
export function twilightFactor(when: Date, lat: number, lng: number): number {
  const t = SunCalc.getTimes(when, lat, lng);
  const marks = [t.sunrise, t.sunset, t.dusk, t.dawn].filter(
    (d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()),
  );
  if (marks.length === 0) return 0.5;
  const now = when.getTime();
  let bestMin = Infinity;
  for (const m of marks) {
    bestMin = Math.min(bestMin, Math.abs(now - m.getTime()) / 60000);
  }
  if (bestMin <= 30) return 1;
  if (bestMin <= 90) return clamp01(1 - (bestMin - 30) / 60);
  // Noche cerrada sigue siendo pescable a potera, pero menos que el crepúsculo.
  const pos = SunCalc.getPosition(when, lat, lng);
  return pos.altitude < 0 ? 0.55 : 0.25;
}

/** Profundidad objetivo del calamar: 30–150 m. */
export function squidDepthFactor(depthM: number | null): number | null {
  if (depthM == null || !Number.isFinite(depthM)) return null;
  if (depthM < 12) return 0.1;
  if (depthM < 30) return 0.35 + ((depthM - 12) / 18) * 0.55;
  if (depthM <= 150) return 1;
  if (depthM <= 260) return clamp01(1 - (depthM - 150) / 110);
  return 0.05;
}

export function computeSquidScore(inp: SquidInputs): SquidBreakdown {
  const factors: Record<string, number> = {};

  const t = bottomTempFactor(inp.bottomTempC, 14.5);
  if (t != null) factors.tempFondo = t;
  const c = bottomCurrentFactor(inp.bottomSpeed);
  if (c != null) factors.corrFondo = c;
  factors.fondoMixto = mixedBottomFactor(inp.roughnessM, inp.roughness5x5M);
  factors.luna = moonLightFactor(inp.when, inp.lat, inp.lng);
  factors.crepusculo = twilightFactor(inp.when, inp.lat, inp.lng);
  const d = squidDepthFactor(inp.depthM);
  if (d != null) factors.profundidad = d;
  factors.fsle = clamp01(inp.fsleProximity);

  const weights = getWeights("squid");
  const raw = weightedScore(factors, weights);

  // Penalización suave por fondo imposible (muy somero o abisal).
  let pen = 0;
  if (inp.depthM != null && inp.depthM < 10) pen += 0.2;
  if (inp.depthM != null && inp.depthM > 400) pen += 0.25;

  const score = Math.round(clamp01(raw - pen) * 100);

  const reasons: string[] = [];
  if ((factors.tempFondo ?? 0) >= 0.8 && inp.bottomTempC != null)
    reasons.push(`temperatura de fondo ideal (${inp.bottomTempC.toFixed(1)} °C)`);
  if ((factors.corrFondo ?? 0) >= 0.8) reasons.push("corriente de fondo moderada");
  else if ((factors.corrFondo ?? 1) < 0.35) reasons.push("corriente poco favorable");
  if (factors.fondoMixto >= 0.8) reasons.push("fondo mixto arena–roca");
  if (factors.luna >= 0.75) reasons.push("poca luz lunar");
  else if (factors.luna < 0.4) reasons.push("luna llena alta (más difícil)");
  if (factors.crepusculo >= 0.9) reasons.push("ventana de crepúsculo");
  if (factors.fsle >= 0.5) reasons.push("cerca de frente FSLE");
  if ((factors.profundidad ?? 0) >= 0.9 && inp.depthM != null)
    reasons.push(`profundidad de potera (~${Math.round(inp.depthM)} m)`);

  const main = reasons[0] ?? "condiciones medias para calamar";
  return { score, factors, reasons, main };
}

