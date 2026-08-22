/**
 * Asistente profesional de pesca marítima de Hotspot Fishing (servidor).
 *
 * Antes de responder consulta SIEMPRE, de forma automática:
 *  - los datos reales de la app (posición, zona, fecha, modalidad, SST,
 *    temperatura de fondo, clorofila, FSLE, corrientes, viento, profundidad…),
 *  - la base de conocimiento de pesca (incluida + documentos del administrador),
 *  - el historial estructurado de capturas del pescador.
 *
 * La IA NO calcula ni inventa nada: elige entre los hotspots reales de la app,
 * los ordena Top 1/2/3, explica por qué y propone técnica y horario.
 */
import { streamText, Output } from "ai";
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
import { retrieveKnowledge, knowledgeBlock } from "./ai-knowledge.server";
import { loadCatchMemory, catchMemoryBlock, historyHintFor } from "./ai-catch-memory.server";
import type {
  AdvisorChatAnswer,
  AdvisorChatRequest,
  AdvisorChatResponse,
} from "./ai-advisor";

import { MODEL_ADMIN, MODEL_USER, MAX_ANSWER_TOKENS } from "./ai-model-router";

const pickSchema = z.object({
  spotId: z.string(),
  rank: z.number(),
  why: z.string(),
  confidence: z.enum(["alta", "media", "baja"]),
  radiusM: z.number(),
  technique: z.string().nullable(),
  bestHours: z.string().nullable(),
  drift: z.boolean(),
});

const answerSchema = z.object({
  reply: z.string(),
  spotId: z.string().nullable(),
  altSpotId: z.string().nullable(),
  picks: z.array(pickSchema),
  species: z.string().nullable(),
  setMode: z.enum(["surface", "bottom", "squid", "drift"]).nullable(),
  needSearchArea: z.boolean(),
  changeSearchArea: z.boolean(),
  regulationNote: z.string().nullable(),
  missingData: z.string().nullable(),
});

