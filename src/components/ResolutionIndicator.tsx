import { useEffect, useState } from "react";
import { useMap, useMapEvents } from "react-leaflet";
import { LAYER_CONFIGS } from "./ocean-layers";
import type { LayerType } from "./ocean-layers";

interface Props {
  activeLayer: LayerType;
}

/**
 * Floating indicator showing the active layer's native resolution
 * and warning when the user has zoomed past the data's true detail.
 */
export function ResolutionIndicator({ activeLayer }: Props) {
  const map = useMap();
  const [zoom, setZoom] = useState<number>(map.getZoom());

  useEffect(() => {
    setZoom(map.getZoom());
  }, [map, activeLayer]);

  useMapEvents({
    zoomend: () => setZoom(map.getZoom()),
  });

  const cfg = LAYER_CONFIGS[activeLayer];
  const isOverzoom = zoom > cfg.nativeZoom;

  return (
    <div className="pointer-events-none absolute bottom-3 left-1/2 z-[1000] -translate-x-1/2">
      <div
        className={`pointer-events-auto rounded-lg border px-2.5 py-1 text-[10px] transition-colors ${
          isOverzoom
            ? "border-ocean-warm bg-panel/95 text-ocean-warm"
            : "border-border bg-panel/90 text-muted-foreground"
        }`}
      >
        {isOverzoom ? (
          <span>⚠️ Overzoom · resolución real {cfg.resolutionKm} km/px</span>
        ) : (
          <span>Resolución nativa: {cfg.resolutionKm} km/px</span>
        )}
      </div>
    </div>
  );
}

