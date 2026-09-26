import { useRef, useState, useSyncExternalStore } from "react";
import {
  getSonarDatasets,
  makeDataset,
  parseSoundingsFile,
  setSonarDatasets,
  subscribeSonarDatasets,
  type SonarDataset,
} from "../lib/sonar-data";
import { parseLowranceSl3 } from "../lib/lowrance-sl3";

/**
 * Importación de sondeos propios (ecosonda / multihaz). Es la única forma de
 * resolver piedras y estructuras de pocas decenas de metros: los datos
 * públicos tienen celdas de 115 m o más.
 */
export function SonarImportPanel() {
  const datasets = useSyncExternalStore(
    subscribeSonarDatasets,
    getSonarDatasets,
    () => [] as SonarDataset[],
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const total = datasets.reduce((n, d) => n + d.points.length, 0);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setStatus("Leyendo archivo…");
    try {
      const added: SonarDataset[] = [];
      const notes: string[] = [];

      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase();
        let points;

        if (lower.endsWith(".sl3")) {
          setStatus(`Leyendo SL3 · ${file.name}…`);
          const parsed = parseLowranceSl3(await file.arrayBuffer());
          if (!parsed.ok) {
            notes.push(`${file.name}: ${parsed.error ?? "SL3 no válido"}`);
            continue;
          }
          points = parsed.points;
          notes.push(
            `${file.name}: ${points.length.toLocaleString("es-ES")} sondas extraídas del SL3`,
          );
        } else {
          const text = await file.text();
          points = parseSoundingsFile(file.name, text);
        }

        const ds = makeDataset(file.name.replace(/\.[^.]+$/, ""), points);
        if (ds) added.push(ds);
      }

      if (!added.length) {
        setStatus(
          notes.length
            ? notes.join(" · ")
            : "No se han encontrado sondeos válidos (lat, lon, profundidad).",
        );
      } else {
        const ok = setSonarDatasets([...datasets, ...added]);
        const pts = added.reduce((n, d) => n + d.points.length, 0);
        const base = ok
          ? `${pts.toLocaleString("es-ES")} sondas importadas · resolución ~${Math.min(
              ...added.map((d) => d.spacingM),
            )} m`
          : "Importado, pero no se ha podido guardar (memoria del navegador llena).";
        setStatus(notes.length ? `${base} · ${notes.join(" · ")}` : base);
      }
    } catch {
      setStatus("No se ha podido leer el archivo.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = (id: string) => setSonarDatasets(datasets.filter((d) => d.id !== id));

  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-background/60 p-2">
      <div className="text-[11px] font-medium text-foreground">Mis sondeos (sonda propia)</div>
      <p className="text-[10px] leading-snug text-muted-foreground">
        Importa directamente un archivo Lowrance/Simrad SL3, o datos ya exportados en CSV, TXT, XYZ,
        GPX o KML. Hotspot extrae posición y profundidad y da prioridad a tus sondeos sobre la
        batimetría pública en esa zona.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept=".sl3,.csv,.txt,.xyz,.gpx,.kml,application/octet-stream,text/plain,text/csv,application/gpx+xml"
        multiple
        className="hidden"
        onChange={(e) => void onFiles(e.target.files)}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="w-full rounded-md border border-primary/50 bg-primary/15 px-2 py-1.5 text-[11px] font-medium text-foreground disabled:opacity-60"
      >
        {busy ? "Importando…" : "Importar datos de sonda"}
      </button>

      <div className="text-[9px] leading-snug text-muted-foreground">
        Primera versión SL3: Lowrance/Simrad. El archivo se procesa en el dispositivo.
      </div>

      {status && <div className="text-[10px] text-muted-foreground">{status}</div>}

      {datasets.length > 0 && (
        <div className="space-y-1 pt-0.5">
          <div className="text-[10px] text-muted-foreground">
            {datasets.length} archivo(s) · {total.toLocaleString("es-ES")} sondas guardadas en este
            dispositivo
          </div>
          {datasets.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-[10px]"
            >
              <span className="min-w-0 flex-1 truncate text-foreground">
                {d.name}
                <span className="ml-1 opacity-70">
                  {d.points.length.toLocaleString("es-ES")} pts · ~{d.spacingM} m
                </span>
              </span>
              <button
                type="button"
                onClick={() => remove(d.id)}
                className="shrink-0 rounded border border-border px-1.5 py-0.5 text-muted-foreground"
              >
                Borrar
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
