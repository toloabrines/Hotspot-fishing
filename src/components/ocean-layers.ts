export type LayerType =
  | "chl"
  | "chl_hc"
  | "chl_micro"
  | "chl_nano"
  | "chl_pico"
  | "chl_monthly"
  | "chl_bbp"
  | "chl_cdm"
  | "sst_analysed"
  | "sst_skin"
  | "sst_error"
  | "sst_ice"
  | "sst_nrt"
  | "sst_nrt_hc"
  | "sst_bottom"
  | "sst_d10"
  | "sst_d20"
  | "sst_d30"
  | "sst_d50"
  | "sst_d100"
  | "alt_sla"
  | "alt_adt"
  | "alt_adt_micro"
  | "alt_ugos"
  | "alt_vgos"
  | "alt_ugosa"
  | "alt_vgosa"
  | "alt_eke"
  | "alt_combined"
  | "alt_currents";

export type LayerGroup = "chlorophyll" | "sst" | "altimetry";

export interface TimeRange {
  min: string;
  max: string;
}

export interface LayerConfig {
  wmtsLayer: string;
  style: string;
  label: string;
  unit: string;
  group: LayerGroup;
  /** Native max zoom level supported by the dataset (resolution limit) */
  nativeZoom: number;
  /** Approximate native resolution in km/pixel */
  resolutionKm: number;
  /** Time coverage available in Copernicus WMTS for this layer (YYYY-MM-DD). */
  timeRange?: TimeRange;
  /** Extra WMTS layers to overlay (e.g. currents on top of height) */
  overlayLayers?: { wmtsLayer: string; style: string }[];
  /** Render animated streamlines instead of WMTS tiles */
  velocityLayer?: boolean;
  /** ELEVATION parameter appended to WMTS GetTile (negative = deeper). */
  elevation?: number;
}


// El WMTS de SST sólo anuncia `cmap:thermal`; otros nombres como `Reds` son
// ignorados y el servidor devuelve el mismo amarillo global. Por eso el tono
// rojo/alto contraste se aplica en cliente sobre el tile (OceanMaskedTileLayer),
// no confiando en vmin/vmax/cmap del servidor.
const SST_CMAP = "thermal";
// Clorofila: quitamos las paletas verdes. En el Mediterráneo casi todos los
// valores caen en el tramo verde de `turbo/Greens`, por eso parecía una capa
// plana. `magma` da bajo=violeta oscuro y alto=amarillo/blanco, sin verde.
const CHL_CMAP = "magma";

// L4 = gap-free interpolated (sin huecos de nubes), L3 = observación cruda
const CHL_L4_DAILY =
  "OCEANCOLOUR_GLO_BGC_L4_NRT_009_102/cmems_obs-oc_glo_bgc-plankton_nrt_l4-gapfree-multi-4km_P1D_202311";
const CHL_L3_DAILY =
  "OCEANCOLOUR_GLO_BGC_L3_NRT_009_101/cmems_obs-oc_glo_bgc-plankton_nrt_l3-multi-4km_P1D_202411";
const CHL_MONTHLY =
  "OCEANCOLOUR_GLO_BGC_L4_MY_009_108/c3s_obs-oc_glo_bgc-plankton_my_l4-multi-4km_P1M_202207";
const OPTICS =
  "OCEANCOLOUR_GLO_BGC_L3_MY_009_103/cmems_obs-oc_glo_bgc-optics_my_l3-multi-4km_P1D_202311";
// SST de ALTA RESOLUCIÓN (~1 km) — producto L4 NRT global, ideal para pesca:
// permite ver frentes térmicos finos y eddies costeros que el producto de 5 km
// no resuelve. https://data.marine.copernicus.eu/product/SST_GLO_SST_L4_NRT_OBSERVATIONS_010_001
const SST_HR = "SST_GLO_SST_L4_NRT_OBSERVATIONS_010_001/METOFFICE-GLO-SST-L4-NRT-OBS-SST-V2";
const SST_REP = "SST_GLO_SST_L4_REP_OBSERVATIONS_010_024/C3S-GLO-SST-L4-REP-OBS-SST_202506";
const SST_NRT =
  "SST_GLO_SST_L3S_NRT_OBSERVATIONS_010_010/cmems_obs-sst_glo_phy_l3s_gir_P1D-m_202311";
