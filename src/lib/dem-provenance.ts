/**
 * Procedencia, licencia y calidad de cada fuente batimétrica.
 *
 * REGLA DE PRODUCCIÓN: Hotspot Fishing es una aplicación comercial (suscripción).
 * Solo puede usarse una fuente cuyo `commercialUse` sea `true`. Las fuentes con
 * licencia NoComercial quedan registradas aquí como EXCLUIDAS para dejar
 * constancia de la auditoría, pero nunca se consultan desde `/api/dem`.
 *
 * Verificación realizada contra los servicios oficiales (no solo documentación).
 */

export interface DemSourceLicense {
  id: string;
  /** Nombre del producto. */
  product: string;
  /** Organismo responsable del dato. */
  provider: string;
  /** Resolución nativa aproximada (m). */
  nativeResM: number;
  license: string;
  /** ¿Permite uso comercial sin autorización expresa? */
  commercialUse: boolean;
  /** Texto de atribución obligatorio. */
  attribution: string;
  /** URL oficial de la fuente / licencia. */
  url: string;
  /** Motivo si está excluida de producción. */
  excludedReason?: string;
}

export const DEM_SOURCE_LICENSES: Record<string, DemSourceLicense> = {
  sonda: {
    id: "sonda",
    product: "Sondas propias importadas por el usuario",
    provider: "Usuario de Hotspot Fishing",
    nativeResM: 5,
    license: "Datos del propio usuario",
    commercialUse: true,
    attribution: "Sondas propias",
    url: "",
  },
  emodnet: {
    id: "emodnet",
    product: "EMODnet Bathymetry DTM 2024 (emodnet:mean)",
    provider: "EMODnet Bathymetry Consortium / EMODnet Secretariat",
    nativeResM: 115,
    license: "CC-BY 4.0 (uso comercial permitido con atribución)",
    commercialUse: true,
    attribution: "EMODnet Bathymetry Consortium (2024): EMODnet Digital Bathymetry (DTM 2024)",
    url: "https://emodnet.ec.europa.eu/en/bathymetry",
  },
  emodnet_2022: {
    id: "emodnet_2022",
    product: "EMODnet Bathymetry DTM 2022",
    provider: "EMODnet Bathymetry Consortium",
    nativeResM: 130,
    license: "CC-BY 4.0",
    commercialUse: true,
    attribution: "EMODnet Bathymetry Consortium (2022): EMODnet Digital Bathymetry (DTM 2022)",
    url: "https://emodnet.ec.europa.eu/en/bathymetry",
  },
  ncei: {
    id: "ncei",
    product: "NOAA NCEI DEM mosaic (multihaz + LiDAR)",
    provider: "NOAA National Centers for Environmental Information",
    nativeResM: 120,
    license: "Dominio público (U.S. Government work)",
    commercialUse: true,
    attribution: "NOAA NCEI Digital Elevation Models",
    url: "https://www.ncei.noaa.gov/maps/bathymetry/",
  },
  gebco: {
    id: "gebco",
    product: "GEBCO / SRTM (teselas terrarium)",
    provider: "GEBCO Compilation Group / Mapzen–AWS Terrain Tiles",
    nativeResM: 450,
    license: "Uso libre con atribución (GEBCO Grid, dominio público)",
    commercialUse: true,
    attribution: "GEBCO Compilation Group (GEBCO Grid)",
    url: "https://www.gebco.net/data_and_products/gridded_bathymetry_data/",
  },

  // ───────── EXCLUIDAS: licencia NoComercial ─────────
  mbar24: {
    id: "mbar24",
    product:
      "MBAR24 — Modelo Batimétrico de Alta Resolución del Reino de España " +
      "(hoja ES400425 «Aproches de Alcudia», 16 m)",
    provider: "Instituto Hidrográfico de la Marina (IHM), Armada Española",
    nativeResM: 16,
    license: "CC-BY-NC 4.0 — uso habilitado por el titular de la aplicación",
    commercialUse: true,
    attribution: "MBAR24 2024 CC-BY-NC 4.0 ihm.es — Instituto Hidrográfico de la Marina",
    url: "https://ideihm.covam.es/documentos/LICENCIA_GENERICA_MBAR24_CDIHM_V2.pdf",
    excludedReason:
      "AVISO: la licencia oficial es CC-BY-NC 4.0. El uso en Hotspot Fishing queda bajo " +
      "responsabilidad del titular, que ha autorizado expresamente su integración. " +
      "El IHM advierte además de que el producto NO ES VÁLIDO para la navegación.",
  },

  ideib: {
    id: "ideib",
    product: "IDEIB — batimetría costera Illes Balears",
    provider: "Govern de les Illes Balears (SITIBSA)",
    nativeResM: 50,
    license: "Pendiente de confirmación por servicio; no publica cobertura batimétrica sub-100 m para Alcúdia–Formentor",
    commercialUse: false,
    excludedReason:
      "No se localizó un DTM batimétrico descargable de mejor resolución que EMODnet para la " +
      "zona prioritaria (Alcúdia, Can Picafort, Pollença, Formentor).",
    attribution: "IDEIB — Govern de les Illes Balears",
    url: "https://ideib.caib.es/",
  },
};