const SYSTEM = `Eres el experto de pesca de Hotspot Fishing. Analizas conjuntamente conocimientos
pesqueros, datos oceanográficos actuales y resultados históricos. Tu misión es decidir dónde,
cuándo y cómo pescar, marcarlo directamente sobre la carta y explicar claramente tus razones.
Distingue siempre entre datos observados, predicciones e información desconocida. Nunca inventes
coordenadas, condiciones del mar, capturas ni normativas.

ÁMBITO: exclusivamente pesca marítima (Mediterráneo, Baleares y pesca de altura). Si te preguntan
otra cosa, dilo en una frase y reconduce a la pesca.

CÓMO TRABAJAS
1. Lee el bloque de DATOS REALES de la app (posición, zona, fecha/hora, modalidad, SST, temperatura
   de fondo, clorofila, altimetría, FSLE, corrientes de superficie y fondo, viento, profundidad,
   pendiente y batimetría) y el HISTORIAL de capturas del pescador.
2. Apóyate en la BASE DE CONOCIMIENTO adjunta para especie, hábitat, temporada, temperaturas,
   profundidades, cebos, señuelos, aparejos, velocidades, horarios y comportamiento.
3. Decide y responde en español claro de patrón experimentado.

MARCAR EN LA CARTA (obligatorio cuando hay hotspots y el pescador busca sitio)
- Rellena "picks" con hasta 3 elementos: rank 1, 2 y 3, cada uno con el id EXACTO de un hotspot
  recibido, por qué (2-3 frases sencillas), confianza, radio de trabajo en metros (200-1500 según
  modalidad y profundidad), técnica/cebo y mejores horas.
- Pon drift=true cuando la modalidad sea deriva/fluixa o cuando la pasada deba hacerse a la deriva.
- La app dibuja sola el polígono y la línea de deriva a partir de esos datos: tú NO das coordenadas.

CLASIFICA LA INTENCIÓN ANTES DE RESPONDER
1) INFORMATIVA (especie, cebo, técnica, temperatura idónea, normativa, seguridad, horarios):
   responde por escrito, picks vacío, needSearchArea=false y changeSearchArea=false SIEMPRE.
2) BUSCAR LUGAR: si NO hay triángulo definido, needSearchArea=true y pide en una frase corta que
   marque 3 puntos en la carta. Si YA hay triángulo, usa los hotspots recibidos y rellena picks.
3) SOBRE UN RESULTADO ANTERIOR (por qué, otra alternativa, más cerca, menos corriente): usa los
   hotspots existentes, needSearchArea=false y changeSearchArea=false.
4) CAMBIAR DE ZONA (lo pide explícitamente): changeSearchArea=true y needSearchArea=true.

REGLAS ESTRICTAS
- SOLO puedes recomendar hotspots de la lista recibida, con su id EXACTO.
- NUNCA inventes coordenadas, profundidades, temperaturas, corrientes, vientos ni capturas.
- Usa SIEMPRE las mediciones exactas del hotspot elegido ("medido en el punto"), nunca las
  condiciones generales del área, ni las del cursor o del punto seleccionado del panel lateral.
- Solo puedes decir que falta un dato si aparece en "sin dato en el punto" de ESE hotspot. Si el
  hotspot dice "sin datos faltantes", missingData debe ser null y está PROHIBIDO escribir que
  faltan datos o que no se han cargado temperatura, clorofila, corriente o altimetría.
- No afirmes que temperatura y clorofila coinciden, convergen o son óptimas si esos valores no
  aparecen medidos en el punto.
- Normativa y tallas: son orientativas; indica siempre la fecha de revisión del documento y avisa
  de que debe verificarse la norma vigente. Usa regulationNote para ese aviso.
- Nunca respondas solo con «marca tres puntos»: siempre aporta antes criterio útil.
- Si falta información importante haz UNA sola pregunta breve, sin repetir lo que ya te han dicho.
- Respuestas de unas 150 palabras como máximo, con viñetas cortas al comparar zonas.
- Recuerda la seguridad si el viento o la corriente son fuertes.`;

function buildContext(req: AdvisorChatRequest, historyHints: Map<string, string>): string {
  const e = req.env;
  const l: string[] = [];
  l.push(`Fecha y hora actual: ${req.whenIso}`);
  l.push(`Fecha de los datos oceanográficos cargados: ${req.dataDateIso ?? "no disponible"}`);
  l.push(`Modalidad activa en la app: ${ADVISOR_MODE_LABEL[req.mode]}`);
  l.push(
    req.user
      ? `Posición del pescador: ${req.user.lat.toFixed(5)}, ${req.user.lng.toFixed(5)}`
      : "Posición del pescador: no disponible (GPS apagado)",
  );
  l.push(
    req.hasSearchArea
      ? "Zona de búsqueda (triángulo): definida, el análisis usa solo su interior"
      : "Zona de búsqueda (triángulo): NO definida",
  );
  l.push("");
  l.push("CONDICIONES GENERALES DEL ÁREA (contexto; NO son los valores de cada hotspot):");
  l.push(
    `- Viento: ${e.windKn ?? "n/d"} kn (racha ${e.windGustKn ?? "n/d"} kn) dir ${e.windDirDeg ?? "n/d"}°`,
  );
  l.push(`- Corriente: ${e.currentKn ?? "n/d"} kn hacia ${e.currentDirDeg ?? "n/d"}°`);
  l.push(`- Presión: ${e.pressureHpa ?? "n/d"} hPa (${e.pressureTrend ?? "n/d"})`);
  l.push(`- Temperatura superficie: ${e.sstC ?? "n/d"} °C · fondo: ${e.bottomTempC ?? "n/d"} °C`);
  l.push(`- Clorofila: ${e.chlMgM3 ?? "n/d"} mg/m3 · FSLE activo: ${e.fsleActive ? "sí" : "no"}`);
  l.push(`- Capas activas: ${e.activeLayers.length ? e.activeLayers.join(", ") : "ninguna"}`);
  l.push("");
  if (req.spots.length) {
    l.push(
      "HOTSPOTS CALCULADOS POR LA APP con sus MEDICIONES EXACTAS en esa coordenada (únicas opciones válidas):",
    );
    for (const s of req.spots) {
      const hint = historyHints.get(s.id);
      l.push(
        `- id=${s.id} | Top ${s.rank} | ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)} | puntuación ${s.scorePct}/100 | ` +
          `profundidad ${s.depthM != null ? `${Math.round(s.depthM)} m` : "n/d"} | ` +
          `distancia ${s.distanceNm != null ? `${s.distanceNm.toFixed(1)} nm` : "n/d"} | ` +
          `medido en el punto: ${spotMeasuredLine(s)} | ` +
          (spotMissingFields(s).length
            ? `sin dato en el punto: ${spotMissingFields(s).join(", ")} | `
            : "sin datos faltantes | ") +
          `motivo app: ${s.reason || "n/d"}${hint ? ` | ${hint}` : ""}`,
      );
    }
  } else {
    l.push(
      "Hotspots calculados: NINGUNO todavía. Si el pescador quiere un punto concreto, pide el triángulo de búsqueda (needSearchArea=true).",
    );
  }
  return l.join("\n");
}

