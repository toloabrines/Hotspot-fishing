/**
 * Tipos y defaults de isolíneas — SIN imports de leaflet/react-leaflet, para
 * que se puedan importar de forma segura desde código SSR (rutas, paneles).
 */
export interface IsolineSettings {
  enabled: boolean;
  sst: boolean;
  chlorophyll: boolean;
  altimetry: boolean;
  /** 1 = pocas (5 bandas), 5 = más densas (14 bandas). */
  density: number;
  /** Halo cálido en convergencia de isolíneas (zonas de frente). */
  highlightGradients: boolean;
}

export const DEFAULT_ISOLINES: IsolineSettings = {
  enabled: true,
  sst: true,
  chlorophyll: true,
  altimetry: true,
  density: 2,
  highlightGradients: true,
};

