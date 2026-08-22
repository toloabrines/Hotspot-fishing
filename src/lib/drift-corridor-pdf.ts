/**
 * Generador de PDF (sin dependencias) para la ficha de los frentes de deriva.
 *
 * Produce un PDF ASCII puro (streams sin comprimir y texto WinAnsi escapado en
 * octal), de modo que el contenido puede viajar como string por los mismos
 * helpers de exportación que el resto de archivos de la app.
 */

import type { DriftCorridor, DriftCorridorEnv } from "./drift-corridor";

const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
const compass = (deg: number | null | undefined) =>
  deg == null || !Number.isFinite(deg) ? "-" : `${Math.round(deg)}° ${DIRS[Math.round((deg % 360) / 22.5) % 16]}`;
const fmtLen = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 2 : 1)} km`);
const fmtEta = (min: number | null) =>
  min == null || !Number.isFinite(min)
    ? "-"
    : min < 60
      ? `${min} min`
      : `${Math.floor(min / 60)} h ${min % 60} min`;

function dms(value: number, kind: "lat" | "lng"): string {
  const hemi = kind === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  const abs = Math.abs(value);
  const d = Math.floor(abs);
  const mFloat = (abs - d) * 60;
  const m = Math.floor(mFloat);
  const s = ((mFloat - m) * 60).toFixed(1);
  return `${d}° ${String(m).padStart(2, "0")}' ${s}" ${hemi}`;
}

/** Escapa a WinAnsi con secuencias octales ASCII (evita bytes > 127). */
function pdfText(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (code < 32) out += " ";
    else if (code < 127) out += ch;
    else if (code < 256) out += `\\${code.toString(8).padStart(3, "0")}`;
    else if (ch === "—" || ch === "–") out += "-";
    else if (ch === "·") out += `\\267`;
    else if (ch === "“" || ch === "”") out += '"';
    else if (ch === "’") out += "'";
    else out += "?";
  }
  return out;
}

interface Line {
  text: string;
  size: number;
  bold: boolean;
  gap: number;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;

function buildPdf(lines: Line[]): string {
  // Reparte las líneas en páginas.
  const pages: Line[][] = [];
  let current: Line[] = [];
  let y = PAGE_H - MARGIN;
  for (const line of lines) {
    if (y - line.gap < MARGIN) {
      pages.push(current);
      current = [];
      y = PAGE_H - MARGIN;
    }
    current.push(line);
    y -= line.gap;
  }
  if (current.length) pages.push(current);
  if (!pages.length) pages.push([]);

  const streams = pages.map((pageLines) => {
    let cursor = PAGE_H - MARGIN;
    const parts: string[] = ["BT"];
    for (const line of pageLines) {
      cursor -= line.gap;
      parts.push(
        `/${line.bold ? "F2" : "F1"} ${line.size} Tf`,
        `1 0 0 1 ${MARGIN.toFixed(2)} ${cursor.toFixed(2)} Tm`,
        `(${pdfText(line.text)}) Tj`,
      );
    }
    parts.push("ET");
    return parts.join("\n");
  });

  const objects: string[] = [];
  const pageObjStart = 4;
  const pageIds = pages.map((_, i) => pageObjStart + i * 2);
  const kids = pageIds.map((id) => `${id} 0 R`).join(" ");

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`;
  objects[3] = `<< /Font << /F1 ${pageObjStart + pages.length * 2} 0 R /F2 ${pageObjStart + pages.length * 2 + 1} 0 R >> >>`;
  pages.forEach((_, i) => {
    const id = pageIds[i];
    objects[id] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources 3 0 R /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${streams[i].length} >>\nstream\n${streams[i]}\nendstream`;
  });
  objects[pageObjStart + pages.length * 2] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objects[pageObjStart + pages.length * 2 + 1] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;

  const total = objects.length;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < total; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return pdf;
}

export function buildCorridorPdf(
  corridors: DriftCorridor[],
  env: DriftCorridorEnv & { gustKn?: number | null },
): string {
  const L: Line[] = [];
  const push = (text: string, size = 10, bold = false, gap = size + 5) =>
    L.push({ text, size, bold, gap });

  push("Frentes de deriva (Fluixa)", 18, true, 26);
  push(`Hotspot Fishing · ${new Date().toLocaleString("es-ES")}`, 9, false, 20);

  push("Condiciones generales", 12, true, 20);
  push(
    `Corriente: ${env.currentSpeedMs != null ? `${(env.currentSpeedMs * 1.94384).toFixed(2)} kn ${compass(env.currentDirDeg)}` : "-"}`,
  );
  push(
    `Viento: ${env.windKn != null ? `${Math.round(env.windKn)} kn${env.gustKn != null ? ` (racha ${Math.round(env.gustKn)})` : ""} de ${compass(env.windFromDeg)}` : "-"}`,
    10,
    false,
    22,
  );

  corridors.forEach((c) => {
    push(`Frente #${c.rank}  ·  ${c.score}/100`, 13, true, 22);
    push(`Longitud: ${fmtLen(c.lengthKm)}`);
    push(`Rumbo del frente: ${c.bearingDeg}° / ${(c.bearingDeg + 180) % 360}°`);
    push(`Deriva: ${compass(c.driftDirDeg)}`);
    push(
      `Tiempo de deriva: ${fmtEta(c.etaMin)}${c.driftKn != null ? ` · ${c.driftKn.toFixed(2)} kn` : ""}`,
    );
    push(`Prof. media: ${c.meanDepthM != null ? `${Math.round(c.meanDepthM)} m` : "-"}`);
    push(
      `T superficie: ${c.sstC != null ? `${c.sstC.toFixed(2)} °C` : `grad ${Math.round(c.sstGrad * 100)}%`}`,
    );
    push(
      `Clorofila: ${c.chlMg != null ? `${c.chlMg.toFixed(4)} mg/m3` : `indice ${Math.round(c.chlIndex * 100)}%`}`,
    );
    push(`Intensidad FSLE: ${c.fsle > 0 ? `${Math.round(c.fsle * 100)}%` : "sin linea FSLE"}`);
    push(`Confianza: ${c.confidence}%`);
    push(`A ${dms(c.start.lat, "lat")} ${dms(c.start.lng, "lng")}`, 9);
    push(`B ${dms(c.end.lat, "lat")} ${dms(c.end.lng, "lng")}`, 9, false, 22);
  });

  return buildPdf(L);
}

export function corridorPdfFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `frentes-deriva-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.pdf`;
}

