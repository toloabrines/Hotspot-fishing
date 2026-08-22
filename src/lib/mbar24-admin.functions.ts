import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Mbar24Index, Mbar24SheetIndex } from "@/lib/mbar24";

/** Sube un lote de teselas ya generadas en el navegador (solo administración). */
export const uploadMbar24Tiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sheet: string; tiles: { x: number; y: number; b64: string }[] }) => data)
  .handler(async ({ data, context }): Promise<{ uploaded: number }> => {
    const { assertInviteAdmin } = await import("@/lib/invites.server");
    assertInviteAdmin((context.claims as { email?: string } | null)?.email);
    const { uploadCloudTile, base64ToBytes } = await import("@/lib/mbar24-storage.server");
    const sheet = String(data.sheet).replace(/[^A-Za-z0-9_-]/g, "");
    if (!sheet) throw new Error("Identificador de hoja no válido.");
    for (const t of data.tiles) {
      await uploadCloudTile(`${sheet}/${t.x}/${t.y}.bin`, base64ToBytes(t.b64));
    }
    return { uploaded: data.tiles.length };
  });

/** Publica (o actualiza) la ficha de la hoja en el índice de la nube. */
export const publishMbar24Sheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sheet: Mbar24SheetIndex }) => data)
  .handler(async ({ data, context }): Promise<{ index: Mbar24Index }> => {
    const { assertInviteAdmin } = await import("@/lib/invites.server");
    assertInviteAdmin((context.claims as { email?: string } | null)?.email);
    const { upsertCloudSheet } = await import("@/lib/mbar24-storage.server");
    return { index: await upsertCloudSheet(data.sheet) };
  });

/** Elimina una hoja subida (índice + teselas). */
export const deleteMbar24Sheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sheet: string }) => data)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { assertInviteAdmin } = await import("@/lib/invites.server");
    assertInviteAdmin((context.claims as { email?: string } | null)?.email);
    const { removeCloudSheet } = await import("@/lib/mbar24-storage.server");
    await removeCloudSheet(data.sheet);
    return { ok: true };
  });

/** Índice de hojas subidas (para la pantalla de administración). */
export const listMbar24Sheets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ index: Mbar24Index | null }> => {
    const { assertInviteAdmin } = await import("@/lib/invites.server");
    assertInviteAdmin((context.claims as { email?: string } | null)?.email);
    const { readCloudIndex } = await import("@/lib/mbar24-storage.server");
    return { index: await readCloudIndex() };
  });

