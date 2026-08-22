/**
 * MOTOR DE PESCA A LA DERIVA (FLUIXA)
 * ===================================
 *
 * Algoritmo COMPLETAMENTE INDEPENDIENTE de fondo, calamar y pesca de altura.
 * Está pensado para bahías y franja costera, donde el barco deriva con el
 * viento y la corriente sobre estructuras que concentran depredadores
 * costeros (llampuga de costa, anjova, lubina, sirvia, dentón, palometón…).
 *
 * Filosofía: la fluixa no busca "el gran frente oceánico", busca el LUGAR
 * donde la deriva natural pasa por encima de un borde productivo. Por eso
 * pondera geometría costera (puntas, veriles, canales, barras) al mismo
 * nivel que la señal oceanográfica, y penaliza tanto la calma absoluta
 * (no hay deriva) como la corriente/oleaje excesivos (no se pesca).
 *
 * Todas las variables son 0..1 y se combinan con `weightedScore`, que
 * renormaliza automáticamente cuando falta una capa.
 */

import { getWeights, weightedScore } from "./scoring-weights";
import { windShelterFactor, type CoastGeometry } from "./coast-geometry";
import type { MarineConditions } from "./marine-conditions";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface DriftInputs {
  lat: number;
  lng: number;
  /** Profundidad positiva en metros. */
  depthM: number | null;
  /** Pendiente del fondo (m/km). */
  slopeMperKm: number;
  /** Rugosidad 3×3 (m) — relieve fino: piedras, barras, cascajo. */
  roughnessM: number;
  /** Rugosidad 5×5 (m) — relieve amplio. */
  roughness5x5M: number;
  /** Curvatura (m/km²): negativa = canal/depresión, positiva = bajo. */
  curvatureMperKm2: number;
  /** Fuerza del quiebro de pendiente (veril) 0..1. */
  slopeBreakStrength: number;
  /** Gradiente SST normalizado 0..1. */
  sstGrad: number;
  /** Clorofila / borde de clorofila normalizado 0..1. */
  chl: number;
  /** Señal de altimetría-corriente normalizada 0..1. */
  alt: number;
  /** Proximidad a línea FSLE 0..1. */
  fsleProximity: number;
  /** Persistencia del frente 2–3 días 0..1. */
  persistencia: number;
  /** Geometría costera del punto. */
  coast: CoastGeometry;
  /** Condiciones marinas del área (viento, ola, corriente superficial). */
  marine: MarineConditions;
  /** Origen del dato batimétrico (calidad). */
  depthSource: "emodnet" | "ncei" | "gebco" | "none";
  /** Nº de capas oceanográficas con dato real (0..3). */
  surfaceLayers: number;
}

export interface DriftBreakdown {
  score: number; // 0..100
  factors: Record<string, number>;
  reasons: string[];
  main: string;
}

/** Profundidad de fluixa: 8–45 m es la franja de oro; hasta 80 m aceptable. */
export function driftDepthFactor(depthM: number | null): number | null {
  if (depthM == null || !Number.isFinite(depthM)) return null;
  if (depthM < 3) return 0.05;
  if (depthM < 8) return 0.3 + ((depthM - 3) / 5) * 0.5;
  if (depthM <= 45) return 1;
  if (depthM <= 80) return clamp01(1 - (depthM - 45) / 70);
  if (depthM <= 140) return clamp01(0.5 - (depthM - 80) / 240);
  return 0.05;
}

/**
 * Deriva útil: la suma vectorial aproximada de corriente superficial y
 * arrastre del viento (≈3 % del viento). Óptimo 0.15–0.6 nudos de deriva:
 * suficiente para cubrir terreno, no tanto como para no pescar.
 */
export function driftSpeedFactor(marine: MarineConditions): number | null {
  const cur = marine.currentSpeedMs;
  const windMs = marine.windKn == null ? null : marine.windKn / 1.94384;
  if (cur == null && windMs == null) return null;
  const drift = (cur ?? 0) + 0.03 * (windMs ?? 0); // m/s
  const kn = drift * 1.94384;
  if (kn < 0.05) return 0.15; // calma total: el barco no deriva
  if (kn < 0.15) return 0.15 + ((kn - 0.05) / 0.1) * 0.55;
  if (kn <= 0.6) return 1;
  if (kn <= 1.2) return clamp01(1 - (kn - 0.6) / 0.75);
  return 0.1;
}

