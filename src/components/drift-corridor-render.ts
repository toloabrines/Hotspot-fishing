/**
 * Render Leaflet de los corredores de deriva (fluixa).
 *
 * Dibuja cada frente como una línea coloreada por calidad, con marcas de
 * inicio/fin, flechas con la dirección de la deriva y un popup con toda la
 * ficha del tramo + navegación (inicio / punto más cercano / centro).
 */

import L from "leaflet";
import {
  corridorColor,
  corridorQualityLabel,
  haversineKm,
  type DriftCorridor,
} from "../lib/drift-corridor";
import { toDegMinSec } from "./FishingHotspots.types";
import { buildCorridorShareUrl } from "../lib/drift-corridor-export";
import { saveTextFileLikeWaypoints } from "../lib/waypoints-io";
import { shareLink } from "../lib/share-link";
import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";

export interface DriftCorridorRenderCtx {
  paneName: string;
  windKn: number | null;
  gustKn: number | null;
  windFromDeg: number | null;
  currentSpeedMs: number | null;
  currentDirDeg: number | null;
  onSaveWaypoint?: (
    lat: number,
    lng: number,
    score: number,
    depth: number | null,
    reason: string,
    name: string,
  ) => void;
}

const compass = (deg: number | null | undefined): string => {
  if (deg == null || !Number.isFinite(deg)) return "—";
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
  return `${Math.round(deg)}° ${dirs[Math.round(((deg % 360) / 22.5)) % 16]}`;
};