// MEDSEA modelo regional (1/24° ≈ 4.2 km) — sea surface height (zos).
// Lo usamos para sustituir el fondo de `alt_currents` cuando el viewport
// está dentro del Mediterráneo: el producto global de altimetría (25 km)
// no resuelve los eddies/frentes que el visor de Copernicus muestra aquí.
const MED_SSH = "MEDSEA_ANALYSISFORECAST_PHY_006_013/cmems_mod_med_phy-ssh_anfc_4.2km_P1D-m_202511";
const MED_TEMP =
  "MEDSEA_ANALYSISFORECAST_PHY_006_013/cmems_mod_med_phy-tem_anfc_4.2km_P1D-m_202511";
const ALT_DAILY =
  "SEALEVEL_GLO_PHY_L4_NRT_008_046/cmems_obs-sl_glo_phy-ssh_nrt_allsat-l4-duacs-0.125deg_P1D_202506";
const ALT_MONTHLY =
  "SEALEVEL_GLO_PHY_CLIMATE_L4_MY_008_057/c3s_obs-sl_glo_phy-ssh_my_twosat-l4-duacs-0.25deg_P1M-m_202411";

// Rangos temporales confirmados desde el WMTS GetCapabilities de Copernicus.
const TIME_RANGES = {
  CHL_DAILY: { min: "2026-04-13", max: "2099-12-31" },
  CHL_MONTHLY: { min: "1997-09-01", max: "2026-03-01" },
  OPTICS_DAILY: { min: "1997-09-04", max: "2099-12-31" },
  SST_REP_DAILY: { min: "1982-01-01", max: "2024-12-31" },
  SST_HR_DAILY: { min: "2024-01-17", max: "2099-12-31" },
  SST_NRT_DAILY: { min: "2024-01-17", max: "2099-12-31" },
  ALT_DAILY: { min: "2024-07-01", max: "2099-12-31" },
  ALT_MONTHLY: { min: "1993-01-01", max: "2025-04-01" },
  MED_SSH_DAILY: { min: "2022-01-01", max: "2099-12-31" },
} as const satisfies Record<string, TimeRange>;

// Resolución nativa típica.
// Pedimos al servidor WMTS un nativeZoom más alto: Copernicus interpola
// server-side y devuelve teselas más suaves que estirarlas en cliente.
const RES_1KM = { nativeZoom: 13, resolutionKm: 1 };
const RES_4KM = { nativeZoom: 12, resolutionKm: 4 };
const RES_5KM = { nativeZoom: 12, resolutionKm: 5 };
const RES_25KM = { nativeZoom: 9, resolutionKm: 25 };

