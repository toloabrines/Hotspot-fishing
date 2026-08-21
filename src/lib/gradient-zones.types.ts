/**
 * Tipos compartidos del sistema "Frentes Productivos".
 *
 * A diferencia del antiguo Top-N de FishingHotspots (puntos discretos),
 * aquí trabajamos con ZONAS continuas: bandas de gradiente fuerte que
 * recorren toda la transición oceanográfica.
 */

import type { LatLng } from "./geo-area";

export type GradientVariable = "sst" | "chl" | "alt";

export interface GradientCell {
  /** Centro geográfico de la celda. */
  center: LatLng;
  /** Esquinas SW y NE (bbox de la celda en lat/lng). */
  bounds: [LatLng, LatLng];
  /** Magnitud de gradiente por variable (0..1, ya normalizado). */
  grad: Partial<Record<GradientVariable, number>>;
  /** Variables que contribuyeron a marcarla como activa (≥2 o mono-fuerte). */
  vars: GradientVariable[];
  /** Score combinado 0..1 (max de gradientes contribuyentes). */
  score: number;
  /** Punto sub-celda sobre la cresta del gradiente real y su campo local. */
  ridge?: {
    point: LatLng;
    /** Vector tangente unitario en coordenadas de grilla: lat=row, lng=col. */
    tangent: LatLng;
    /** Vector normal unitario hacia la máxima pendiente: lat=row, lng=col. */
    normal: LatLng;
    /** Fuerza fusionada SST/CHL/ALT en la cresta. */
    strength: number;
    /** Contraste local contra los lados de la transición. */
    localContrast: number;
  };
  /** Índices en la grilla original (col, row). */
  col: number;
  row: number;
}

export interface GradientZone {
  id: string;
  /** Celdas que forman la zona (componente conexa). */
  cells: GradientCell[];
  /** Polígono cerrado (ring lat/lng) que envuelve toda la zona. */
  outline: LatLng[];
  /** Área aproximada en km². */
  areaKm2: number;
  /** Longitud aproximada del eje frontal en millas náuticas. */
  lengthNm: number;
  /** Variables predominantes en la zona. */
  vars: GradientVariable[];
  /** Score medio 0..1 (intensidad relativa del frente). */
  meanScore: number;
  /** Eje principal (centroide y dirección unitaria), usado por el corredor. */
  axis: { centroid: LatLng; dir: LatLng };
  /** Intensidad media del gradiente por variable (0..1). */
  gradMeans: Partial<Record<GradientVariable, number>>;
  /** Fracción de capas presentes con señal significativa (0..1). */
  multiLayer: number;
  /** Pendiente batimétrica (m/km) detectada cerca del centroide. */
  depthSlope?: number;
  /** Profundidad media de la zona en m (positiva). */
  meanDepthM?: number;
  /** Distancia estimada al veril significativo (km). */
  nearestVerilKm?: number;
  /** Convergencia de corrientes normalizada 0..1 (positivo = acumulación). */
  convergence?: number;
  /** Tensión geostrófica (proxy FSLE) normalizada 0..1. */
  fsleStrain?: number;
  /** Factores normalizados 0..1 para el desglose en el popup. */
  factors?: {
    sst?: number;
    chl?: number;
    alt?: number;
    conv?: number;
    fsle?: number;
    depth?: number;
  };
  /** Nº de factores (SST/CHL/ALT/Conv/FSLE) por encima del umbral local. */
  passCount?: number;
  /** Puntuación final de confianza 0-100. */
  confidence: number;
  /** Razón legible de la selección. */
  reason: string;
}

export interface GradientZonesResult {
  zones: GradientZone[];
  bbox: { south: number; west: number; north: number; east: number };
  /** Variables que se muestrearon. */
  sampledVars: GradientVariable[];
  /** Resolución de la grilla. */
  grid: { cols: number; rows: number };
}