/** Oleaje: hasta 0.4 m ideal; a partir de 1.2 m la fluixa es inviable. */
export function waveFactor(waveHeightM: number | null): number | null {
  if (waveHeightM == null || !Number.isFinite(waveHeightM)) return null;
  if (waveHeightM <= 0.4) return 1;
  if (waveHeightM <= 0.8) return clamp01(1 - (waveHeightM - 0.4) / 0.8);
  if (waveHeightM <= 1.5) return clamp01(0.5 - (waveHeightM - 0.8) / 1.4);
  return 0.05;
}

/** Distancia a costa: la fluixa vive entre 200 m y 3 km de tierra. */
export function coastDistanceFactor(coastKm: number | null): number | null {
  if (coastKm == null) return 0.25; // mar abierto sin costa cerca
  if (coastKm < 0.15) return 0.35; // demasiado pegado a la roca
  if (coastKm <= 0.4) return 0.75;
  if (coastKm <= 2.5) return 1;
  if (coastKm <= 5) return clamp01(1 - (coastKm - 2.5) / 4);
  return 0.15;
}

/**
 * Estructura costera: piedra suelta, barras de arena y cascajo. Rugosidad
 * moderada puntúa alto; arena plana o pared vertical, bajo.
 */
export function driftStructureFactor(roughnessM: number, roughness5x5M: number): number {
  const r = 0.7 * roughnessM + 0.3 * roughness5x5M;
  if (r < 0.4) return 0.2; // arenal liso
  if (r <= 1.5) return 0.2 + ((r - 0.4) / 1.1) * 0.6;
  if (r <= 6) return 1; // mosaico piedra–arena: lo ideal
  if (r <= 12) return clamp01(1 - (r - 6) / 10);
  return 0.25;
}

/** Veril / cambio brusco de profundidad accesible a la deriva. */
export function driftEdgeFactor(slopeMperKm: number, slopeBreakStrength: number): number {
  // En costa un veril de 25–120 m/km ya es una pared pescable.
  let s: number;
  if (slopeMperKm < 5) s = 0.15;
  else if (slopeMperKm < 25) s = 0.15 + ((slopeMperKm - 5) / 20) * 0.55;
  else if (slopeMperKm <= 120) s = 1;
  else s = clamp01(1 - (slopeMperKm - 120) / 260);
  return clamp01(0.7 * s + 0.3 * clamp01(slopeBreakStrength));
}

/** Canales, depresiones y bajos: curvatura marcada en cualquier signo. */
export function channelFactor(curvatureMperKm2: number): number {
  const a = Math.abs(curvatureMperKm2);
  if (!Number.isFinite(a)) return 0;
  if (a < 2) return 0.15;
  if (a <= 40) return clamp01(0.15 + (a / 40) * 0.85);
  return 1;
}

/** Puntas, cabos y bocanas de ensenada: donde la corriente se acelera. */
export function headlandFactor(coast: CoastGeometry): number {
  // Una punta pura puntúa máximo; el borde de una ensenada, alto también.
  return clamp01(0.75 * coast.capeIndex + 0.45 * coast.bayIndex);
}

/** Calidad y resolución de los datos usados en esta celda. */
export function driftDataQuality(
  depthSource: "emodnet" | "ncei" | "gebco" | "none",
  surfaceLayers: number,
  marine: MarineConditions,
): number {
  let q = 0;
  q += depthSource === "emodnet" ? 0.5 : depthSource === "gebco" ? 0.28 : 0;
  q += (Math.min(3, surfaceLayers) / 3) * 0.3;
  if (marine.windKn != null) q += 0.1;
  if (marine.waveHeightM != null) q += 0.05;
  if (marine.currentSpeedMs != null) q += 0.05;
  return clamp01(q);
}

