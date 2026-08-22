import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  GUIDE_SECTIONS,
  searchGuide,
  type Block,
  type GuideSection,
} from "@/lib/guide-content";

export const Route = createFileRoute("/guia")({
  head: () => ({
    meta: [
      { title: "Manual completo — Hotspot Fishing" },
      {
        name: "description",
        content:
          "Manual técnico y práctico de Hotspot Fishing: pantallas, capas oceanográficas, algoritmo de puntuación, modos de pesca, exportaciones, FAQ y glosario.",
      },
      { property: "og:title", content: "Manual completo de Hotspot Fishing" },
      {
        property: "og:description",
        content:
          "Documentación definitiva: cada pantalla, cada capa, el algoritmo al detalle, los pesos reales de cada modo de pesca y solución de problemas.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: GuidePage,
});

function GuidePage() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>(GUIDE_SECTIONS[0].id);
  const [showAll, setShowAll] = useState(false);

  const hits = useMemo(() => searchGuide(query), [query]);
  const searching = query.trim().length >= 2;

  const section = GUIDE_SECTIONS.find((s) => s.id === active) ?? GUIDE_SECTIONS[0];

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#050b18] via-[#071629] to-[#0a1a2e] text-slate-100">
      <header className="sticky top-0 z-20 border-b border-cyan-400/10 bg-[#050b18]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link
            to="/"
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            <span aria-hidden>←</span>
            <span>Volver al mapa</span>
          </Link>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/70">
              Manual de la aplicación
            </div>
            <div className="text-[13px] font-semibold text-white">Hotspot Fishing</div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-9">
        <section className="relative overflow-hidden rounded-2xl border border-cyan-400/20 bg-gradient-to-br from-[#0c2747] to-[#071629] p-6 sm:p-8">
          <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-cyan-400/20 blur-3xl" />
          <div className="relative">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/30 bg-cyan-400/10 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-cyan-200">
              <span aria-hidden>📘</span> Documentación oficial · {GUIDE_SECTIONS.length} secciones
            </div>
            <h1 className="mt-4 text-2xl font-bold leading-tight text-white sm:text-3xl">
              Manual completo de Hotspot Fishing
            </h1>
            <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-cyan-50/85">
              Todo lo que hace la aplicación, explicado sin omitir detalle: cada pantalla, cada capa
              de datos, el algoritmo con sus pesos reales, los modos de pesca, las exportaciones, la
              resolución de problemas y el glosario técnico.
            </p>

            <label className="mt-5 flex items-center gap-2 rounded-xl border border-white/15 bg-[#04101f]/80 px-3 py-2 focus-within:border-cyan-300/60">
              <span aria-hidden className="text-cyan-300/80">
                🔎
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar en el manual: FSLE, veril, GPX, rugosidad, calamar…"
                className="w-full bg-transparent text-[13px] text-white placeholder:text-white/35 focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="rounded-md px-2 py-0.5 text-[11px] text-white/50 hover:text-white"
                >
                  Limpiar
                </button>
              )}
            </label>
          </div>
        </section>

        {searching ? (
          <SearchResults
            hits={hits}
            query={query}
            onOpen={(id) => {
              setActive(id);
              setQuery("");
              setShowAll(false);
            }}
          />
        ) : (
          <div className="mt-6 grid gap-6 lg:grid-cols-[260px_1fr]">
            <nav className="lg:sticky lg:top-[68px] lg:self-start">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/45">
                  Índice
                </h2>
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/70 hover:bg-white/10 hover:text-white"
                >
                  {showAll ? "Ver por secciones" : "Ver todo"}
                </button>
              </div>
              <ol className="flex flex-col gap-1">
                {GUIDE_SECTIONS.map((s) => {
                  const isActive = !showAll && s.id === active;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setActive(s.id);
                          setShowAll(false);
                          if (typeof window !== "undefined") window.scrollTo({ top: 0 });
                        }}
                        className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors ${
                          isActive
                            ? "border-cyan-300/50 bg-cyan-400/15 text-cyan-100"
                            : "border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
                        }`}
                      >
                        <span aria-hidden>{s.icon}</span>
                        <span>
                          <span className="text-white/40">{s.number}. </span>
                          {s.title}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </nav>

            <div className="min-w-0 space-y-8">
              {(showAll ? GUIDE_SECTIONS : [section]).map((s) => (
                <SectionView key={s.id} section={s} />
              ))}

              {!showAll && (
                <div className="flex justify-between gap-2 pt-2">
                  <NavButton
                    section={GUIDE_SECTIONS[GUIDE_SECTIONS.findIndex((s) => s.id === section.id) - 1]}
                    dir="prev"
                    onClick={setActive}
                  />
                  <NavButton
                    section={GUIDE_SECTIONS[GUIDE_SECTIONS.findIndex((s) => s.id === section.id) + 1]}
                    dir="next"
                    onClick={setActive}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function NavButton({
  section,
  dir,
  onClick,
}: {
  section?: GuideSection;
  dir: "prev" | "next";
  onClick: (id: string) => void;
}) {
  if (!section) return <span />;
  return (
    <button
      type="button"
      onClick={() => {
        onClick(section.id);
        if (typeof window !== "undefined") window.scrollTo({ top: 0 });
      }}
      className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-white/75 hover:bg-white/10 hover:text-white"
    >
      {dir === "prev" ? "← " : ""}
      {section.number}. {section.title}
      {dir === "next" ? " →" : ""}
    </button>
  );
}

function SearchResults({
  hits,
  query,
  onOpen,
}: {
  hits: ReturnType<typeof searchGuide>;
  query: string;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="mt-6 space-y-3">
      <p className="text-[12px] text-white/50">
        {hits.length === 0
          ? `Sin resultados para “${query}”.`
          : `${hits.length} sección(es) con “${query}”.`}
      </p>
      {hits.map((h) => (
        <button
          key={h.section.id}
          type="button"
          onClick={() => onOpen(h.section.id)}
          className="block w-full rounded-xl border border-white/10 bg-white/5 p-4 text-left transition-colors hover:border-cyan-300/40 hover:bg-white/10"
        >
          <div className="text-[13px] font-semibold text-cyan-100">
            {h.section.icon} {h.section.number}. {h.section.title}
          </div>
          <div className="mt-1 text-[12px] text-white/55">{h.section.summary}</div>
          <ul className="mt-2 space-y-1">
            {h.snippets.map((s, i) => (
              <li key={i} className="text-[11.5px] leading-relaxed text-white/70">
                …{s}…
              </li>
            ))}
          </ul>
        </button>
      ))}
    </div>
  );
}

function SectionView({ section }: { section: GuideSection }) {
  return (
    <section id={section.id} className="scroll-mt-20">
      <header className="border-b border-white/10 pb-3">
        <div className="text-[11px] uppercase tracking-wider text-cyan-300/70">
          Sección {section.number}
        </div>
        <h2 className="mt-1 text-xl font-bold text-white sm:text-2xl">
          <span aria-hidden className="mr-2">
            {section.icon}
          </span>
          {section.title}
        </h2>
        <p className="mt-1 text-[13px] text-white/60">{section.summary}</p>
      </header>
      <div className="mt-4 space-y-4">
        {section.blocks.map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
      </div>
    </section>
  );
}

function BlockView({ block, depth = 0 }: { block: Block; depth?: number }) {
  switch (block.kind) {
    case "text":
      return <p className="text-[13.5px] leading-relaxed text-slate-200/90">{block.text}</p>;

    case "list":
      return (
        <div>
          {block.title && (
            <h4 className="mb-1.5 text-[12.5px] font-semibold text-cyan-200">{block.title}</h4>
          )}
          {block.ordered ? (
            <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-slate-200/90 marker:text-cyan-300/70">
              {block.items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ol>
          ) : (
            <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-slate-200/90 marker:text-cyan-300/70">
              {block.items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ul>
          )}
        </div>
      );

    case "table":
      return (
        <figure className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03]">
          <table className="w-full min-w-[520px] border-collapse text-left text-[12.5px]">
            <thead>
              <tr className="bg-white/[0.06]">
                {block.head.map((h, i) => (
                  <th key={i} className="px-3 py-2 font-semibold text-cyan-100">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i} className="border-t border-white/8">
                  {r.map((c, j) => (
                    <td key={j} className="px-3 py-2 align-top text-slate-200/85">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {block.caption && (
            <figcaption className="border-t border-white/10 px-3 py-2 text-[11.5px] text-white/50">
              {block.caption}
            </figcaption>
          )}
        </figure>
      );

    case "note": {
      const tones = {
        info: "border-sky-300/30 bg-sky-400/10 text-sky-100",
        warn: "border-amber-300/30 bg-amber-400/10 text-amber-100",
        tip: "border-emerald-300/30 bg-emerald-400/10 text-emerald-100",
      } as const;
      const icon = block.tone === "warn" ? "⚠️" : block.tone === "tip" ? "💡" : "ℹ️";
      return (
        <div className={`rounded-xl border p-3 text-[12.5px] leading-relaxed ${tones[block.tone]}`}>
          <span aria-hidden className="mr-1.5">
            {icon}
          </span>
          {block.title && <strong className="mr-1">{block.title}:</strong>}
          {block.text}
        </div>
      );
    }

    case "diagram":
      return (
        <figure className="rounded-xl border border-cyan-400/20 bg-[#04101f]/80 p-3">
          <figcaption className="mb-2 text-[12px] font-semibold text-cyan-200">
            {block.title}
          </figcaption>
          <pre className="overflow-x-auto whitespace-pre font-mono text-[11px] leading-[1.45] text-cyan-50/85">
            {block.art}
          </pre>
          {block.legend && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-white/55">{block.legend}</p>
          )}
        </figure>
      );

    case "faq":
      return (
        <div className="space-y-2">
          {block.items.map((it, i) => (
            <details
              key={i}
              className="group rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2"
            >
              <summary className="cursor-pointer list-none text-[13px] font-medium text-cyan-100 marker:hidden">
                <span aria-hidden className="mr-1.5 text-white/40 group-open:hidden">
                  ▸
                </span>
                <span aria-hidden className="mr-1.5 hidden text-white/40 group-open:inline">
                  ▾
                </span>
                {it.q}
              </summary>
              <p className="mt-2 text-[12.5px] leading-relaxed text-slate-200/85">{it.a}</p>
            </details>
          ))}
        </div>
      );

    case "sub":
      return (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <h3
            className={`mb-3 font-semibold text-white ${depth > 0 ? "text-[13px]" : "text-[15px]"}`}
          >
            {block.title}
          </h3>
          <div className="space-y-3">
            {block.blocks.map((b, i) => (
              <BlockView key={i} block={b} depth={depth + 1} />
            ))}
          </div>
        </div>
      );
  }
}

