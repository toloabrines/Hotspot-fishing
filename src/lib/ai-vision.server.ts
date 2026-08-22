/**
 * «Analizar foto» — visión por IA para pesca (solo servidor).
 *
 * Recibe una imagen ya comprimida por el móvil (data URL base64), la envía a un
 * modelo con visión y devuelve una ficha de identificación.
 *
 * La imagen NO se guarda en ningún sitio: se usa solo para la petición.
 * Consume una consulta del cupo diario (el administrador no tiene límite).
 */
import { ADVISOR_DAILY_LIMIT, ADVISOR_LIMIT_MESSAGE } from "./ai-advisor";
import { isUnlimitedUser } from "./ai-limits.server";
import { MODEL_ADMIN, MODEL_USER } from "./ai-model-router";
import type { VisionAnswer, VisionRequest, VisionResponse } from "./ai-vision";

const SYSTEM = `Eres el experto de pesca marítima de Hotspot Fishing analizando una fotografía.

Analiza SIEMPRE lo que realmente se ve: pez, cebo, señuelo, anzuelo, montaje/aparejo, captura de
pantalla de sonda, material náutico, avería o cualquier otro objeto relacionado con la pesca.

1. Explica primero con claridad qué observas.
2. Después da consejos prácticos y útiles de patrón experimentado.
3. Si es un PEZ, rellena el objeto "fish" con nombre común, nombre científico (si puedes),
   familia o especie probable, características que te han permitido identificarlo, hábitat,
   alimentación, técnica recomendada, nivel de confianza (alto/medio/bajo) y especies parecidas.
4. NUNCA inventes la especie. Si no estás seguro, pon uncertain=true, deja fish en null o con
   confidence "bajo", y escribe en observation: "No puedo identificarlo con suficiente seguridad",
   pidiendo en retakeHint otra fotografía lateral, con buena luz y con el pez completo.
5. Si la foto no tiene nada que ver con la pesca, dilo en una frase y reconduce.
6. Español claro, sin tecnicismos innecesarios, máximo unas 200 palabras en total.

Responde EXCLUSIVAMENTE con un JSON válido con esta forma exacta:
{"kind":"pez|señuelo|aparejo|anzuelo|sonda|material|avería|otro","observation":"...","advice":"...",
"fish":{"commonName":"","scientificName":"","family":"","features":"","habitat":"","feeding":"",
"technique":"","confidence":"alto|medio|bajo","similar":["",""]},"uncertain":false,"retakeHint":null}
Si no hay pez, "fish" debe ser null.`;

function parseAnswer(raw: string): VisionAnswer | null {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return text
      ? { kind: "otro", observation: text, advice: null, fish: null, uncertain: false, retakeHint: null }
      : null;
  }
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const f = (j["fish"] ?? null) as Record<string, unknown> | null;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return {
      kind: str(j["kind"]) ?? "otro",
      observation: str(j["observation"]) ?? "",
      advice: str(j["advice"]),
      uncertain: Boolean(j["uncertain"]),
      retakeHint: str(j["retakeHint"]),
      fish: f
        ? {
            commonName: str(f["commonName"]),
            scientificName: str(f["scientificName"]),
            family: str(f["family"]),
            features: str(f["features"]),
            habitat: str(f["habitat"]),
            feeding: str(f["feeding"]),
            technique: str(f["technique"]),
            confidence: (["alto", "medio", "bajo"] as const).find(
              (c) => c === String(f["confidence"] ?? "").toLowerCase(),
            ) ?? null,
            similar: Array.isArray(f["similar"])
              ? (f["similar"] as unknown[]).map((s) => String(s)).filter(Boolean).slice(0, 6)
              : [],
          }
        : null,
    };
  } catch {
    return { kind: "otro", observation: text, advice: null, fish: null, uncertain: false, retakeHint: null };
  }
}