export const LAYER_CONFIGS: Record<LayerType, LayerConfig> = {
  chl: {
    wmtsLayer: `${CHL_L4_DAILY}/CHL`,
    // Paleta sin verde con rango calibrado a aguas oligotróficas mediterráneas
    // (0.04–0.30 mg/m³). Cuando la capa se activa, el contraste adaptativo
    // por viewport ajusta finamente min/max al rango real visible, así el
    // mar deja de aparecer como un único color verde plano.
    style: `cmap:${CHL_CMAP},logscale:true,vmin:0.04,vmax:0.3`,
    label: "Clorofila-a (L4 sin huecos)",
    unit: "mg/m³",
    group: "chlorophyll",
    timeRange: TIME_RANGES.CHL_DAILY,
    ...RES_4KM,
  },
  chl_monthly: {
    wmtsLayer: `${CHL_MONTHLY}/CHL`,
    style: `cmap:${CHL_CMAP},logscale:true,vmin:0.01,vmax:20`,
    label: "Clorofila-a (mensual)",
    unit: "mg/m³",
    group: "chlorophyll",
    timeRange: TIME_RANGES.CHL_MONTHLY,
    ...RES_4KM,
  },
  chl_micro: {
    wmtsLayer: `${CHL_L3_DAILY}/MICRO`,
    style: `cmap:${CHL_CMAP},logscale:true,vmin:0.01,vmax:10`,
    label: "Microfitoplancton",
    unit: "mg/m³",
    group: "chlorophyll",
    timeRange: TIME_RANGES.CHL_DAILY,
    ...RES_4KM,
  },
  chl_nano: {
    wmtsLayer: `${CHL_L3_DAILY}/NANO`,
    style: `cmap:${CHL_CMAP},logscale:true,vmin:0.01,vmax:10`,
    label: "Nanofitoplancton",
    unit: "mg/m³",
    group: "chlorophyll",
    timeRange: TIME_RANGES.CHL_DAILY,
    ...RES_4KM,
  },
  chl_pico: {
    wmtsLayer: `${CHL_L3_DAILY}/PICO`,
    style: `cmap:${CHL_CMAP},logscale:true,vmin:0.01,vmax:10`,
    label: "Picofitoplancton",
    unit: "mg/m³",
    group: "chlorophyll",
    timeRange: TIME_RANGES.CHL_DAILY,
    ...RES_4KM,
  },
  chl_bbp: {
    wmtsLayer: `${OPTICS}/BBP`,
    style: `cmap:${CHL_CMAP},logscale:true,vmin:0.0005,vmax:0.05`,
    label: "Retrodispersión (BBP)",
    unit: "m⁻¹",
    group: "chlorophyll",
    timeRange: TIME_RANGES.OPTICS_DAILY,
    ...RES_4KM,
  },
  chl_cdm: {
    wmtsLayer: `${OPTICS}/CDM`,
    style: `cmap:${CHL_CMAP},logscale:true,vmin:0.005,vmax:2`,
    label: "Mat. Orgánica Disuelta (CDM)",
    unit: "m⁻¹",
    group: "chlorophyll",
    timeRange: TIME_RANGES.OPTICS_DAILY,
    ...RES_4KM,
  },
  sst_analysed: {
    wmtsLayer: `${SST_HR}/analysed_sst`,
    style: `cmap:${SST_CMAP},vmin:288.15,vmax:296.15`,
    label: "SST temperatura real",
    unit: "°C",
    group: "sst",
    timeRange: TIME_RANGES.SST_HR_DAILY,
    ...RES_1KM,
  },
  sst_skin: {
    wmtsLayer: `${SST_HR}/analysed_sst`,
    style: `cmap:${SST_CMAP},vmin:271.15,vmax:305.15`,
    label: "SST temperatura real",
    unit: "°C",
    group: "sst",
    timeRange: TIME_RANGES.SST_HR_DAILY,
    ...RES_1KM,
  },
  sst_error: {
    wmtsLayer: `${SST_HR}/analysis_error`,
    style: "cmap:magma,vmin:0,vmax:2",
    label: "Error del Análisis SST",
    unit: "°C",
    group: "sst",
    timeRange: TIME_RANGES.SST_HR_DAILY,
    ...RES_1KM,
  },
  sst_ice: {
    wmtsLayer: `${SST_HR}/sea_ice_fraction`,
    style: "cmap:Blues,vmin:0,vmax:1",
    label: "Fracción de Hielo Marino",
    unit: "%",
    group: "sst",
    timeRange: TIME_RANGES.SST_HR_DAILY,
    ...RES_1KM,
  },
  // Temperatura del FONDO marino (bottomT del modelo MEDSEA Copernicus 1/24°).
  // Útil para pesca de fondo: T real cerca del sedimento, no la superficie.
  // Producto: MEDSEA_ANALYSISFORECAST_PHY_006_013. Rango 12-20 °C típico
  // Mediterráneo occidental a >50 m. La autoescala viewport lo afina.
  sst_bottom: {
    wmtsLayer: `${MED_TEMP}/bottomT`,
    style: `cmap:${SST_CMAP},vmin:285.15,vmax:293.15`,
    label: "Temperatura de fondo (MEDSEA)",
    unit: "°C",
    group: "sst",
    timeRange: TIME_RANGES.MED_SSH_DAILY,
    nativeZoom: 12,
    resolutionKm: 4,
  },
  // Temperatura a profundidad — modelo MEDSEA (thetao 3D, 4 km, Mediterráneo).
  // Producto: MEDSEA_ANALYSISFORECAST_PHY_006_013. La profundidad concreta la
  // fija el parámetro ELEVATION (negativo hacia abajo); Copernicus snap-ea al
  // nivel de modelo más cercano.
  sst_d10: {
    wmtsLayer: `${MED_TEMP}/thetao`,
    style: `cmap:${SST_CMAP},vmin:288.15,vmax:299.15`,
    label: "T a 10 m (MEDSEA)",
    unit: "°C",
    group: "sst",
    timeRange: { min: "2022-01-01", max: "2099-12-31" },
    nativeZoom: 11,
    resolutionKm: 4,
    elevation: -10,
  },
  sst_d20: {
    wmtsLayer: `${MED_TEMP}/thetao`,
    style: `cmap:${SST_CMAP},vmin:287.15,vmax:298.15`,
    label: "T a 20 m (MEDSEA)",
    unit: "°C",
    group: "sst",
    timeRange: { min: "2022-01-01", max: "2099-12-31" },
    nativeZoom: 11,
    resolutionKm: 4,
    elevation: -20,
  },
  sst_d30: {
    wmtsLayer: `${MED_TEMP}/thetao`,
    style: `cmap:${SST_CMAP},vmin:286.15,vmax:296.15`,
    label: "T a 30 m (MEDSEA)",
    unit: "°C",
    group: "sst",
    timeRange: { min: "2022-01-01", max: "2099-12-31" },
    nativeZoom: 11,
    resolutionKm: 4,
    elevation: -30,
  },
  sst_d50: {
    wmtsLayer: `${MED_TEMP}/thetao`,
    style: `cmap:${SST_CMAP},vmin:285.15,vmax:293.15`,
    label: "T a 50 m (MEDSEA)",
    unit: "°C",
    group: "sst",
    timeRange: { min: "2022-01-01", max: "2099-12-31" },
    nativeZoom: 11,
    resolutionKm: 4,
    elevation: -50,
  },
  sst_d100: {
    wmtsLayer: `${MED_TEMP}/thetao`,
    style: `cmap:${SST_CMAP},vmin:285.15,vmax:291.15`,
    label: "T a 100 m (MEDSEA)",
    unit: "°C",
    group: "sst",
    timeRange: { min: "2022-01-01", max: "2099-12-31" },
    nativeZoom: 11,
    resolutionKm: 4,
    elevation: -100,
  },
  sst_nrt: {
    wmtsLayer: `${SST_HR}/analysed_sst`,
    // Rango fijo Mediterráneo: no se sustituye por escala local para evitar
    // rectángulos de color engañosos.
    style: `cmap:${SST_CMAP},vmin:288.15,vmax:296.15`,
    label: "SST temperatura real",
    unit: "°C",
    group: "sst",
    timeRange: TIME_RANGES.SST_HR_DAILY,
    ...RES_1KM,
  },
  // Modo "contraste alto" — rango aún más estrecho (16–26 °C) para resaltar
  // microfrentes térmicos en zonas con poca variación (verano Mediterráneo).
  sst_nrt_hc: {
    wmtsLayer: `${SST_HR}/analysed_sst`,
    style: `cmap:${SST_CMAP},vmin:289.15,vmax:295.15`,
    label: "SST temperatura real",
    unit: "°C",
    group: "sst",
    timeRange: TIME_RANGES.SST_HR_DAILY,
    ...RES_1KM,
  },
  chl_hc: {
    wmtsLayer: `${CHL_L4_DAILY}/CHL`,
    // Alto contraste extremo para Med oligotrófico: 0.04–0.10 mg/m³.
    // Toda la paleta turbo se reparte en una ventana muy estrecha para
    // resaltar microfrentes productivos imperceptibles con el rango normal.
    style: `cmap:${CHL_CMAP},logscale:true,vmin:0.04,vmax:0.1`,
    label: "Clorofila Alto Contraste",
    unit: "mg/m³",
    group: "chlorophyll",
    timeRange: TIME_RANGES.CHL_DAILY,
    ...RES_4KM,
  },

  alt_sla: {
    wmtsLayer: `${ALT_DAILY}/sla`,
    style: "cmap:RdBu_r,vmin:-0.4,vmax:0.4",
    label: "Anomalía Nivel del Mar (SLA)",
    unit: "m",
    group: "altimetry",
    timeRange: TIME_RANGES.ALT_DAILY,
    ...RES_25KM,
  },
  alt_adt: {
    wmtsLayer: `${ALT_DAILY}/adt`,
    // ADT en Med ronda -0.5..-0.1 m y en Atlántico ibérico -0.2..+0.3 m.
    // Rango asimétrico -0.6..+0.4 para que AMBAS cuencas muestren gradiente
    // en lugar de saturar el Mediterráneo a azul uniforme.
    style: "cmap:seismic,vmin:-0.6,vmax:0.4",
    label: "Topografía Dinámica Abs. (ADT)",
    unit: "m",
    group: "altimetry",
    timeRange: TIME_RANGES.ALT_DAILY,
    ...RES_25KM,
  },
  // Altimetría Micro: mismos datos reales que alt_adt, pero pensada para
  // detectar microestructura (bordes, giros y corrientes débiles) en zonas
  // de bajo contraste como el Mediterráneo. La paleta `turbo` da saltos
  // azul/verde/amarillo/rojo muy marcados, y el rango ±0.25 m es el límite
  // físico máximo. La autoescala viewport (P5–P95) afina el rango a la zona
  // visible — ver ViewportAdaptiveContrast.
  alt_adt_micro: {
    wmtsLayer: `${ALT_DAILY}/adt`,
    style: "cmap:turbo,vmin:-0.25,vmax:0.25",
    label: "Altimetría Micro (alto contraste local)",
    unit: "m",
    group: "altimetry",
    timeRange: TIME_RANGES.ALT_DAILY,
    ...RES_25KM,
  },
  alt_ugos: {
    wmtsLayer: `${ALT_DAILY}/ugos`,
    style: "cmap:RdBu_r,vmin:-1.2,vmax:1.2",
    label: "Corriente Geostrófica U",
    unit: "m/s",
    group: "altimetry",
    timeRange: TIME_RANGES.ALT_DAILY,
    ...RES_25KM,
  },
  alt_vgos: {
    wmtsLayer: `${ALT_DAILY}/vgos`,
    style: "cmap:RdBu_r,vmin:-1.2,vmax:1.2",
    label: "Corriente Geostrófica V",
    unit: "m/s",
    group: "altimetry",
    timeRange: TIME_RANGES.ALT_DAILY,
    ...RES_25KM,
  },
  alt_ugosa: {
    wmtsLayer: `${ALT_DAILY}/ugosa`,
    style: "cmap:RdBu_r,vmin:-0.5,vmax:0.5",
    label: "Anomalía Corriente U",
    unit: "m/s",
    group: "altimetry",
    timeRange: TIME_RANGES.ALT_DAILY,
    ...RES_25KM,
  },
  alt_vgosa: {
    wmtsLayer: `${ALT_DAILY}/vgosa`,
    style: "cmap:RdBu_r,vmin:-0.5,vmax:0.5",
    label: "Anomalía Corriente V",
    unit: "m/s",
    group: "altimetry",
    timeRange: TIME_RANGES.ALT_DAILY,
    ...RES_25KM,
  },
  alt_eke: {
    wmtsLayer: `${ALT_MONTHLY}/eke`,
    style: "cmap:inferno,logscale:true,vmin:0.001,vmax:1",
    label: "Energía Cinética Remolinos (EKE)",
    unit: "m²/s²",
    group: "altimetry",
    timeRange: TIME_RANGES.ALT_MONTHLY,
    ...RES_25KM,
  },
  alt_combined: {
    wmtsLayer: `${ALT_DAILY}/adt`,
    // Rango asimétrico -0.6..+0.4 m: cubre tanto el Mediterráneo (ADT
    // típicamente negativo, ~-0.5..-0.1 m) como el Atlántico ibérico
    // (~-0.2..+0.3 m). Con ±0.25 el Med saturaba a azul plano.
    style: "cmap:seismic,vmin:-0.6,vmax:0.4",
    label: "Corrientes + Altura del Mar",
    unit: "m / m·s⁻¹",
    group: "altimetry",
    timeRange: TIME_RANGES.ALT_DAILY,
    ...RES_25KM,
    overlayLayers: [
      // Corrientes geostróficas reales raramente superan ±0.5 m/s salvo en
      // chorros (Gulf Stream, Agulhas). ±1.2 hacía invisible la dinámica.
      { wmtsLayer: `${ALT_DAILY}/ugos`, style: "cmap:RdBu_r,vmin:-0.5,vmax:0.5" },
      { wmtsLayer: `${ALT_DAILY}/vgos`, style: "cmap:RdBu_r,vmin:-0.5,vmax:0.5" },
    ],
  },
  alt_currents: {
    wmtsLayer: `${ALT_DAILY}/adt`,
    // Paleta oceánica profesional `cmo.balance` (estilo Copernicus Viewer):
    // azul profundo → blanco → rojo intenso, con transiciones nítidas que
    // resaltan remolinos y frentes. Rango ±0.15 m base (la autoescala
    // viewport lo ajusta a P15–P85 reales, ver ViewportAdaptiveContrast)
    // para que en el Mediterráneo (ADT típica -0.15..-0.05 m) se vea
    // gradiente real en lugar de un cian plano.
    style: "cmap:cmo.balance,vmin:-0.15,vmax:0.15",
    label: "Corrientes + líneas SSH",
    unit: "m / m·s⁻¹",
    group: "altimetry",
    timeRange: TIME_RANGES.ALT_DAILY,
    ...RES_25KM,
    overlayLayers: [
      // Componentes geostróficas más sensibles para que las flechas/líneas
      // de corriente sean visibles incluso con velocidades débiles (~0.1 m/s).
      { wmtsLayer: `${ALT_DAILY}/ugos`, style: "cmap:RdBu_r,vmin:-0.3,vmax:0.3" },
      { wmtsLayer: `${ALT_DAILY}/vgos`, style: "cmap:RdBu_r,vmin:-0.3,vmax:0.3" },
    ],
  },
};

