/**
 * Asistente de pesca conversacional.
 *
 * El pescador escribe (o dicta) libremente. La IA responde con los datos
 * REALES de la app (hotspots ya calculados, viento, corriente, temperatura…),
 * mantiene el hilo de la conversación, pregunta solo lo que falta y puede:
 *  - cambiar la modalidad de pesca,
 *  - pedir el triángulo de búsqueda,
 *  - marcar y centrar en la carta el punto recomendado.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { chatFishingAdvisor, transcribeVoice } from "../lib/ai-advisor.functions";
import {
  ADVISOR_MODE_LABEL,
  compassLabel,
  type AdvisorChatMessage,
  type AdvisorMode,
  type AdvisorPlanSpot,
  type AdvisorSpot,
} from "../lib/ai-advisor";
import { buildPlan } from "../lib/ai-plan";
import { toDegMinSec } from "./FishingHotspots.types";
import AiPhotoAnalyzer from "./AiPhotoAnalyzer";


interface Props {
  mode: AdvisorMode;
  spots: AdvisorSpot[];
  gps: { lat: number; lng: number } | null;
  dataDateIso: string | null;
  wind: { avgKn: number; gustKn: number; dirDeg: number } | null;
  current: { avgKn: number; dirDeg: number } | null;
  pressureHpa: number | null;
  pressureTrend: string | null;
  sstC?: number | null;
  activeLayers: string[];
  fsleActive: boolean;
  analyzing: boolean;
  hasSearchArea: boolean;
  onRequestDrawArea: () => void;
  onSelectMode: (mode: AdvisorMode) => void;
  onFlyTo: (lat: number, lng: number) => void;
  /** La IA marca Top 1/2/3 + polígonos + deriva sobre la carta. */
  onPlan?: (plan: AdvisorPlanSpot[]) => void;
  /** Abrir el registro de capturas de una zona recomendada. */
  onLogCatch?: (spot: { lat: number; lng: number; depthM: number | null }) => void;
}


interface Bubble extends AdvisorChatMessage {
  spot?: AdvisorSpot | null;
  needArea?: boolean;
  alt?: AdvisorSpot | null;
  missing?: string | null;
  plan?: AdvisorPlanSpot[];
  regulation?: string | null;
}