export async function analyzePhoto(
  req: VisionRequest,
  ctx: { userId: string },
): Promise<VisionResponse> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  const base: VisionResponse = {
    ok: false,
    answer: null,
    message: null,
    code: null,
    usedToday: 0,
    dailyLimit: ADVISOR_DAILY_LIMIT,
  };

  if (!apiKey) {
    return { ...base, code: "missing_key", message: "El servicio de IA no está configurado." };
  }
  if (!req.imageDataUrl || !req.imageDataUrl.startsWith("data:image/")) {
    return { ...base, code: "bad_image", message: "La imagen no es válida. Haz otra foto." };
  }
  // ~6 MB de base64 como tope de seguridad.
  if (req.imageDataUrl.length > 6_000_000) {
    return { ...base, code: "bad_image", message: "La imagen es demasiado grande. Haz otra foto." };
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const day = new Date().toISOString().slice(0, 10);

  const { data: usageRow } = await supabaseAdmin
    .from("ai_advisor_usage")
    .select("id, request_count")
    .eq("user_id", ctx.userId)
    .eq("day", day)
    .maybeSingle();

  const unlimited = await isUnlimitedUser(supabaseAdmin, ctx.userId);
  const usedToday = (usageRow?.request_count as number | undefined) ?? 0;
  let creditsLeft: number | undefined;

  if (!unlimited && usedToday >= ADVISOR_DAILY_LIMIT) {
    const { consumeAiCredit } = await import("./ai-credits.server");
    const remaining = await consumeAiCredit(supabaseAdmin, ctx.userId);
    if (remaining == null) {
      return {
        ...base,
        code: "rate_limited",
        usedToday,
        unlimited,
        creditsLeft: 0,
        message: ADVISOR_LIMIT_MESSAGE,
      };
    }
    creditsLeft = remaining;
  }

  const MODEL = unlimited ? MODEL_ADMIN : MODEL_USER;
  const { recordAiUsage, readUsage } = await import("./ai-usage.server");
  let usage = { promptTokens: 0, completionTokens: 0 };

  const finish = async (errorMessage?: string) => {
    await recordAiUsage(supabaseAdmin, {
      userId: ctx.userId,
      day,
      kind: "chat",
      model: MODEL,
      usage,
      errorMessage,
      usageRow: usageRow ? { id: usageRow.id as string, request_count: usedToday } : null,
      usedToday,
    });
  };

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Analiza esta fotografía relacionada con la pesca." +
                  (req.note?.trim() ? ` Nota del pescador: ${req.note.trim().slice(0, 300)}` : ""),
              },
              { type: "image_url", image_url: { url: req.imageDataUrl } },
            ],
          },
        ],
        max_tokens: 900,
      }),
    });

    if (!res.ok) {
      const message =
        res.status === 429
          ? "El servicio de IA está saturado. Inténtalo en un minuto."
          : res.status === 402
            ? "No quedan créditos de IA disponibles en este momento."
            : "No se pudo analizar la imagen. Inténtalo de nuevo.";
      await finish(`vision ${res.status}`);
      return { ...base, code: "provider_error", message, usedToday: usedToday + 1, unlimited, ...(creditsLeft != null ? { creditsLeft } : {}) };
    }

    const json = (await res.json()) as Record<string, any>;
    usage = readUsage(json?.["usage"]);
    const answer = parseAnswer(String(json?.["choices"]?.[0]?.message?.content ?? ""));
    await finish(answer ? undefined : "vision empty");

    if (!answer) {
      return {
        ...base,
        code: "provider_error",
        message: "La IA no devolvió respuesta. Prueba con otra foto.",
        usedToday: usedToday + 1,
        unlimited,
        ...(creditsLeft != null ? { creditsLeft } : {}),
      };
    }

    return {
      ok: true,
      answer,
      message: null,
      code: null,
      usedToday: usedToday + 1,
      dailyLimit: ADVISOR_DAILY_LIMIT,
      unlimited,
      ...(creditsLeft != null ? { creditsLeft } : {}),
    };
  } catch {
    await finish("vision network");
    return {
      ...base,
      code: "provider_error",
      message: "No se pudo conectar con la IA. Revisa la conexión.",
      usedToday: usedToday + 1,
      unlimited,
    };
  }
}

