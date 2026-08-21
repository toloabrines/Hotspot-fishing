import { createFileRoute } from "@tanstack/react-router";

import type { Mbar24Index, Mbar24SheetIndex } from "@/lib/mbar24";

/**
 * Índice combinado de hojas MBAR24: las publicadas en `public/mbar24/` (repo)
 * más las subidas desde la pantalla de administración (bucket privado).
 * El mapa 2D lo usa para saber dónde hay dato real de 16 m.
 */
export const Route = createFileRoute("/api/mbar24-index")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        const sheets: Mbar24SheetIndex[] = [];

        try {
          const res = await fetch(`${origin}/mbar24/index.json`);
          if (res.ok) {
            const text = await res.text();
            if (text.trim().startsWith("{")) {
              const json = JSON.parse(text) as Mbar24Index;
              if (Array.isArray(json?.sheets)) sheets.push(...json.sheets);
            }
          }
        } catch {
          /* sin índice local */
        }

        try {
          const { readCloudIndex } = await import("@/lib/mbar24-storage.server");
          const cloud = await readCloudIndex();
          for (const s of cloud?.sheets ?? []) {
            const i = sheets.findIndex((x) => x.sheet === s.sheet);
            const withFlag = { ...s, storage: true };
            if (i >= 0) sheets[i] = withFlag;
            else sheets.push(withFlag);
          }
        } catch {
          /* sin bucket */
        }

        const body: Mbar24Index = {
          version: 1,
          generatedAt: new Date().toISOString(),
          sheets,
        };
        return new Response(JSON.stringify(body), {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=60",
          },
        });
      },
    },
  },
});

