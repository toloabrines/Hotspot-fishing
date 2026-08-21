import { useEffect, useRef } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";

type MapWithOceanTileRegistry = L.Map & {
  __oceanTileRegistry?: Map<string, L.TileLayer>;
};

interface ManagedWmsTileLayerProps {
  attribution?: string;
  className?: string;
  maxNativeZoom?: number;
  maxZoom: number;
  minZoom?: number;
  opacity: number;
  pane: string;
  params: L.WMSOptions;
  blendMode?: string;
  onTileError?: () => void;
  removeOnError?: boolean;
  registryKey?: string;
  url: string;
}

function cleanupManagedTileContainers(paneElement: HTMLElement | null) {
  if (!paneElement) return;
  paneElement
    .querySelectorAll<HTMLElement>("[data-ocean-tile-managed='true'], .leaflet-image-layer")
    .forEach((node) => {
      node.remove();
    });
}

export function ManagedWmsTileLayer({
  attribution = "",
  blendMode,
  className,
  maxNativeZoom,
  maxZoom,
  minZoom,
  opacity,
  onTileError,
  pane,
  params,
  removeOnError = false,
  registryKey,
  url,
}: ManagedWmsTileLayerProps) {
  const map = useMap();
  const layerRef = useRef<L.TileLayer | null>(null);
  const onTileErrorRef = useRef(onTileError);
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    onTileErrorRef.current = onTileError;
  }, [onTileError]);

  useEffect(() => {
    layerRef.current?.setOpacity(opacity);
  }, [opacity]);

  useEffect(() => {
    const registryMap = map as MapWithOceanTileRegistry;
    const registry = registryMap.__oceanTileRegistry ?? new Map<string, L.TileLayer>();
    registryMap.__oceanTileRegistry = registry;

    const layerKey = registryKey ?? pane;
    const previousLayer = registry.get(layerKey);
    if (previousLayer) {
      try {
        map.removeLayer(previousLayer);
      } catch {
        // no-op
      }
      registry.delete(layerKey);
    }

    const paneElement = map.getPane(pane) ?? null;
    cleanupManagedTileContainers(paneElement);

    // HiDPI / Retina: pedimos teselas al doble de resolución en pantallas con
    // devicePixelRatio > 1. Esto duplica los píxeles efectivos del WMS y hace
    // que el contorno de la costa, las isobatas y el hillshade se vean nítidos
    // al hacer zoom (sin pixelado, sin escalado borroso). Combinado con
    // `image-rendering: high-quality` (bicubic) en CSS, da el efecto de
    // antialiasing en costas como Mallorca, Alcúdia y Palma.
    const layer = L.tileLayer.wms(url, {
      attribution,
      className: [className, "ocean-tile-smooth"].filter(Boolean).join(" "),
      crossOrigin: true,
      crs: L.CRS.EPSG3857,
      keepBuffer: 2,
      maxNativeZoom,
      maxZoom,
      minZoom,
      opacity,
      pane,
      tileSize: 256,
      detectRetina: true,
      updateWhenIdle: true,
      updateWhenZooming: false,
      uppercase: true,
      noWrap: true,
      ...params,
    });

    let errorCount = 0;
    let removedDueToError = false;

    const applyVisualState = () => {
      const container = layer.getContainer();
      if (!container) return;
      container.dataset.oceanTileManaged = "true";
      container.style.background = "transparent";
      container.style.backgroundColor = "transparent";
      if (blendMode) container.style.mixBlendMode = blendMode;
    };

    const handleTileError = () => {
      errorCount += 1;
      if (errorCount < 4) return;

      onTileErrorRef.current?.();
      if (!removeOnError || removedDueToError) return;

      removedDueToError = true;
      if (registry.get(layerKey) === layer) {
        registry.delete(layerKey);
      }
      try {
        map.removeLayer(layer);
      } catch {
        // no-op
      }
      cleanupManagedTileContainers(map.getPane(pane) ?? null);
    };

    const handleLoad = () => {
      errorCount = 0;
      applyVisualState();
    };

    layer.on("tileerror", handleTileError);
    layer.on("load", handleLoad);
    layer.addTo(map);
    layerRef.current = layer;
    registry.set(layerKey, layer);
    applyVisualState();

    return () => {
      layer.off("tileerror", handleTileError);
      layer.off("load", handleLoad);
      if (registry.get(layerKey) === layer) {
        registry.delete(layerKey);
      }
      if (layerRef.current === layer) {
        layerRef.current = null;
      }
      try {
        map.removeLayer(layer);
      } catch {
        // no-op
      }
      cleanupManagedTileContainers(map.getPane(pane) ?? null);
    };
  }, [
    attribution,
    blendMode,
    className,
    map,
    maxNativeZoom,
    maxZoom,
    minZoom,
    pane,
    paramsKey,
    registryKey,
    removeOnError,
    url,
  ]);

  return null;
}

