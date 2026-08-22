/**
 * Hook que orquesta la detección de zonas de gradiente sobre la vista
 * actual del mapa. Debounce + cancelación + cache simple por bbox.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LAYER_CONFIGS, type LayerType } from "../components/ocean-layers";
import { detectGradientZones, type SampledLayer } from "../lib/gradient-zones";
import type { GradientZonesResult } from "../lib/gradient-zones.types";
import {
  clearAllCache,
  makeCacheKey,
  makeCacheSignature,
  readLatestCompatible,
  readCache,
  writeCache,
} from "../lib/gradient-zones-cache";

export interface UseGradientZonesArgs {
  enabled: boolean;
  bbox: { south: number; west: number; north: number; east: number } | null;
  zoom: number;
  sstLayer?: LayerType;
  chlLayer?: LayerType;
  altLayer?: LayerType;
  time?: string;
  layerTimes?: Partial<Record<LayerType, string>>;
  /** Trigger manual de re-análisis (incrementa para recomputar). */
  recomputeNonce: number;
}

export interface UseGradientZonesResult {
  result: GradientZonesResult | null;
  loading: boolean;
  progress: number;
  error: string | null;
  clear: () => void;
}

// Tamaño de celda (en grados) a la que anclamos el bbox de análisis por
// zoom entero. Mientras estés en el mismo zoom y muevas el mapa dentro de
// la misma celda, el bbox de análisis NO cambia → mismo resultado exacto.
function snapStepForZoom(zoomInt: number): number {
  if (zoomInt <= 5) return 1.0;
  if (zoomInt <= 6) return 0.5;
  if (zoomInt <= 7) return 0.25;
  if (zoomInt <= 8) return 0.125;
  if (zoomInt <= 9) return 0.0625;
  return 0.03125;
}

function snapBbox(
  bbox: { south: number; west: number; north: number; east: number },
  step: number,
): { south: number; west: number; north: number; east: number } {
  const floor = (v: number) => Math.floor(v / step) * step;
  const ceil = (v: number) => Math.ceil(v / step) * step;
  return {
    south: floor(bbox.south),
    west: floor(bbox.west),
    north: ceil(bbox.north),
    east: ceil(bbox.east),
  };
}

