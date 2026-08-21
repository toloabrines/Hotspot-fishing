/**
 * Tipos y utilidades SSR-safe para Spots Pescables.
 * No importa leaflet ni react-leaflet → seguro de cargar en server.
 */

import { downloadGeneratedFile, type GeneratedFileExportResult } from "../lib/file-export";

export interface FishingSpot {
  id: string;
  lat: number;
  lng: number;
  score: number; // 0..1
  depth: number | null; // metros (positivo)
  reason: string;
  /**
   * Ranking final (1 = mejor). Se asigna ordenando por score descendente
   * tras cruzar TODAS las capas (SST, clorofila, altimetría, batimetría).
   * Solo los 3 mejores muestran badge "TOP N" en la UI.
   */
  rank?: number;
  /**
   * Valores REALES medidos en la coordenada exacta del spot (GetFeatureInfo).
   * Son los que ve el usuario en la ficha y los únicos que puede usar la IA.
   */
  sstC?: number | null;
  chlMgM3?: number | null;
  adtM?: number | null;
  currentKn?: number | null;
  bottomTempC?: number | null;
}

export type SpotsGpxExportResult = GeneratedFileExportResult;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Genera GPX con waypoints (spots) + rutas (rt). */
export function spotsToGpx(spots: FishingSpot[], routes: FishingSpot[][]): string {
  const wpts = spots
    .map(
      (s) =>
        `  <wpt lat="${s.lat.toFixed(6)}" lon="${s.lng.toFixed(6)}">
    <name>${escapeXml(`Spot ${Math.round(s.score * 100)}%`)}</name>
    <desc>${escapeXml(s.reason)}</desc>
  </wpt>`,
    )
    .join("\n");
  const rtes = routes
    .map((r, i) => {
      const pts = r
        .map(
          (s) =>
            `    <rtept lat="${s.lat.toFixed(6)}" lon="${s.lng.toFixed(6)}"><name>${escapeXml(`${Math.round(s.score * 100)}%`)}</name></rtept>`,
        )
        .join("\n");
      return `  <rte><name>${escapeXml(`Curricán ${i + 1}`)}</name>\n${pts}\n  </rte>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Hotspot Fishing" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
${rtes}
</gpx>`;
}

export async function downloadSpotsGpx(
  spots: FishingSpot[],
  routes: FishingSpot[][],
): Promise<SpotsGpxExportResult> {
  if (typeof window === "undefined") return "cancelled";
  if (spots.length === 0) {
    alert("No hay spots para exportar. Activa SST/clorofila y re-analiza.");
    return "empty";
  }
  const gpx = spotsToGpx(spots, routes);
  const filename = `totymar-spots-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.gpx`;
  return downloadGeneratedFile({
    filename,
    mime: "application/gpx+xml",
    content: gpx,
    shareTitle: "Spots Totymar",
    shareText: "Spots GPS Totymar",
  });
}

/** Convierte lat/lng decimal a "GG°MM.mmm' N/S" estilo plotter. */
export function toDegMin(value: number, axis: "lat" | "lng"): string {
  const hemi = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${deg}°${min.toFixed(3).padStart(6, "0")}' ${hemi}`;
}

/** Convierte lat/lng decimal a "GG°MM'SS.s\" N/S" (grados, minutos, segundos). */
export function toDegMinSec(value: number, axis: "lat" | "lng"): string {
  const hemi = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  let min = Math.floor(minFloat);
  let sec = (minFloat - min) * 60;
  // Carry over por redondeo (59.95" → 60.0")
  if (sec >= 59.95) {
    sec = 0;
    min += 1;
  }
  if (min >= 60) {
    min = 0;
    deg += 1;
  }
  const degPad = axis === "lat" ? 2 : 3;
  return `${String(deg).padStart(degPad, "0")}°${String(min).padStart(2, "0")}'${sec.toFixed(1).padStart(4, "0")}" ${hemi}`;
}

