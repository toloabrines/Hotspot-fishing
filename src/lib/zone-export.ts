/**
 * Exportación GPX/KML para zonas de gradiente y corredores de pesca.
 */

import type { LatLng } from "./geo-area";
import type { GradientZone } from "./gradient-zones.types";
import {
  exportFileWithSheet,
  exportFilesWithSheet,
  type GeneratedFileExportResult,
} from "./file-export";


export type ZoneExportResult = GeneratedFileExportResult;

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&apos;",
  );
}

async function downloadBlob(
  filename: string,
  mime: string,
  content: string,
): Promise<ZoneExportResult> {
  return exportFileWithSheet({ filename, mime, content, shareTitle: filename });
}

async function downloadEarthKml(filename: string, content: string): Promise<ZoneExportResult> {
  return exportFileWithSheet({
    filename,
    mime: "application/vnd.google-earth.kml+xml",
    content,
    shareTitle: "Abrir en Google Earth",
    shareText: "Elige Google Earth para ver la ruta.",
  });
}


function zoneName(zone: GradientZone, idx: number): string {
  const vars = zone.vars.join("+").toUpperCase();
  return `Frente ${idx + 1} (${vars}) ${zone.areaKm2.toFixed(1)} km² · ${zone.lengthNm.toFixed(1)} mn`;
}

function isValidPoint(p: LatLng): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

function cleanLine(points: LatLng[]): LatLng[] {
  const out: LatLng[] = [];
  for (const p of points) {
    if (!isValidPoint(p)) continue;
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.lat - p.lat) < 0.000001 && Math.abs(prev.lng - p.lng) < 0.000001)
      continue;
    out.push(p);
  }
  return out;
}

