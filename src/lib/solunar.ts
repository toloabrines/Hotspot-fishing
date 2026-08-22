/**
 * Tablas solunares simplificadas para pesca.
 *
 * - Períodos MAYORES (~2h): centrados en el tránsito lunar superior e inferior
 *   (cuando la luna cruza el meridiano, por encima o por debajo).
 * - Períodos MENORES (~1h): centrados en la salida y puesta de la luna.
 *
 * Se calcula la próxima ventana solunar a partir de "ahora" y se clasifica
 * por proximidad. Usa la librería suncalc (puro JS, sin red).
 */

import SunCalc from "suncalc";

export type SolunarKind = "mayor" | "menor";

export interface SolunarWindow {
  kind: SolunarKind;
  /** Inicio de la ventana. */
  start: Date;
  /** Fin de la ventana. */
  end: Date;
  /** Centro (tránsito / orto / ocaso). */
  center: Date;
  /** Descripción corta: "Tránsito alto", "Tránsito bajo", "Orto luna", "Ocaso luna". */
  label: string;
}

export interface SolunarSummary {
  /** Próxima ventana solunar a partir de ahora (o la actual si está en curso). */
  next: SolunarWindow | null;
  /** ¿Estamos dentro de una ventana ahora mismo? */
  active: boolean;
  /** Minutos hasta el inicio de la próxima ventana (0 si activa). */
  minutesUntil: number;
  /** Fase lunar 0..1 (0 = nueva, 0.5 = llena). */
  moonPhase: number;
  /** Iluminación 0..1. */
  moonIllumination: number;
}

const MAJOR_HALF_MIN = 60; // ±60 min → ventana de 2 h
const MINOR_HALF_MIN = 30; // ±30 min → ventana de 1 h

function addMin(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60_000);
}

function makeWindow(center: Date, kind: SolunarKind, label: string): SolunarWindow {
  const half = kind === "mayor" ? MAJOR_HALF_MIN : MINOR_HALF_MIN;
  return {
    kind,
    label,
    center,
    start: addMin(center, -half),
    end: addMin(center, half),
  };
}

/**
 * Calcula tránsito lunar superior e inferior aproximados para un día y lat/lng.
 * SunCalc no expone tránsito directamente; lo aproximamos como el punto medio
 * entre salida y puesta (superior) y su antípoda temporal (inferior).
 */
function getLunarTransits(
  day: Date,
  lat: number,
  lng: number,
): { upper: Date | null; lower: Date | null } {
  const times = SunCalc.getMoonTimes(day, lat, lng, true);
  const rise = times.rise ?? null;
  const set = times.set ?? null;
  let upper: Date | null = null;
  if (rise && set) {
    upper = new Date((rise.getTime() + set.getTime()) / 2);
  } else if (rise) {
    upper = addMin(rise, 6 * 60);
  } else if (set) {
    upper = addMin(set, -6 * 60);
  }
  const lower = upper ? addMin(upper, 12 * 60) : null;
  return { upper, lower };
}

export function computeSolunar(lat: number, lng: number, now: Date = new Date()): SolunarSummary {
  const windows: SolunarWindow[] = [];
  for (const offset of [-1, 0, 1]) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    const { upper, lower } = getLunarTransits(day, lat, lng);
    if (upper) windows.push(makeWindow(upper, "mayor", "Tránsito alto"));
    if (lower) windows.push(makeWindow(lower, "mayor", "Tránsito bajo"));
    const times = SunCalc.getMoonTimes(day, lat, lng, true);
    if (times.rise) windows.push(makeWindow(times.rise, "menor", "Orto luna"));
    if (times.set) windows.push(makeWindow(times.set, "menor", "Ocaso luna"));
  }
  windows.sort((a, b) => a.center.getTime() - b.center.getTime());

  const active = windows.find((w) => now >= w.start && now <= w.end) ?? null;
  const next = active ?? windows.find((w) => w.start > now) ?? null;
  const minutesUntil = active
    ? 0
    : next
      ? Math.round((next.start.getTime() - now.getTime()) / 60_000)
      : -1;

  const illum = SunCalc.getMoonIllumination(now);

  return {
    next,
    active: !!active,
    minutesUntil,
    moonPhase: illum.phase,
    moonIllumination: illum.fraction,
  };
}

export function formatHHMM(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatMinutesUntil(min: number): string {
  if (min <= 0) return "ahora";
  if (min < 60) return `en ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `en ${h} h` : `en ${h} h ${m} min`;
}

