/**
 * Importación/exportación de waypoints en formato GPX 1.1.
 * Compatible con Garmin, Navionics, Google Earth y la mayoría de plotters.
 */
import type { SavedWaypoint } from "../hooks/use-saved-waypoints";
import { Capacitor } from "@capacitor/core";
import type { GeneratedFileExportResult } from "./file-export";
import { EarthShareNative } from "./earth-share-native";

function isNativeIos(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

function isCancelled(error: unknown): boolean {
  const value = error as { name?: string; message?: string };
  return value?.name === "AbortError" || /cancel|dismiss|closed/i.test(String(value?.message ?? error));
}

export type ImportedWaypoint = {
  lat: number;
  lng: number;
  name: string;
  depth: number | null;
  reason: string;
};

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&apos;",
  );
}

/** Construye un GPX 1.1 con todos los waypoints. */
export function buildWaypointsGpx(waypoints: SavedWaypoint[]): string {
  const now = new Date().toISOString();
  const wpts = waypoints
    .filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng))
    .map((w) => {
      const time = new Date(w.savedAt || Date.now()).toISOString();
      const ele =
        w.depth !== null && Number.isFinite(w.depth)
          ? `\n    <ele>${(-Math.abs(w.depth)).toFixed(1)}</ele>`
          : "";
      const desc = w.reason ? `\n    <desc>${escapeXml(w.reason)}</desc>` : "";
      return `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lng.toFixed(6)}">${ele}
    <time>${time}</time>
    <name>${escapeXml(w.name || "Waypoint")}</name>${desc}
    <sym>Anchor</sym>
  </wpt>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Hotspot Fishing" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Hotspot Fishing — Waypoints</name>
    <time>${now}</time>
  </metadata>
${wpts}
</gpx>`;
}

const GPX_MIME = "application/gpx+xml";
const XML_FALLBACK_MIMES = ["application/xml", "text/xml", "text/plain"];

function gpxFilename(): string {
  return `waypoints-hotspot-fishing-${new Date().toISOString().slice(0, 10)}.gpx`;
}

/** Blob GPX en UTF-8 real (con BOM-less encoder explícito). */
function gpxBlob(content: string, mime: string): Blob {
  const bytes = new TextEncoder().encode(content);
  return new Blob([bytes], { type: `${mime};charset=utf-8` });
}

/**
 * Descarga mediante un enlace temporal oculto. Nunca navega la página actual
 * (en iPhone eso deja una pantalla en blanco). Limpia siempre la URL temporal.
 */
export function downloadWaypointsGpxDirect(waypoints: SavedWaypoint[]): boolean {
  if (typeof document === "undefined" || waypoints.length === 0) return false;
  try {
    const blob = gpxBlob(buildWaypointsGpx(waypoints), GPX_MIME);
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = gpxFilename();
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
    return true;
  } catch (error) {
    console.error("No se pudo descargar el GPX", error);
    return false;
  }
}

/** Intenta compartir un archivo con Web Share, probando tipos MIME compatibles. */
async function shareViaWebShare(
  filename: string,
  content: string,
): Promise<WaypointExportResult | null> {
  if (typeof navigator === "undefined" || typeof File === "undefined") return null;
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (!nav.share) return null;

  for (const mime of [GPX_MIME, ...XML_FALLBACK_MIMES]) {
    const file = new File([new TextEncoder().encode(content)], filename, { type: mime });
    const data: ShareData = { title: "Waypoints Hotspot Fishing", files: [file] };
    if (nav.canShare && !nav.canShare(data)) continue; // tipo rechazado: probar otro
    try {
      await nav.share(data);
      return "shared";
    } catch (error) {
      if (isCancelled(error)) return "cancelled";
      // el sistema rechazó este tipo: seguir con el siguiente
    }
  }
  return null;
}



/** Parsea texto GPX/KML y devuelve waypoints. Tolerante a namespaces y XML sucio. */
export function parseWaypointsGpx(text: string): ImportedWaypoint[] {
  const out: ImportedWaypoint[] = [];
  const clean = text.replace(/^\uFEFF/, "").trim();

  const parseDoc = (): Document | null => {
    try {
      const parser = new DOMParser();
      let doc = parser.parseFromString(clean, "application/xml");
      if (doc.getElementsByTagName("parsererror").length > 0) {
        // Fallback: el parser HTML es mucho más tolerante (etiquetas en minúscula)
        doc = parser.parseFromString(clean, "text/html");
      }
      return doc;
    } catch {
      return null;
    }
  };

  const doc = parseDoc();
  if (!doc) return out;

  const byTag = (root: Document | Element, tag: string): Element[] => {
    const lower = tag.toLowerCase();
    return Array.from(root.getElementsByTagName("*")).filter((el) => {
      const local = (el.localName || el.tagName || "").toLowerCase();
      return local === lower || local.endsWith(":" + lower);
    });
  };
  const firstText = (root: Element, tag: string): string =>
    byTag(root, tag)[0]?.textContent?.trim() || "";

  // GPX <wpt> / <rtept> / <trkpt>
  for (const tag of ["wpt", "rtept", "trkpt"]) {
    for (const w of byTag(doc, tag)) {
      const lat = parseFloat(w.getAttribute("lat") || "");
      const lng = parseFloat(w.getAttribute("lon") || w.getAttribute("lng") || "");
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const name = firstText(w, "name") || "Waypoint";
      const desc = firstText(w, "desc") || firstText(w, "cmt");
      const ele = parseFloat(firstText(w, "ele"));
      out.push({
        lat,
        lng,
        name,
        depth: Number.isFinite(ele) ? Math.abs(ele) : null,
        reason: desc || "Waypoint importado",
      });
    }
    if (out.length > 0) break;
  }

  // KML <Placemark><Point><coordinates>
  if (out.length === 0) {
    for (const pm of byTag(doc, "placemark")) {
      const coord = byTag(pm, "coordinates")[0]?.textContent?.trim();
      if (!coord) continue;
      const parts = coord.split(/\s+/)[0]?.split(",") ?? [];
      const lng = parseFloat(parts[0] ?? "");
      const lat = parseFloat(parts[1] ?? "");
      const alt = parseFloat(parts[2] ?? "");
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      out.push({
        lat,
        lng,
        name: firstText(pm, "name") || "Waypoint",
        depth: Number.isFinite(alt) && alt !== 0 ? Math.abs(alt) : null,
        reason: firstText(pm, "description") || "Waypoint importado",
      });
    }
  }

  return out;
}

/** Abre un selector de archivos y devuelve los waypoints importados. */
export async function pickAndParseWaypointsFile(): Promise<ImportedWaypoint[] | null> {
  if (isNativeIos()) {
    try {
      const file = await EarthShareNative.pickWaypointFile();
      return parseWaypointsGpx(file.content);
    } catch (error) {
      if (isCancelled(error)) return null;
      throw error;
    }
  }

  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    // Sin filtro estricto: iOS/Android ocultan .gpx si el accept es demasiado específico
    input.accept = ".gpx,.kml,.xml,.txt";
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.opacity = "0";

    let settled = false;
    const finish = (items: ImportedWaypoint[] | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      try {
        input.remove();
      } catch {
        /* noop */
      }
      resolve(items);
    };

    // Si el usuario cancela, no hay 'change': detectamos el regreso del foco.
    const onFocus = () => {
      window.setTimeout(() => {
        if (!settled && !(input.files && input.files.length > 0)) finish(null);
      }, 1500);
    };

    input.addEventListener("cancel", () => finish(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      const done = (text: string) => finish(parseWaypointsGpx(text));
      if (typeof file.text === "function") {
        file.text().then(done).catch(() => finish([]));
      } else {
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result ?? ""));
        reader.onerror = () => finish([]);
        reader.readAsText(file);
      }
    });

    window.addEventListener("focus", onFocus);
    document.body.appendChild(input);
    input.click();
  });
}


