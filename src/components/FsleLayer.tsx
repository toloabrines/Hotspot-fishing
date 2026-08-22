/**
 * Capa FSLE / LCS reales.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────
 *
 * Consume el endpoint `/api/public/fsle`, que calcula un FSLE lagrangiano
 * auténtico (integrador RK4 sobre uo/vo de Copernicus MEDSEA, campo
 * congelado del día seleccionado). El servidor devuelve un GeoJSON de
 * LineString con las crestas del campo FSLE — las LCS.
 *
 * IMPORTANTE: **no es AVISO-FSLE oficial**. Es FSLE lagrangiano calculado
 * por la app con RK4 sobre uo/vo del día seleccionado. Es una aproximación
 * cinemática estándar (Waugh & Abraham 2008; d'Ovidio et al.) que captura
 * bien mesoescala; para submesoescala real haría falta un backend Python
 * con OceanParcels.
 *
 * ── Comportamiento ─────────────────────────────────────────────────────
 *
 *   - Al activar: fetch al endpoint, overlay de "cargando".
 *   - Al recibir el GeoJSON: dibuja las líneas amarillo→rojo por intensidad.
 *   - Doble-click sobre una línea (o cerca de ella): popup con SST/CHL/ALT/
 *     corriente/viento en ese punto.
 *   - Pan/zoom no dispara reanálisis (las líneas se reproyectan). Solo
 *     recalcula al cambiar fecha o al cambiar de forma significativa el bbox.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";
import { toast } from "sonner";
import { fetchCopernicusValue } from "../lib/copernicus-feature-info";
import { exportFileWithSheet } from "../lib/file-export";

import { fetchWindForecast } from "../lib/wind-forecast";
import {
  LAYER_CONFIGS,
  type LayerType,
} from "./ocean-layers";
import type { MultiLayerState } from "./MultiLayerPanel";

// ── Suavizado Chaikin compartido ────────────────────────────────────────
// Se usa tanto para dibujar en el mapa como para exportar GeoJSON, de modo
// que el archivo exportado contiene EXACTAMENTE las mismas líneas que ve
// el usuario, sin desfase entre "lo dibujado" y "lo exportado".
export function chaikinSmoothLonLat(
  coords: Array<[number, number]>,
  values: number[],
  fallback: number,
  passes: number = 2,
): { coords: Array<[number, number]>; values: number[] } {
  let pts = coords;
  let vals =
    values.length === coords.length
      ? values.map((v) => Math.max(0, Math.min(1, Number(v) || 0)))
      : coords.map(() => fallback);
  for (let pass = 0; pass < passes; pass++) {
    if (pts.length < 3) break;
    const outPts: Array<[number, number]> = [pts[0]];
    const outVals: number[] = [vals[0] ?? fallback];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const va = vals[i] ?? fallback;
      const vb = vals[i + 1] ?? fallback;
      outPts.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
      outPts.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
      outVals.push(va * 0.75 + vb * 0.25);
      outVals.push(va * 0.25 + vb * 0.75);
    }
    outPts.push(pts[pts.length - 1]);
    outVals.push(vals[vals.length - 1] ?? fallback);
    pts = outPts;
    vals = outVals;
  }
  return { coords: pts, values: vals };
}

const FSLE_PANE = "ocean-fsle-pane";

// ── Modo navegación estable ─────────────────────────────────────────────
// Rejilla fija de tiles geográficos de 2°×2° independiente de zoom y pantalla.
// Un tile se identifica por (tileSouth, tileWest) en múltiplos de TILE_DEG.
// Debe coincidir con el TILE_DEG del servidor en api.public.fsle.ts.
const TILE_DEG = 2;

// ── Caché local por sesión / dispositivo ───────────────────────────────
// El backend ya cachea en Storage, pero cada visita seguía haciendo un
// round-trip. Aquí guardamos la respuesta completa por (date, tileId) en
// localStorage con TTL 24h para que las siguientes visitas sean instantáneas
// (0 red) cuando el usuario reabre la misma zona el mismo día.
const LOCAL_CACHE_PREFIX = "fsle:v16:";
const LOCAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const MED_FSLE_BBOX = { west: -6, east: 36, south: 30, north: 46 };
const MAX_PARALLEL_FSLE_TILES = 3;
const MAX_VISIBLE_FSLE_TILES = 12;


function localCacheKey(date: string, tileId: string): string {
  return `${LOCAL_CACHE_PREFIX}${date}:${tileId}`;
}

function readLocalTile(date: string, tileId: string): { payload: unknown; ageMs: number } | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(localCacheKey(date, tileId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt: number; payload: unknown };
    const ageMs = Date.now() - parsed.savedAt;
    if (ageMs > LOCAL_CACHE_TTL_MS) {
      localStorage.removeItem(localCacheKey(date, tileId));
      return null;
    }
    return { payload: parsed.payload, ageMs };
  } catch {
    return null;
  }
}

function writeLocalTile(date: string, tileId: string, payload: unknown): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      localCacheKey(date, tileId),
      JSON.stringify({ savedAt: Date.now(), payload }),
    );
  } catch {
    // quota exceeded → limpiar entradas antiguas del prefijo
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LOCAL_CACHE_PREFIX)) localStorage.removeItem(k);
      }
    } catch {
      /* noop */
    }
  }
}

function pruneOldLocalTiles(currentDate: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const keepPrefix = `${LOCAL_CACHE_PREFIX}${currentDate}:`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LOCAL_CACHE_PREFIX)) continue;
      if (!k.startsWith(keepPrefix)) localStorage.removeItem(k);
    }
  } catch {
    /* noop */
  }
}