// Variante regional de altimetría para el Mediterráneo. Misma "ranura" visual
// que ADT/corrientes, pero usa el modelo MEDSEA a 1/24° (~4 km), que SÍ
// resuelve eddies y frentes que el producto global de altimetría (25 km) deja
// planos. El rango está centrado en valores MEDSEA reales observados en Baleares
// y Mediterráneo occidental (~-0.54..-0.33 m); usar ±0.3 saturaba todo a azul.
export const MED_ALTIMETRY_CONFIG: LayerConfig = {
  wmtsLayer: `${MED_SSH}/zos`,
  style: "cmap:cmo.balance,vmin:-0.55,vmax:-0.33",
  label: "Altura del mar SSH (Med 1/24°)",
  unit: "m / m·s⁻¹",
  group: "altimetry",
  timeRange: TIME_RANGES.MED_SSH_DAILY,
  nativeZoom: 11,
  resolutionKm: 4,
};

export const MED_ALT_CURRENTS_CONFIG: LayerConfig = {
  ...MED_ALTIMETRY_CONFIG,
  label: "Corrientes + líneas SSH (Med 1/24°)",
};

// Variante regional de clorofila para el Mediterráneo. Producto MEDSEA L4
// gapfree a 1 km (vs. 4 km del producto global), que sí resuelve plumas
// costeras, filamentos y frentes biológicos finos invisibles en el producto
// global. Rango log estrecho (0.04–0.4 mg/m³) calibrado para aguas
// oligotróficas mediterráneas típicas.
const MED_CHL_DAILY =
  "OCEANCOLOUR_MED_BGC_L4_NRT_009_142/cmems_obs-oc_med_bgc-plankton_nrt_l4-gapfree-multi-1km_P1D_202207";

export const MED_CHL_CONFIG: LayerConfig = {
  wmtsLayer: `${MED_CHL_DAILY}/CHL`,
  // Rango log muy estrecho para pesca en Mediterráneo oligotrófico: concentra
  // toda la paleta en 0.045–0.13 mg/m³, donde están los filamentos y frentes
  // útiles. Magma evita el verde plano: bajo=violeta oscuro, alto=amarillo.
  style: `cmap:${CHL_CMAP},logscale:true,vmin:0.045,vmax:0.13`,
  label: "Clorofila-a (Med 1 km)",
  unit: "mg/m³",
  group: "chlorophyll",
  timeRange: { min: "2022-01-01", max: "2099-12-31" },
  nativeZoom: 13,
  resolutionKm: 1,
};

export const MED_CHL_HC_CONFIG: LayerConfig = {
  ...MED_CHL_CONFIG,
  // Detalle máximo: rango ultra estrecho para que incluso microvariaciones de
  // clorofila baja salten de color en zonas abiertas; la costa puede saturar.
  style: `cmap:${CHL_CMAP},logscale:true,vmin:0.05,vmax:0.095`,
  label: "CHL Detalle Mediterráneo (1 km)",
};

