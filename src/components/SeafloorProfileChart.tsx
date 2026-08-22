import { useMemo } from "react";
import type { DemGrid } from "../lib/dem";

interface Props {
  grid: DemGrid | null;
  points: { lat: number; lng: number }[];
  onReset: () => void;
  onClose: () => void;
}

/** Perfil del fondo entre dos puntos (corte vertical del relieve). */
export function SeafloorProfileChart({ grid, points, onReset, onClose }: Props) {
  const data = useMemo(() => {
    if (!grid || points.length < 2) return null;
    const samples = grid.profile(points[0], points[1], 180);
    const valid = samples.filter((s) => s.depthM != null) as {
      distM: number;
      depthM: number;
    }[];
    if (valid.length < 3) return null;
    const maxDist = samples[samples.length - 1].distM;
    const minD = Math.min(...valid.map((v) => v.depthM));
    const maxD = Math.max(...valid.map((v) => v.depthM));
    return { samples, maxDist, minD, maxD, drop: maxD - minD };
  }, [grid, points]);

  const W = 320;
  const H = 130;

  const path = useMemo(() => {
    if (!data) return "";
    const span = Math.max(1, data.maxD - data.minD);
    let d = "";
    let started = false;
    for (const s of data.samples) {
      if (s.depthM == null) {
        started = false;
        continue;
      }
      const x = (s.distM / Math.max(1, data.maxDist)) * W;
      const y = ((s.depthM - data.minD) / span) * (H - 20) + 8;
      d += `${started ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      started = true;
    }
    return d;
  }, [data]);

  return (
    <div className="pointer-events-auto w-[min(94vw,360px)] rounded-xl border border-border bg-background/95 p-3 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Perfil del fondo
        </p>
        <div className="flex gap-1">
          <button
            onClick={onReset}
            className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"
          >
            Reiniciar
          </button>
          <button
            onClick={onClose}
            className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
          >
            Cerrar
          </button>
        </div>
      </div>

      {!data ? (
        <p className="text-xs text-muted-foreground">
          Toca dos puntos en el mapa para dibujar el corte del relieve entre ellos.
        </p>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
            <defs>
              <linearGradient id="sfProfileFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#0c4a6e" stopOpacity="0.8" />
              </linearGradient>
            </defs>
            <path d={`${path} L${W},${H} L0,${H} Z`} fill="url(#sfProfileFill)" />
            <path d={path} fill="none" stroke="#f97316" strokeWidth="1.8" />
          </svg>
          <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[11px]">
            <Stat label="Distancia" value={`${(data.maxDist / 1000).toFixed(2)} km`} />
            <Stat label="Mín" value={`${data.minD.toFixed(0)} m`} />
            <Stat label="Máx" value={`${data.maxD.toFixed(0)} m`} />
            <Stat label="Desnivel" value={`${data.drop.toFixed(0)} m`} />
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/50 px-1 py-1">
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-xs font-semibold text-foreground">{value}</p>
    </div>
  );
}