function blobDownload(filename: string, json: string): boolean {
  if (typeof document === "undefined") return false;
  try {
    const blob = new Blob([json], { type: "application/geo+json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    return true;
  } catch {
    return false;
  }
}

function openGeoJsonInThisTab(filename: string, json: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const blob = new Blob([json], { type: "application/geo+json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.location.assign(url);
    setTimeout(() => URL.revokeObjectURL(url), 12000);
    toast.info(`${filename} abierto. Usa compartir/guardar del navegador.`);
    return true;
  } catch {
    return false;
  }
}

async function shareGeoJsonFile(filename: string, json: string): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof File === "undefined") return false;
  try {
    const nav = navigator as Navigator & {
      canShare?: (data: ShareData) => boolean;
      share?: (data: ShareData) => Promise<void>;
    };
    if (!nav.share) return false;
    const file = new File([json], filename, { type: "application/geo+json" });
    if (nav.canShare && !nav.canShare({ files: [file] })) return false;
    await nav.share({ files: [file], title: filename });
    return true;
  } catch {
    return false;
  }
}

function copyGeoJsonToClipboard(filename: string, json: string): void {
  void navigator.clipboard?.writeText(json).then(
    () => toast.success(`${filename} copiado al portapapeles.`),
    () => toast.error("No se pudo copiar el GeoJSON."),
  );
}

function makeExportToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function openGeoJsonExportPage(filename: string, json: string, lineCount: number): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const key = makeExportToken();
    try {
      window.sessionStorage.setItem(
        `fsle-export:${key}`,
        JSON.stringify({ filename, json, lineCount, createdAt: Date.now() }),
      );
    } catch {
      /* sessionStorage lleno — se persiste igual en el servidor */
    }
    // Persistir en el servidor para que el archivo quede guardado y descargable
    // de forma fiable aunque el navegador cierre la pestaña o borre la sesión.
    try {
      const { saveFsleExport } = await import("../lib/fsle-export.functions");
      await saveFsleExport({ data: { token: key, filename, content: json, lineCount } });
    } catch (err) {
      console.warn("FSLE: no se pudo guardar el GeoJSON en el servidor", err);
      toast.error("No se pudo guardar el GeoJSON en el servidor.");
      return false;
    }
    window.location.assign(`/fsle-export?token=${encodeURIComponent(key)}`);
    return true;
  } catch {
    return false;
  }
}

function geoJsonDataHref(json: string): string {
  return `data:application/geo+json;charset=utf-8,${encodeURIComponent(json)}`;
}

function isInIframe(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function submitGeoJsonAttachmentDownload(filename: string, json: string): boolean {
  if (typeof document === "undefined") return false;
  try {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/public/fsle-geojson-download";
    form.enctype = "multipart/form-data";
    form.target = isInIframe() ? "_blank" : "_self";
    form.style.display = "none";

    const filenameInput = document.createElement("input");
    filenameInput.type = "hidden";
    filenameInput.name = "filename";
    filenameInput.value = filename;

    const contentInput = document.createElement("textarea");
    contentInput.name = "content";
    contentInput.value = json;

    form.append(filenameInput, contentInput);
    document.body.appendChild(form);
    form.submit();
    setTimeout(() => form.remove(), 5000);
    return true;
  } catch {
    return false;
  }
}

function showGeoJsonDownloadPanel(filename: string, json: string, lineCount: number): boolean {
  if (typeof document === "undefined") return false;
  try {
    document.getElementById("fsle-geojson-download-panel")?.remove();

    const blob = new Blob([json], { type: "application/geo+json;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const panel = document.createElement("div");
    panel.id = "fsle-geojson-download-panel";
    panel.style.cssText = [
      "position:fixed",
      "left:12px",
      "right:12px",
      "bottom:12px",
      "z-index:2147483647",
      "background:rgba(2,6,23,.96)",
      "color:#e0f2fe",
      "border:1px solid rgba(56,189,248,.55)",
      "border-radius:10px",
      "box-shadow:0 18px 45px rgba(0,0,0,.45)",
      "padding:12px",
      "font:500 13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif",
      "max-width:420px",
      "margin:0 auto",
      "pointer-events:auto",
    ].join(";");
    panel.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    panel.addEventListener("touchstart", (ev) => ev.stopPropagation(), { passive: true });
    panel.addEventListener("click", (ev) => ev.stopPropagation());

    const title = document.createElement("div");
    title.textContent = `GeoJSON FSLE listo · ${lineCount} líneas`;
    title.style.cssText = "font-weight:800;margin-bottom:8px;color:#f8fafc";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap";

    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "Descargar en Archivos";
    download.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "justify-content:center",
      "border:0",
      "border-radius:8px",
      "background:#0ea5e9",
      "color:#00111f",
      "font-weight:800",
      "padding:9px 12px",
      "text-decoration:none",
      "touch-action:manipulation",
      "-webkit-tap-highlight-color:transparent",
    ].join(";");
    download.onclick = () => {
      if (submitGeoJsonAttachmentDownload(filename, json)) {
        toast.success(`Descargando ${filename}`);
        return;
      }
      if (blobDownload(filename, json)) return;
      copyGeoJsonToClipboard(filename, json);
    };

    const nativeShare = document.createElement("button");
    nativeShare.type = "button";
    nativeShare.textContent = "Compartir iOS";
    nativeShare.style.cssText =
      "border:1px solid rgba(56,189,248,.45);border-radius:8px;background:transparent;color:#7dd3fc;font-weight:700;padding:9px 12px;touch-action:manipulation;-webkit-tap-highlight-color:transparent";
    nativeShare.onclick = () => {
      nativeShare.setAttribute("disabled", "true");
      nativeShare.textContent = "Abriendo…";
      void shareGeoJsonFile(filename, json).then((ok) => {
        nativeShare.removeAttribute("disabled");
        nativeShare.textContent = "Compartir iOS";
        if (!ok) toast.error("El visor bloqueó compartir. Pulsa Descargar archivo.");
      });
    };

    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Abrir JSON";
    open.style.cssText =
      "border:1px solid rgba(56,189,248,.45);border-radius:8px;background:transparent;color:#7dd3fc;font-weight:700;padding:9px 12px;touch-action:manipulation;-webkit-tap-highlight-color:transparent";
    open.onclick = () => {
      if (!openGeoJsonInThisTab(filename, json)) copyGeoJsonToClipboard(filename, json);
    };

    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copiar JSON";
    copy.style.cssText =
      "border:1px solid rgba(56,189,248,.45);border-radius:8px;background:transparent;color:#7dd3fc;font-weight:700;padding:9px 12px";
    copy.onclick = () => {
      copyGeoJsonToClipboard(filename, json);
    };

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Cerrar";
    close.style.cssText =
      "border:0;border-radius:8px;background:#1e293b;color:#f8fafc;font-weight:700;padding:9px 12px";
    close.onclick = () => {
      panel.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1200);
    };

    actions.append(download, nativeShare, open, copy, close);
    panel.append(title, actions);
    document.body.appendChild(panel);
    return true;
  } catch {
    return false;
  }
}

interface TileKey {
  tileSouth: number;
  tileWest: number;
  id: string;
}

function tilesCoveringBounds(b: L.LatLngBounds): TileKey[] {
  const south = Math.max(MED_FSLE_BBOX.south, b.getSouth());
  const west = Math.max(MED_FSLE_BBOX.west, b.getWest());
  const north = Math.min(MED_FSLE_BBOX.north, b.getNorth());
  const east = Math.min(MED_FSLE_BBOX.east, b.getEast());
  if (east <= west || north <= south) return [];

  const s = Math.floor(south / TILE_DEG) * TILE_DEG;
  const w = Math.floor(west / TILE_DEG) * TILE_DEG;
  const n = Math.ceil(north / TILE_DEG) * TILE_DEG;
  const e = Math.ceil(east / TILE_DEG) * TILE_DEG;
  const center = b.getCenter();
  const out: TileKey[] = [];
  for (let ts = s; ts < n; ts += TILE_DEG) {
    for (let tw = w; tw < e; tw += TILE_DEG) {
      if (ts >= MED_FSLE_BBOX.north || ts + TILE_DEG <= MED_FSLE_BBOX.south) continue;
      if (tw >= MED_FSLE_BBOX.east || tw + TILE_DEG <= MED_FSLE_BBOX.west) continue;
      out.push({
        tileSouth: ts,
        tileWest: tw,
        id: `y${ts.toFixed(0)}_x${tw.toFixed(0)}`,
      });
    }
  }
  out.sort((a, bTile) => {
    const acLat = a.tileSouth + TILE_DEG / 2;
    const acLng = a.tileWest + TILE_DEG / 2;
    const bcLat = bTile.tileSouth + TILE_DEG / 2;
    const bcLng = bTile.tileWest + TILE_DEG / 2;
    return Math.hypot(acLat - center.lat, acLng - center.lng) - Math.hypot(bcLat - center.lat, bcLng - center.lng);
  });
  return out.slice(0, MAX_VISIBLE_FSLE_TILES);
}

// Paleta amarillo → rojo para el raster FSLE (sin suavizados adicionales).
function fsleRasterColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  // amarillo (255,235,60) → naranja (255,140,20) → rojo (200,20,20)
  if (x < 0.5) {
    const k = x / 0.5;
    const r = 255;
    const g = Math.round(235 - k * 95);
    const b = Math.round(60 - k * 40);
    return `rgb(${r},${g},${b})`;
  }
  const k = (x - 0.5) / 0.5;
  const r = Math.round(255 - k * 55);
  const g = Math.round(140 - k * 120);
  const b = Math.round(20);
  return `rgb(${r},${g},${b})`;
}

