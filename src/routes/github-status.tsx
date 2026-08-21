import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { CheckCircle2, XCircle, Github, GitBranch, ExternalLink, Loader2 } from "lucide-react";

export const Route = createFileRoute("/github-status")({
  head: () => ({
    meta: [
      { title: "Estado de GitHub · Hotspot Fishing" },
      {
        name: "description",
        content: "Verifica la conexión del proyecto con GitHub y la rama activa.",
      },
    ],
  }),
  component: GitHubStatusPage,
  errorComponent: ({ error }) => (
    <div className="min-h-screen flex items-center justify-center p-6 text-center">
      <p className="text-red-600">Error: {error.message}</p>
    </div>
  ),
  notFoundComponent: () => <div className="p-6">No encontrado</div>,
});

type RepoCheck = {
  status: "idle" | "checking" | "connected" | "not_found" | "error";
  owner?: string;
  repo?: string;
  branch?: string;
  message?: string;
};

function GitHubStatusPage() {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [result, setResult] = useState<RepoCheck>({ status: "idle" });

  const expectedFiles = ["ios/", "capacitor.config.ts", "TESTFLIGHT_SIMPLE.md"];

  async function checkRepo(e: React.FormEvent) {
    e.preventDefault();
    if (!owner.trim() || !repo.trim()) return;
    setResult({ status: "checking" });
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
      if (res.status === 404) {
        setResult({ status: "not_found", message: "Repositorio no encontrado o privado." });
        return;
      }
      if (!res.ok) {
        setResult({ status: "error", message: `Error ${res.status}` });
        return;
      }
      const data = await res.json();
      setResult({
        status: "connected",
        owner: data.owner?.login,
        repo: data.name,
        branch: data.default_branch,
      });
    } catch (err) {
      setResult({ status: "error", message: (err as Error).message });
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="max-w-xl mx-auto space-y-6">
        <header className="text-center">
          <Github className="w-10 h-10 mx-auto mb-2 text-slate-700" />
          <h1 className="text-2xl font-bold text-slate-900">Estado de GitHub</h1>
          <p className="text-sm text-slate-600 mt-1">
            Comprueba si tu proyecto está sincronizado con GitHub.
          </p>
        </header>

        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h2 className="font-semibold text-slate-900 mb-3">Verificar repositorio</h2>
          <form onSubmit={checkRepo} className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="usuario u organización"
                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
              <span className="self-center text-slate-400">/</span>
              <input
                type="text"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="nombre-repo"
                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={result.status === "checking"}
              className="w-full bg-slate-900 text-white py-2 rounded-lg font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {result.status === "checking" ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Comprobando…
                </>
              ) : (
                "Comprobar conexión"
              )}
            </button>
          </form>

          {result.status === "connected" && (
            <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center gap-2 text-green-800 font-semibold">
                <CheckCircle2 className="w-5 h-5" /> Conectado
              </div>
              <dl className="mt-3 text-sm text-slate-700 space-y-1">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Repositorio</dt>
                  <dd className="font-mono">
                    {result.owner}/{result.repo}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500 flex items-center gap-1">
                    <GitBranch className="w-3.5 h-3.5" /> Rama
                  </dt>
                  <dd className="font-mono">{result.branch}</dd>
                </div>
              </dl>
              <a
                href={`https://github.com/${result.owner}/${result.repo}/tree/${result.branch}`}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
              >
                Abrir en GitHub <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          )}

          {(result.status === "not_found" || result.status === "error") && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 text-sm text-red-800">
              <XCircle className="w-5 h-5 mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">No se pudo verificar</p>
                <p className="text-red-700">{result.message}</p>
              </div>
            </div>
          )}
        </section>

        <section className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h2 className="font-semibold text-slate-900 mb-2">
            Archivos que deben estar sincronizados
          </h2>
          <ul className="text-sm text-slate-700 space-y-1">
            {expectedFiles.map((f) => (
              <li key={f} className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                <span className="font-mono">{f}</span>
              </li>
            ))}
          </ul>
          {result.status === "connected" && (
            <a
              href={`https://github.com/${result.owner}/${result.repo}/tree/${result.branch}/ios`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
            >
              Ver carpeta ios/ en GitHub <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </section>

        <section className="bg-blue-50 border border-blue-200 rounded-xl p-5 text-sm text-blue-900">
          <p className="font-semibold mb-1">¿Aún no está conectado?</p>
          <p>
            En Lovable, abre el menú <b>+</b> del chat → <b>GitHub</b> → <b>Conectar proyecto</b>.
            Los cambios se sincronizan automáticamente con la rama{" "}
            <code className="font-mono">main</code>.
          </p>
        </section>

        <div className="text-center">
          <Link to="/" className="text-sm text-slate-500 hover:underline">
            ← Volver al inicio
          </Link>
        </div>
      </div>
    </main>
  );
}

