import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { useSubscriptions } from "@/hooks/use-subscriptions";
import {
  deleteMbar24Sheet,
  listMbar24Sheets,
  publishMbar24Sheet,
  uploadMbar24Tiles,
} from "@/lib/mbar24-admin.functions";
import { MBAR24_TILE_SIZE, type Mbar24SheetIndex } from "@/lib/mbar24";
import {
  buildMbar24Tiles,
  inspectMbar24File,
  toBase64,
  type Mbar24Inspection,
} from "@/lib/mbar24-build";

export const Route = createFileRoute("/mbar24")({
  component: Mbar24AdminPage,
  head: () => ({
    meta: [
      { title: "Batimetría MBAR24 · Hotspot Fishing" },
      {
        name: "description",
        content:
          "Sube una hoja MBAR24 del IHM (GeoTIFF) y genera las teselas de 16 m que usa el mapa de Hotspot Fishing.",
      },
      { property: "og:title", content: "Batimetría MBAR24 · Hotspot Fishing" },
      {
        property: "og:description",
        content: "Carga de hojas batimétricas de alta resolución para el mapa de pesca.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const PROVIDER = "Instituto Hidrográfico de la Marina (IHM), Armada Española";
const LICENSE = "CC-BY-NC 4.0";
const ATTRIBUTION = "MBAR24 2024 CC-BY-NC 4.0 ihm.es — Instituto Hidrográfico de la Marina";
const BATCH = 4;

type PhaseKey = "idle" | "validate" | "read" | "grid" | "tiles" | "upload" | "publish" | "done";

const PHASE_LABEL: Record<PhaseKey, string> = {
  idle: "",
  validate: "Validando el fichero",
  read: "Leyendo GeoTIFF",
  grid: "Reproyectando a EPSG:4326",
  tiles: "Teselando",
  upload: "Subiendo teselas",
  publish: "Fusionando y publicando el índice",
  done: "Completado",
};

const PHASE_ORDER: PhaseKey[] = ["validate", "read", "grid", "tiles", "upload", "publish"];

function Mbar24AdminPage() {
  const { isAdmin, loading } = useSubscriptions();
  const upload = useServerFn(uploadMbar24Tiles);
  const publish = useServerFn(publishMbar24Sheet);
  const remove = useServerFn(deleteMbar24Sheet);
  const list = useServerFn(listMbar24Sheets);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheetId, setSheetId] = useState("");
  const [sheetName, setSheetName] = useState("Bahía de Palma");
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [sheets, setSheets] = useState<Mbar24SheetIndex[]>([]);
  const [phase, setPhase] = useState<PhaseKey>("idle");
  const [inspection, setInspection] = useState<Mbar24Inspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [downloadMB, setDownloadMB] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [pasteHint, setPasteHint] = useState<string | null>(null);



  const refresh = useCallback(async () => {
    try {
      const res = await list({ data: undefined });
      setSheets(res.index?.sheets ?? []);
    } catch {
      /* sin permisos o sin índice */
    }
  }, [list]);

  useEffect(() => {
    if (isAdmin) void refresh();
  }, [isAdmin, refresh]);

  const onPick = async (f: File | null) => {
    setFile(f);
    setError(null);
    setDone(null);
    setInspection(null);
    setPhase("idle");
    setPct(0);
    if (!f) return;
    const m = f.name.match(/ES\d{6}/);
    if (m) setSheetId(m[0]);
    setInspecting(true);
    setPhase("validate");
    setDetail("Comprobando resolución, sistema de referencia, cobertura y nodata…");
    try {
      const res = await inspectMbar24File(f);
      setInspection(res);
      if (res.ok && res.info && !sheetId && !m) {
        /* sin identificador detectado: se pedirá manualmente */
      }
    } catch (e) {
      setInspection({
        ok: false,
        errors: [e instanceof Error ? e.message : "No se ha podido leer el fichero."],
        warnings: [],
        info: null,
      });
    } finally {
      setInspecting(false);
      setPhase("idle");
      setDetail("");
    }
  };

  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  /** Permite pegar el fichero con Ctrl+V (o ⌘+V) en cualquier punto de la pantalla. */
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      if (busy || inspecting) return;
      const items = e.clipboardData?.files;
      if (items && items.length > 0) {
        e.preventDefault();
        void onPickRef.current(items[0]);
        return;
      }
      const text = e.clipboardData?.getData("text")?.trim();
      if (text && /^https?:\/\//i.test(text)) setRemoteUrl(text);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [busy, inspecting]);

  /** Descarga el GeoTIFF desde un enlace público (a través del proxy de administración). */
  const fetchFromUrl = async () => {
    const url = remoteUrl.trim();
    if (!url) return;
    setError(null);
    setDone(null);
    setInspection(null);
    setDownloading(true);
    setDownloadMB(0);
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Sesión caducada: vuelve a iniciar sesión.");

      const res = await fetch(`/api/mbar24-download?url=${encodeURIComponent(url)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok || !res.body) {
        throw new Error((await res.text().catch(() => "")) || `Descarga fallida (${res.status}).`);
      }

      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        if (value) {
          chunks.push(value);
          received += value.length;
          setDownloadMB(received / 1048576);
        }
      }
      const name = (url.split("/").pop() || "mbar24.tif").split("?")[0];
      const blob = new Blob(chunks as BlobPart[], { type: "image/tiff" });
      const file = new File([blob], name, { type: "image/tiff" });
      await onPick(file);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "No se ha podido descargar el fichero del enlace.",
      );
    } finally {
      setDownloading(false);
    }
  };

  const pasteRemoteUrl = async () => {
    setPasteHint(null);
    setError(null);
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!/^https?:\/\//i.test(text)) {
        setPasteHint("El portapapeles no contiene un enlace http válido.");
        return;
      }
      setRemoteUrl(text);
      setPasteHint("Enlace pegado correctamente.");
    } catch {
      document.getElementById("mbar-url")?.focus();
      setPasteHint("iPhone ha bloqueado el portapapeles. Mantén pulsado el campo y toca Pegar.");
    }
  };



  const run = async () => {
    if (!file) return;
    const id = sheetId.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    if (!id) {
      setError("Indica el identificador de la hoja (p. ej. ES393923).");
      return;
    }
    if (inspection && !inspection.ok) {
      setError("Corrige los errores del fichero antes de procesarlo.");
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    setPct(0);
    try {
      const built = await buildMbar24Tiles(file, id, (p) => {
        setPct(p.pct);
        setDetail(p.detail);
        setPhase(p.phase);
      });

      const total = built.tiles.length;
      if (total === 0) throw new Error("La hoja no ha producido ninguna tesela con datos.");

      setPhase("upload");
      for (let i = 0; i < total; i += BATCH) {
        const chunk = built.tiles.slice(i, i + BATCH).map((t) => ({
          x: t.x,
          y: t.y,
          b64: toBase64(t.data),
        }));
        await upload({ data: { sheet: id, tiles: chunk } });
        setPct(92 + Math.round(((i + chunk.length) / total) * 7));
        setDetail(`Subiendo teselas ${Math.min(i + BATCH, total)}/${total}…`);
      }

      const meta: Mbar24SheetIndex = {
        sheet: id,
        product: `MBAR24 — ${sheetName || id} (${id}), 16 m`,
        provider: PROVIDER,
        license: LICENSE,
        attribution: ATTRIBUTION,
        nativeResM: 16,
        south: built.south,
        west: built.west,
        north: built.north,
        east: built.east,
        cols: built.cols,
        rows: built.rows,
        dLat: built.dLat,
        dLng: built.dLng,
        tileSize: MBAR24_TILE_SIZE,
        tilesX: built.tilesX,
        tilesY: built.tilesY,
        storage: true,
        checks: {
          srcWidth: built.srcWidth,
          srcHeight: built.srcHeight,
          srcEpsg: built.srcEpsg,
          minElev: built.minElev,
          maxElev: built.maxElev,
        },
      };
      setPhase("publish");
      setDetail("Fusionando la ficha con el índice de cobertura…");
      await publish({ data: { sheet: meta } });
      setPct(100);
      setPhase("done");
      setDetail("");
      setDone(
        `Hoja ${id} publicada: ${total} teselas · ${built.cols}×${built.rows} celdas · ` +
          `${built.minElev.toFixed(1)} … ${built.maxElev.toFixed(1)} m. ` +
          `Abre el mapa en esa zona y verás el relieve real de 16 m.`,
      );
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido procesando la hoja.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <main className="p-6 text-sm text-muted-foreground">Cargando…</main>;
  }
  if (!isAdmin) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-xl font-semibold">Batimetría MBAR24</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Esta pantalla es solo para la cuenta de administración.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Batimetría MBAR24 · 16 m</h1>
        <p className="text-sm text-muted-foreground">
          Sube la hoja del IHM en <strong>GeoTIFF</strong> (16 M). El fichero se procesa en este
          dispositivo: se reproyecta a EPSG:4326, se trocea en teselas de {MBAR24_TILE_SIZE}×
          {MBAR24_TILE_SIZE} y solo se suben esas teselas y su ficha. El mapa 2D las usa al
          instante.
        </p>
        <p className="text-xs text-muted-foreground">
          El formato <strong>.bag</strong> (HDF5) no se puede leer en el navegador: descarga la
          variante <strong>GeoTiff 16 M</strong> de la misma hoja.
        </p>
      </header>

      <section className="space-y-4 rounded-lg border p-4">
        <div className="space-y-2">
          <Label htmlFor="mbar-file">Fichero GeoTIFF de la hoja</Label>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (busy || inspecting) return;
              const f = e.dataTransfer.files?.[0];
              if (f) void onPick(f);
            }}
            className={
              "flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed p-6 text-center transition-colors " +
              (dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/30")
            }
          >
            <p className="text-sm font-medium">Selecciona el GeoTIFF</p>
            <p className="text-xs text-muted-foreground">
              En iPhone toca el botón y elige “Seleccionar archivo” para abrir la app Archivos.
            </p>
            <Label
              htmlFor="mbar-file"
              className="mt-3 inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground"
            >
              Elegir desde Archivos
            </Label>
          </div>
          <input
            id="mbar-file"
            ref={fileRef}
            type="file"
            accept=".tif,.tiff,image/tiff,application/geotiff"
            disabled={busy || inspecting}
            className="sr-only"
            onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
          />
          {file && (
            <p className="text-xs text-muted-foreground">
              {file.name} · {(file.size / 1048576).toFixed(1)} MB
            </p>
          )}
          {inspecting && (
            <p className="text-xs text-muted-foreground">Validando el fichero…</p>
          )}
        </div>

        <div className="space-y-2 rounded-md border border-dashed p-3">
          <Label htmlFor="mbar-url">…o pega un enlace descargable</Label>
          <p className="text-xs text-muted-foreground">
            Útil cuando el GeoTIFF supera el límite de adjuntos: pega la URL directa al fichero
            (Drive/Dropbox: usa el enlace de descarga directa) y se traerá al dispositivo para
            procesarlo aquí mismo. En iPhone, mantén pulsado dentro del campo y toca “Pegar”.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="mbar-url"
              type="url"
              inputMode="url"
              placeholder="https://…/ES393923_16M.tif"
              value={remoteUrl}
              disabled={busy || inspecting || downloading}
              onChange={(e) => setRemoteUrl(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy || inspecting || downloading}
              onClick={() => void pasteRemoteUrl()}
            >
              Pegar enlace
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy || inspecting || downloading || !remoteUrl.trim()}
              onClick={() => void fetchFromUrl()}
            >
              {downloading ? "Descargando…" : "Descargar"}
            </Button>
          </div>
          {pasteHint && <p className="text-xs text-muted-foreground">{pasteHint}</p>}
          {downloading && (
            <p className="text-xs text-muted-foreground">
              {downloadMB > 0
                ? `Descargados ${downloadMB.toFixed(1)} MB…`
                : "Conectando con el servidor de origen…"}
            </p>
          )}
        </div>


        {inspection && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <p className="text-sm font-medium">
              {inspection.ok ? "Comprobaciones previas correctas" : "El fichero no es válido"}
            </p>
            {inspection.info && (
              <ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                <li>Tamaño: {inspection.info.fileSizeMB.toFixed(1)} MB</li>
                <li>
                  Rejilla: {inspection.info.width}×{inspection.info.height} px
                </li>
                <li>
                  Sistema de referencia: EPSG:{inspection.info.epsg}
                  {inspection.info.isGeographic ? " (geográfico)" : ""}
                </li>
                <li>Resolución: ≈{inspection.info.resM.toFixed(1)} m</li>
                <li>Cobertura: ≈{Math.round(inspection.info.coverageKm2)} km²</li>
                <li>Celdas con dato: {inspection.info.validPct.toFixed(1)}%</li>
                <li>
                  Profundidades: {inspection.info.minElev.toFixed(1)} …{" "}
                  {inspection.info.maxElev.toFixed(1)} m
                </li>
                <li>Teselas estimadas: {inspection.info.estTiles}</li>
              </ul>
            )}
            {inspection.errors.map((m) => (
              <p key={m} className="text-xs text-destructive">
                ✕ {m}
              </p>
            ))}
            {inspection.warnings.map((m) => (
              <p key={m} className="text-xs text-amber-600 dark:text-amber-400">
                ⚠ {m}
              </p>
            ))}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="mbar-id">Identificador de hoja</Label>
            <Input
              id="mbar-id"
              value={sheetId}
              disabled={busy}
              placeholder="ES393923"
              onChange={(e) => setSheetId(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mbar-name">Nombre visible</Label>
            <Input
              id="mbar-name"
              value={sheetName}
              disabled={busy}
              placeholder="Bahía de Palma"
              onChange={(e) => setSheetName(e.target.value)}
            />
          </div>
        </div>

        <Button
          onClick={run}
          disabled={!file || busy || inspecting || (inspection ? !inspection.ok : false)}
          className="w-full"
        >
          {busy ? "Procesando…" : inspecting ? "Validando…" : "Generar teselas y publicar"}
        </Button>

        {busy && (
          <div className="space-y-2">
            <Progress value={pct} />
            <p className="text-xs font-medium">
              {pct}% · {PHASE_LABEL[phase] || "Procesando"}
            </p>
            {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
            <ol className="flex flex-wrap gap-1 text-[11px]">
              {PHASE_ORDER.map((p) => {
                const idx = PHASE_ORDER.indexOf(phase as PhaseKey);
                const here = PHASE_ORDER.indexOf(p);
                const state = phase === "done" || here < idx ? "done" : here === idx ? "now" : "next";
                return (
                  <li
                    key={p}
                    className={
                      "rounded-full border px-2 py-0.5 " +
                      (state === "now"
                        ? "border-primary bg-primary/10 text-primary"
                        : state === "done"
                          ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                          : "text-muted-foreground")
                    }
                  >
                    {state === "done" ? "✓ " : ""}
                    {PHASE_LABEL[p]}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {done && <p className="text-sm text-emerald-600 dark:text-emerald-400">{done}</p>}
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Hojas publicadas desde la app</h2>
        {sheets.length === 0 && (
          <p className="text-sm text-muted-foreground">Todavía no hay hojas subidas.</p>
        )}
        <ul className="space-y-2">
          {sheets.map((s) => (
            <li
              key={s.sheet}
              className="flex items-center justify-between gap-3 rounded-md bg-muted/40 p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{s.product}</p>
                <p className="text-xs text-muted-foreground">
                  {s.cols}×{s.rows} celdas · {s.south.toFixed(4)},{s.west.toFixed(4)} →{" "}
                  {s.north.toFixed(4)},{s.east.toFixed(4)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await remove({ data: { sheet: s.sheet } });
                    await refresh();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Eliminar
              </Button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Atribución obligatoria: IHM MBAR24 · 16 m · No válido para la navegación.
        </p>
      </section>
    </main>
  );
}

