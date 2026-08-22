import { ManagedWmsTileLayer } from "./ManagedWmsTileLayer";
import { ShallowBathymetryLayer, SHALLOW_BATHYMETRY_PANE } from "./ShallowBathymetryLayer";

/**
 * Batimetría GLOBAL combinada:
 *  - Base mundial: GEBCO 2024 (cobertura 100% del planeta, ~450 m de resolución).
 *    Es lo que ve el usuario fuera de Europa, y también como fondo en Europa
 *    si EMODnet tarda o no tiene cobertura puntual.
 *  - Relieve EMODnet DTM (~115 m, Europa): usamos SIEMPRE las capas oceánicas
 *    (sin land cover) para no volver a pintar continentes/blancos pixelados
 *    encima del mapa base. Las teselas fuera de cobertura llegan transparentes
 *    y no rompen ni desplazan el render. NO usamos `bounds` restrictivos.
 *  - Hillshade + slope + isobatas EMODnet: detalle profesional Europa.
 *
 * El componente NUNCA bloquea el render: si EMODnet falla en una zona, el
 * mapa sigue mostrando GEBCO sin huecos.
 */
const GEBCO_BASE_PANE = "bathy-gebco-base-pane";
const RELIEF_PANE = "bathy-pane";
const COASTAL_RELIEF_PANE = "bathy-coastal-pane";
const HILLSHADE_PANE = "bathy-hillshade-pane";
const SLOPE_PANE = "bathy-slope-pane";
const CONTOUR_PANE = "bathy-contour-pane";
const COASTAL_CONTOUR_PANE = "bathy-coastal-contour-pane";

const EMODNET_WMS = "https://ows.emodnet-bathymetry.eu/wms";
// GEBCO 2024 global (cobertura mundial, alta resolución para fondo de visor).
const GEBCO_WMS = "https://wms.gebco.net/2024/mapserv";

// Parámetros WMS estándar. Preferimos 1.1.1 para evitar problemas de orden
// de ejes/BBOX en algunos servidores WMS 1.3.0 y forzamos Web Mercator desde
// Leaflet en ManagedWmsTileLayer.
const HD_PARAMS = {
  format: "image/png",
  transparent: true,
  version: "1.1.1",
} as const;

interface BathymetryLayerProps {
  /** Mostrar relieve del fondo (degradado azul + hillshade 3D). */
  showRelief: boolean;
  /** Mostrar isobatas (líneas de profundidad alta densidad). */
  showContours: boolean;
  /** Refuerzo costero / somero (0–60 m) para pesca en bahías y costa. */
  coastalEnhancement?: boolean;
  /** Mostrar capa de pendiente (slope) — azul/amarillo/rojo. */
  showSlope?: boolean;
  /** Opacidad del relieve 0-1. */
  reliefOpacity?: number;
  /** Opacidad del hillshade 0-1 (default 0.5). */
  hillshadeOpacity?: number;
  /**
   * Intensidad global del efecto 3D (hillshade + slope) 0–1.
   * Multiplica la opacidad de hillshade y slope para no tapar SST/CHL/ALT.
   * Default 1 (intensidad completa). 0 = invisibles.
   */
  reliefIntensity?: number;
  /**
   * Oculta las capas EMODnet (relieve, hillshade, isóbatas) porque el
   * viewport está totalmente cubierto por el DEM real MBAR24/IHM y no
   * queremos líneas dobles ni relieves superpuestos.
   */
  hideEmodnet?: boolean;
  /**
   * Oculta SOLO las isóbatas EMODnet (el relieve sigue visible) porque el
   * viewport solapa el DEM MBAR24, que ya dibuja sus propias curvas. Evita
   * isóbatas duplicadas y etiquetas repetidas.
   */
  hideEmodnetContours?: boolean;
  onTileError?: () => void;
}