export default function AiFishingChat({
  mode,
  spots,
  gps,
  dataDateIso,
  wind,
  current,
  pressureHpa,
  pressureTrend,
  sstC = null,
  activeLayers,
  fsleActive,
  analyzing,
  hasSearchArea,
  onRequestDrawArea,
  onSelectMode,
  onFlyTo,
  onPlan,
  onLogCatch,
}: Props) {
  const chat = useServerFn(chatFishingAdvisor);
  const transcribe = useServerFn(transcribeVoice);
  const [transcribing, setTranscribing] = useState(false);

  const [msgs, setMsgs] = useState<Bubble[]>([
    {
      role: "assistant",
      content:
        "Cuéntame qué quieres hacer hoy: especie, modalidad, profundidad, hasta dónde quieres alejarte… " +
        "Te respondo con los datos reales de la app y te marco la zona en la carta.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<{
    used: number;
    limit: number;
    unlimited: boolean;
    credits: number;
    rateLimited: boolean;
  } | null>(null);
  const [listening, setListening] = useState(false);
  const [photoMode, setPhotoMode] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);
  const recogRef = useRef<any>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, loading]);

  const advisorSpots = useMemo(() => spots.slice(0, 12), [spots]);

  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || loading) return;
      const history: AdvisorChatMessage[] = [
        ...msgs.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: clean },
      ];
      setMsgs((m) => [...m, { role: "user", content: clean }]);
      setInput("");
      setLoading(true);
      try {
        const out = await chat({
          data: {
            messages: history,
            mode,
            whenIso: new Date().toISOString(),
            dataDateIso,
            user: gps,
            hasSearchArea,
            spots: advisorSpots,
            env: {
              windKn: wind?.avgKn ?? null,
              windGustKn: wind?.gustKn ?? null,
              windDirDeg: wind?.dirDeg ?? null,
              currentKn: current?.avgKn ?? null,
              currentDirDeg: current?.dirDeg ?? null,
              pressureHpa,
              pressureTrend,
              sstC,
              bottomTempC: null,
              chlMgM3: null,
              fsleActive,
              activeLayers,
            },
          },
        });
        setUsage({
          used: out.usedToday,
          limit: out.dailyLimit,
          unlimited: Boolean(out.unlimited),
          credits: out.creditsLeft ?? 0,
          rateLimited: out.code === "rate_limited",
        });
        if (!out.ok || !out.answer) {
          setMsgs((m) => [
            ...m,
            { role: "assistant", content: out.message ?? "No se pudo completar la consulta." },
          ]);
          return;
        }
        const a = out.answer;
        const plan = a.picks?.length
          ? buildPlan(a.picks, advisorSpots, gps, {
              wind: wind ? { avgKn: wind.avgKn, dirDeg: wind.dirDeg } : null,
              current: current ? { avgKn: current.avgKn, dirDeg: current.dirDeg } : null,
            })
          : [];
        if (plan.length) onPlan?.(plan);
        const spot = a.spotId ? (advisorSpots.find((s) => s.id === a.spotId) ?? null) : null;
        const alt = a.altSpotId ? (advisorSpots.find((s) => s.id === a.altSpotId) ?? null) : null;
        setMsgs((m) => [
          ...m,
          {
            role: "assistant",
            content: a.reply,
            spot,
            alt,
            missing: a.missingData,
            plan,
            regulation: a.regulationNote,
            needArea: Boolean(a.changeSearchArea || (a.needSearchArea && !hasSearchArea)),
          },
        ]);
        if (a.setMode && a.setMode !== mode) onSelectMode(a.setMode);
        if (plan[0]) onFlyTo(plan[0].lat, plan[0].lng);
        else if (spot) onFlyTo(spot.lat, spot.lng);
      } catch {
        setMsgs((m) => [
          ...m,
          {
            role: "assistant",
            content: "No se pudo conectar con la IA. Revisa la conexión e inténtalo de nuevo.",
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [
      chat,
      msgs,
      loading,
      mode,
      dataDateIso,
      gps,
      hasSearchArea,
      advisorSpots,
      wind,
      current,
      pressureHpa,
      pressureTrend,
      sstC,
      fsleActive,
      activeLayers,
      onSelectMode,
      onFlyTo,
      onPlan,
      onRequestDrawArea,
    ],
  );

  // El pescador ha pulsado «Marcar zona en la carta» desde el chat: recordamos
  // que la conversación está esperando ese triángulo para continuar sola.
  const awaitingAreaRef = useRef(false);
  const requestArea = useCallback(() => {
    awaitingAreaRef.current = true;
    setMsgs((m) => [
      ...m,
      {
        role: "assistant",
        content: "Marca los 3 puntos en la carta. En cuanto cierres el triángulo sigo yo.",
      },
    ]);
    onRequestDrawArea();
  }, [onRequestDrawArea]);

  // Cuando el triángulo ya está cerrado y la app ha terminado de calcular los
  // hotspots, la IA continúa la conversación automáticamente.
  useEffect(() => {
    if (!awaitingAreaRef.current) return;
    if (!hasSearchArea || analyzing || loading) return;
    if (advisorSpots.length === 0) return;
    awaitingAreaRef.current = false;
    void send(
      "Ya he marcado el triángulo en la carta y la app ha calculado los puntos. " +
        "Dime dónde pescar dentro de esa zona y por qué.",
    );
  }, [hasSearchArea, analyzing, loading, advisorSpots, send]);



  // Micrófono: grabación real (MediaRecorder) + transcripción en el servidor.
  // Funciona en iOS/Android/WebView, donde SpeechRecognition no existe.
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeCandidates = ["audio/webm", "audio/mp4", "audio/ogg"];
      const mime = mimeCandidates.find((m) => (window as any).MediaRecorder?.isTypeSupported?.(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setListening(false);
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 1200) return;
        setTranscribing(true);
        try {
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 8192) {
            bin += String.fromCharCode(...buf.subarray(i, i + 8192));
          }
          const b64 = btoa(bin);
          const fmt = (rec.mimeType || "audio/webm").includes("mp4")
            ? "m4a"
            : (rec.mimeType || "").includes("ogg")
              ? "ogg"
              : "webm";
          const out = await transcribe({ data: { audioBase64: b64, format: fmt } });
          if (out.ok && out.text) void send(out.text);
          else
            setMsgs((m) => [
              ...m,
              { role: "assistant", content: out.message ?? "No se entendió el audio." },
            ]);
        } catch {
          setMsgs((m) => [
            ...m,
            { role: "assistant", content: "No se pudo transcribir el audio. Inténtalo de nuevo." },
          ]);
        } finally {
          setTranscribing(false);
        }
      };
      recogRef.current = rec;
      rec.start();
      setListening(true);
    } catch {
      setMsgs((m) => [
        ...m,
        {
          role: "assistant",
          content:
            "No tengo acceso al micrófono. Permite el micrófono en los ajustes del navegador o escribe la pregunta.",
        },
      ]);
    }
  }, [send, transcribe]);

  const toggleVoice = useCallback(() => {
    if (listening) {
      try {
        recogRef.current?.stop();
      } catch {
        setListening(false);
      }
      return;
    }
    void startRecording();
  }, [listening, startRecording]);


  if (photoMode) {
    return <AiPhotoAnalyzer onClose={() => setPhotoMode(false)} onUsage={setUsage} />;
  }

  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col">

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded-full border border-border px-2 py-0.5">
          {ADVISOR_MODE_LABEL[mode]}
        </span>
        <span className="rounded-full border border-border px-2 py-0.5">
          {hasSearchArea ? "△ triángulo activo" : "△ sin triángulo"}
        </span>
        <span className="rounded-full border border-border px-2 py-0.5">
          {advisorSpots.length} hotspots
        </span>
        {analyzing && <span className="text-cyan-400">recalculando…</span>}
      </div>

      <div
        ref={listRef}
        className="mt-2 min-h-[180px] flex-1 space-y-2 overflow-y-auto overscroll-contain rounded-xl border border-border bg-muted/20 p-2 sm:max-h-[46vh] sm:flex-none"
      >

        {msgs.map((m, i) => (
          <div
            key={i}
            className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
          >
            <div
              className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                m.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-card"
              }`}
            >
              {m.content}
              {m.missing && <div className="mt-1 text-[11px] text-amber-500">⚠️ {m.missing}</div>}
              {m.needArea && (
                <button
                  onClick={requestArea}
                  className="mt-2 rounded-lg border border-cyan-400/60 px-2 py-1 text-[11px] font-semibold text-cyan-400"
                >
                  △ Marcar zona en la carta
                </button>
              )}
              {m.regulation && (
                <div className="mt-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-500">
                  📋 {m.regulation}
                </div>
              )}
              {m.plan && m.plan.length > 0 && (
                <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
                  {m.plan.map((p) => (
                    <div key={p.rank} className="rounded-lg border border-border bg-background/60 p-2 text-[11px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-primary px-2 py-0.5 font-bold text-primary-foreground">
                          TOP {p.rank}
                        </span>
                        <span className="font-mono">
                          {toDegMinSec(p.lat, "lat")} {toDegMinSec(p.lng, "lng")}
                        </span>
                        <span>
                          {p.depthM != null ? `${Math.round(p.depthM)} m` : "prof. n/d"} ·{" "}
                          {p.distanceNm != null ? `${p.distanceNm.toFixed(1)} nm` : "— nm"} ·{" "}
                          rumbo {p.bearingDeg != null ? `${Math.round(p.bearingDeg)}°` : "—"} ·{" "}
                          confianza {p.confidence}
                        </span>
                      </div>
                      <p className="mt-1 text-muted-foreground">{p.why}</p>
                      {(p.technique || p.bestHours) && (
                        <p className="mt-1">
                          {p.technique ? `🎣 ${p.technique}` : ""}
                          {p.technique && p.bestHours ? " · " : ""}
                          {p.bestHours ? `🕒 ${p.bestHours}` : ""}
                        </p>
                      )}
                      {p.driftBearingDeg != null && (
                        <p className="mt-1 text-cyan-400">
                          Deriva marcada en la carta hacia {compassLabel(p.driftBearingDeg)}
                        </p>
                      )}
                      <div className="mt-1 flex gap-2">
                        <button
                          onClick={() => onFlyTo(p.lat, p.lng)}
                          className="rounded-md border border-border px-2 py-0.5"
                        >
                          Ver en carta
                        </button>
                        {onLogCatch && (
                          <button
                            onClick={() => onLogCatch({ lat: p.lat, lng: p.lng, depthM: p.depthM })}
                            className="rounded-md border border-border px-2 py-0.5"
                          >
                            Anotar captura
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {(m.spot || m.alt) && !m.plan?.length && (
                <div className="mt-2 space-y-1 border-t border-border/60 pt-2 text-[11px]">
                  {[m.spot, m.alt].filter(Boolean).map((s, k) => (
                    <div key={k} className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">
                        {k === 0 ? "📍" : "🔁"} Top {s!.rank}
                      </span>
                      <span className="font-mono">
                        {toDegMinSec(s!.lat, "lat")} {toDegMinSec(s!.lng, "lng")}
                      </span>
                      <span>
                        {s!.depthM != null ? `${Math.round(s!.depthM)} m` : "—"} ·{" "}
                        {s!.distanceNm != null ? `${s!.distanceNm.toFixed(1)} nm` : "—"} ·{" "}
                        {s!.scorePct}/100
                      </span>
                      <button
                        onClick={() => onFlyTo(s!.lat, s!.lng)}
                        className="rounded-md border border-border px-2 py-0.5"
                      >
                        Ver en carta
                      </button>
                    </div>
                  ))}
                  <div className="text-muted-foreground">
                    Corriente:{" "}
                    {current ? `${current.avgKn.toFixed(1)} kn de ${compassLabel(current.dirDeg)}` : "—"} ·
                    Viento: {wind ? `${wind.avgKn.toFixed(0)} kn` : "—"}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="text-xs text-muted-foreground">La IA está pensando con los datos reales…</div>
        )}
        {transcribing && (
          <div className="text-xs text-muted-foreground">Transcribiendo tu voz…</div>

        )}
      </div>




      <form
        className="sticky bottom-0 z-10 mt-2 flex items-end gap-2 border-t border-border bg-card pt-2 pb-[max(0.25rem,env(safe-area-inset-bottom))]"

        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={2}
          placeholder="Pregunta lo que quieras: especie, zona, hora, cebo, corriente…"
          className="min-h-[44px] flex-1 resize-none rounded-lg border border-border bg-background p-2 text-sm"
        />
        <button
          type="button"
          onClick={() => setPhotoMode(true)}
          className="rounded-lg border border-border px-3 py-2 text-sm"
          aria-label="Analizar una foto con la IA"
          title="Analizar foto"
        >
          📷
        </button>
        <button
          type="button"
          onClick={toggleVoice}
          disabled={transcribing}
          className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-50 ${
            listening ? "border-red-500 text-red-500" : "border-border"
          }`}
          aria-label={listening ? "Detener dictado" : "Dictar por voz"}
        >
          {transcribing ? "…" : listening ? "■" : "🎤"}
        </button>


        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          Enviar
        </button>
      </form>

      <p className="mt-1 text-[11px] text-muted-foreground">
        Datos: {dataDateIso ? new Date(dataDateIso).toLocaleString("es-ES") : "—"}
        {usage
          ? usage.unlimited
            ? " · Consultas de IA: ilimitadas (administrador)"
            : ` · Te quedan ${Math.max(0, usage.limit - usage.used)} de ${usage.limit} consultas de IA hoy` +
              (usage.credits > 0 ? ` · ${usage.credits} extra` : "")
          : ""}
      </p>

      {usage && !usage.unlimited && usage.rateLimited && usage.credits <= 0 && (
        <a
          href="/precios#packs-ia"
          className="mt-2 block rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-center text-[11px] font-semibold text-primary"
        >
          ⚡ Comprar paquete de consultas extra (desde 2,99 €)
        </a>
      )}
    </div>
  );
}