function lineCoords(points: LatLng[]): string {
  return cleanLine(points)
    .map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)},0`)
    .join(" ");
}

function zoneTrackPoints(zone: GradientZone): LatLng[] {
  if (zone.cells.length >= 2) {
    const c = zone.axis.centroid;
    const cosLat = Math.cos((c.lat * Math.PI) / 180) || 1;
    let vx = zone.axis.dir.lng * 111 * cosLat;
    let vy = zone.axis.dir.lat * 111;
    const norm = Math.hypot(vx, vy) || 1;
    vx /= norm;
    vy /= norm;

    const samples = zone.cells
      .map((cell) => {
        const point = cell.ridge?.point ?? cell.center;
        const x = (point.lng - c.lng) * 111 * cosLat;
        const y = (point.lat - c.lat) * 111;
        return {
          point,
          proj: x * vx + y * vy,
          score: Math.max(0.1, cell.ridge?.strength ?? cell.score ?? 0.1),
        };
      })
      .filter((sample) => isValidPoint(sample.point))
      .sort((a, b) => a.proj - b.proj);

    if (samples.length >= 2) {
      const lengthKm = Math.max(0.4, zone.lengthNm * 1.852);
      const binKm = Math.max(0.2, lengthKm / 60);
      const bins: { lat: number; lng: number; weight: number; proj: number }[] = [];

      for (const sample of samples) {
        const last = bins[bins.length - 1];
        if (!last || sample.proj - last.proj > binKm) {
          bins.push({
            lat: sample.point.lat * sample.score,
            lng: sample.point.lng * sample.score,
            weight: sample.score,
            proj: sample.proj,
          });
        } else {
          last.lat += sample.point.lat * sample.score;
          last.lng += sample.point.lng * sample.score;
          last.weight += sample.score;
          last.proj = (last.proj + sample.proj) / 2;
        }
      }

      const track = cleanLine(
        bins.map((bin) => ({ lat: bin.lat / bin.weight, lng: bin.lng / bin.weight })),
      );
      if (track.length >= 2) return track;
    }
  }

  return cleanLine(zone.outline);
}

function closedRing(points: LatLng[]): LatLng[] {
  const ring = cleanLine(points);
  if (ring.length < 3) return [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (Math.abs(first.lat - last.lat) >= 0.000001 || Math.abs(first.lng - last.lng) >= 0.000001) {
    ring.push(first);
  }
  return ring;
}

export function buildGpx(
  zones: GradientZone[],
  corridors: { zoneId: string; route: LatLng[] }[],
): string {
  const tracks: string[] = [];
  zones.forEach((z, i) => {
    const track = zoneTrackPoints(z);
    if (track.length < 2) return;
    const pts = track
      .map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"/>`)
      .join("\n");
    tracks.push(
      `  <trk><name>${escapeXml(zoneName(z, i))}</name><trkseg>\n${pts}\n    </trkseg></trk>`,
    );
  });
  corridors.forEach((c, i) => {
    if (c.route.length < 2) return;
    const pts = c.route
      .map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"/>`)
      .join("\n");
    tracks.push(
      `  <trk><name>${escapeXml(`Corredor pesca ${i + 1}`)}</name><trkseg>\n${pts}\n    </trkseg></trk>`,
    );
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Hotspot Fishing" xmlns="http://www.topografix.com/GPX/1/1">
${tracks.join("\n")}
</gpx>
`;
}

export function buildKml(
  zones: GradientZone[],
  corridors: { zoneId: string; route: LatLng[] }[],
): string {
  const placemarks: string[] = [];
  zones.forEach((z, i) => {
    const track = zoneTrackPoints(z);
    if (track.length < 2) return;
    const trackCoords = lineCoords(track);
    const ring = closedRing(z.outline);
    if (ring.length >= 4) {
      placemarks.push(`  <Placemark>
    <name>${escapeXml(zoneName(z, i))}</name>
    <styleUrl>#zoneStyle</styleUrl>
    <Polygon>
      <tessellate>1</tessellate>
      <altitudeMode>clampToGround</altitudeMode>
      <outerBoundaryIs><LinearRing>
        <coordinates>${lineCoords(ring)}</coordinates>
      </LinearRing></outerBoundaryIs>
    </Polygon>
  </Placemark>`);
    }
    placemarks.push(`  <Placemark>
    <name>${escapeXml(`Track frente ${i + 1}`)}</name>
    <description>${escapeXml(zoneName(z, i))}</description>
    <styleUrl>#zoneTrackStyle</styleUrl>
    <LineString>
      <tessellate>1</tessellate>
      <altitudeMode>clampToGround</altitudeMode>
      <coordinates>${trackCoords}</coordinates>
    </LineString>
  </Placemark>`);
  });
  corridors.forEach((c, i) => {
    const route = cleanLine(c.route);
    if (route.length < 2) return;
    const coords = lineCoords(route);
    placemarks.push(`  <Placemark>
    <name>${escapeXml(`Corredor pesca ${i + 1}`)}</name>
    <styleUrl>#corridorStyle</styleUrl>
    <LineString>
      <tessellate>1</tessellate>
      <altitudeMode>clampToGround</altitudeMode>
      <coordinates>${coords}</coordinates>
    </LineString>
  </Placemark>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Frentes Productivos</name>
  <open>1</open>
  <Style id="zoneStyle">
    <LineStyle><color>ff00a5ff</color><width>2</width></LineStyle>
    <PolyStyle><color>3300a5ff</color><outline>1</outline><fill>1</fill></PolyStyle>
  </Style>
  <Style id="zoneTrackStyle">
    <LineStyle><color>ff00ffff</color><width>5</width></LineStyle>
  </Style>
  <Style id="corridorStyle">
    <LineStyle><color>ff00ffff</color><width>4</width></LineStyle>
  </Style>
${placemarks.join("\n")}
</Document>
</kml>
`;
}

export function downloadZoneGpx(zone: GradientZone, idx: number, corridor?: LatLng[]) {
  const c = corridor ? [{ zoneId: zone.id, route: corridor }] : [];
  return downloadBlob(`frente-${idx + 1}.gpx`, "application/gpx+xml", buildGpx([zone], c));
}

export function downloadZoneKml(
  zone: GradientZone,
  idx: number,
  corridor?: LatLng[],
): Promise<ZoneExportResult> {
  const c = corridor ? [{ zoneId: zone.id, route: corridor }] : [];
  return downloadEarthKml(`frente-${idx + 1}.kml`, buildKml([zone], c));
}

export function downloadAllGpx(
  zones: GradientZone[],
  corridors: { zoneId: string; route: LatLng[] }[] = [],
): Promise<ZoneExportResult> {
  if (zones.length === 0 && corridors.length === 0) {
    if (typeof window !== "undefined") {
      window.alert(
        "No hay frentes productivos para exportar. Activa Frentes Productivos y espera el análisis.",
      );
    }
    return Promise.resolve("empty" as ZoneExportResult);
  }
  return downloadBlob("frentes-productivos.gpx", "application/gpx+xml", buildGpx(zones, corridors));
}

export function downloadAllKml(
  zones: GradientZone[],
  corridors: { zoneId: string; route: LatLng[] }[] = [],
): Promise<ZoneExportResult> {
  if (zones.length === 0 && corridors.length === 0) {
    if (typeof window !== "undefined") {
      window.alert(
        "No hay frentes productivos para exportar. Activa Frentes Productivos y espera el análisis.",
      );
    }
    return Promise.resolve("empty" as ZoneExportResult);
  }
  return downloadEarthKml("frentes-productivos.kml", buildKml(zones, corridors));
}

/**
 * Exporta a la vez GPX y KML en un solo gesto del usuario para que pueda
 * abrir el KML en Google Earth y conservar el GPX para el plotter/GPS.
 */
/**
 * Verifica que el export tenga al menos una traza visible en Google Earth:
 * polígono de zona (≥3 puntos) o corredor LineString (≥2 puntos).
 */
function hasRenderableTrack(
  zones: GradientZone[],
  corridors: { zoneId: string; route: LatLng[] }[],
): boolean {
  const zoneOk = zones.some(
    (z) => zoneTrackPoints(z).length >= 2 || closedRing(z.outline).length >= 4,
  );
  const corrOk = corridors.some((c) => cleanLine(c.route).length >= 2);
  return zoneOk || corrOk;
}

export async function downloadAllGpxAndKml(
  zones: GradientZone[],
  corridors: { zoneId: string; route: LatLng[] }[] = [],
): Promise<{ gpx: ZoneExportResult; kml: ZoneExportResult }> {
  if (zones.length === 0 && corridors.length === 0) {
    if (typeof window !== "undefined") {
      window.alert(
        "No hay frentes productivos para exportar. Activa Frentes Productivos y espera el análisis.",
      );
    }
    return { gpx: "empty", kml: "empty" };
  }
  if (!hasRenderableTrack(zones, corridors)) {
    if (typeof window !== "undefined") {
      window.alert(
        "El KML/GPX no contiene ninguna traza válida (polígonos con <3 puntos y sin corredores). Google Earth lo abriría vacío. Recalcula los frentes y vuelve a exportar.",
      );
    }
    return { gpx: "empty", kml: "empty" };
  }
  // Los dos archivos en una sola hoja (web) o secuencialmente en nativo:
  // así nunca se salta ninguna ventana.
  const result = await exportFilesWithSheet(
    [
      {
        filename: "frentes-productivos.kml",
        mime: "application/vnd.google-earth.kml+xml",
        content: buildKml(zones, corridors),
      },
      {
        filename: "frentes-productivos.gpx",
        mime: "application/gpx+xml",
        content: buildGpx(zones, corridors),
      },
    ],
    "Frentes productivos",
  );
  return { gpx: result, kml: result };
}

export async function downloadZoneGpxAndKml(
  zone: GradientZone,
  idx: number,
  corridor?: LatLng[],
): Promise<{ gpx: ZoneExportResult; kml: ZoneExportResult }> {
  const corridors = corridor ? [{ zoneId: zone.id, route: corridor }] : [];
  if (!hasRenderableTrack([zone], corridors)) {
    if (typeof window !== "undefined") {
      window.alert(
        `El frente ${idx + 1} no tiene traza suficiente para Google Earth (polígono <3 puntos y sin corredor). Recalcula y vuelve a exportar.`,
      );
    }
    return { gpx: "empty", kml: "empty" };
  }
  const c = corridor ? [{ zoneId: zone.id, route: corridor }] : [];
  const result = await exportFilesWithSheet(
    [
      {
        filename: `frente-${idx + 1}.kml`,
        mime: "application/vnd.google-earth.kml+xml",
        content: buildKml([zone], c),
      },
      {
        filename: `frente-${idx + 1}.gpx`,
        mime: "application/gpx+xml",
        content: buildGpx([zone], c),
      },
    ],
    `Frente ${idx + 1}`,
  );
  return { gpx: result, kml: result };
}


/**
 * Descarga el KML y abre Google Earth Web. Google Earth Web NO carga archivos
 * remotos automáticamente: el usuario debe arrastrar el .kml descargado a la
 * ventana de Earth (o ☰ → Proyectos → Importar archivo KML).
 */
export async function openInGoogleEarth(
  zones: GradientZone[],
  corridors: { zoneId: string; route: LatLng[] }[] = [],
): Promise<ZoneExportResult> {
  if (zones.length === 0 && corridors.length === 0) {
    if (typeof window !== "undefined") {
      window.alert(
        "No hay frentes productivos para exportar. Activa Frentes Productivos y espera el análisis.",
      );
    }
    return "empty";
  }

  // 1) Descargar el KML primero (dentro del gesto del usuario).
  const result = await downloadEarthKml("frentes-productivos.kml", buildKml(zones, corridors));

  // Si la app nativa ya ha mostrado "Abrir en…" / compartir, no abras también
  // Google Earth Web encima: eso era parte de la sensación de que "no funciona".
  if (result !== "downloaded" && result !== "copied") return result;

  // 2) Abrir Google Earth Web e indicar cómo cargar el .kml.
  if (typeof window !== "undefined") {
    try {
      window.open("https://earth.google.com/web/", "_blank", "noopener,noreferrer");
    } catch {
      /* popup bloqueado */
    }
    setTimeout(() => {
      window.alert(
        "KML descargado. En Google Earth Web: ☰ → Proyectos → Nuevo proyecto → Importar archivo KML/KMZ y elige 'frentes-productivos.kml' desde tus Descargas. En móvil, abre la app Archivos y comparte el .kml a Google Earth.",
      );
    }, 600);
  }

  return result;
}