// Color para las líneas de cresta LCS: mantenemos naranja→rojo intenso.
function intensityColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  if (x < 0.5) {
    const k = x / 0.5;
    return `rgb(255,${Math.round(225 - k * 80)},${Math.round(120 - k * 110)})`;
  }
  const k = (x - 0.5) / 0.5;
  return `rgb(255,${Math.round(145 - k * 105)},${Math.round(10 - k * 10)})`;
}

function bearingLabel(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round((deg % 360) / 45) % 8];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

interface SpotData {
  sst: number | null;
  chl: number | null;
  alt: number | null;
  uo: number | null;
  vo: number | null;
  wind: { avgKn: number; gustKn: number; dirDeg: number } | null;
}

function renderPopup(
  latlng: L.LatLng,
  intensity: number,
  data: SpotData | null,
  extra?: { confidence?: number; fsleAvg?: number; fsleMax?: number; lengthKm?: number; nearNaN?: boolean },
): string {
  const row = (l: string, v: string) =>
    `<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;line-height:1.5"><span style="opacity:.7">${escapeHtml(l)}</span><span style="font-weight:600">${escapeHtml(v)}</span></div>`;
  const confStr = extra?.confidence != null ? `${Math.round(extra.confidence * 100)} %` : null;
  const lenStr = extra?.lengthKm != null ? `${extra.lengthKm.toFixed(1)} km` : null;
  const fsleStr =
    extra?.fsleAvg != null && extra?.fsleMax != null
      ? `media ${extra.fsleAvg.toFixed(3)} · máx ${extra.fsleMax.toFixed(3)} d⁻¹`
      : null;
  const nearNaNBadge = extra?.nearNaN
    ? `<div style="margin-top:6px;padding:4px 6px;border-radius:6px;background:rgba(234,179,8,0.15);color:#fde68a;font-size:10px">⚠️ Cresta cercana a celdas sin datos (NaN)</div>`
    : "";
  const extraBlock =
    (confStr || lenStr || fsleStr)
      ? `<div style="margin:6px 0 4px;padding:6px 8px;border-radius:6px;background:rgba(30,41,59,0.6)">` +
        (confStr ? row("Confianza LCS", confStr) : "") +
        (lenStr ? row("Longitud", lenStr) : "") +
        (fsleStr ? row("FSLE cresta", fsleStr) : "") +
        `</div>` + nearNaNBadge
      : "";
  if (!data) {
    return `<div style="min-width:220px;font-family:system-ui,sans-serif;color:#f8fafc">
      <div style="font-weight:700;font-size:13px;margin-bottom:6px">LCS · cargando…</div>
      ${extraBlock}
      <div style="font-size:11px;opacity:.7">Consultando datos del punto…</div>
    </div>`;
  }
  const sstStr =
    data.sst != null && Number.isFinite(data.sst)
      ? `${(data.sst > 200 ? data.sst - 273.15 : data.sst).toFixed(2)} °C`
      : "–";
  const chlStr = data.chl != null ? `${data.chl.toFixed(2)} mg/m³` : "–";
  const altStr = data.alt != null ? `${(data.alt * 100).toFixed(1)} cm` : "–";
  let currStr = "–";
  if (data.uo != null && data.vo != null) {
    const sp = Math.sqrt(data.uo * data.uo + data.vo * data.vo);
    const kn = sp * 1.94384;
    const dir = ((Math.atan2(data.uo, data.vo) * 180) / Math.PI + 360) % 360;
    currStr = `${kn.toFixed(2)} kn · ${Math.round(dir)}° ${bearingLabel(dir)}`;
  }
  const windStr = data.wind
    ? `${data.wind.avgKn.toFixed(1)} kn · ráf ${data.wind.gustKn.toFixed(1)} · ${Math.round(data.wind.dirDeg)}° ${bearingLabel(data.wind.dirDeg)}`
    : "–";
  return `<div style="min-width:240px;font-family:system-ui,sans-serif;color:#f8fafc">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-weight:700;font-size:13px">Frente LCS</div>
      <div style="font-size:11px;font-weight:600;color:${intensityColor(intensity)}">FSLE ${Math.round(intensity * 100)}%</div>
    </div>
    ${extraBlock}
    ${row("Temperatura", sstStr)}
    ${row("Clorofila", chlStr)}
    ${row("Altimetría", altStr)}
    ${row("Corriente", currStr)}
    ${row("Viento", windStr)}
    <div style="font-size:10px;opacity:.55;margin-top:6px">${latlng.lat.toFixed(4)}°, ${latlng.lng.toFixed(4)}°</div>
    <div style="font-size:9px;opacity:.45;margin-top:4px;font-style:italic">FSLE real aprox. — RK4/Copernicus congelado</div>
  </div>`;
}