export function useGradientZones(args: UseGradientZonesArgs): UseGradientZonesResult {
  const zoomInt = Math.max(4, Math.min(10, Math.round(args.zoom)));
  // Anclamos el bbox a una rejilla geográfica fija que depende del zoom.
  // Así, con la misma fecha/capas/zoom y la misma vista visual, el análisis
  // recibe SIEMPRE el mismo bbox y produce el mismo resultado (sin drift por
  // pans mínimos que recolocaban la grilla de muestreo).
  const snappedBbox = args.bbox ? snapBbox(args.bbox, snapStepForZoom(zoomInt)) : null;
  const bboxKey = snappedBbox
    ? `${snappedBbox.south.toFixed(4)},${snappedBbox.west.toFixed(4)},${snappedBbox.north.toFixed(4)},${snappedBbox.east.toFixed(4)}`
    : "none";
  const bboxReadyKey = bboxKey === "none" ? "none" : "ready";
  const layerTimeKey = args.layerTimes
    ? [
        args.layerTimes[args.sstLayer ?? "sst_analysed"],
        args.layerTimes[args.chlLayer ?? "chl"],
        args.layerTimes[args.altLayer ?? "alt_combined"],
      ].join("|")
    : "none";
  const [result, setResult] = useState<GradientZonesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const lastResultRef = useRef<GradientZonesResult | null>(null);
  const lastAnalyzedBboxRef = useRef<{
    south: number;
    west: number;
    north: number;
    east: number;
  } | null>(null);
  const lastSignatureRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const skipCacheRef = useRef<boolean>(false);
  const lastNonceRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    lastResultRef.current = null;
    lastAnalyzedBboxRef.current = null;
    lastSignatureRef.current = null;
    skipCacheRef.current = true;
    try {
      clearAllCache();
    } catch {
      /* best-effort */
    }
    setResult(null);
    setLoading(false);
    setProgress(0);
    setError(null);
  }, []);

  useEffect(() => {
    if (!args.enabled) {
      clear();
      return;
    }
    if (!args.bbox) return;

    const getLayerTime = (layer: LayerType): string | undefined => {
      const direct = args.layerTimes?.[layer];
      if (direct) return direct;
      const group = LAYER_CONFIGS[layer]?.group;
      if (args.layerTimes && group === "altimetry") {
        return (
          args.layerTimes.alt_combined ??
          args.layerTimes.alt_adt ??
          args.layerTimes.alt_currents ??
          args.layerTimes.alt_sla ??
          args.time
        );
      }
      if (args.layerTimes && group === "sst") {
        return args.layerTimes.sst_analysed ?? args.layerTimes.sst_nrt ?? args.time;
      }
      if (args.layerTimes && group === "chlorophyll") {
        return args.layerTimes.chl ?? args.layerTimes.chl_hc ?? args.time;
      }
      return args.time;
    };

    const layers: SampledLayer[] = [];
    if (args.sstLayer) {
      const cfg = LAYER_CONFIGS[args.sstLayer];
      layers.push({
        variable: "sst",
        wmtsLayer: cfg.wmtsLayer,
        style: cfg.style,
        time: getLayerTime(args.sstLayer),
      });
    }
    if (args.chlLayer) {
      const cfg = LAYER_CONFIGS[args.chlLayer];
      layers.push({
        variable: "chl",
        wmtsLayer: cfg.wmtsLayer,
        style: cfg.style,
        time: getLayerTime(args.chlLayer),
      });
    }
    if (args.altLayer) {
      const cfg = LAYER_CONFIGS[args.altLayer];
      layers.push({
        variable: "alt",
        wmtsLayer: cfg.wmtsLayer,
        style: cfg.style,
        time: getLayerTime(args.altLayer),
      });
    }
    if (layers.length === 0) {
      setError("Activa al menos una capa (SST, clorofila o altimetría)");
      return;
    }

    const zoom = zoomInt;
    const analysisBbox = snappedBbox ?? args.bbox;

    // Firma que define "el mismo análisis": SOLO capas activas y la fecha
    // que el usuario ha elegido explícitamente (args.time). Excluimos zoom,
    // bbox y layerTimeKey (fecha auto-resuelta por Copernicus) para que la
    // re-resolución de fecha al despertar la app, los pans y los zooms NO
    // disparen un nuevo análisis. Solo se recomputa con "Reanalizar"
    // (recomputeNonce), cambio de capas o cambio explícito de fecha.
    const sigNow = makeCacheSignature({
      zoom: 0,
      sstLayer: args.sstLayer,
      chlLayer: args.chlLayer,
      altLayer: args.altLayer,
      layerTimeKey: args.time ?? "",
    });

    // Modo "congelado": si ya hay un resultado y la firma coincide y no
    // se ha pulsado Reanalizar, NO recomputamos. El usuario puede moverse
    // por el mapa, hacer zoom y despertar la pantalla sin que se regeneren
    // los corredores.
    if (
      lastResultRef.current &&
      lastSignatureRef.current === sigNow &&
      lastNonceRef.current === args.recomputeNonce
    ) {
      return;
    }
    lastNonceRef.current = args.recomputeNonce;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Cache hit → mostrar inmediato y evitar reanálisis al reanudar.
    const cacheKey = makeCacheKey({
      bbox: analysisBbox,
      zoom,
      sstLayer: args.sstLayer,
      chlLayer: args.chlLayer,
      altLayer: args.altLayer,
      layerTimeKey,
    });
    const allowCache = !skipCacheRef.current;
    skipCacheRef.current = false;
    const cached = allowCache ? readCache(cacheKey) : null;
    if (cached) {
      lastResultRef.current = cached;
      lastAnalyzedBboxRef.current = analysisBbox;
      lastSignatureRef.current = sigNow;
      setResult(cached);
      setLoading(false);
      setProgress(1);
      setError(null);
      return () => {
        ctrl.abort();
      };
    }

    const compatibleCacheKey = makeCacheSignature({
      zoom,
      sstLayer: args.sstLayer,
      chlLayer: args.chlLayer,
      altLayer: args.altLayer,
      layerTimeKey,
    });
    const compatible = allowCache ? readLatestCompatible(compatibleCacheKey) : null;
    if (compatible) {
      lastResultRef.current = compatible;
      lastAnalyzedBboxRef.current = compatible.bbox;
      lastSignatureRef.current = sigNow;
      setResult(compatible);
      setLoading(false);
      setProgress(1);
      setError(null);
      return () => {
        ctrl.abort();
      };
    }

    // Mantenemos el resultado anterior visible mientras se recalcula la
    // nueva pantalla: así un zoom o pan no deja el mapa sin corredores
    // durante el debounce. El layer ya recorta al viewport visible.
    setProgress(0);

    // Parámetros fijos y conservadores: prioriza estabilidad de la UI
    // sobre densidad de muestreo. El escalado por zoom saturaba la red
    // y el hilo principal en móvil, dejando la pantalla en blanco.
    const gridSize = 16;
    const concurrency = 12;

    // Debounce alto para evitar disparar análisis pesados durante
    // pan/zoom continuo o al pulsar botones que cambian capas.
    const debounceMs = 700;
    const timer = setTimeout(() => {
      if (ctrl.signal.aborted) return;
      setLoading(true);
      setProgress(0);
      setError(null);

      detectGradientZones({
        bbox: analysisBbox,
        layers,
        zoom,
        gridSize,
        concurrency,
        signal: ctrl.signal,
        onProgress: (p) => {
          if (!ctrl.signal.aborted) setProgress(p);
        },
      })
        .then((res) => {
          if (ctrl.signal.aborted) return;
          lastResultRef.current = res;
          setResult(res);
          lastAnalyzedBboxRef.current = analysisBbox;
          lastSignatureRef.current = sigNow;
          setLoading(false);
          setProgress(1);
          if (res.zones.length > 0) {
            try {
              writeCache(cacheKey, res);
            } catch {
              /* best-effort */
            }
          }
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };

    // Solo dependemos de los disparadores explícitos. Excluimos bboxKey,
    // zoomInt y layerTimeKey para que pans/zooms y re-resoluciones
    // automáticas de fecha no relancen el análisis.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    args.enabled,
    bboxReadyKey,
    args.recomputeNonce,
    args.sstLayer,
    args.chlLayer,
    args.altLayer,
    args.time,
  ]);

  return { result, loading, progress, error, clear };
}

