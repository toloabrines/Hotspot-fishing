/**
 * CenterCrosshair — cruz fija en el centro del visor con lectura en vivo de
 * los valores oceanográficos justo bajo el cursor.
 *
 * - No bloquea interacción (pointer-events: none).
 * - Para no saturar Copernicus en móvil, NO consulta al mover/zoomear el mapa:
 *   sólo lee SST / CHL / ALT al activar la herramienta o cambiar fecha/capas.
 * - Las peticiones se cancelan si el usuario sigue moviendo el mapa.
 */

import { useEffect, useRef, useState } from "react";
import { useMap, useMapEvents } from "react-leaflet";

import { LAYER_CONFIGS } from "./ocean-layers";
import type { LayerConfig, LayerType } from "./ocean-layers";
import type { MultiLayerState } from "./MultiLayerPanel";
import { fetchCopernicusValue } from "../lib/copernicus-feature-info";
import {
  currentDepthLabel,
  fetchCopernicusCurrentVector,
  type CurrentVectorResult,
} from "../lib/copernicus-currents";
import { getDepthAtLatLng } from "../lib/bathymetry";
import { toDegMinSec } from "./FishingHotspots.types";
import { useWindForecast } from "../hooks/use-wind-forecast";

// El cursor SÍ debe leer al terminar de mover el mapa: si no, los valores
// quedan congelados en el primer punto y no sirven para nada. Leaflet ya
// espera al fin del gesto (moveend), y cancelamos la petición previa si
// llega otra para no saturar Copernicus.
const AUTO_FETCH_AFTER_MAP_MOVE = true;

interface Reading {
  lat: number;
  lng: number;
  loading: boolean;
  sst?: number | null;
  bottomSst?: number | null;
  chl?: number | null;
  alt?: number | null;
  current?: CurrentVectorResult | null;
  depth?: number | null;
}

function formatLat(lat: number) {
  const h = lat >= 0 ? "N" : "S";
  return `${Math.abs(lat).toFixed(4)}° ${h}`;
}
function formatLng(lng: number) {
  const h = lng >= 0 ? "E" : "W";
  return `${Math.abs(lng).toFixed(4)}° ${h}`;
}

function bearingToCompass(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return dirs[idx];
}

function kelvinToCelsius(v: number) {
  // SST de Copernicus llega en Kelvin (~270-310). Si ya está en °C lo dejamos.
  return v > 200 ? v - 273.15 : v;
}

function getSstDepthLabel(layer: LayerType | undefined): { label: string; suffix: string } {
  if (layer === "sst_bottom") return { label: "Tfondo", suffix: "fondo" };
  if (layer === "sst_d10") return { label: "T10m", suffix: "10 m" };
  if (layer === "sst_d20") return { label: "T20m", suffix: "20 m" };
  if (layer === "sst_d30") return { label: "T30m", suffix: "30 m" };
  if (layer === "sst_d50") return { label: "T50m", suffix: "50 m" };
  if (layer === "sst_d100") return { label: "T100m", suffix: "100 m" };
  return { label: "T", suffix: "sup." };
}

export interface CenterCrosshairProps {
  enabled: boolean;
  multiLayer?: MultiLayerState;
  activeLayer?: LayerType;
  time?: string;
  layerTimes?: Partial<Record<LayerType, string>>;
  topSpot?: { lat: number; lng: number } | null;
  fishingMode?: "surface" | "bottom" | "squid" | "drift";
}

/** Distancia haversine en metros. */
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Rumbo inicial (bearing) en grados 0..360 desde A hacia B. */
function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const φ1 = toRad(aLat);
  const φ2 = toRad(bLat);
  const dλ = toRad(bLng - aLng);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const MILES_PER_METER = 0.000621371192;

function formatDist(m: number) {
  if (!Number.isFinite(m)) return "–";
  const mi = m * MILES_PER_METER;
  if (mi < 0.1) return `${Math.round(m)} m`;
  if (mi < 10) return `${mi.toFixed(2)} mi`;
  return `${mi.toFixed(1)} mi`;
}

