/**
 * Tipos y utilidades compartidas de «¿Dónde pescarías hoy?».
 *
 * REGLA DE ORO: la IA NO calcula nada. Todos los números (coordenadas,
 * profundidad, puntuación, distancia, temperatura, corriente…) los produce
 * la propia aplicación con sus motores actuales. La IA solo elige entre los
 * hotspots reales que se le envían y explica por qué.
 */

export type AdvisorMode = "surface" | "bottom" | "squid" | "drift";

export const ADVISOR_MODE_LABEL: Record<AdvisorMode, string> = {
  surface: "Pesca de altura / superficie",
  bottom: "Pesca de fondo",
  squid: "Calamar",
  drift: "Pesca a la deriva (Fluixa)",
};

/** Un hotspot real, tal y como lo ha calculado la app. */
export interface AdvisorSpot {
  id: string;
  rank: number;
  lat: number;
  lng: number;
  /** 0..100, derivado del score real (0..1). */
  scorePct: number;
  depthM: number | null;
  /** Distancia desde el usuario en millas náuticas (null si no hay GPS). */
  distanceNm: number | null;
  reason: string;
  /**
   * Valores REALES medidos en la coordenada exacta de este hotspot.
   * NO son los del cursor ni los del punto seleccionado.
   */
  sstC?: number | null;
  chlMgM3?: number | null;
  adtM?: number | null;
  currentKn?: number | null;
  bottomTempC?: number | null;
}

/** Condiciones reales del área (las mismas que muestra la app). */
export interface AdvisorEnvironment {
  windKn: number | null;
  windGustKn: number | null;
  windDirDeg: number | null;
  currentKn: number | null;
  currentDirDeg: number | null;
  pressureHpa: number | null;
  pressureTrend: string | null;
  sstC: number | null;
  bottomTempC: number | null;
  chlMgM3: number | null;
  fsleActive: boolean;
  activeLayers: string[];
}

export interface AdvisorRequest {
  mode: AdvisorMode;
  species: string | null;
  whenIso: string;
  /** Fecha/hora de los datos oceanográficos cargados. */
  dataDateIso: string | null;
  user: { lat: number; lng: number } | null;
  maxDistanceNm: number | null;
  spots: AdvisorSpot[];
  env: AdvisorEnvironment;
}

export interface AdvisorChoice {
  spotId: string;
  reasons: string[];
  confidence: "alta" | "media" | "baja";
}

export interface AdvisorAnswer {
  primary: AdvisorChoice;
  secondary: AdvisorChoice | null;
  missingData: string | null;
  summary: string;
}

export interface AdvisorResponse {
  ok: boolean;
  answer: AdvisorAnswer | null;
  /** Motivo legible cuando ok === false. */
  message: string | null;
  /** "missing_key" | "rate_limited" | "no_spots" | "provider_error" */
  code: string | null;
  usedToday: number;
  dailyLimit: number;
  /** true si la cuenta es administradora (sin límite de consultas). */
  unlimited?: boolean;
  /** Consultas extra compradas que quedan disponibles. */
  creditsLeft?: number;
}

export const ADVISOR_DAILY_LIMIT = 5;

/** Mensaje único mostrado al agotar el cupo diario. */
export const ADVISOR_LIMIT_MESSAGE = `Has alcanzado el límite diario de ${5} consultas a la IA. Puedes comprar un paquete de consultas extra o volver mañana.`;


/** Distancia en millas náuticas entre dos puntos (haversine). */
export function distanceNm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(s));
  return km / 1.852;
}

/** Compás legible: "245° OSO". */
export function compassLabel(deg: number | null | undefined): string {
  if (deg == null || !Number.isFinite(deg)) return "—";
  const dirs = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO",
  ];
  return `${Math.round(deg)}° ${dirs[Math.round((deg % 360) / 22.5) % 16]}`;
}

const num = (v: number | null | undefined): v is number =>
  v != null && Number.isFinite(v);

/**
 * Línea con los valores REALES medidos en la coordenada exacta del hotspot.
 * Solo aparecen los datos que existen: nunca "n/d" inventado.
 */
export function spotMeasuredLine(s: AdvisorSpot): string {
  const p: string[] = [];
  if (num(s.sstC)) p.push(`T superficie ${s.sstC.toFixed(2)} °C`);
  if (num(s.bottomTempC)) p.push(`T fondo ${s.bottomTempC.toFixed(2)} °C`);
  if (num(s.chlMgM3)) p.push(`clorofila ${s.chlMgM3.toFixed(3)} mg/m3`);
  if (num(s.adtM)) p.push(`altimetría ${s.adtM.toFixed(3)} m`);
  if (num(s.currentKn)) p.push(`corriente ${s.currentKn.toFixed(2)} kn`);
  return p.length ? p.join(", ") : "sin lecturas puntuales";
}

