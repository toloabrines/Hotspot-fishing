/**
 * Ajustes de la capa profesional de fondo marino (DEM propio).
 * Sin imports de leaflet: seguro para SSR y para paneles de UI.
 */
export interface SeafloorSettings {
  /** Activa toda la capa DEM (hillshade / pendiente / rugosidad / isóbatas). */
  enabled: boolean;
  hillshade: boolean;
  /** Intensidad del sombreado 0–1. */
  hillshadeIntensity: number;
  /** Azimut solar en grados (0 = norte). */
  sunAzimuth: number;
  /** Altura solar en grados. */
  sunAltitude: number;
  /** Isóbatas 5/10/25/50 m según profundidad. */
  contours: boolean;
  /** Mapa de pendientes verde→amarillo→rojo. */
  slope: boolean;
  /** Mapa de rugosidad (roca / grietas). */
  roughness: boolean;
  /** Detección automática de bajos, veriles, cañones… */
  structures: boolean;
  /** Paleta de color del fondo. */
  palette: "pesca" | "clasica";
  /** Transparencia global de la capa de fondo 0–1. */
  opacity: number;
  /** Centrar el relieve en la posición GPS con máxima resolución. */
  focusGps: boolean;
  /** Radio (m) de la zona de máximo detalle alrededor del GPS. */
  focusRadiusM: number;
  /** Realce de microrelieve (piedras, grietas, cantos). */
  microRelief: boolean;
  /** Exageración visual del relieve (1 = normal, 2–3 = piedras más marcadas). */
  reliefBoost?: number;
  /** Contraste general de la carta (0.5 = suave, 1 = normal, 2 = muy marcado). */
  contrast?: number;
}


export const DEFAULT_SEAFLOOR: SeafloorSettings = {
  enabled: false,
  hillshade: true,
  hillshadeIntensity: 0.65,
  sunAzimuth: 315,
  sunAltitude: 45,
  contours: true,
  slope: false,
  roughness: false,
  structures: true,
  palette: "pesca",
  opacity: 0.85,
  focusGps: false,
  focusRadiusM: 800,
  microRelief: true,
};