export function CenterCrosshair({
  enabled,
  multiLayer,
  activeLayer,
  time,
  layerTimes,
  topSpot,
  fishingMode,
}: CenterCrosshairProps) {
  const map = useMap();
  const [reading, setReading] = useState<Reading | null>(null);
  const { wind } = useWindForecast(
    enabled && reading ? reading.lat : null,
    enabled && reading ? reading.lng : null,
  );
  const abortRef = useRef<AbortController | null>(null);

  const fetchAt = (lat: number, lng: number) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Mantén los valores previos mientras llega la nueva lectura — así el
    // panel no "parpadea" a "–" cada vez que el usuario mueve el mapa.
    setReading((prev) => ({
      lat,
      lng,
      loading: true,
      sst: prev?.sst,
      bottomSst: prev?.bottomSst,
      chl: prev?.chl,
      alt: prev?.alt,
      current: prev?.current,
      depth: prev?.depth,
    }));


    const queries: Array<{ key: "sst" | "chl" | "alt" | "bottomSst"; cfg: LayerConfig; layer: LayerType }> = [];
    // En fondo y calamar SIEMPRE queremos T de superficie y T de fondo,
    // aunque la capa de temperatura esté apagada.
    const needsBottomTemps = fishingMode === "bottom" || fishingMode === "squid";
    if (multiLayer) {
      if (multiLayer.sst.enabled) {
        queries.push({
          key: "sst",
          cfg: LAYER_CONFIGS[multiLayer.sst.layer],
          layer: multiLayer.sst.layer,
        });
      } else if (needsBottomTemps) {
        queries.push({ key: "sst", cfg: LAYER_CONFIGS.sst_analysed, layer: "sst_analysed" });
      }
      if (
        needsBottomTemps &&
        (!multiLayer.sst.enabled || multiLayer.sst.layer !== "sst_bottom")
      ) {
        queries.push({
          key: "bottomSst",
          cfg: LAYER_CONFIGS.sst_bottom,
          layer: "sst_bottom",
        });
      }
      if (multiLayer.chlorophyll.enabled)
        queries.push({
          key: "chl",
          cfg: LAYER_CONFIGS[multiLayer.chlorophyll.layer],
          layer: multiLayer.chlorophyll.layer,
        });
      if (multiLayer.altimetry.enabled)
        queries.push({
          key: "alt",
          cfg: LAYER_CONFIGS[multiLayer.altimetry.layer],
          layer: multiLayer.altimetry.layer,
        });
    } else if (activeLayer) {
      const cfg = LAYER_CONFIGS[activeLayer];
      const k = cfg.group === "sst" ? "sst" : cfg.group === "chlorophyll" ? "chl" : "alt";
      queries.push({ key: k, cfg, layer: activeLayer });
      if (needsBottomTemps && k !== "sst") {
        queries.push({ key: "sst", cfg: LAYER_CONFIGS.sst_analysed, layer: "sst_analysed" });
      }
      if (needsBottomTemps && activeLayer !== "sst_bottom") {
        queries.push({ key: "bottomSst", cfg: LAYER_CONFIGS.sst_bottom, layer: "sst_bottom" });
      }
    } else if (needsBottomTemps) {
      queries.push({ key: "sst", cfg: LAYER_CONFIGS.sst_analysed, layer: "sst_analysed" });
      queries.push({ key: "bottomSst", cfg: LAYER_CONFIGS.sst_bottom, layer: "sst_bottom" });
    }


    const zoom = Math.min(Math.max(map.getZoom(), 3), 9);
    const depthPromise = getDepthAtLatLng(lat, lng, ctrl.signal).catch(() => ({
      depth: null,
      source: "none" as const,
    }));
    const currentDepth = multiLayer?.streamlines?.depth ?? "surface";
    const currentPromise = depthPromise
      .then((depthSample) =>
        fetchCopernicusCurrentVector({
          lat,
          lng,
          zoom,
          time: layerTimes?.alt_combined ?? layerTimes?.alt_currents ?? time,
          depth: currentDepth,
          seafloorDepthM: depthSample.depth,
          signal: ctrl.signal,
        }),
      )
      .catch(() => null);

    Promise.all([
      ...queries.map((q) =>
        fetchCopernicusValue(
          q.cfg.wmtsLayer,
          q.cfg.style,
          lat,
          lng,
          zoom,
          layerTimes?.[q.layer] ?? time,
          ctrl.signal,
          q.cfg.elevation,
        ).then((r) => ({ key: q.key, value: r.value })),
      ),
      depthPromise.then((d) => ({ key: "depth" as const, value: d.depth ?? null })),
      currentPromise.then((current) => ({ key: "current" as const, value: current })),
    ])
      .then((results) => {
        if (ctrl.signal.aborted) return;
        const r: Reading = { lat, lng, loading: false };
        for (const x of results) {
          if (x.key === "sst") r.sst = x.value != null ? kelvinToCelsius(x.value) : null;
          else if (x.key === "bottomSst") r.bottomSst = x.value != null ? kelvinToCelsius(x.value) : null;
          else if (x.key === "chl") r.chl = x.value;
          else if (x.key === "alt") r.alt = x.value;
          else if (x.key === "current") r.current = x.value;
          else if (x.key === "depth") r.depth = x.value;
        }
        setReading(r);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setReading({ lat, lng, loading: false });
      });
  };

  useMapEvents({
    moveend: () => {
      if (!enabled) return;
      if (!AUTO_FETCH_AFTER_MAP_MOVE) return;
      const c = map.getCenter();
      fetchAt(c.lat, c.lng);
    },
  });

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      setReading(null);
      return;
    }
    const c = map.getCenter();
    fetchAt(c.lat, c.lng);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    multiLayer?.sst.enabled,
    multiLayer?.sst.layer,
    multiLayer?.chlorophyll.enabled,
    multiLayer?.chlorophyll.layer,
    multiLayer?.altimetry.enabled,
    multiLayer?.altimetry.layer,
    multiLayer?.streamlines.depth,
    activeLayer,
    time,
    fishingMode,
  ]);

  if (!enabled) return null;

  const activeSstLayer = multiLayer?.sst.enabled
    ? multiLayer.sst.layer
    : activeLayer && LAYER_CONFIGS[activeLayer]?.group === "sst"
      ? activeLayer
      : undefined;
  const sstLabelInfo = getSstDepthLabel(activeSstLayer);

  const sstStr =
    reading?.sst != null && Number.isFinite(reading.sst) ? `${reading.sst.toFixed(2)} °C` : "–";
  const bottomSstStr =
    reading?.bottomSst != null && Number.isFinite(reading.bottomSst)
      ? `${reading.bottomSst.toFixed(2)} °C`
      : "–";
  const chlStr =
    reading?.chl != null && Number.isFinite(reading.chl) ? `${reading.chl.toFixed(2)} mg/m³` : "–";
  const altStr =
    reading?.alt != null && Number.isFinite(reading.alt)
      ? `${(reading.alt * 100).toFixed(1)} cm`
      : "–";
  const depthStr =
    reading?.depth != null && Number.isFinite(reading.depth)
      ? `${Math.round(reading.depth)} m`
      : "–";
  const currentStr =
    reading?.current != null && Number.isFinite(reading.current.speed)
      ? `${reading.current.speed.toFixed(2).replace(".", ",")} m/s — viene del ${bearingToCompass(
          reading.current.dirDeg,
        )} → va hacia el ${bearingToCompass((reading.current.dirDeg + 180) % 360)} ${currentDepthLabel(
          reading.current.depth,
        )}`
      : "—";

  const showBottomSstRow =
    (fishingMode === "bottom" || fishingMode === "squid") && activeSstLayer !== "sst_bottom";

  return (
    <>
      {/* Cruz */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: 44,
          height: 44,
          pointerEvents: "none",
          zIndex: 800,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: "50%",
            width: "100%",
            height: 1,
            background: "rgba(255,255,255,0.85)",
            boxShadow: "0 0 2px rgba(0,0,0,0.85)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 0,
            left: "50%",
            height: "100%",
            width: 1,
            background: "rgba(255,255,255,0.85)",
            boxShadow: "0 0 2px rgba(0,0,0,0.85)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: 12,
            height: 12,
            border: "1px solid rgba(255,255,255,0.85)",
            borderRadius: "50%",
            boxShadow: "0 0 2px rgba(0,0,0,0.85)",
          }}
        />
      </div>

      {/* Lectura — esquina superior derecha (donde estaba el menú) */}
      <div
        data-no-map-click
        className="crosshair-readout"
        style={{
          position: "absolute",
          right: "calc(env(safe-area-inset-right, 0px) + 8px)",
          top: "calc(env(safe-area-inset-top, 0px) + 8px)",
          zIndex: 5000,
          width: 170,
          padding: "9px 11px",
          borderRadius: 8,
          background: "rgba(4, 16, 28, 0.96)",
          border: "1px solid rgba(255,255,255,0.32)",
          color: "#e6f1ff",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          lineHeight: 1.45,
          pointerEvents: "none",
          boxShadow: "0 10px 28px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.35)",
          backdropFilter: "blur(10px)",
          transform: "scale(0.65)",
          transformOrigin: "top right",

          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <Row label={sstLabelInfo.label} value={sstStr} />
        {showBottomSstRow && <Row label="Tfondo" value={bottomSstStr} />}
        <Row label="Chl" value={chlStr} />
        <Row label="η" value={altStr} />
        <Row label="Prof" value={depthStr} />
        <Row label="Corr" value={currentStr} />
        <Row
          label="💨"
          value={
            wind
              ? `${wind.avgKn.toFixed(1)}/${wind.gustKn.toFixed(1)}kn ${Math.round(wind.dirDeg)}°`
              : "–"
          }
        />
        {topSpot && reading && (
          <Row
            label="→T1"
            value={`${formatDist(
              haversineM(reading.lat, reading.lng, topSpot.lat, topSpot.lng),
            )} ${Math.round(bearingDeg(reading.lat, reading.lng, topSpot.lat, topSpot.lng))}°`}
          />
        )}
        <span
          style={{
            fontSize: 10,
            opacity: 0.75,
            marginTop: 2,
            lineHeight: 1.3,
            whiteSpace: "pre-line",
          }}
        >
          {reading ? `${toDegMinSec(reading.lat, "lat")}\n${toDegMinSec(reading.lng, "lng")}` : "–"}
        </span>
        {reading?.loading && <span style={{ fontSize: 9, opacity: 0.55 }}>···</span>}
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
      <span style={{ opacity: 0.6, flex: "0 0 42px" }}>{label}</span>
      <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>{value}</span>
    </span>
  );
}