/** Datos que realmente NO están disponibles en este hotspot. */
export function spotMissingFields(s: AdvisorSpot): string[] {
  const m: string[] = [];
  if (!num(s.sstC)) m.push("temperatura de superficie");
  if (!num(s.chlMgM3)) m.push("clorofila");
  if (!num(s.adtM)) m.push("altimetría");
  if (!num(s.currentKn)) m.push("corriente en el punto");
  if (!num(s.depthM)) m.push("profundidad");
  return m;
}

/* ─────────────────────────────────────────────────────────────
 * Asistente conversacional (chat) — mismos datos reales, sin inventar.
 * ───────────────────────────────────────────────────────────── */

export interface AdvisorChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AdvisorChatRequest {
  messages: AdvisorChatMessage[];
  /** Modalidad activa en la app (puede cambiarla la IA). */
  mode: AdvisorMode;
  whenIso: string;
  dataDateIso: string | null;
  user: { lat: number; lng: number } | null;
  hasSearchArea: boolean;
  spots: AdvisorSpot[];
  env: AdvisorEnvironment;
}

export interface AdvisorChatAnswer {
  /** Respuesta en lenguaje natural para el pescador. */
  reply: string;
  /** Hotspot que debe marcarse/centrarse en la carta (id exacto) o null. */
  spotId: string | null;
  /** Segunda opción para comparar, o null. */
  altSpotId: string | null;
  /** Top 1/2/3 con explicación, técnica y confianza (vacío si no procede). */
  picks: AdvisorPick[];
  /** Especie objetivo detectada en la conversación, si la hay. */
  species: string | null;
  /** Avisos de normativa (tallas, vedas) con recordatorio de verificar vigencia. */
  regulationNote: string | null;
  /** Modalidad que la app debe activar, o null si no cambia. */
  setMode: AdvisorMode | null;
  /** true si la IA necesita que el usuario dibuje el triángulo de búsqueda. */
  needSearchArea: boolean;
  /** true solo si el pescador pide cambiar de zona (obliga a redibujar el triángulo). */
  changeSearchArea: boolean;
  /** Datos que faltan o no están actualizados (aviso honesto), o null. */
  missingData: string | null;
}

export interface AdvisorChatResponse {
  ok: boolean;
  answer: AdvisorChatAnswer | null;
  message: string | null;
  code: string | null;
  usedToday: number;
  dailyLimit: number;
  /** true si la cuenta es administradora (sin límite de consultas). */
  unlimited?: boolean;
  /** Consultas extra compradas que quedan disponibles. */
  creditsLeft?: number;
}

/* ─────────────────────────────────────────────────────────────
 * Plan de pesca marcado sobre la carta (Top 1/2/3)
 * ───────────────────────────────────────────────────────────── */

/** Una recomendación de la IA sobre un hotspot REAL de la app. */
export interface AdvisorPick {
  /** id exacto de un AdvisorSpot recibido. */
  spotId: string;
  /** 1, 2 o 3. */
  rank: number;
  /** Por qué, en lenguaje de pescador (2-3 frases cortas). */
  why: string;
  confidence: "alta" | "media" | "baja";
  /** Radio de trabajo sugerido en metros (la app dibuja el polígono). */
  radiusM: number;
  /** Técnica/cebo sugeridos según la base de conocimiento. */
  technique: string | null;
  bestHours: string | null;
  /** true si conviene dibujar la línea de deriva sobre ese punto. */
  drift: boolean;
}

/** Punto ya resuelto por la app, listo para pintar en la carta. */
export interface AdvisorPlanSpot {
  rank: number;
  lat: number;
  lng: number;
  depthM: number | null;
  distanceNm: number | null;
  bearingDeg: number | null;
  scorePct: number;
  confidence: "alta" | "media" | "baja";
  why: string;
  technique: string | null;
  bestHours: string | null;
  /** Polígono de trabajo (triángulo/hexágono) calculado por la app. */
  polygon: Array<{ lat: number; lng: number }>;
  /** Línea de deriva [inicio, fin] cuando aplica. */
  driftLine: Array<{ lat: number; lng: number }> | null;
  driftBearingDeg: number | null;
}

export interface AdvisorPlan {
  spots: AdvisorPlanSpot[];
  createdAtIso: string;
}