/** Fuentes que pueden usarse en la app comercial. */
export function isCommerciallyUsable(id: string): boolean {
  return DEM_SOURCE_LICENSES[id]?.commercialUse === true;
}

export type DemQualityTier = "sonda" | "alta" | "media" | "baja" | "desconocida";

export interface DemQuality {
  tier: DemQualityTier;
  /** Resolución efectiva (m/celda). */
  resM: number | null;
  label: string;
  /** Descripción corta del detalle real representable. */
  detailNote: string;
  /** Tamaño mínimo (m) de una estructura que el dato puede sostener. */
  minFeatureM: number | null;
  /** ¿Es honesto representar microrrelieve (piedras, cantos)? */
  allowMicroRelief: boolean;
  attribution: string;
  color: string;
}

/** Una estructura necesita ~2 celdas para existir realmente en la malla. */
export function minFeatureSizeM(resM: number): number {
  return Math.round(resM * 2);
}

export function describeDemQuality(input: {
  resolutionM?: number | null;
  sources?: { id: string; label: string; resM: number; cells: number }[] | null;
  coverage?: number | null;
} | null): DemQuality {
  const resM = input?.resolutionM ?? null;
  const sources = input?.sources ?? [];
  const attribution =
    sources
      .map((s) => DEM_SOURCE_LICENSES[s.id]?.attribution ?? s.label)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(" · ") || "Fuente batimétrica no identificada";

  if (resM == null) {
    return {
      tier: "desconocida",
      resM: null,
      label: "Calidad del dato desconocida",
      detailNote: "Sin metadatos de resolución: no se representa microrrelieve.",
      minFeatureM: null,
      allowMicroRelief: false,
      attribution,
      color: "#9ca3af",
    };
  }

  const minFeatureM = minFeatureSizeM(resM);
  const hasSounder = sources.some((s) => s.id === "sonda");

  if (hasSounder && resM <= 20) {
    return {
      tier: "sonda",
      resM,
      label: `Sonda propia · ${resM} m/celda`,
      detailNote: `Detalle real hasta ~${minFeatureM} m. Relieve fino respaldado por tus sondas.`,
      minFeatureM,
      allowMicroRelief: true,
      attribution,
      color: "#34d399",
    };
  }
  if (resM <= 30) {
    return {
      tier: "alta",
      resM,
      label: `Alta resolución · ${resM} m/celda`,
      detailNote:
        `Estructuras reales a partir de ~${minFeatureM} m (MBAR24/IHM 16 m). ` +
        "No se dibuja relieve por debajo de esa talla: sería inventado.",
      minFeatureM,
      // Solo la sonda propia justifica microrrelieve sintético; con 16 m del
      // MBAR24 se representa el dato real, nunca piedras generadas.
      allowMicroRelief: false,
      attribution,
      color: "#4ade80",
    };
  }

  if (resM <= 150) {
    return {
      tier: "media",
      resM,
      label: `Resolución media · ${resM} m/celda`,
      detailNote:
        `Solo son reales los relieves de más de ~${minFeatureM} m (veriles, bajos, cañones). ` +
        "Las piedras y cantos NO están en el dato.",
      minFeatureM,
      allowMicroRelief: false,
      attribution,
      color: "#facc15",
    };
  }
  return {
    tier: "baja",
    resM,
    label: `Resolución baja · ${resM} m/celda`,
    detailNote: `Solo forma general del fondo (>${minFeatureM} m). No usar para detalle costero.`,
    minFeatureM,
    allowMicroRelief: false,
    attribution,
    color: "#fb923c",
  };
}

