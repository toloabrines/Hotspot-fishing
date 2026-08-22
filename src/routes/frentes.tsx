import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { decodeCorridorPayload, type CorridorSharePayload } from "@/lib/drift-corridor-export";
import { toDegMinSec } from "@/components/FishingHotspots.types";

export const Route = createFileRoute("/frentes")({
  head: () => ({
    meta: [
      { title: "Frentes de deriva — Hotspot Fishing" },
      {
        name: "description",
        content:
          "Ficha completa de los 3 mejores frentes de pesca a la deriva: puntuación, rumbo, deriva, profundidad, temperatura y clorofila.",
      },
      { property: "og:title", content: "Frentes de deriva — Hotspot Fishing" },
      {
        property: "og:description",
        content: "Comparte los corredores de deriva con su ficha completa e imprímelos en PDF.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: FrentesPage,
});

const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
const compass = (deg: number | null) =>
  deg == null || !Number.isFinite(deg) ? "—" : `${Math.round(deg)}° ${DIRS[Math.round((deg % 360) / 22.5) % 16]}`;
const fmtLen = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 2 : 1)} km`);
const fmtEta = (min: number | null) =>
  min == null ? "—" : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
const color = (s: number) => (s >= 75 ? "#16a34a" : s >= 60 ? "#eab308" : s >= 45 ? "#f97316" : "#ef4444");

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/50 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold text-foreground">{value}</span>
    </div>
  );
}

function FrentesPage() {
  const [data, setData] = useState<CorridorSharePayload | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const enc = new URLSearchParams(hash).get("d");
    const parsed = enc ? decodeCorridorPayload(enc) : null;
    if (parsed) setData(parsed);
    else setMissing(true);
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 print:px-0">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Frentes de deriva (Fluixa)</h1>
          {data && (
            <p className="text-xs text-muted-foreground">
              Generado el {new Date(data.t).toLocaleString("es-ES")} · Hotspot Fishing
            </p>
          )}
        </div>
        {data && (
          <button
            onClick={() => window.print()}
            className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/80 print:hidden"
          >
            🖨 Guardar como PDF
          </button>
        )}
      </header>

      {missing && (
        <p className="rounded-md border border-border bg-card/50 p-4 text-sm text-muted-foreground">
          Este enlace no contiene datos de frentes. Vuelve al mapa, ejecuta el modo Deriva y usa
          “Compartir frentes”.
        </p>
      )}

      {data && (
        <section className="mb-6 rounded-lg border border-border bg-card/40 p-3">
          <h2 className="mb-2 text-sm font-semibold text-foreground">Condiciones generales</h2>
          <Row
            label="Corriente"
            value={data.e.c != null ? `${(data.e.c * 1.94384).toFixed(2)} kn ${compass(data.e.cd)}` : "—"}
          />
          <Row
            label="Viento"
            value={
              data.e.w != null
                ? `${Math.round(data.e.w)} kn${data.e.g != null ? ` (racha ${Math.round(data.e.g)})` : ""} de ${compass(data.e.wd)}`
                : "—"
            }
          />
        </section>
      )}

      <div className="flex flex-col gap-4">
        {data?.f.map((f) => (
          <article key={f.r} className="rounded-lg border border-border bg-card/40 p-3 print:break-inside-avoid">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-bold text-foreground">Frente #{f.r}</h2>
              <span
                className="rounded-full px-2 py-0.5 text-xs font-bold text-white"
                style={{ background: color(f.s) }}
              >
                {f.s}/100
              </span>
            </div>
            <Row label="Longitud" value={fmtLen(f.l)} />
            <Row label="Rumbo del frente" value={`${f.b}° / ${(f.b + 180) % 360}°`} />
            <Row label="Deriva" value={compass(f.dd)} />
            <Row label="Tiempo de deriva" value={`${fmtEta(f.eta)}${f.dk != null ? ` · ${f.dk.toFixed(2)} kn` : ""}`} />
            <Row label="Prof. media" value={f.dep != null ? `${f.dep} m` : "—"} />
            <Row label="T superficie" value={f.sst != null ? `${f.sst.toFixed(2)} °C` : `∇ ${Math.round(f.sg * 100)}%`} />
            <Row label="Clorofila" value={f.chl != null ? `${f.chl.toFixed(4)} mg/m³` : `índice ${Math.round(f.ci * 100)}%`} />
            <Row label="Intensidad FSLE" value={f.fs > 0 ? `${Math.round(f.fs * 100)}%` : "sin línea FSLE"} />
            <Row label="Confianza" value={`${f.cf}%`} />
            <div className="mt-2 font-mono text-[11px] text-muted-foreground">
              <div>
                A {toDegMinSec(f.p[0][0], "lat")} {toDegMinSec(f.p[0][1], "lng")}
              </div>
              <div>
                B {toDegMinSec(f.p[f.p.length - 1][0], "lat")} {toDegMinSec(f.p[f.p.length - 1][1], "lng")}
              </div>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}