export function BathymetryLayer({
  showRelief,
  showContours,
  coastalEnhancement = false,
  showSlope = false,
  reliefOpacity = 0.92,
  hillshadeOpacity = 0.5,
  reliefIntensity = 1,
  hideEmodnet = false,
  hideEmodnetContours = false,
  onTileError,
}: BathymetryLayerProps) {
  const hideContours = hideEmodnet || hideEmodnetContours;
  const intensity = Math.max(0, Math.min(1, reliefIntensity));
  const effectiveHillshade = hillshadeOpacity * intensity;
  const effectiveSlopeOpacity = 0.78 * intensity;
  const effectiveCoastalHillshade = Math.min(0.78, 0.18 + effectiveHillshade * 0.9);
  return (
    <>
      {showRelief && (
        <>
          {/* === BASE GLOBAL: GEBCO 2024 ===
              Cobertura mundial 100%. Es lo que ve el usuario fuera de Europa
              y como respaldo dentro de Europa si EMODnet falla en una tesela.
              Sin `bounds`: cubre todo el planeta. */}
          <ManagedWmsTileLayer
            key="gebco-global-base"
            registryKey="bathy-gebco-global-base"
            url={GEBCO_WMS}
            params={{
              format: "image/png",
              transparent: true,
              version: "1.1.1",
              layers: "GEBCO_2024_2",
            }}
            opacity={Math.min(1, reliefOpacity)}
            attribution='Batimetría base &copy; <a href="https://www.gebco.net/">GEBCO 2024</a>'
            pane={GEBCO_BASE_PANE}
            blendMode="normal"
            className="bathy-relief-tile bathy-relief-tile-gebco"
            maxZoom={19}
            onTileError={onTileError}
            removeOnError
          />

          {!hideEmodnet && (
          <>
          {/* === DETALLE EUROPA: EMODnet DTM (~115 m) ===
              SIN bounds restrictivos: el servidor devuelve teselas vacías/transparentes
              fuera de su cobertura, así que no rompe el render global y añade
              detalle automáticamente donde lo tiene. */}
          <ManagedWmsTileLayer
            key="emodnet-mean-atlas"
            registryKey="bathy-emodnet-mean-atlas"
            url={EMODNET_WMS}
            params={{
              ...HD_PARAMS,
              layers: "emodnet:mean",
            }}
            opacity={reliefOpacity}
            attribution='Detalle Europa &copy; <a href="https://emodnet.ec.europa.eu/">EMODnet Bathymetry DTM</a>'
            pane={RELIEF_PANE}
            blendMode="normal"
            className="bathy-relief-tile"
            maxZoom={19}
            onTileError={onTileError}
            removeOnError
          />
          {/* Hillshade EMODnet: define cañones, talud, bajos en Europa.
              Fuera de Europa la tesela es transparente — sin efecto adverso. */}
          <ManagedWmsTileLayer
            key="emodnet-hillshade"
            registryKey="bathy-emodnet-hillshade"
            url={EMODNET_WMS}
            params={{
              ...HD_PARAMS,
              layers: "emodnet:hillshade",
            }}
            opacity={effectiveHillshade}
            attribution=""
            pane={HILLSHADE_PANE}
            blendMode="multiply"
            className="bathy-hillshade-tile"
            maxZoom={19}
            onTileError={onTileError}
            removeOnError
          />
          {coastalEnhancement && (
            <>
              <ManagedWmsTileLayer
                key="emodnet-coastal-relief"
                registryKey="bathy-emodnet-coastal-relief"
                url={EMODNET_WMS}
                params={{
                  ...HD_PARAMS,
                  layers: "emodnet:mean_multicolour",
                  styles: "mean_multicolour",
                }}
                opacity={0.68}
                attribution=""
                pane={COASTAL_RELIEF_PANE}
                blendMode="multiply"
                className="bathy-relief-tile bathy-relief-tile-coastal"
                minZoom={9}
                maxZoom={19}
                onTileError={onTileError}
                removeOnError
              />
              <ManagedWmsTileLayer
                key="emodnet-coastal-hillshade"
                registryKey="bathy-emodnet-coastal-hillshade"
                url={EMODNET_WMS}
                params={{
                  ...HD_PARAMS,
                  layers: "emodnet:hillshade",
                }}
                opacity={effectiveCoastalHillshade}
                attribution=""
                pane={HILLSHADE_PANE}
                blendMode="multiply"
                className="bathy-hillshade-tile bathy-hillshade-tile-coastal"
                minZoom={9}
                maxZoom={19}
                onTileError={onTileError}
                removeOnError
              />
            </>
          )}
          </>
          )}
        </>
      )}

      {showSlope && (
        /* Pendiente del fondo (EMODnet, Europa). Fuera: transparente. */
        <ManagedWmsTileLayer
          key="emodnet-slope"
          registryKey="bathy-emodnet-slope"
          url={EMODNET_WMS}
          params={{
            ...HD_PARAMS,
            layers: "emodnet:slope",
          }}
          opacity={effectiveSlopeOpacity}
          attribution="Pendiente &copy; EMODnet"
          pane={SLOPE_PANE}
          blendMode="screen"
          className="bathy-slope-tile"
          maxZoom={19}
          onTileError={onTileError}
          removeOnError
        />
      )}

      {showContours && (
        <>
          {!hideContours && <ShallowBathymetryLayer />}
          {/* Isobatas EMODnet (Europa). Fuera de Europa: tesela transparente.
              EMODnet WMS sólo publica contornos generalizados de 50 m+;
              las líneas 10/20/30/40 m se dibujan arriba como vector real
              calculado desde EMODnet DTM WCS para Mallorca. */}
          {!hideContours && (
          <ManagedWmsTileLayer
            key="emodnet-contours"
            registryKey="bathy-emodnet-contours"
            url={EMODNET_WMS}
            params={{
              ...HD_PARAMS,
              layers: "emodnet:contours",
              styles: "contours",
            }}
            opacity={1}
            attribution='Isobatas &copy; <a href="https://emodnet.ec.europa.eu/">EMODnet</a>'
            pane={CONTOUR_PANE}
            blendMode="multiply"
            className="bathy-contours-tile bathy-contours-shallow bathy-contours-shelf bathy-contours-mid bathy-contours-deep"
            maxZoom={19}
            onTileError={onTileError}
            removeOnError
          />
          )}
          {!hideContours && coastalEnhancement && (
            <ManagedWmsTileLayer
              key="emodnet-contours-coastal-hd"
              registryKey="bathy-emodnet-contours-coastal-hd"
              url={EMODNET_WMS}
              params={{
                ...HD_PARAMS,
                layers: "emodnet:contours",
                styles: "contours",
              }}
              opacity={1}
              attribution=""
              pane={COASTAL_CONTOUR_PANE}
              blendMode="multiply"
              className="bathy-contours-tile bathy-contours-coastal bathy-contours-coastal-hd"
              minZoom={8}
              maxZoom={19}
              onTileError={onTileError}
              removeOnError
            />
          )}
        </>
      )}
    </>
  );
}

export const BATHY_PANES = {
  GEBCO_BASE_PANE,
  BATHY_PANE: RELIEF_PANE,
  COASTAL_RELIEF_PANE,
  HILLSHADE_PANE,
  SLOPE_PANE,
  CONTOUR_PANE,
  COASTAL_CONTOUR_PANE,
  SHALLOW_BATHYMETRY_PANE,
};