export interface AdvisorContext {
  userId: string;
}

export async function runAdvisorChat(
  req: AdvisorChatRequest,
  ctx: AdvisorContext,
): Promise<AdvisorChatResponse> {
  const apiKey = process.env["LOVABLE_API_KEY"];

  const base: AdvisorChatResponse = {
    ok: false,
    answer: null,
    message: null,
    code: null,
    usedToday: 0,
    dailyLimit: ADVISOR_DAILY_LIMIT,
  };

  if (!apiKey) {
    return {
      ...base,
      code: "missing_key",
      message:
        "El servicio de IA no está configurado en el backend. El resto de la app funciona con normalidad.",
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

  const lastUserMsg = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  // Coste controlado: modelo ligero para clientes, modelo potente solo para el admin.
  const MODEL = unlimited ? MODEL_ADMIN : MODEL_USER;

  const bumpUsage = async (errorMessage?: string) => {
    await recordAiUsage(supabaseAdmin, {
      userId: ctx.userId,
      day,
      kind: "chat",
      model: MODEL,
      usage: lastUsage,
      errorMessage,
      usageRow: usageRow ? { id: usageRow.id as string, request_count: usedToday } : null,
      usedToday,
    });
  };

  // Consulta automática de la base de conocimiento y del historial real.
  const [knowledge, catches] = await Promise.all([
    retrieveKnowledge(supabaseAdmin, `${lastUserMsg} ${ADVISOR_MODE_LABEL[req.mode]}`, req.mode),
    loadCatchMemory(supabaseAdmin, ctx.userId, null, 40),
  ]);

  const historyHints = new Map<string, string>();
  for (const s of req.spots) {
    const hint = historyHintFor(s, catches);
    if (hint) historyHints.set(s.id, hint);
  }

  const gateway = createLovableAiGatewayProvider(apiKey, undefined, { structuredOutputs: true });

  // Sin historial: solo la última pregunta del pescador (ahorro de tokens).
  const history = [{ role: "user" as const, content: lastUserMsg.slice(0, 1200) }];

  let answer: AdvisorChatAnswer | null = null;
  try {
    const result = streamText({
      model: gateway(MODEL),
      system: SYSTEM,
      messages: [
        {
          role: "user" as const,
          content:
            `DATOS REALES ACTUALES DE LA APP (contexto, no es un mensaje del pescador):\n${buildContext(req, historyHints)}` +
            `\n\n${knowledgeBlock(knowledge)}` +
            `\n\n${catchMemoryBlock(catches)}`,
        },
        ...history,
      ],
      output: Output.object({ schema: answerSchema }),
      maxOutputTokens: MAX_ANSWER_TOKENS,
    });
    answer = (await result.output) as AdvisorChatAnswer;
    try {
      lastUsage = readUsage(await result.usage);
    } catch {
      /* sin datos de tokens */
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    await bumpUsage(msg);
    const rate = /\b429\b|rate limit|rate_limit|too many requests/i.test(msg);
    const credits = /\b402\b|\b403\b|credits?\b/i.test(msg);
    const parseFail = /no object generated|could not parse|invalid json/i.test(msg);
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
            ? "La IA cortó la respuesta a medias. Prueba a repetir la pregunta de forma más concreta."
            : "No se pudo completar la consulta de IA. Inténtalo de nuevo.",
    };
  }

  if (!answer?.reply) {
    await bumpUsage("respuesta vacía del modelo");
    return {
      ...base,
      code: "provider_error",
      usedToday: usedToday + 1,
      unlimited,
      creditsLeft,
      message: "La IA no devolvió respuesta. Vuelve a intentarlo.",
    };
  }

  // Saneado: los ids deben existir de verdad.
  const validIds = new Set(req.spots.map((s) => s.id));
  if (answer.spotId && !validIds.has(answer.spotId)) answer.spotId = null;
  if (answer.altSpotId && !validIds.has(answer.altSpotId)) answer.altSpotId = null;

  const seen = new Set<string>();
  answer.picks = (answer.picks ?? [])
    .filter((p) => p && validIds.has(p.spotId) && !seen.has(p.spotId) && seen.add(p.spotId))
    .slice(0, 3)
    .map((p, i) => ({
      ...p,
      rank: i + 1,
      radiusM: Math.max(150, Math.min(2000, Number(p.radiusM) || 400)),
      why: String(p.why ?? "").slice(0, 400),
      technique: p.technique ? String(p.technique).slice(0, 200) : null,
      bestHours: p.bestHours ? String(p.bestHours).slice(0, 120) : null,
      drift: Boolean(p.drift) || req.mode === "drift",
    }));

  if (!answer.spotId && answer.picks[0]) answer.spotId = answer.picks[0].spotId;
  if (!answer.altSpotId && answer.picks[1]) answer.altSpotId = answer.picks[1].spotId;

  // Guardarraíl anti «marca tres puntos»: solo se puede pedir zona si el ÚLTIMO
  // mensaje del pescador pide de verdad buscar un sitio o cambiar de zona.
  const t = lastUserMsg.toLowerCase();
  const asksPlace =
    /\b(d[oó]nde|donde|zona|sitio|lugar|punto|puntos|caladero|marca|busca|buscar|b[uú]scame|ll[eé]vame|recomi[eé]nda|recomiendame|recomi[eé]ndame|voy|ir[eé]?|salgo|fondear|mancha|spot)\b/.test(
      t,
    );
  const asksChange =
    /(otra zona|otro sitio|otra parte|cambiar (de )?zona|cambia (de )?zona|nueva zona|otro lugar|borra(r)? (el )?tri[aá]ngulo|nuevo tri[aá]ngulo|otra [aá]rea)/.test(
      t,
    );
  if (!asksChange) answer.changeSearchArea = false;
  if (!asksPlace && !asksChange) answer.needSearchArea = false;
  if (answer.needSearchArea && req.hasSearchArea && !asksChange) answer.needSearchArea = false;
  if (answer.picks.length) answer.needSearchArea = false;

  // Aviso de datos faltantes recalculado con la realidad del hotspot elegido:
  // nunca un "faltan datos" genérico cuando el punto sí tiene lecturas.
  const chosenSpot = req.spots.find((s) => s.id === answer!.spotId) ?? null;
  const missingReal = chosenSpot ? spotMissingFields(chosenSpot) : [];
  answer.missingData =
    chosenSpot == null
      ? null
      : missingReal.length
        ? `Sin dato en el punto: ${missingReal.join(", ")}.`
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

