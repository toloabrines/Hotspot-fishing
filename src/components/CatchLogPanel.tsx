/**
 * Memoria de resultados reales: registro estructurado de capturas.
 * Solo datos validados (especie, cantidad, técnica, resultado) alimentan
 * el ajuste progresivo del ranking de zonas.
 */
import { useState } from "react";
import { saveCatchReport } from "../lib/catch-learning.functions";
import type { FishingModeKey } from "../lib/scoring-weights";

export interface CatchLogTarget {
  lat: number;
  lng: number;
  depthM: number | null;
}

interface Props {
  target: CatchLogTarget;
  mode: FishingModeKey;
  env: Record<string, number | string | null>;
  onClose: () => void;
}

const QUALITIES = [
  { key: "bueno", label: "Bueno" },
  { key: "regular", label: "Regular" },
  { key: "malo", label: "Malo" },
] as const;

export function CatchLogPanel({ target, mode, env, onClose }: Props) {
  const [species, setSpecies] = useState("");
  const [quantity, setQuantity] = useState("");
  const [depth, setDepth] = useState(target.depthM != null ? String(Math.round(target.depthM)) : "");
  const [technique, setTechnique] = useState("");
  const [bait, setBait] = useState("");
  const [quality, setQuality] = useState<"bueno" | "regular" | "malo">("bueno");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveCatchReport({
        data: {
          lat: target.lat,
          lng: target.lng,
          mode,
          outcome: quality === "malo" ? "bad" : "good",
          factors: {},
          note: note || null,
          species: species || null,
          quantity: quantity ? Number(quantity) : null,
          depthM: depth ? Number(depth) : target.depthM,
          technique: technique || null,
          bait: bait || null,
          quality,
          fishedAtIso: new Date().toISOString(),
          env,
        },
      });
      setDone(true);
      setTimeout(onClose, 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar la captura.");
    } finally {
      setSaving(false);
    }
  };

  const field = "w-full rounded-md border border-border bg-background px-2 py-1 text-sm";

  return (
    <div className="fixed inset-0 z-[2600] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
      <div className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-border bg-card p-4 text-card-foreground sm:rounded-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Anotar captura</h2>
          <button onClick={onClose} className="rounded-md border border-border px-2 py-1 text-xs">
            ✕ Cerrar
          </button>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {target.lat.toFixed(5)}, {target.lng.toFixed(5)} · se guardan también las condiciones
          oceanográficas actuales.
        </p>

        <div className="mt-3 space-y-2">
          <label className="block text-xs">
            Especie
            <input className={field} value={species} onChange={(e) => setSpecies(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs">
              Cantidad
              <input
                type="number"
                inputMode="numeric"
                className={field}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </label>
            <label className="block text-xs">
              Profundidad (m)
              <input
                type="number"
                inputMode="numeric"
                className={field}
                value={depth}
                onChange={(e) => setDepth(e.target.value)}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs">
              Técnica
              <input
                className={field}
                value={technique}
                onChange={(e) => setTechnique(e.target.value)}
              />
            </label>
            <label className="block text-xs">
              Cebo o señuelo
              <input className={field} value={bait} onChange={(e) => setBait(e.target.value)} />
            </label>
          </div>
          <div>
            <span className="text-xs">Resultado</span>
            <div className="mt-1 flex gap-2">
              {QUALITIES.map((q) => (
                <button
                  key={q.key}
                  onClick={() => setQuality(q.key)}
                  className={`flex-1 rounded-md border px-2 py-1 text-xs ${
                    quality === q.key
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border"
                  }`}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
          <label className="block text-xs">
            Notas
            <textarea
              rows={2}
              className={field}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        {done && <p className="mt-2 text-xs text-emerald-500">Captura guardada.</p>}

        <button
          onClick={submit}
          disabled={saving || done}
          className="mt-3 w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {saving ? "Guardando…" : "Guardar captura"}
        </button>
      </div>
    </div>
  );
}

export default CatchLogPanel;

