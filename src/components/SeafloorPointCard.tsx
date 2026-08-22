import { useEffect, useState } from "react";
import { LANDFORM_LABEL, type DemPointInfo } from "../lib/dem";
import { fetchBottomConditions, seafloorScore } from "../lib/seafloor-point";
import { getDepthAtLatLng, type DepthSource } from "../lib/bathymetry";

interface Props {
  lat: number;
  lng: number;
  info: DemPointInfo;
  time: string;
  onClose: () => void;
}

function fmt(v: number | null | undefined, digits = 1, unit = "") {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}${unit}`;
}

function curvatureLabel(c: number | null) {
  if (c == null) return "—";
  if (c > 1.5) return `Convexa (+${c.toFixed(1)})`;
  if (c < -1.5) return `Cóncava (${c.toFixed(1)})`;
  return `Plana (${c.toFixed(1)})`;
}

function scoreColor(score: number) {
  if (score >= 70) return "bg-emerald-500/20 text-emerald-300 border-emerald-400/40";
  if (score >= 45) return "bg-amber-500/20 text-amber-300 border-amber-400/40";
  return "bg-rose-500/20 text-rose-300 border-rose-400/40";
}

/** Ficha completa del fondo en un punto: morfología + T y corriente + Score. */
export function SeafloorPointCard({ lat, lng, info, time, onClose }: Props) {
  const [bottom, setBottom] = useState<{
    tempC: number | null;
    speed: number | null;
    dirDeg: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  // Profundidad puntual exacta (EMODnet/GEBCO), no la celda interpolada del DEM.
  const [exactDepth, setExactDepth] = useState<{ depth: number | null; source: DepthSource } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    setExactDepth(null);
    const ctrl = new AbortController();
    getDepthAtLatLng(lat, lng, ctrl.signal)
      .then((s) => {
        if (alive) setExactDepth({ depth: s.depth, source: s.source });
      })
      .catch(() => {});
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [lat, lng]);

  const depthM = exactDepth?.depth ?? info.depthM;
  const infoForScore: DemPointInfo = { ...info, depthM };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setBottom(null);
    const ctrl = new AbortController();
    fetchBottomConditions(lat, lng, depthM, time, ctrl.signal).then((r) => {
      if (!alive) return;
      setBottom(r);
      setLoading(false);
    });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [lat, lng, depthM, time]);

  const { score, reasons } = seafloorScore(
    infoForScore,
    bottom?.tempC ?? null,
    bottom?.speed ?? null,
  );


  return (
    <div className="pointer-events-auto w-[min(92vw,340px)] rounded-xl border border-border bg-background/95 p-3 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Ficha del fondo
          </p>
          <p className="text-xs text-muted-foreground">
            {lat.toFixed(4)}, {lng.toFixed(4)}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
        >
          Cerrar
        </button>
      </div>

      <div className={`mb-2 rounded-lg border px-3 py-2 text-center ${scoreColor(score)}`}>
        <p className="text-[10px] uppercase tracking-wide opacity-80">Score pesca de fondo</p>
        <p className="text-2xl font-bold leading-tight">{score}</p>
      </div>

      <dl className="grid grid-cols-2 gap-1.5 text-xs">
        <Row
          label={
            exactDepth == null
              ? "Profundidad (aprox.)"
              : exactDepth.source === "mbar24"
                ? "Profundidad (IHM 16 m)"
                : exactDepth.source === "emodnet"
                  ? "Profundidad (EMODnet)"
                : exactDepth.source === "ncei"
                  ? "Profundidad (NOAA NCEI)"
                  : exactDepth.source === "gebco"
                    ? "Profundidad (GEBCO)"
                    : "Profundidad (aprox.)"

          }
          value={fmt(depthM, 0, " m")}
        />

        <Row label="Estructura" value={LANDFORM_LABEL[info.landform]} />
        <Row label="Pendiente" value={fmt(info.slopeDeg, 1, "°")} />
        <Row label="Orientación" value={fmt(info.aspectDeg, 0, "°")} />
        <Row label="Rugosidad" value={fmt(info.roughnessM, 1, " m")} />
        <Row label="Curvatura" value={curvatureLabel(info.curvature)} />
        <Row label="T fondo" value={loading ? "…" : fmt(bottom?.tempC ?? null, 1, " °C")} />
        <Row
          label="Corr. fondo"
          value={
            loading
              ? "…"
              : bottom?.speed != null
                ? `${(bottom.speed * 100).toFixed(0)} cm/s · ${Math.round(bottom.dirDeg ?? 0)}°`
                : "—"
          }
        />
      </dl>

      {reasons.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-border pt-2 text-[11px] leading-snug text-muted-foreground">
          {reasons.slice(0, 5).map((r) => (
            <li key={r}>· {r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/50 px-2 py-1">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold text-foreground">{value}</dd>
    </div>
  );
}

