import { useEffect, useState } from "react";

interface DateSelectorProps {
  /** ISO date YYYY-MM-DD, or undefined for "latest". */
  value?: string;
  onChange: (value: string | undefined) => void;
}

const MIN_DATE_ISO = "1993-01-01";

function localTodayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatHuman(iso: string): string {
  // Parseamos como hora local (no UTC) para que el día mostrado coincida
  // siempre con el día del dispositivo, sin desfases de zona horaria.
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * Lightweight date picker that controls the Copernicus WMTS `TIME` parameter.
 * Copernicus typically lags ~5 days for L4 daily products, so we default the
 * "latest" anchor to today − 5 and cap the max selectable date there.
 */
export function DateSelector({ value, onChange }: DateSelectorProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="h-[86px] rounded-lg border border-border bg-card/60" />;
  }

  const maxDate = localTodayIso();
  const minDate = MIN_DATE_ISO;
  const latest = maxDate;

  const current = value ?? latest;
  const isLatest = !value;

  const shift = (days: number) => {
    const d = new Date(current + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    const iso = toIso(d);
    if (iso > maxDate) return;
    if (iso < minDate) return;
    onChange(iso);
  };

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card/60 p-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs">📅</span>
        <span className="flex-1 text-[10px] font-semibold text-foreground">Fecha</span>
        {!isLatest && (
          <button
            onClick={() => onChange(undefined)}
            className="rounded px-1 py-0.5 text-[9px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Volver a la fecha más reciente"
          >
            Reciente
          </button>
        )}
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={() => shift(-1)}
          className="rounded-md border border-border bg-secondary/60 px-1 py-0.5 text-[10px] text-foreground transition-colors hover:bg-secondary"
          title="Día anterior"
        >
          ◀
        </button>
        <input
          type="date"
          value={current}
          min={minDate}
          max={maxDate}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="flex-1 rounded-md border border-border bg-background/80 px-1 py-0.5 text-[10px] text-foreground"
        />
        <button
          onClick={() => shift(1)}
          disabled={current >= maxDate}
          className="rounded-md border border-border bg-secondary/60 px-1 py-0.5 text-[10px] text-foreground transition-colors hover:bg-secondary disabled:opacity-40"
          title="Día siguiente"
        >
          ▶
        </button>
      </div>

      <p className="text-[8px] text-muted-foreground">
        {isLatest ? `Hoy · ${formatHuman(latest)}` : formatHuman(current)}
      </p>
    </div>
  );
}