async function fetchSpotData(
  latlng: L.LatLng,
  time: string,
  multiLayer: MultiLayerState | undefined,
  layerTimes: Partial<Record<LayerType, string>> | undefined,
  zoom: number,
  signal: AbortSignal,
): Promise<SpotData> {
  const t = (time || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const sstL = (multiLayer?.sst.enabled ? multiLayer.sst.layer : "sst_nrt") as LayerType;
  const chlL = (multiLayer?.chlorophyll.enabled ? multiLayer.chlorophyll.layer : "chl") as LayerType;
  const altL = (multiLayer?.altimetry.enabled ? multiLayer.altimetry.layer : "alt_combined") as LayerType;
  const z = Math.max(3, Math.min(9, Math.round(zoom)));

  const [sstR, chlR, altR, uoR, voR, wind] = await Promise.all([
    fetchCopernicusValue(
      LAYER_CONFIGS[sstL].wmtsLayer,
      LAYER_CONFIGS[sstL].style,
      latlng.lat,
      latlng.lng,
      z,
      layerTimes?.[sstL] ?? t,
      signal,
    ).then((r) => r.value).catch(() => null),
    fetchCopernicusValue(
      LAYER_CONFIGS[chlL].wmtsLayer,
      LAYER_CONFIGS[chlL].style,
      latlng.lat,
      latlng.lng,
      z,
      layerTimes?.[chlL] ?? t,
      signal,
    ).then((r) => r.value).catch(() => null),
    fetchCopernicusValue(
      LAYER_CONFIGS[altL].wmtsLayer,
      LAYER_CONFIGS[altL].style,
      latlng.lat,
      latlng.lng,
      z,
      layerTimes?.[altL] ?? t,
      signal,
    ).then((r) => r.value).catch(() => null),
    Promise.resolve(null as number | null),
    Promise.resolve(null as number | null),
    fetchWindForecast(latlng.lat, latlng.lng, signal).catch(() => null),
  ]);

  return {
    sst: sstR,
    chl: chlR,
    alt: altR,
    uo: uoR,
    vo: voR,
    wind: wind ? { avgKn: wind.avgKn, gustKn: wind.gustKn, dirDeg: wind.dirDeg } : null,
  };
}

// ────────────────────────── componente ──────────────────────────

interface FsleLayerProps {
  enabled: boolean;
  time?: string;
  refreshKey?: string;
  multiLayer?: MultiLayerState;
  layerTimes?: Partial<Record<LayerType, string>>;
}

export function FsleLayer({ enabled, time, multiLayer, layerTimes }: FsleLayerProps) {
  const map = useMap();
  // Estado persistente por sesión: un LayerGroup por tile geográfico ya cargado.
  // Zoom/pan NO refetch: sólo se piden tiles nuevos que entran en vista.
  interface StoredRidge {
    coords: Array<[number, number]>; // WGS84 [lng, lat]
    fsleValues: number[];
    properties: {
      fsle: number;
      fsleAvg: number;
      fsleMax: number;
      lengthKm: number;
      confidence: number;
      nearNaN: boolean;
    };
  }
  interface LoadedTile {
    group: L.LayerGroup;
    tileId: string;
    tileSouth: number;
    tileWest: number;
    cache: "HIT" | "MISS" | "LOCAL";
    computedAt: string;
    resolution: number;
    datasetTime: string;
    ridgeCount: number;
    ridges: StoredRidge[];
    ageMs?: number;
    computeMs?: number;
    fetchMs?: number;
  }
  const tilesRef = useRef<Map<string, LoadedTile>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const inFlightStartRef = useRef<Map<string, number>>(new Map());
  const metricsRef = useRef<{ hit: number; miss: number; local: number; totalMs: number; peakParallel: number }>({
    hit: 0, miss: 0, local: 0, totalMs: 0, peakParallel: 0,
  });
  const abortRef = useRef<AbortController | null>(null);
  const loaderRef = useRef<HTMLDivElement | null>(null);
  const lastToastRef = useRef<number>(0);

  const [_tick, setTick] = useState(0);

  const propsRef = useRef({ multiLayer, layerTimes, time });
  propsRef.current = { multiLayer, layerTimes, time };

  const activeDate = useMemo(
    () => (time || new Date().toISOString().slice(0, 10)).slice(0, 10),
    [time],
  );

  // Overlay de carga
  const showLoader = (label: string) => {
    let el = loaderRef.current;
    if (!el) {
      el = document.createElement("div");
      el.className = "fsle-loading-overlay";
      el.style.cssText = [
        "position:absolute",
        "top:50%",
        "left:50%",
        "transform:translate(-50%,-50%)",
        "z-index:1200",
        "background:rgba(15,23,42,0.85)",
        "color:#fff",
        "padding:10px 14px",
        "border-radius:10px",
        "font:500 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif",
        "display:flex",
        "align-items:center",
        "gap:10px",
        "box-shadow:0 4px 14px rgba(0,0,0,0.35)",
        "pointer-events:none",
        "backdrop-filter:blur(4px)",
        "max-width:70vw",
        "text-align:left",
      ].join(";");
      if (!document.getElementById("fsle-loading-kf")) {
        const st = document.createElement("style");
        st.id = "fsle-loading-kf";
        st.textContent = "@keyframes fsle-spin{to{transform:rotate(360deg)}}";
        document.head.appendChild(st);
      }
      map.getContainer().appendChild(el);
      loaderRef.current = el;
    }
    el.innerHTML =
      '<span style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.35);border-top-color:#fff;border-radius:50%;display:inline-block;animation:fsle-spin 0.8s linear infinite;flex-shrink:0"></span>' +
      `<span>${escapeHtml(label)}</span>`;
    el.style.display = "flex";
  };
  const hideLoader = () => {
    if (loaderRef.current) loaderRef.current.style.display = "none";
  };

  // Botón flotante persistente "⬇ GeoJSON": descarga las líneas FSLE tal y
  // como aparecen en el mapa (WGS84, formato GeoJSON estándar, sin datos de
  // depuración). Abre directamente en QGIS, ArcGIS, Leaflet, OpenLayers y,
  // tras conversión a KML, en Google Earth.
  const traceBtnRef = useRef<HTMLButtonElement | null>(null);
  const showTraceButton = () => {
    let el = traceBtnRef.current;
    if (!el) {
      el = document.createElement("button");
      el.type = "button";
      el.textContent = "⬇ GeoJSON";
      el.title = "Descargar líneas FSLE como GeoJSON (QGIS, ArcGIS, Leaflet…)";
      el.style.cssText = [
        "position:absolute",
        "top:12px",
        "right:12px",
        "z-index:1301",
        "background:rgba(2,6,23,0.92)",
        "color:#7dd3fc",
        "border:1px solid rgba(56,189,248,0.5)",
        "padding:6px 10px",
        "border-radius:8px",
        "font:600 11px/1.2 system-ui,-apple-system,Segoe UI,sans-serif",
        "cursor:pointer",
        "box-shadow:0 2px 8px rgba(0,0,0,0.4)",
        "backdrop-filter:blur(4px)",
        "pointer-events:auto",
        "touch-action:manipulation",
      ].join(";");
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const w = window as unknown as { __fsleDownloadGeoJSON?: () => void };
        if (typeof w.__fsleDownloadGeoJSON === "function") {
          w.__fsleDownloadGeoJSON();
        } else {
          toast.info("Todavía no hay líneas FSLE cargadas para exportar.");
        }
      });
      map.getContainer().appendChild(el);
      traceBtnRef.current = el;
    }
    el.style.display = "block";
  };
  const hideTraceButton = () => {
    if (traceBtnRef.current) traceBtnRef.current.style.display = "none";
  };


  // Pane + renderer
  useEffect(() => {
    if (!map.getPane(FSLE_PANE)) {
      const pane = map.createPane(FSLE_PANE);
      pane.style.zIndex = "1180";
      pane.style.pointerEvents = "auto";
    }
    setTick((v) => v + 1);
  }, [map]);

  // Ciclo principal — MODO NAVEGACIÓN ESTABLE:
  //   1) Al activar / cambiar fecha → resetea tiles cargados.
  //   2) Cada moveend → identifica los tiles de 2° que cubren la vista.
  //      Los ya cargados no se refetchan (persistencia por sesión).
  //   3) Zoom SOLO cambia detalle visual, jamás dispara refetch.
  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      for (const t of tilesRef.current.values()) t.group.remove();
      tilesRef.current.clear();
      inFlightRef.current.clear();
      hideLoader();
      hideTraceButton();
      return;
    }
    showTraceButton();

    // Al cambiar de fecha, la "foto del día" cambia → limpiar tiles cargados.
    for (const t of tilesRef.current.values()) t.group.remove();
    tilesRef.current.clear();
    inFlightRef.current.clear();
    inFlightStartRef.current.clear();
    metricsRef.current = { hit: 0, miss: 0, local: 0, totalMs: 0, peakParallel: 0 };
    // Purga entradas de localStorage de fechas distintas a la activa.
    pruneOldLocalTiles(activeDate);

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const renderGeojsonIntoGroup = (
      geojson: {
        features: Array<{
          geometry:
            | { type: "LineString"; coordinates: Array<[number, number]> }
            | { type: "Polygon"; coordinates: Array<Array<[number, number]>> }
            | { type: "Point"; coordinates: [number, number] };
          properties: {
            kind?: "ridge" | "fsle_cell" | "trajectory";
            fsle?: number;
            fsleValues?: number[];
            fsleAvg?: number;
            fsleMax?: number;
            lengthKm?: number;
            confidence?: number;
            nearNaN?: boolean;
            norm?: number;
            value?: number;
          };
        }>;
      },
      group: L.LayerGroup,
    ) => {
      const cellFeats = geojson.features.filter((f) => f.properties.kind === "fsle_cell");
      const ridgeFeats = geojson.features.filter(
        (f) => (f.properties.kind ?? "ridge") === "ridge" && f.geometry.type === "LineString",
      );

      // Raster (casi transparente para no tapar las líneas finas de LCS)
      for (const feat of cellFeats) {
        if (feat.geometry.type !== "Polygon") continue;
        const ring = feat.geometry.coordinates[0].map(
          ([lng, lat]) => [lat, lng] as [number, number],
        );
        const nrm = Math.max(0, Math.min(1, Number(feat.properties.norm ?? 0)));
        const val = Number(feat.properties.value ?? 0);
        if (!Number.isFinite(val) || val <= 0) continue;
        L.polygon(ring, {
          pane: FSLE_PANE,
          color: fsleRasterColor(nrm),
          weight: 0,
          fillColor: fsleRasterColor(nrm),
          fillOpacity: 0.03 + 0.08 * nrm,
          interactive: false,
        }).addTo(group);
      }

      // Crestas LCS
      const capped = ridgeFeats.slice(0, 300);
      for (const feat of capped) {
        if (feat.geometry.type !== "LineString") continue;
        const rawPoints: Array<[number, number]> = feat.geometry.coordinates.map(
          ([lng, lat]) => [lat, lng],
        );
        if (rawPoints.length < 2) continue;
        const intensity = Math.max(0, Math.min(1, Number(feat.properties.fsle ?? 0)));
        const confidence = Math.max(0, Math.min(1, Number(feat.properties.confidence ?? 0)));
        const rawFsleVals = Array.isArray(feat.properties.fsleValues)
          ? (feat.properties.fsleValues as number[])
          : [];

        // Suavizado Chaikin (2 pasadas) — usa el helper compartido con el
        // exportador GeoJSON para garantizar que el .geojson que descarga el
        // usuario contiene exactamente las mismas líneas que se dibujan.
        const rawLngLat: Array<[number, number]> = rawPoints.map(
          ([lat, lng]) => [lng, lat],
        );
        const smoothed = chaikinSmoothLonLat(rawLngLat, rawFsleVals, intensity, 2);
        const pts: Array<[number, number]> = smoothed.coords.map(
          ([lng, lat]) => [lat, lng],
        );
        const vals = smoothed.values;

        // Grosor variable según intensidad FSLE (líneas muy finas), respetando
        // también la confianza global de la línea.
        const widthFor = (t: number) => 0.6 + 1.2 * t + 0.4 * confidence;

        // Halo oscuro mínimo para legibilidad sobre mapas claros.
        const maxW = widthFor(Math.max(intensity, ...vals));
        L.polyline(pts, {
          pane: FSLE_PANE,
          color: "#020617",
          weight: maxW + 0.5,
          opacity: 0.6,
          interactive: false,
          lineCap: "round",
          lineJoin: "round",
        }).addTo(group);

        // Colored: se dibuja como sub-segmentos para variar grosor Y color
        // (amarillo→rojo) a lo largo de la línea sin perder la interacción.
        const openSegPopup = (latlng: L.LatLng, i: number) => {
          const t = vals[i] ?? intensity;
          openSpotPopup(latlng, t, {
            confidence,
            fsleAvg: Number(feat.properties.fsleAvg ?? 0),
            fsleMax: Number(feat.properties.fsleMax ?? 0),
            lengthKm: Number(feat.properties.lengthKm ?? 0),
            nearNaN: !!feat.properties.nearNaN,
          });
        };
        for (let i = 0; i < pts.length - 1; i++) {
          const t = (vals[i] + vals[i + 1]) * 0.5;
          const seg = L.polyline([pts[i], pts[i + 1]], {
            pane: FSLE_PANE,
            color: intensityColor(t),
            weight: Math.max(widthFor(t), 0.8),
            opacity: 1,
            interactive: true,
            bubblingMouseEvents: false,
            lineCap: "round",
            lineJoin: "round",
          });
          seg.on("dblclick", (ev: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(ev.originalEvent as Event);
            openSegPopup(ev.latlng, i);
          });
          seg.addTo(group);
        }
      }
    };

    // Función común: instala un tile ya resuelto (payload GeoJSON) en el mapa
    // y actualiza métricas. Devuelve el LoadedTile insertado.
    const installTile = (
      tile: TileKey,
      geojson: {
        properties?: {
          cache?: string;
          computeMs?: number;
          computedAt?: string;
          tile_id?: string;
          dataset_time?: string;
          resolution?: number;
          ridgeCount?: number;
        };
        features: Array<{
          geometry:
            | { type: "LineString"; coordinates: Array<[number, number]> }
            | { type: "Polygon"; coordinates: Array<Array<[number, number]>> }
            | { type: "Point"; coordinates: [number, number] };
          properties: {
            kind?: "ridge" | "fsle_cell" | "trajectory";
            fsle?: number;
            fsleValues?: number[];
            fsleAvg?: number;
            fsleMax?: number;
            lengthKm?: number;
            confidence?: number;
            nearNaN?: boolean;
            norm?: number;
            value?: number;
          };
        }>;
      },
      cache: "HIT" | "MISS" | "LOCAL",
      fetchMs: number,
      ageMs?: number,
    ): LoadedTile => {
      const p = geojson.properties ?? {};
      const group = L.layerGroup([], { pane: FSLE_PANE });
      renderGeojsonIntoGroup(geojson, group);
      group.addTo(map);

      // Extrae las crestas LineString con propiedades limpias para poder
      // exportar un GeoJSON reproducible sin metadatos de caché/debug.
      const ridges: StoredRidge[] = [];
      const ridgeFeatures = geojson.features
        .filter((feat) => (feat.properties.kind ?? "ridge") === "ridge" && feat.geometry.type === "LineString")
        .slice(0, 60);
      for (const feat of ridgeFeatures) {
        if ((feat.properties.kind ?? "ridge") !== "ridge") continue;
        if (feat.geometry.type !== "LineString") continue;
        const coords = (feat.geometry.coordinates as Array<[number, number]>).filter(
          ([lng, lat]) =>
            Number.isFinite(lng) && Number.isFinite(lat) &&
            Math.abs(lat) <= 90 && Math.abs(lng) <= 180,
        );
        if (coords.length < 2) continue;
        const raw = Array.isArray(feat.properties.fsleValues)
          ? (feat.properties.fsleValues as number[])
          : [];
        ridges.push({
          coords,
          fsleValues: raw,
          properties: {
            fsle: Number(feat.properties.fsle ?? 0),
            fsleAvg: Number(feat.properties.fsleAvg ?? 0),
            fsleMax: Number(feat.properties.fsleMax ?? 0),
            lengthKm: Number(feat.properties.lengthKm ?? 0),
            confidence: Number(feat.properties.confidence ?? 0),
            nearNaN: !!feat.properties.nearNaN,
          },
        });
      }

      const loaded: LoadedTile = {
        group,
        tileId: p.tile_id ?? tile.id,
        tileSouth: tile.tileSouth,
        tileWest: tile.tileWest,
        cache,
        computedAt: p.computedAt ?? new Date().toISOString(),
        resolution: p.resolution ?? 64,
        datasetTime: p.dataset_time ?? `${activeDate}T00:00:00.000Z`,
        ridgeCount: p.ridgeCount ?? ridges.length,
        ridges,
        ageMs,
        computeMs: p.computeMs,
        fetchMs,
      };
      tilesRef.current.set(tile.id, loaded);

      // métricas
      const m = metricsRef.current;
      if (cache === "LOCAL") m.local++;
      else if (cache === "HIT") m.hit++;
      else m.miss++;
      m.totalMs += fetchMs;
      return loaded;
    };

    // ── Exportador GeoJSON limpio ─────────────────────────────────────
    // Recorre todos los tiles cargados y construye un FeatureCollection en
    // WGS84 (EPSG:4326) con las mismas líneas suavizadas (Chaikin 2 pases)
    // que se ven en el mapa. Sólo Placemarks de crestas LCS; sin celdas
    // raster, sin metadatos de caché/tile/computedAt. Abre en QGIS, ArcGIS,
    // Leaflet, OpenLayers y (tras conversión) en Google Earth.
    const buildCleanFeatureCollection = () => {
      type CleanFeature = {
        type: "Feature";
        geometry: { type: "LineString"; coordinates: Array<[number, number]> };
        properties: {
          fsle: number;
          fsleAvg: number;
          fsleMax: number;
          fsleValues: number[];
          lengthKm: number;
          confidence: number;
          nearNaN: boolean;
          dataset_time: string;
        };
      };
      const features: CleanFeature[] = [];
      const tiles = Array.from(tilesRef.current.values());
      // Deduplicación: crestas idénticas pueden aparecer si dos tiles
      // solapan en la frontera (raro pero posible). Firma = redondeo 5 dec.
      const seen = new Set<string>();
      const roundKey = (c: Array<[number, number]>) =>
        c.slice(0, 4).map(([x, y]) => `${x.toFixed(5)},${y.toFixed(5)}`).join("|");
      let datasetTime = "";
      for (const t of tiles) {
        if (t.datasetTime && !datasetTime) datasetTime = t.datasetTime;
        for (const r of t.ridges) {
          const smoothed = chaikinSmoothLonLat(
            r.coords,
            r.fsleValues,
            r.properties.fsle,
            2,
          );
          const coords = smoothed.coords.map(
            ([lng, lat]) =>
              [Number(lng.toFixed(6)), Number(lat.toFixed(6))] as [number, number],
          );
          if (coords.length < 2) continue;
          const key = roundKey(coords);
          if (seen.has(key)) continue;
          seen.add(key);
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: coords },
            properties: {
              fsle: Number(r.properties.fsle.toFixed(4)),
              fsleAvg: Number(r.properties.fsleAvg.toFixed(4)),
              fsleMax: Number(r.properties.fsleMax.toFixed(4)),
              fsleValues: smoothed.values.map((v) => Number(v.toFixed(4))),
              lengthKm: Number(r.properties.lengthKm.toFixed(3)),
              confidence: Number(r.properties.confidence.toFixed(4)),
              nearNaN: r.properties.nearNaN,
              dataset_time: t.datasetTime,
            },
          });
        }
      }
      return {
        type: "FeatureCollection" as const,
        name: `FSLE ${activeDate}`,
        crs: {
          type: "name" as const,
          properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" },
        },
        features,
        // No incluimos metadatos de caché, ni tile_id, ni computeMs.
        // Sólo dataset_time (fecha Copernicus) por trazabilidad científica.
        metadata: {
          dataset_time: datasetTime || `${activeDate}T00:00:00.000Z`,
          source:
            "FSLE lagrangiano RK4 sobre uo/vo Copernicus MEDSEA (foto del día)",
          generated_at: new Date().toISOString(),
        },
      };
    };

    try {
      const w = window as unknown as { __fsleDownloadGeoJSON?: () => void };
      w.__fsleDownloadGeoJSON = () => {
        const fc = buildCleanFeatureCollection();
        if (fc.features.length === 0) {
          toast.info("Todavía no hay líneas FSLE cargadas para exportar.");
          return;
        }
        const filename = `fsle-${activeDate}.geojson`;
        const json = JSON.stringify(fc);
        void exportFileWithSheet({
          filename,
          mime: "application/geo+json",
          content: json,
          shareTitle: filename,
        }).then((result) => {
          if (result === "downloaded" || result === "shared") {
            toast.success("Archivo guardado en tu dispositivo.");
          } else if (result === "cancelled") {
            toast.info("Guardado cancelado.");
          }
        });

      };
    } catch {
      /* noop */
    }



    // Descarga un tile concreto. Prioridades:
    //   0) tilesRef (memoria)          → 0 ms
    //   1) localStorage LOCAL cache    → ~1 ms, sin red
    //   2) fetch al endpoint (HIT/MISS)
    const fetchTile = async (tile: TileKey, attempt: number = 0): Promise<void> => {
      if (tilesRef.current.has(tile.id)) return;
      if (inFlightRef.current.has(tile.id)) return;

      // ── Camino 1: localStorage (instantáneo, 0 red) ──────────────────
      const local = readLocalTile(activeDate, tile.id);
      if (local) {
        const t0 = performance.now();
        installTile(
          tile,
          local.payload as Parameters<typeof installTile>[1],
          "LOCAL",
          Math.round(performance.now() - t0),
          local.ageMs,
        );
        return;
      }

      // ── Camino 2: red ────────────────────────────────────────────────
      inFlightRef.current.add(tile.id);
      const startedAt = performance.now();
      inFlightStartRef.current.set(tile.id, Date.now());
      const parallelNow = inFlightRef.current.size;
      if (parallelNow > metricsRef.current.peakParallel) {
        metricsRef.current.peakParallel = parallelNow;
      }

      const url = `/api/public/fsle?date=${activeDate}&tileSouth=${tile.tileSouth}&tileWest=${tile.tileWest}&_v=fsle-v16`;

      // Reintento automático: teselas que devuelven MISS con 0 crestas o
      // que fallan por red/HTTP se recalculan hasta MAX_RETRIES veces con
      // backoff exponencial. Copernicus a veces devuelve 429 y produce
      // mallas con pocos valores válidos; el segundo intento suele salir OK.
      const MAX_RETRIES = 3;
      const scheduleRetry = (reason: string) => {
        inFlightRef.current.delete(tile.id);
        inFlightStartRef.current.delete(tile.id);
        if (attempt + 1 >= MAX_RETRIES || ctrl.signal.aborted) return;
        const delay = 800 * Math.pow(2, attempt); // 800, 1600, 3200 ms
        setTimeout(() => {
          if (ctrl.signal.aborted) return;
          if (tilesRef.current.has(tile.id)) return;
          void fetchTile(tile, attempt + 1);
        }, delay);
      };

      try {
        const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
        if (ctrl.signal.aborted) return;
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (attempt + 1 < MAX_RETRIES && res.status !== 422) {
            scheduleRetry(`HTTP ${res.status}`);
            return;
          }
          inFlightRef.current.delete(tile.id);
          inFlightStartRef.current.delete(tile.id);
          setTimeout(discoverAndFetch, 0);
          const now = Date.now();
          if (now - lastToastRef.current > 60000) {
            lastToastRef.current = now;
            toast.info(body.error ?? `FSLE tile ${tile.id}: HTTP ${res.status}`);
          }
          return;
        }
        const cacheHdr = (res.headers.get("X-FSLE-Cache") as "HIT" | "MISS") ?? "MISS";
        const ageHdr = Number(res.headers.get("X-FSLE-Age-Ms") ?? 0);
        const geojson = (await res.json()) as Parameters<typeof installTile>[1];
        if (ctrl.signal.aborted) return;
        const p = geojson.properties ?? {};
        const cache = ((p.cache as "HIT" | "MISS") ?? cacheHdr) as "HIT" | "MISS";
        const ridgeCount = Number(p.ridgeCount ?? 0);
        const fetchMs = Math.round(performance.now() - startedAt);

        // MISS con 0 crestas → probablemente Copernicus devolvió campo casi
        // vacío por 429; reintentar.
        if (cache === "MISS" && ridgeCount === 0 && attempt + 1 < MAX_RETRIES) {
          scheduleRetry("MISS sin crestas");
          return;
        }

        installTile(tile, geojson, cache, fetchMs, cache === "HIT" ? ageHdr : undefined);
        // Guardamos en localStorage para próximas visitas (0 red).
        writeLocalTile(activeDate, tile.id, geojson);
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;
        if (attempt + 1 < MAX_RETRIES) {
          scheduleRetry("network error");
          return;
        }
        const now = Date.now();
        if (now - lastToastRef.current > 60000) {
          lastToastRef.current = now;
          toast.error(`Error cargando tile FSLE ${tile.id}.`);
        }
      } finally {
        // Sólo limpiar aquí si no se ha programado retry (scheduleRetry ya
        // limpia; los caminos exitosos limpian implícitamente al no haber
        // inFlight en la siguiente iteración).
        if (inFlightRef.current.has(tile.id)) {
          inFlightRef.current.delete(tile.id);
          inFlightStartRef.current.delete(tile.id);
          setTimeout(discoverAndFetch, 0);
        }
      }
    };

    // Descubre los tiles que cubren la vista actual y descarga los que faltan.
    // NO cancela los que ya están cargados: la "foto del día" permanece anclada.
    const discoverAndFetch = () => {
      const wanted = tilesCoveringBounds(map.getBounds());
      for (const tile of wanted) {
        if (inFlightRef.current.size >= MAX_PARALLEL_FSLE_TILES) break;
        if (!tilesRef.current.has(tile.id) && !inFlightRef.current.has(tile.id)) {
          void fetchTile(tile);
        }
      }
    };

    const openSpotPopup = (
      latlng: L.LatLng,
      intensity: number,
      extra?: { confidence?: number; fsleAvg?: number; fsleMax?: number; lengthKm?: number; nearNaN?: boolean },
    ) => {
      const popup = L.popup({ maxWidth: 300, autoClose: true, closeButton: true })
        .setLatLng(latlng)
        .setContent(renderPopup(latlng, intensity, null, extra))
        .openOn(map);
      const pctrl = new AbortController();
      popup.on("remove", () => pctrl.abort());
      const p = propsRef.current;
      fetchSpotData(latlng, activeDate, p.multiLayer, p.layerTimes, map.getZoom(), pctrl.signal)
        .then((data) => {
          if (pctrl.signal.aborted) return;
          popup.setContent(renderPopup(latlng, intensity, data, extra));
        })
        .catch(() => {
          /* abortado o error */
        });
    };

    // Doble-click: buscar la línea más cercana entre TODOS los tiles cargados.
    const onMapDblClick = (ev: L.LeafletMouseEvent) => {
      if (tilesRef.current.size === 0) return;
      const target = map.latLngToContainerPoint(ev.latlng);
      type Best = { latlng: L.LatLng; intensity: number; d: number };
      const bestRef: { cur: Best | null } = { cur: null };
      for (const t of tilesRef.current.values()) {
        t.group.eachLayer((l: L.Layer) => {
          if (!(l instanceof L.Polyline)) return;
          const opts = l.options as L.PathOptions;
          if (!opts.interactive) return;
          const rings = l.getLatLngs() as L.LatLng[];
          const intensity =
            (opts.weight ?? 3) > 3.5
              ? Math.min(1, Math.max(0, ((opts.weight ?? 4) - 4) / 8))
              : 0.5;
          for (let i = 0; i < rings.length - 1; i++) {
            const a = map.latLngToContainerPoint(rings[i]);
            const b = map.latLngToContainerPoint(rings[i + 1]);
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len2 = dx * dx + dy * dy;
            let tt = len2 > 0 ? ((target.x - a.x) * dx + (target.y - a.y) * dy) / len2 : 0;
            tt = Math.max(0, Math.min(1, tt));
            const px = a.x + dx * tt;
            const py = a.y + dy * tt;
            const d = Math.hypot(target.x - px, target.y - py);
            const prev = bestRef.cur;
            if (!prev || d < prev.d) {
              bestRef.cur = {
                latlng: map.containerPointToLatLng(L.point(px, py)),
                intensity,
                d,
              };
            }
          }
        });
      }
      const best = bestRef.cur;
      if (!best || best.d > 90) return;
      L.DomEvent.stop(ev.originalEvent as Event);
      openSpotPopup(best.latlng, best.intensity);
    };

    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    const onMoveEnd = () => {
      if (moveTimer) clearTimeout(moveTimer);
      // Debounce: pequeñas paneos consecutivos no lanzan múltiples descubrimientos.
      moveTimer = setTimeout(discoverAndFetch, 300);
    };
    map.on("moveend", onMoveEnd);
    map.on("dblclick", onMapDblClick);
    map.doubleClickZoom?.disable();

    discoverAndFetch();

    return () => {
      if (moveTimer) clearTimeout(moveTimer);
      map.off("moveend", onMoveEnd);
      map.off("dblclick", onMapDblClick);
      map.doubleClickZoom?.enable();
      abortRef.current?.abort();
    };
  }, [enabled, activeDate, map]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      for (const t of tilesRef.current.values()) t.group.remove();
      tilesRef.current.clear();
      if (loaderRef.current) {
        loaderRef.current.remove();
        loaderRef.current = null;
      }
      if (traceBtnRef.current) {
        traceBtnRef.current.remove();
        traceBtnRef.current = null;
      }
    };
  }, []);

  return null;
}

