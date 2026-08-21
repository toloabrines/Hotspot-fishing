/**
 * «Analizar foto» dentro de Pesca con IA.
 *
 * Permite hacer una foto con la cámara o elegirla de la galería, la comprime en
 * el móvil (menos coste y menos datos) y la envía a la IA con visión.
 * La imagen no se guarda en ningún sitio: solo se usa para el análisis.
 */
import { useCallback, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { analyzeFishingPhoto } from "../lib/ai-advisor.functions";
import type { VisionAnswer, VisionResponse } from "../lib/ai-vision";

interface Props {
  onClose: () => void;
  onUsage?: (u: { used: number; limit: number; unlimited: boolean; credits: number; rateLimited: boolean }) => void;
}

const DISCLAIMER =
  "Identificación orientativa realizada mediante inteligencia artificial. Comprueba la normativa y " +
  "no consumas ninguna especie si existen dudas sobre su identificación.";

/** Redimensiona a 1024 px de lado mayor y comprime a JPEG. */
async function compressImage(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("read"));
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("img"));
    el.src = dataUrl;
  });
  const max = 1024;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.72);
}

function answerToText(a: VisionAnswer): string {
  const l: string[] = [];
  l.push(`🔎 ${a.observation}`);
  if (a.fish) {
    const f = a.fish;
    if (f.commonName) l.push(`Especie: ${f.commonName}${f.scientificName ? ` (${f.scientificName})` : ""}`);
    if (f.family) l.push(`Familia: ${f.family}`);
    if (f.features) l.push(`Rasgos: ${f.features}`);
    if (f.habitat) l.push(`Hábitat: ${f.habitat}`);
    if (f.feeding) l.push(`Alimentación: ${f.feeding}`);
    if (f.technique) l.push(`Técnica: ${f.technique}`);
    if (f.confidence) l.push(`Confianza: ${f.confidence}`);
    if (f.similar.length) l.push(`Parecidas: ${f.similar.join(", ")}`);
  }
  if (a.advice) l.push(`Consejo: ${a.advice}`);
  if (a.retakeHint) l.push(a.retakeHint);
  l.push("");
  l.push(DISCLAIMER);
  l.push("— Hotspot Fishing");
  return l.join("\n");
}