export type WaypointExportResult = "shared" | "downloaded" | "cancelled" | "failed";

function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

/** Comparte el GPX con la hoja nativa de Android (Filesystem + Share). */
async function shareViaCapacitor(
  filename: string,
  content: string,
): Promise<WaypointExportResult | null> {
  try {
    const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
      import("@capacitor/filesystem"),
      import("@capacitor/share"),
    ]);
    await Filesystem.writeFile({
      path: filename,
      data: content,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
    await Share.share({ title: "Waypoints Hotspot Fishing", files: [uri] });
    return "shared";
  } catch (error) {
    if (isCancelled(error)) return "cancelled";
    console.warn("Compartir nativo no disponible; usando fallback.", error);
    return null;
  }
}

/**
 * Guardar GPX: iOS usa el selector de Archivos nativo; el resto descarga el
 * archivo con un enlace temporal oculto (nunca navega la página).
 */
export async function exportWaypointsGpx(
  waypoints: SavedWaypoint[],
): Promise<GeneratedFileExportResult> {
  if (waypoints.length === 0) return "empty";
  const filename = gpxFilename();
  const content = buildWaypointsGpx(waypoints);

  if (isNativeIos()) {
    try {
      const result = await EarthShareNative.saveFileToFiles({
        filename,
        content,
        title: "Guardar waypoints GPX",
      });
      if (result.saved) return "downloaded";
      return "cancelled";
    } catch (error) {
      if (isCancelled(error)) return "cancelled";
      console.warn("Guardado nativo no disponible; usando descarga.", error);
    }
  }

  if (isNativeAndroid()) {
    const native = await shareViaCapacitor(filename, content);
    if (native === "shared") return "downloaded";
    if (native === "cancelled") return "cancelled";
  }

  return downloadWaypointsGpxDirect(waypoints) ? "downloaded" : "cancelled";
}

