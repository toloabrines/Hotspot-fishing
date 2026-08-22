/**
 * Recuperación de conocimiento pesquero para el asistente (solo servidor).
 *
 * Combina dos fuentes:
 *  1. La base incluida en la app (src/lib/fishing-knowledge.ts).
 *  2. Los documentos que el administrador añade en `public.ai_knowledge_docs`,
 *     que se pueden ampliar en caliente sin reconstruir la aplicación.
 *
 * La búsqueda es por coincidencia de palabras clave (título, especies, etiquetas
 * y contenido) más un empujón por modalidad activa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { FISHING_KNOWLEDGE, normalizeText, type KnowledgeDoc } from "./fishing-knowledge";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>;

export interface KnowledgeHit {
  title: string;
  category: string;
  reviewedOn: string;
  source: string | null;
  content: string;
  score: number;
}

const STOP = new Set([
  "para","donde","como","cual","cuales","que","con","los","las","del","una","uno","por","muy",
  "hoy","mañana","ahora","este","esta","esto","hay","son","ser","tengo","quiero","puedo","dime",
  "voy","ir","sobre","mas","menos","bien","mejor","zona","pesca","pescar","pescado",
]);

function tokens(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
}

function scoreDoc(doc: KnowledgeDoc, qTokens: string[], mode: string): number {
  const hay = normalizeText(
    `${doc.title} ${doc.species.join(" ")} ${doc.tags.join(" ")} ${doc.category} ${doc.content}`,
  );
  const title = normalizeText(`${doc.title} ${doc.species.join(" ")} ${doc.tags.join(" ")}`);
  let s = 0;
  for (const t of qTokens) {
    if (title.includes(t)) s += 4;
    else if (hay.includes(t)) s += 1.5;
  }
  if (doc.modes.includes(mode as KnowledgeDoc["modes"][number])) s += 2;
  if (doc.modes.includes("any")) s += 0.5;
  // La normativa se adjunta siempre que se pregunte por tallas/legalidad.
  return s;
}

async function loadDbDocs(client: AnyClient): Promise<KnowledgeDoc[]> {
  try {
    const { data, error } = await client
      .from("ai_knowledge_docs")
      .select("id, title, category, species, modes, tags, content, source, reviewed_on")
      .eq("is_active", true)
      .limit(400);
    if (error || !data) return [];
    return data.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      category: String(r.category) as KnowledgeDoc["category"],
      species: (r.species ?? []) as string[],
      modes: (r.modes ?? []) as KnowledgeDoc["modes"],
      tags: (r.tags ?? []) as string[],
      content: String(r.content),
      reviewedOn: r.reviewed_on ? String(r.reviewed_on) : "sin fecha",
      source: r.source ? String(r.source) : undefined,
    }));
  } catch {
    return [];
  }
}

/** Devuelve los documentos más relevantes para la consulta. */
export async function retrieveKnowledge(
  client: AnyClient,
  query: string,
  mode: string,
  limit = 6,
): Promise<KnowledgeHit[]> {
  const qTokens = tokens(query);
  const dbDocs = await loadDbDocs(client);
  const all = [...FISHING_KNOWLEDGE, ...dbDocs];

  const asksRules = /talla|legal|normativ|permit|licenc|veda|cupo|prohib/.test(normalizeText(query));

  const scored = all
    .map((d) => ({
      d,
      score: scoreDoc(d, qTokens, mode) + (asksRules && d.category === "normativa" ? 10 : 0),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ d, score }) => ({
    title: d.title,
    category: d.category,
    reviewedOn: d.reviewedOn,
    source: d.source ?? null,
    content: d.content.slice(0, 1800),
    score,
  }));
}

/** Bloque de texto listo para el prompt. */
export function knowledgeBlock(hits: KnowledgeHit[]): string {
  if (!hits.length) return "Base de conocimiento: sin documentos relevantes para esta pregunta.";
  return [
    "BASE DE CONOCIMIENTO DE PESCA (criterio general, NO son datos medidos):",
    ...hits.map(
      (h) =>
        `### ${h.title} [${h.category}] (revisado ${h.reviewedOn}${h.source ? `, fuente: ${h.source}` : ""})\n${h.content}`,
    ),
  ].join("\n\n");
}