export default function AiPhotoAnalyzer({ onClose, onUsage }: Props) {
  const analyze = useServerFn(analyzeFishingPhoto);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);

  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<VisionResponse | null>(null);

  const pick = useCallback(async (file: File | undefined | null) => {
    if (!file) return;
    setRes(null);
    try {
      setPreview(await compressImage(file));
    } catch {
      setRes({
        ok: false,
        answer: null,
        message: "No se pudo leer la imagen. Prueba con otra foto.",
        code: "bad_image",
        usedToday: 0,
        dailyLimit: 10,
      });
    }
  }, []);

  const run = useCallback(async () => {
    if (!preview || loading) return;
    setLoading(true);
    setRes(null);
    try {
      const out = (await analyze({
        data: { imageDataUrl: preview, note: note.trim() || null },
      })) as VisionResponse;
      setRes(out);
      onUsage?.({
        used: out.usedToday,
        limit: out.dailyLimit,
        unlimited: Boolean(out.unlimited),
        credits: out.creditsLeft ?? 0,
        rateLimited: out.code === "rate_limited",
      });
    } catch {
      setRes({
        ok: false,
        answer: null,
        message: "No se pudo conectar con la IA. Revisa la conexión.",
        code: "provider_error",
        usedToday: 0,
        dailyLimit: 10,
      });
    } finally {
      setLoading(false);
    }
  }, [analyze, preview, note, loading, onUsage]);

  const reset = useCallback(() => {
    setPreview(null);
    setRes(null);
    setNote("");
  }, []);

  const shareWhatsApp = useCallback(() => {
    if (!res?.answer) return;
    const url = `https://wa.me/?text=${encodeURIComponent(answerToText(res.answer))}`;
    window.open(url, "_blank", "noopener");
  }, [res]);

  const fish = res?.answer?.fish ?? null;

  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold">📷 Analizar foto</h3>
        <button
          onClick={onClose}
          className="rounded-lg border border-border px-2 py-1 text-[11px] text-muted-foreground"
        >
          Volver al chat
        </button>
      </div>

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void pick(e.target.files?.[0])}
      />

      {!preview && (
        <div className="mt-3 space-y-2">
          <button
            onClick={() => cameraRef.current?.click()}
            className="w-full rounded-xl bg-primary px-4 py-4 text-base font-bold text-primary-foreground active:scale-[0.99]"
          >
            📷 Hacer foto
          </button>
          <button
            onClick={() => galleryRef.current?.click()}
            className="w-full rounded-xl border border-border px-4 py-3 text-sm font-semibold"
          >
            🖼️ Elegir de la galería
          </button>
          <p className="text-[11px] text-muted-foreground">
            La foto se comprime en el móvil y solo se usa para este análisis: no queda guardada.
          </p>
        </div>
      )}

      {preview && (
        <div className="mt-3 space-y-2">
          <img
            src={preview}
            alt="Foto a analizar"
            className="max-h-[38vh] w-full rounded-xl border border-border object-contain"
          />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Opcional: cuéntame algo de la foto (dónde, con qué la pescaste…)"
            className="w-full resize-none rounded-lg border border-border bg-background p-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={() => void run()}
              disabled={loading}
              className="flex-1 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              {loading ? "Analizando imagen…" : "🤖 Analizar con IA"}
            </button>
            <button
              onClick={reset}
              className="rounded-xl border border-border px-3 py-3 text-sm font-semibold"
            >
              Hacer otra foto
            </button>
          </div>
        </div>
      )}

      {loading && (
        <div className="mt-3 text-xs text-muted-foreground">Analizando imagen…</div>
      )}

      {res && !res.ok && (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-500">
          {res.message ?? "No se pudo analizar la imagen."}
        </div>
      )}

      {res?.answer && (
        <div className="mt-3 space-y-2 rounded-xl border border-border bg-card p-3 text-sm">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {res.answer.kind}
          </div>
          <p className="whitespace-pre-wrap">{res.answer.observation}</p>

          {fish && (
            <div className="space-y-1 rounded-lg border border-border bg-background/60 p-2 text-[12px]">
              {fish.commonName && (
                <div className="text-sm font-bold">
                  {fish.commonName}
                  {fish.scientificName && (
                    <span className="ml-1 font-normal italic text-muted-foreground">
                      {fish.scientificName}
                    </span>
                  )}
                </div>
              )}
              {fish.family && <div>🧬 Familia: {fish.family}</div>}
              {fish.features && <div>🔍 Rasgos: {fish.features}</div>}
              {fish.habitat && <div>🌊 Hábitat: {fish.habitat}</div>}
              {fish.feeding && <div>🍤 Alimentación: {fish.feeding}</div>}
              {fish.technique && <div>🎣 Técnica: {fish.technique}</div>}
              {fish.confidence && (
                <div
                  className={
                    fish.confidence === "alto"
                      ? "text-emerald-500"
                      : fish.confidence === "medio"
                        ? "text-amber-500"
                        : "text-red-500"
                  }
                >
                  Confianza: {fish.confidence}
                </div>
              )}
              {fish.similar.length > 0 && <div>↔️ Parecidas: {fish.similar.join(", ")}</div>}
            </div>
          )}

          {res.answer.advice && (
            <p className="whitespace-pre-wrap text-[13px] text-muted-foreground">
              💡 {res.answer.advice}
            </p>
          )}
          {res.answer.retakeHint && (
            <p className="rounded-lg border border-cyan-400/40 bg-cyan-400/10 p-2 text-[12px] text-cyan-400">
              {res.answer.retakeHint}
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={shareWhatsApp}
              className="rounded-lg border border-emerald-500/60 px-3 py-1.5 text-[12px] font-semibold text-emerald-500"
            >
              Compartir por WhatsApp
            </button>
            <button
              onClick={reset}
              className="rounded-lg border border-border px-3 py-1.5 text-[12px] font-semibold"
            >
              Hacer otra foto
            </button>
          </div>

          <p className="border-t border-border pt-2 text-[11px] text-muted-foreground">
            {DISCLAIMER}
          </p>
        </div>
      )}
    </div>
  );
}

