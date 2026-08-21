import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type StoredFsleExport = {
  filename: string;
  json: string;
  lineCount: number;
  createdAt: number;
};

function submitGeoJsonDownload(filename: string, json: string): boolean {
  try {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/public/fsle-geojson-download";
    form.enctype = "multipart/form-data";
    form.target = "_self";
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

export const Route = createFileRoute("/fsle-export")({
  head: () => ({
    meta: [
      { title: "Exportar FSLE GeoJSON — Hotspot Fishing" },
      {
        name: "description",
        content: "Página de exportación GeoJSON FSLE para abrir, copiar o guardar el archivo.",
      },
      { property: "og:title", content: "Exportar FSLE GeoJSON — Hotspot Fishing" },
      {
        property: "og:description",
        content: "Exportación GeoJSON FSLE lista para abrir, copiar o guardar.",
      },
    ],
  }),
  component: FsleExportPage,
});

function FsleExportPage() {
  const [stored, setStored] = useState<StoredFsleExport | null>(null);
  const [missing, setMissing] = useState(false);
  const [downloadToken, setDownloadToken] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const key = params.get("token") ?? params.get("key");
    if (!key) {
      setMissing(true);
      return;
    }
    setDownloadToken(key);

    void (async () => {
      try {
      const raw = window.sessionStorage.getItem(`fsle-export:${key}`);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredFsleExport;
        setStored(parsed);
        return;
      }

      setStored({ filename: "fsle.geojson", json: "", lineCount: 0, createdAt: Date.now() });
      } catch {
      setMissing(true);
      }
    })();
  }, []);

  const sizeKb = useMemo(() => {
    if (!stored?.json) return "0";
    return (new TextEncoder().encode(stored.json).byteLength / 1024).toFixed(1);
  }, [stored]);

  const copyJson = async () => {
    if (!stored) return;
    if (!stored.json) {
      toast.info("Usa Descargar archivo; el contenido está guardado en el enlace.");
      return;
    }
    try {
      await navigator.clipboard.writeText(stored.json);
      toast.success("GeoJSON copiado.");
    } catch {
      toast.error("No se pudo copiar automáticamente. Mantén pulsado el texto para copiar.");
    }
  };

  const shareJson = async () => {
    if (!stored || typeof File === "undefined" || !navigator.share) {
      toast.error("Compartir no está disponible aquí. Usa Copiar JSON.");
      return;
    }
    try {
      if (!stored.json) {
        toast.info("Usa Descargar archivo; el visor no permite compartir este enlace.");
        return;
      }
      const file = new File([stored.json], stored.filename, { type: "application/geo+json" });
      const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
      if (nav.canShare && !nav.canShare({ files: [file] })) {
        toast.error("Este visor no permite compartir archivos. Usa Copiar JSON.");
        return;
      }
      await navigator.share({ files: [file], title: stored.filename });
    } catch {
      toast.error("El visor bloqueó compartir. Usa Copiar JSON.");
    }
  };

  const downloadJson = () => {
    if (!stored?.json) {
      window.location.href = `/api/public/fsle-geojson-download?token=${encodeURIComponent(downloadToken)}`;
      return;
    }
    if (submitGeoJsonDownload(stored.filename, stored.json)) {
      toast.success(`Descargando ${stored.filename}`);
      return;
    }
    const blob = new Blob([stored.json], { type: "application/geo+json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = stored.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <main className="min-h-screen bg-background px-4 py-5 text-foreground">
      <section className="mx-auto flex max-w-2xl flex-col gap-4">
        <button
          type="button"
          onClick={() => window.history.back()}
          className="w-fit rounded-md border border-border px-3 py-2 text-sm font-semibold"
        >
          ← Volver al mapa
        </button>

        <header className="space-y-1">
          <h1 className="text-2xl font-black tracking-normal">GeoJSON FSLE</h1>
          {stored ? (
            <p className="text-sm text-muted-foreground">
              {stored.filename} · {stored.lineCount} líneas · {sizeKb} KB
            </p>
          ) : null}
        </header>

        {missing ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            No encuentro el GeoJSON. Vuelve al mapa y pulsa GeoJSON otra vez.
          </p>
        ) : null}

        {downloadToken ? (
          <>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={downloadJson}
                className="rounded-md bg-primary px-4 py-3 text-sm font-black text-primary-foreground no-underline"
              >
                Descargar en Archivos
              </button>
              <button
                type="button"
                onClick={shareJson}
                className="rounded-md border border-border px-4 py-3 text-sm font-bold"
              >
                Compartir iOS
              </button>
              <button
                type="button"
                onClick={copyJson}
                className="rounded-md border border-border px-4 py-3 text-sm font-bold"
              >
                Copiar JSON
              </button>
            </div>

            {stored?.json ? (
              <textarea
                readOnly
                value={stored.json}
                className="h-[65vh] w-full resize-none rounded-md border border-border bg-card p-3 font-mono text-[11px] leading-relaxed text-card-foreground"
                aria-label="Contenido GeoJSON FSLE"
                onFocus={(event) => event.currentTarget.select()}
              />
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  );
}