function fmtLen(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 2 : 1)} km`;
}

function fmtEta(min: number | null): string {
  if (min == null || !Number.isFinite(min)) return "—";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

export type GpxShareResult = "shared" | "cancelled" | "unsupported" | "failed";

function isCancelledError(error: unknown): boolean {
  const v = error as { name?: string; message?: string };
  return v?.name === "AbortError" || /cancel|dismiss|closed/i.test(String(v?.message ?? error));
}

/**
 * Comparte el propio archivo GPX (no un enlace):
 * Capacitor Filesystem + Share → Web Share con files → "unsupported".
 */
async function shareGpxFile(
  filename: string,
  gpx: string,
  title: string,
): Promise<GpxShareResult> {
  if (Capacitor.isNativePlatform()) {
    try {
      await Filesystem.writeFile({
        path: filename,
        data: gpx,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
      await Share.share({ title, dialogTitle: title, files: [uri] });
      return "shared";
    } catch (error) {
      if (isCancelledError(error)) return "cancelled";
      console.warn("Compartir GPX nativo no disponible.", error);
    }
  }

  if (typeof navigator !== "undefined" && typeof File !== "undefined") {
    const nav = navigator as Navigator & {
      canShare?: (data: ShareData) => boolean;
      share?: (data: ShareData) => Promise<void>;
    };
    if (nav.share) {
      for (const mime of ["application/gpx+xml", "application/xml", "text/xml", "text/plain"]) {
        const file = new File([new TextEncoder().encode(gpx)], filename, { type: mime });
        const data: ShareData = { title, files: [file] };
        if (nav.canShare && !nav.canShare(data)) continue;
        try {
          await nav.share(data);
          return "shared";
        } catch (error) {
          if (isCancelledError(error)) return "cancelled";
        }
      }
    }
  }

  return "unsupported";
}



function pointAlong(points: L.LatLngLiteral[], frac: number): L.LatLngLiteral {
  let total = 0;
  const segs: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const d = haversineKm(points[i - 1], points[i]);
    segs.push(d);
    total += d;
  }
  let target = total * frac;
  for (let i = 0; i < segs.length; i++) {
    if (target <= segs[i] || i === segs.length - 1) {
      const t = segs[i] > 0 ? target / segs[i] : 0;
      return {
        lat: points[i].lat + (points[i + 1].lat - points[i].lat) * t,
        lng: points[i].lng + (points[i + 1].lng - points[i].lng) * t,
      };
    }
    target -= segs[i];
  }
  return points[points.length - 1];
}

/**
 * Enlaza una acción a un botón dentro de un popup de Leaflet.
 *
 * En móvil (WebView iOS/Android) los gestos del mapa se tragan a menudo el
 * `click` sintético del botón, así que escuchamos también `touchend`/`pointerup`
 * y detenemos la propagación para que Leaflet no interprete la pulsación como
 * arrastre del mapa.
 */
function bindTap(el: HTMLElement, fn: () => void) {
  let lastFire = 0;
  const run = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
    const now = Date.now();
    if (now - lastFire < 500) return; // evita doble disparo touch+click
    lastFire = now;
    fn();
  };
  const stop = (ev: Event) => ev.stopPropagation();
  (["touchstart", "pointerdown", "mousedown", "dblclick"] as const).forEach((t) =>
    el.addEventListener(t, stop, { passive: false }),
  );
  el.addEventListener("touchend", run, { passive: false });
  el.addEventListener("click", run);
  el.style.touchAction = "manipulation";
}

function row(label: string, value: string): string {
  return `<div style="display:flex;justify-content:space-between;gap:8px;"><span style="color:var(--muted-foreground);">${label}</span><span style="font-weight:700;color:var(--foreground);">${value}</span></div>`;
}

export function renderDriftCorridors(
  map: L.Map,
  corridors: DriftCorridor[],
  ctx: DriftCorridorRenderCtx,
): L.Layer[] {
  const layers: L.Layer[] = [];
  const pane = ctx.paneName;

  corridors.forEach((c) => {
    const color = corridorColor(c.score);
    const latlngs = c.points.map((p) => [p.lat, p.lng] as [number, number]);
    const isTop = c.rank === 1;

    // Halo oscuro para contraste sobre cualquier capa.
    const halo = L.polyline(latlngs, {
      pane,
      color: "#0f172a",
      weight: isTop ? 11 : 8,
      opacity: 0.45,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(map);
    layers.push(halo);

    const line = L.polyline(latlngs, {
      pane,
      color,
      weight: isTop ? 6 : 4.5,
      opacity: 0.95,
      lineCap: "round",
      lineJoin: "round",
      dashArray: isTop ? undefined : "10,6",
    }).addTo(map);
    layers.push(line);

    // Inicio (A) y fin (B).
    const endIcon = (text: string) =>
      L.divIcon({
        className: "drift-corridor-end",
        html: `<div style="width:22px;height:22px;border-radius:9999px;background:${color};border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;color:#fff;font:800 11px/1 ui-sans-serif,system-ui;">${text}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
    const mStart = L.marker([c.start.lat, c.start.lng], {
      pane,
      icon: endIcon("A"),
      interactive: false,
    }).addTo(map);
    const mEnd = L.marker([c.end.lat, c.end.lng], {
      pane,
      icon: endIcon("B"),
      interactive: false,
    }).addTo(map);
    layers.push(mStart, mEnd);

    // Etiqueta del frente con score y longitud.
    const label = L.marker([c.center.lat, c.center.lng], {
      pane,
      interactive: false,
      icon: L.divIcon({
        className: "drift-corridor-label",
        html: `<div style="transform:translateY(-18px);white-space:nowrap;padding:2px 7px;border-radius:9999px;background:${color};color:#fff;font:800 10px/1.2 ui-sans-serif,system-ui;box-shadow:0 2px 8px rgba(0,0,0,.45);">${isTop ? "FRENTE 1" : `FRENTE ${c.rank}`} · ${c.score} · ${fmtLen(c.lengthKm)}</div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
    }).addTo(map);
    layers.push(label);

    // Flechas con la dirección recomendada de la deriva.
    if (c.driftDirDeg != null && c.points.length >= 2) {
      [0.2, 0.5, 0.8].forEach((f) => {
        const p = pointAlong(c.points, f);
        const arrow = L.marker([p.lat, p.lng], {
          pane,
          interactive: false,
          icon: L.divIcon({
            className: "drift-corridor-arrow",
            html: `<div style="transform:rotate(${c.driftDirDeg}deg);font-size:16px;line-height:1;color:${color};text-shadow:0 0 3px #0f172a,0 0 6px #0f172a;">▲</div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          }),
        }).addTo(map);
        layers.push(arrow);
      });
    }

    const bodyRows = [
      row("Puntuación", `${c.score}/100 · ${corridorQualityLabel(c.score)}`),
      row("Longitud", fmtLen(c.lengthKm)),
      row("Rumbo del frente", `${c.bearingDeg}° / ${(c.bearingDeg + 180) % 360}°`),
      row("Deriva", compass(c.driftDirDeg)),
      row(
        "Corriente",
        ctx.currentSpeedMs != null
          ? `${(ctx.currentSpeedMs * 1.94384).toFixed(2)} kn ${compass(ctx.currentDirDeg)}`
          : "—",
      ),
      row(
        "Viento",
        ctx.windKn != null
          ? `${Math.round(ctx.windKn)} kn${ctx.gustKn != null ? ` (racha ${Math.round(ctx.gustKn)})` : ""} de ${compass(ctx.windFromDeg)}`
          : "—",
      ),
      row(
        "Tiempo de deriva",
        `${fmtEta(c.etaMin)}${c.driftKn != null ? ` · ${c.driftKn.toFixed(2)} kn` : ""}`,
      ),
      row("Prof. media", c.meanDepthM != null ? `${Math.round(c.meanDepthM)} m` : "—"),
      row(
        "T superficie",
        c.sstC != null ? `${c.sstC.toFixed(2)} °C` : `∇ ${Math.round(c.sstGrad * 100)}%`,
      ),
      row(
        "Clorofila",
        c.chlMg != null ? `${c.chlMg.toFixed(4)} mg/m³` : `índice ${Math.round(c.chlIndex * 100)}%`,
      ),
      row("Intensidad FSLE", c.fsle > 0 ? `${Math.round(c.fsle * 100)}%` : "sin línea FSLE"),
      row("Confianza", `${c.confidence}%`),
    ].join("");

    line.bindPopup(
      `<div class="font-body" style="min-width:190px;max-width:250px;font-size:10px;line-height:1.25;">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:4px;">
          <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);">Frente de deriva #${c.rank}</span>
          <span style="font-weight:800;color:${color};">${c.score}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;">${bodyRows}</div>
        <div style="margin-top:5px;border-top:1px solid var(--border);padding-top:4px;font-family:ui-monospace,monospace;font-size:9px;color:var(--muted-foreground);">
          <div>A ${toDegMinSec(c.start.lat, "lat")} ${toDegMinSec(c.start.lng, "lng")}</div>
          <div>B ${toDegMinSec(c.end.lat, "lat")} ${toDegMinSec(c.end.lng, "lng")}</div>
        </div>
        <div style="margin-top:6px;display:flex;gap:4px;">
          <button data-nav="start" style="flex:1;padding:5px 2px;font-size:9px;font-weight:700;border:1px solid #0ea5e9;background:#e0f2fe;color:#075985;border-radius:4px;cursor:pointer;">▶ Inicio</button>
          <button data-nav="near" style="flex:1;padding:5px 2px;font-size:9px;font-weight:700;border:1px solid #0ea5e9;background:#e0f2fe;color:#075985;border-radius:4px;cursor:pointer;">📍 Más cercano</button>
          <button data-nav="center" style="flex:1;padding:5px 2px;font-size:9px;font-weight:700;border:1px solid #0ea5e9;background:#e0f2fe;color:#075985;border-radius:4px;cursor:pointer;">◎ Centro</button>
        </div>
        <div data-nav-msg style="margin-top:3px;font-size:9px;color:var(--muted-foreground);"></div>
        <button data-download-pdf="1" style="margin-top:6px;width:100%;padding:6px;font-size:10px;font-weight:800;border:1px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:4px;cursor:pointer;">⬇️ Descargar PDF (3 frentes)</button>
        <button data-save-gpx="1" style="margin-top:6px;width:100%;padding:6px;font-size:10px;font-weight:800;border:1px solid #0ea5e9;background:#0ea5e9;color:#fff;border-radius:4px;cursor:pointer;">💾 Guardar GPX en Archivos</button>
        <button data-share-gpx="1" style="margin-top:6px;width:100%;padding:6px;font-size:10px;font-weight:800;border:1px solid #0ea5e9;background:#e0f2fe;color:#075985;border-radius:4px;cursor:pointer;">📤 Compartir archivo GPX</button>
        <div style="margin-top:6px;display:flex;gap:4px;">
          <button data-share-front="pdf" style="flex:1;padding:5px 2px;font-size:9px;font-weight:700;border:1px solid #7c3aed;background:#ede9fe;color:#5b21b6;border-radius:4px;cursor:pointer;">📄 Ver ficha</button>
          <button data-share-front="link" style="flex:1;padding:5px 2px;font-size:9px;font-weight:700;border:1px solid #7c3aed;background:#ede9fe;color:#5b21b6;border-radius:4px;cursor:pointer;">🔗 Compartir enlace</button>
        </div>
        <div data-share-msg style="margin-top:3px;font-size:9px;color:var(--muted-foreground);"></div>
        <button data-save-front="1" style="margin-top:6px;width:100%;padding:5px;font-size:10px;font-weight:700;border:1px solid #dc2626;background:#fee2e2;color:#dc2626;border-radius:4px;cursor:pointer;">📌 Guardar frente como waypoint</button>

      </div>`,
      { maxWidth: 250, minWidth: 190, className: "compact-popup", autoPan: true },
    );

    line.on("popupopen", (ev) => {
      const el = (ev as L.PopupEvent).popup.getElement();
      if (el) L.DomEvent.disableClickPropagation(el);
      const msg = el?.querySelector<HTMLDivElement>("[data-nav-msg]");
      const goTo = (lat: number, lng: number, tag: string) => {
        map.flyTo([lat, lng], Math.max(map.getZoom(), 13), { duration: 0.8 });
        if (msg) msg.textContent = `Navegando a ${tag}: ${toDegMinSec(lat, "lat")} ${toDegMinSec(lng, "lng")}`;
      };
      el?.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((btn) => {
        bindTap(btn, () => {
          const kind = btn.dataset.nav;
          if (kind === "start") return goTo(c.start.lat, c.start.lng, "inicio del frente");
          if (kind === "center") return goTo(c.center.lat, c.center.lng, "centro del frente");
          const pick = (from: L.LatLngLiteral) => {
            let bestP = c.points[0];
            let bestD = Infinity;
            for (const p of c.points) {
              const d = haversineKm(from, p);
              if (d < bestD) {
                bestD = d;
                bestP = p;
              }
            }
            goTo(bestP.lat, bestP.lng, `punto más cercano (${fmtLen(bestD)})`);
          };
          if (typeof navigator !== "undefined" && navigator.geolocation) {
            if (msg) msg.textContent = "Buscando tu posición…";
            navigator.geolocation.getCurrentPosition(
              (pos) => pick({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
              () => {
                const ctr = map.getCenter();
                pick({ lat: ctr.lat, lng: ctr.lng });
              },
              { enableHighAccuracy: true, timeout: 6000 },
            );
          } else {
            const ctr = map.getCenter();
            pick({ lat: ctr.lat, lng: ctr.lng });
          }
        });
      });

      const shareMsg = el?.querySelector<HTMLDivElement>("[data-share-msg]");
      const dlBtn = el?.querySelector<HTMLButtonElement>("[data-download-pdf]");
      if (dlBtn) {
        bindTap(dlBtn, async () => {
          const say = (t: string) => {
            if (shareMsg) shareMsg.textContent = t;
          };
          const original = dlBtn.textContent ?? "";
          dlBtn.disabled = true;
          dlBtn.textContent = "⏳ Generando PDF…";
          try {
            const [{ buildCorridorPdf, corridorPdfFilename }, { saveGeneratedFileToFiles }] =
              await Promise.all([
                import("../lib/drift-corridor-pdf"),
                import("../lib/file-export"),
              ]);
            const pdf = buildCorridorPdf(corridors, {
              currentSpeedMs: ctx.currentSpeedMs,
              currentDirDeg: ctx.currentDirDeg,
              windKn: ctx.windKn,
              windFromDeg: ctx.windFromDeg,
              gustKn: ctx.gustKn,
            });
            const filename = corridorPdfFilename();
            const result = await saveGeneratedFileToFiles({

              filename,
              mime: "application/pdf",
              content: pdf,
              shareTitle: "Frentes de deriva — Hotspot Fishing",
              shareText: "Ficha de los 3 mejores frentes de deriva",
            });
            if (result === "cancelled") {
              say("Descarga cancelada.");
              dlBtn.textContent = original;
              dlBtn.disabled = false;
              return;
            }
            if (result === "copied") {
              say("No se pudo descargar; contenido copiado al portapapeles.");
              dlBtn.textContent = original;
              dlBtn.disabled = false;
              return;
            }
            dlBtn.textContent = "✅ PDF descargado";
            say(`Descarga completada: ${filename}`);
          } catch (err) {
            console.warn("No se pudo generar el PDF de frentes.", err);
            say("No se pudo generar el PDF. Inténtalo de nuevo.");
            dlBtn.textContent = original;
            dlBtn.disabled = false;
          }
        });
      }

      // Construcción del GPX de los 3 frentes (compartido por guardar y compartir).
      const buildGpxFile = (): { filename: string; gpx: string } => {
        const esc = (s: string) =>
          s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const stamp = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const filename = `frentes-deriva-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.gpx`;
        const fmtDesc = (co: DriftCorridor, extra?: string) => {
          const parts = [
            `Puntuación ${co.score}/100 · confianza ${co.confidence}%`,
            `rumbo ${co.bearingDeg}° · longitud ${fmtLen(co.lengthKm)}`,
            co.meanDepthM != null ? `profundidad media ${Math.round(co.meanDepthM)} m` : null,
            co.sstC != null ? `T ${co.sstC.toFixed(2)} °C` : null,
            co.chlMg != null ? `clorofila ${co.chlMg.toFixed(4)} mg/m³` : null,
            co.etaMin != null ? `tiempo de deriva ${fmtEta(co.etaMin)}` : null,
            extra,
          ].filter((s): s is string => typeof s === "string" && s.length > 0);
          return esc(parts.join(" · "));
        };
        const tracks = corridors
          .map(
            (co) =>
              `  <trk><name>${esc(`Frente #${co.rank} (${co.score}/100)`)}</name><desc>${fmtDesc(co)}</desc><trkseg>` +
              co.points
                .map((p) => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"/>`)
                .join("") +
              `</trkseg></trk>`,
          )
          .join("\n");
        const waypoints = corridors
          .flatMap((co) => [
            `  <wpt lat="${co.start.lat.toFixed(6)}" lon="${co.start.lng.toFixed(6)}"><name>${esc(`Frente #${co.rank} · A`)}</name><desc>${fmtDesc(co, "inicio del frente")}</desc></wpt>`,
            `  <wpt lat="${co.center.lat.toFixed(6)}" lon="${co.center.lng.toFixed(6)}"><name>${esc(`Frente #${co.rank} · centro`)}</name><desc>${fmtDesc(co, "centro del frente")}</desc></wpt>`,
            `  <wpt lat="${co.end.lat.toFixed(6)}" lon="${co.end.lng.toFixed(6)}"><name>${esc(`Frente #${co.rank} · B`)}</name><desc>${fmtDesc(co, "fin del frente")}</desc></wpt>`,
          ])
          .join("\n");
        const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Hotspot Fishing" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>Frentes de deriva (Fluixa)</name><time>${stamp.toISOString()}</time></metadata>\n${waypoints}\n${tracks}\n</gpx>\n`;
        return { filename, gpx };
      };

      // Guardar los 3 frentes como GPX en Archivos (mismo flujo que waypoints/tracks).
      const gpxBtn = el?.querySelector<HTMLButtonElement>("[data-save-gpx]");
      if (gpxBtn) {
        bindTap(gpxBtn, async () => {
          const say = (t: string) => {
            if (shareMsg) shareMsg.textContent = t;
          };
          const original = gpxBtn.textContent ?? "";
          gpxBtn.disabled = true;
          gpxBtn.textContent = "⏳ Guardando…";
          try {
            const { filename, gpx } = buildGpxFile();
            const result = await saveTextFileLikeWaypoints(
              filename,
              gpx,
              "Frentes de deriva — Hotspot Fishing",
            );
            if (result === "downloaded" || result === "shared") {
              gpxBtn.textContent = "✅ GPX guardado";
              say(`Archivo: ${filename}`);
              return;
            }
            say("Guardado cancelado.");
          } catch (err) {
            console.warn("No se pudo guardar el GPX de frentes.", err);
            say("No se pudo guardar el GPX.");
          }
          gpxBtn.textContent = original;
          gpxBtn.disabled = false;
        });
      }

      // Compartir el propio archivo GPX (no un enlace).
      const shareGpxBtn = el?.querySelector<HTMLButtonElement>("[data-share-gpx]");
      if (shareGpxBtn) {
        bindTap(shareGpxBtn, async () => {
          const say = (t: string) => {
            if (shareMsg) shareMsg.textContent = t;
          };
          const original = shareGpxBtn.textContent ?? "";
          shareGpxBtn.disabled = true;
          shareGpxBtn.textContent = "⏳ Compartiendo…";
          try {
            const { filename, gpx } = buildGpxFile();
            const title = "Frentes de deriva — Hotspot Fishing";
            const result = await shareGpxFile(filename, gpx, title);
            if (result === "shared") {
              say(`GPX compartido: ${filename}`);
            } else if (result === "cancelled") {
              say("Compartir cancelado.");
            } else {
              const saved = await saveTextFileLikeWaypoints(filename, gpx, title);
              if (saved === "downloaded" || saved === "shared") say(`Archivo guardado: ${filename}`);
              else say("No se pudo compartir el GPX.");
            }
          } catch (err) {
            console.warn("No se pudo compartir el GPX de frentes.", err);
            say("No se pudo compartir el GPX.");
          }
          shareGpxBtn.textContent = original;
          shareGpxBtn.disabled = false;
        });
      }





      el?.querySelectorAll<HTMLButtonElement>("[data-share-front]").forEach((btn) => {
        bindTap(btn, async () => {
          const url = buildCorridorShareUrl(corridors, {
            currentSpeedMs: ctx.currentSpeedMs,
            currentDirDeg: ctx.currentDirDeg,
            windKn: ctx.windKn,
            windFromDeg: ctx.windFromDeg,
            gustKn: ctx.gustKn,
          });
          const say = (t: string) => {
            if (shareMsg) shareMsg.textContent = t;
          };

          if (btn.dataset.shareFront === "pdf") {
            const win = window.open(url, "_blank", "noopener");
            if (!win) window.location.assign(url);
            say("Ficha abierta: pulsa «Guardar como PDF».");
            return;
          }

          const original = btn.textContent ?? "";
          btn.disabled = true;
          btn.textContent = "⏳ Compartiendo…";
          try {
            const result = await shareLink({
              url,
              title: "Frentes de deriva — Hotspot Fishing",
              text: "Frentes de deriva (Fluixa)",
              dialogTitle: "Compartir frentes",
            });
            if (result === "shared") say("Enlace compartido.");
            else if (result === "copied") say("Enlace copiado al portapapeles.");
            else if (result === "cancelled") say("Compartir cancelado.");
            else say("Ficha abierta: copia el enlace desde la barra de direcciones.");
          } catch (err) {
            console.warn("No se pudo compartir el enlace de frentes.", err);
            say("No se pudo compartir el enlace.");
          } finally {
            btn.disabled = false;
            btn.textContent = original;
          }
        });
      });

      const save = el?.querySelector<HTMLButtonElement>("[data-save-front]");
      if (save) {
        bindTap(save, () => {
          if (!ctx.onSaveWaypoint) {
            save.textContent = "⚠️ No disponible aquí";
            return;
          }
          ctx.onSaveWaypoint(
            c.center.lat,
            c.center.lng,
            c.score / 100,
            c.meanDepthM,
            `Frente de deriva ${fmtLen(c.lengthKm)} rumbo ${c.bearingDeg}°`,
            `Frente deriva #${c.rank}`,
          );
          save.textContent = "✅ Waypoint guardado";
          save.disabled = true;
          save.style.opacity = "0.6";
        });
      }
    });
  });

  return layers;
}

