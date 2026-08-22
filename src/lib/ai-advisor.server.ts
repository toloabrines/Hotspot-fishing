/**
 * Lógica servidor de «¿Dónde pescarías hoy?».
 *
 * - Usa la IA incluida de Lovable (LOVABLE_API_KEY, solo backend).
 * - La IA únicamente elige entre los hotspots reales recibidos y los explica.
 * - Límite de 10 consultas/día por usuario (tabla public.ai_advisor_usage).
 */
import { streamText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import {
  ADVISOR_DAILY_LIMIT,
  ADVISOR_LIMIT_MESSAGE,
  ADVISOR_MODE_LABEL,
  spotMeasuredLine,
  spotMissingFields,
} from "./ai-advisor";
import { isUnlimitedUser } from "./ai-limits.server";
import type { AdvisorAnswer, AdvisorRequest, AdvisorResponse } from "./ai-advisor";

import { MODEL_USER, MAX_ANSWER_TOKENS } from "./ai-model-router";

const MODEL = MODEL_USER;

const choiceSchema = z.object({
  spotId: z.string(),
  reasons: z.array(z.string()),
  confidence: z.enum(["alta", "media", "baja"]),
});

const answerSchema = z.object({
  primary: choiceSchema,
  secondary: choiceSchema.nullable(),
  missingData: z.string().nullable(),
  summary: z.string(),
});

function buildPrompt(req: AdvisorRequest): string {
  const e = req.env;
  const lines: string[] = [];
  lines.push(`Modalidad: ${ADVISOR_MODE_LABEL[req.mode]}`);
  lines.push(`Especie objetivo: ${req.species?.trim() || "no especificada"}`);
  lines.push(`Fecha y hora de pesca: ${req.whenIso}`);
  lines.push(`Fecha de los datos oceanográficos: ${req.dataDateIso ?? "no disponible"}`);
  lines.push(
    req.user
      ? `Posición del usuario: ${req.user.lat.toFixed(5)}, ${req.user.lng.toFixed(5)}`
      : "Posición del usuario: no disponible",
  );
  lines.push(
    req.maxDistanceNm != null
      ? `Distancia máxima aceptada: ${req.maxDistanceNm} millas náuticas`
      : "Distancia máxima aceptada: sin límite indicado",
  );
  lines.push("");
  lines.push(
    "Condiciones generales del área (contexto meteorológico; NO son los valores de cada hotspot):",
  );
  lines.push(
    `- Viento: ${e.windKn ?? "n/d"} kn (racha ${e.windGustKn ?? "n/d"} kn), dir ${e.windDirDeg ?? "n/d"}°`,
  );
  lines.push(`- Corriente: ${e.currentKn ?? "n/d"} kn hacia ${e.currentDirDeg ?? "n/d"}°`);
  lines.push(`- Presión: ${e.pressureHpa ?? "n/d"} hPa (${e.pressureTrend ?? "n/d"})`);
  lines.push(`- Temperatura superficie: ${e.sstC ?? "n/d"} °C · fondo: ${e.bottomTempC ?? "n/d"} °C`);
  lines.push(`- Clorofila: ${e.chlMgM3 ?? "n/d"} mg/m3 · FSLE activo: ${e.fsleActive ? "sí" : "no"}`);
  lines.push(`- Capas activas: ${e.activeLayers.length ? e.activeLayers.join(", ") : "ninguna"}`);
  lines.push("");
  lines.push(
    "Hotspots calculados por Hotspot Fishing con sus MEDICIONES EXACTAS en esa coordenada (únicas opciones válidas):",
  );
  for (const s of req.spots) {
    const missing = spotMissingFields(s);
    lines.push(
      `- id=${s.id} | Top ${s.rank} | ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)} | puntuación ${s.scorePct}/100 | ` +
        `profundidad ${s.depthM != null ? `${Math.round(s.depthM)} m` : "n/d"} | ` +
        `distancia ${s.distanceNm != null ? `${s.distanceNm.toFixed(1)} nm` : "n/d"} | ` +
        `medido en el punto: ${spotMeasuredLine(s)}` +
        (missing.length ? ` | sin dato en el punto: ${missing.join(", ")}` : " | sin datos faltantes") +
        ` | motivo app: ${s.reason || "n/d"}`,
    );
  }
  return lines.join("\n");
}

const SYSTEM = `Eres el asesor de pesca de la app Hotspot Fishing.
Reglas estrictas:
- SOLO puedes elegir entre los hotspots listados, usando su id exacto.
- NUNCA inventes coordenadas, temperaturas, corrientes, profundidades ni hotspots.
- Usa SIEMPRE las mediciones exactas del hotspot elegido ("medido en el punto"), nunca las
  condiciones generales del área ni las del cursor o del punto seleccionado.
- Solo puedes decir que falta un dato si aparece en "sin dato en el punto" de ESE hotspot.
  Si el hotspot dice "sin datos faltantes", missingData debe ser null y no puedes escribir que
  faltan datos, ni que no se han cargado temperatura o clorofila.
- No afirmes que temperatura y clorofila coinciden, son óptimas o convergen si esos valores no
  aparecen medidos en el punto.
- Explica con lenguaje claro de pescador, en español, sin tecnicismos innecesarios.
- Da exactamente 3 razones concretas para la opción principal, cada una basada en los datos recibidos.
- Elige también una segunda opción distinta si hay más de un hotspot.
- Máximo 250 palabras en total.`;

export interface AdvisorContext {
  userId: string;
}

export async function runAdvisor(
  req: AdvisorRequest,
  ctx: AdvisorContext,
): Promise<AdvisorResponse> {
  const apiKey = process.env["LOVABLE_API_KEY"];

  const base: AdvisorResponse = {
    ok: false,
    answer: null,
    message: null,
    code: null,
    usedToday: 0,
    dailyLimit: ADVISOR_DAILY_LIMIT,
  };

  if (!req.spots.length) {
    return {
      ...base,
      code: "no_spots",
      message:
        "No hay hotspots calculados en la zona. Dibuja el triángulo y ejecuta el análisis antes de preguntar.",
    };
  }

  if (!apiKey) {
    return {
      ...base,
      code: "missing_key",
      message:
        "La función de IA está instalada pero el servicio de IA no está configurado en el backend. El resto de la app funciona con normalidad.",
    };
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
  const usedToday = usageRow?.request_count ?? 0;
  let creditsLeft: number | undefined;
  if (!unlimited && usedToday >= ADVISOR_DAILY_LIMIT) {
    // Cupo diario agotado: se intenta usar una consulta extra comprada.
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

  const { recordAiUsage, readUsage } = await import("./ai-usage.server");
  let lastUsage = { promptTokens: 0, completionTokens: 0 };

  const bumpUsage = async (errorMessage?: string) => {
    await recordAiUsage(supabaseAdmin, {
      userId: ctx.userId,
      day,
      kind: "advisor",
      model: MODEL,
      usage: lastUsage,
      errorMessage,
      usageRow: usageRow ? { id: usageRow.id as string, request_count: usedToday } : null,
      usedToday,
    });
  };


  const gateway = createLovableAiGatewayProvider(apiKey, undefined, { structuredOutputs: true });

  let answer: AdvisorAnswer | null = null;
  try {
    // Streaming consumido en servidor: evita cortes por timeout aunque el
    // resultado se devuelva de una sola vez a la app.
    const result = streamText({
      model: gateway(MODEL),
      system: SYSTEM,
      prompt: buildPrompt(req),
      output: Output.object({ schema: answerSchema }),
      maxOutputTokens: MAX_ANSWER_TOKENS,
    });
    answer = (await result.output) as AdvisorAnswer;
    try {
      lastUsage = readUsage(await result.usage);
    } catch {
      /* sin datos de tokens */
    }

  } catch (err) {
    const msg =
      err instanceof Error ? err.message : NoObjectGeneratedError.isInstance(err) ? "sin objeto" : "error";
    await bumpUsage(msg);
    const rate = /\b429\b|rate limit|rate_limit|too many requests/i.test(msg);
    const credits = /\b402\b|\b403\b|credits?\b/i.test(msg);
    const parseFail = /no object generated|could not parse|invalid json|sin objeto/i.test(msg);
    return {
      ...base,
      code: "provider_error",
      usedToday: usedToday + 1,
      unlimited,
      creditsLeft,
      message: rate
        ? "El servicio de IA está saturado ahora mismo. Inténtalo dentro de unos minutos."
        : credits
          ? "Se han agotado los créditos de IA del espacio de trabajo."
          : parseFail
            ? "La IA cortó la respuesta a medias. Vuelve a intentarlo."
            : "No se pudo completar la consulta de IA. Inténtalo de nuevo.",
    };
  }

  const validIds = new Set(req.spots.map((s) => s.id));
  if (!answer?.primary || !validIds.has(answer.primary.spotId)) {
    await bumpUsage("respuesta no válida del modelo");
    return {
      ...base,
      code: "provider_error",
      usedToday: usedToday + 1,
      unlimited,
      creditsLeft,
      message:
        "La IA no devolvió una recomendación válida sobre los hotspots calculados. Vuelve a intentarlo.",
    };
  }
  if (answer.secondary && !validIds.has(answer.secondary.spotId)) {
    answer.secondary = null;
  }
  answer.primary.reasons = (answer.primary.reasons ?? []).slice(0, 3);
  if (answer.secondary) answer.secondary.reasons = (answer.secondary.reasons ?? []).slice(0, 3);

  // Aviso de datos faltantes: se recalcula con la realidad del punto elegido.
  // Nunca se muestra un "faltan datos" genérico si el hotspot tiene lecturas.
  const chosen = req.spots.find((s) => s.id === answer!.primary.spotId) ?? null;
  const missing = chosen ? spotMissingFields(chosen) : [];
  answer.missingData = missing.length
    ? `Sin dato en el punto: ${missing.join(", ")}.`
    : null;

  await bumpUsage();

  return {
    ok: true,
    answer,
    message: null,
    code: null,
    usedToday: usedToday + 1,
    dailyLimit: ADVISOR_DAILY_LIMIT,
    unlimited,
    creditsLeft,
  };
}

