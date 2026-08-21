import type { SavedTrack } from "../hooks/use-saved-tracks";
import { formatTrackStats } from "../hooks/use-saved-tracks";

interface SavedTracksPanelProps {
  tracks: SavedTrack[];
  activeId?: string | null;
  onShow: (track: SavedTrack) => void;
  onExport: (track: SavedTrack) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

export function SavedTracksPanel({
  tracks,
  activeId,
  onShow,
  onExport,
  onRename,
  onDelete,
}: SavedTracksPanelProps) {
  if (tracks.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card/30 px-2 py-2 text-[10.5px] text-muted-foreground">
        Aún no hay tracks guardados. Activa el GPS, navega y pulsa «💾 Guardar track»: se
        guardan en este dispositivo (memoria de la app) y aparecerán aquí, en Menú › Tracks
        guardados.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[9.5px] leading-tight text-muted-foreground">
        Guardados en este dispositivo. Usa «⬇ GPX» para exportarlos a Archivos y compartirlos.
      </div>
      {tracks.map((t) => (
        <div
          key={t.id}
          className={`rounded-lg border px-2 py-1.5 ${
            activeId === t.id ? "border-cyan-400/60 bg-cyan-500/10" : "border-border bg-card/30"
          }`}
        >
          <div className="truncate text-[11.5px] font-medium text-foreground">{t.name}</div>
          <div className="mt-0.5 font-mono text-[9.5px] text-muted-foreground">
            {formatTrackStats(t.points)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => onShow(t)}
              className="rounded-md border border-border bg-secondary/60 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary"
            >
              🗺 Ver en mapa
            </button>
            <button
              type="button"
              onClick={() => onExport(t)}
              className="rounded-md border border-border bg-secondary/60 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary"
            >
              ⬇ GPX
            </button>
            <button
              type="button"
              onClick={() => {
                const name = window.prompt("Nuevo nombre del track", t.name);
                if (name) onRename(t.id, name);
              }}
              className="rounded-md border border-border bg-secondary/60 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-secondary"
            >
              ✎
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`¿Borrar el track «${t.name}»?`)) onDelete(t.id);
              }}
              className="ml-auto rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1 text-[10px] font-medium text-foreground hover:bg-destructive/20"
            >
              🗑
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