/**
 * Compartir GPX: plugin nativo → Web Share (probando tipos compatibles) →
 * descarga con enlace oculto. Nunca redirige la página actual.
 */
export async function shareWaypointsGpx(
  waypoints: SavedWaypoint[],
): Promise<WaypointExportResult> {
  if (waypoints.length === 0) return "failed";

  const filename = gpxFilename();
  const content = buildWaypointsGpx(waypoints);

  if (isNativeIos()) {
    try {
      await EarthShareNative.shareFile({
        filename,
        content,
        title: "Waypoints Hotspot Fishing",
      });
      return "shared";
    } catch (error) {
      if (isCancelled(error)) return "cancelled";
      console.warn("Compartir nativo iOS falló; usando fallback.", error);
    }
  } else if (isNativeAndroid()) {
    const native = await shareViaCapacitor(filename, content);
    if (native) return native;
  }

  const web = await shareViaWebShare(filename, content);
  if (web) return web;

  return downloadWaypointsGpxDirect(waypoints) ? "downloaded" : "failed";
}



/**
 * Guarda cualquier texto (GPX, KML, GeoJSON…) usando exactamente el mismo flujo
 * que los waypoints: selector nativo de Archivos en iOS, hoja nativa en Android
 * y descarga con enlace oculto en web. Se llama de forma síncrona desde el
 * gesto del usuario para no perder la activación del navegador.
 */
export async function saveTextFileLikeWaypoints(
  filename: string,
  content: string,
  title = "Hotspot Fishing",
  mime: string = GPX_MIME,
): Promise<GeneratedFileExportResult> {
  if (isNativeIos()) {
    try {
      const result = await EarthShareNative.saveFileToFiles({ filename, content, title });
      if (result.saved) return "downloaded";
      return "cancelled";
    } catch (error) {
      if (isCancelled(error)) return "cancelled";
      console.warn("Guardado nativo no disponible; usando descarga.", error);
    }
  }

  if (isNativeAndroid()) {
    // Paridad con iPhone: primero un archivo real en Documentos y después la
    // hoja del sistema para elegir "Guardar en Archivos"/Drive.
    try {
      const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
      await Filesystem.writeFile({
        path: filename,
        data: content,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
        recursive: true,
      });
    } catch (error) {
      console.warn("No se pudo escribir en Documentos (Android).", error);
    }
    const native = await shareViaCapacitor(filename, content);
    if (native === "shared") return "downloaded";
    if (native === "cancelled") return "cancelled";
  }

  try {
    const blob = gpxBlob(content, mime);
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
    return "downloaded";
  } catch (error) {
    console.error("No se pudo descargar el archivo", error);
  }

  const web = await shareViaWebShare(filename, content);
  if (web === "shared") return "shared";
  if (web === "cancelled") return "cancelled";

  // Último recurso: hoja propia con Guardar en Archivos / Descargar / Copiar.
  const { presentExportSheet } = await import("./file-export");
  return presentExportSheet(filename, mime, content);
}