export function computeDriftScore(inp: DriftInputs): DriftBreakdown {
  const factors: Record<string, number> = {};

  // ── Oceanografía superficial ──
  factors.fsle = clamp01(inp.fsleProximity);
  factors.sst = clamp01(inp.sstGrad);
  factors.chl = clamp01(inp.chl);
  factors.altCorriente = clamp01(inp.alt);

  // ── Deriva real del barco ──
  const ds = driftSpeedFactor(inp.marine);
  if (ds != null) factors.deriva = ds;
  const wv = waveFactor(inp.marine.waveHeightM);
  if (wv != null) factors.oleaje = wv;
  const sh = windShelterFactor(
    inp.coast.coastKm,
    inp.coast.coastBearingDeg,
    inp.marine.windFromDeg,
    inp.marine.windKn,
  );
  if (sh != null) factors.abrigo = sh;

  // ── Geografía y fondo ──
  const d = driftDepthFactor(inp.depthM);
  if (d != null) factors.profundidad = d;
  factors.estructura = driftStructureFactor(inp.roughnessM, inp.roughness5x5M);
  factors.veril = driftEdgeFactor(inp.slopeMperKm, inp.slopeBreakStrength);
  factors.canal = channelFactor(inp.curvatureMperKm2);
  factors.punta = headlandFactor(inp.coast);
  const cd = coastDistanceFactor(inp.coast.coastKm);
  if (cd != null) factors.distCosta = cd;

  // ── Confianza y estabilidad ──
  factors.persistencia = clamp01(inp.persistencia);
  factors.calidadDatos = driftDataQuality(inp.depthSource, inp.surfaceLayers, inp.marine);

  const weights = getWeights("drift");
  let raw = weightedScore(factors, weights);

  // Penalizaciones duras propias de la fluixa.
  let pen = 0;
  const wave = inp.marine.waveHeightM;
  if (wave != null && wave > 1.5) pen += 0.25;
  if (inp.marine.gustKn != null && inp.marine.gustKn > 28) pen += 0.2;
  if (inp.depthM != null && inp.depthM < 4) pen += 0.2;
  if (inp.coast.coastKm != null && inp.coast.coastKm > 8) pen += 0.1;
  raw = clamp01(raw - pen);

  const score = Math.round(raw * 100);

  const reasons: string[] = [];
  if ((factors.punta ?? 0) >= 0.6) reasons.push("punta o cabo con aceleración de corriente");
  if ((factors.veril ?? 0) >= 0.75) reasons.push("veril costero pescable a la deriva");
  if ((factors.canal ?? 0) >= 0.7) reasons.push("canal o depresión que canaliza la corriente");
  if ((factors.estructura ?? 0) >= 0.8) reasons.push("fondo mixto piedra–arena");
  if ((factors.deriva ?? 0) >= 0.85) reasons.push("velocidad de deriva ideal");
  else if ((factors.deriva ?? 1) < 0.3) reasons.push("apenas hay deriva (calma o exceso)");
  if ((factors.abrigo ?? 0) >= 0.8) reasons.push("zona abrigada del viento");
  if ((factors.oleaje ?? 1) < 0.4) reasons.push("mar de fondo incómodo");
  if ((factors.fsle ?? 0) >= 0.5) reasons.push("línea de convergencia FSLE cerca");
  if ((factors.sst ?? 0) >= 0.6) reasons.push("cambio de temperatura superficial marcado");
  if ((factors.chl ?? 0) >= 0.6) reasons.push("borde de clorofila (comida)");
  if ((factors.distCosta ?? 0) >= 0.9 && inp.coast.coastKm != null)
    reasons.push(`distancia a costa idónea (${inp.coast.coastKm.toFixed(1)} km)`);
  if ((factors.profundidad ?? 0) >= 0.9 && inp.depthM != null)
    reasons.push(`profundidad de fluixa (~${Math.round(inp.depthM)} m)`);
  if ((factors.persistencia ?? 0) >= 0.6) reasons.push("frente estable 2–3 días");

  const main = reasons[0] ?? "condiciones medias para la deriva";
  return { score, factors, reasons, main };
}

