/**
 * Almacén en la nube de las hojas MBAR24 subidas desde la pantalla de
 * administración. El bucket `mbar24` es privado: las teselas se leen siempre
 * desde el servidor (`/api/dem`) con la clave de servicio, nunca directamente
 * desde el navegador.
 *
 * Estructura:
 *   index.json                  → { version, generatedAt, sheets: [...] }
 *   <hoja>/<tileX>/<tileY>.bin  → 256×256 Int16 (decímetros)
 */

import type { Mbar24Index, Mbar24SheetIndex } from "./mbar24";

export const MBAR24_BUCKET = "mbar24";

function admin() {
  // Import perezoso: este módulo lo usan rutas que también entran al grafo cliente.
  return import("@/integrations/supabase/client.server").then((m) => m.supabaseAdmin);
}

export async function readCloudIndex(): Promise<Mbar24Index | null> {
  try {
    const sb = await admin();
    const { data, error } = await sb.storage.from(MBAR24_BUCKET).download("index.json");
    if (error || !data) return null;
    const json = JSON.parse(await data.text()) as Mbar24Index;
    if (!json || !Array.isArray(json.sheets)) return null;
    return json;
  } catch {
    return null;
  }
}

export async function writeCloudIndex(index: Mbar24Index): Promise<void> {
  const sb = await admin();
  const body = new Blob([JSON.stringify(index, null, 2)], { type: "application/json" });
  const { error } = await sb.storage
    .from(MBAR24_BUCKET)
    .upload("index.json", body, { upsert: true, contentType: "application/json" });
  if (error) throw new Error(error.message);
}

export async function upsertCloudSheet(sheet: Mbar24SheetIndex): Promise<Mbar24Index> {
  const current = (await readCloudIndex()) ?? {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    sheets: [],
  };
  const next: Mbar24Index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sheets: [...current.sheets.filter((s) => s.sheet !== sheet.sheet), sheet],
  };
  await writeCloudIndex(next);
  return next;
}

export async function removeCloudSheet(sheetId: string): Promise<void> {
  const sb = await admin();
  const current = await readCloudIndex();
  if (current) {
    await writeCloudIndex({
      version: 1,
      generatedAt: new Date().toISOString(),
      sheets: current.sheets.filter((s) => s.sheet !== sheetId),
    });
  }
  // Borrado recursivo del directorio de la hoja.
  const { data: dirs } = await sb.storage.from(MBAR24_BUCKET).list(sheetId, { limit: 1000 });
  for (const d of dirs ?? []) {
    const { data: files } = await sb.storage
      .from(MBAR24_BUCKET)
      .list(`${sheetId}/${d.name}`, { limit: 1000 });
    const paths = (files ?? []).map((f) => `${sheetId}/${d.name}/${f.name}`);
    if (paths.length > 0) await sb.storage.from(MBAR24_BUCKET).remove(paths);
  }
}

export async function uploadCloudTile(path: string, bytes: Uint8Array): Promise<void> {
  const sb = await admin();
  const { error } = await sb.storage
    .from(MBAR24_BUCKET)
    .upload(path, new Blob([bytes as unknown as BlobPart], { type: "application/octet-stream" }), {
      upsert: true,
      contentType: "application/octet-stream",
    });
  if (error) throw new Error(error.message);
}

export async function downloadCloudTile(
  sheetId: string,
  key: string,
): Promise<ArrayBuffer | null> {
  try {
    const sb = await admin();
    const { data, error } = await sb.storage
      .from(MBAR24_BUCKET)
      .download(`${sheetId}/${key}.bin`);
    if (error || !data) return null;
    return await data.arrayBuffer();
  } catch {
    return null;
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

