import { useCallback, useEffect, useMemo, useState } from "react";
import { listAiUsage, type AiUsageReport, type AiUsageUserRow } from "@/lib/ai-usage.functions";
import { Button } from "@/components/ui/button";

const nf = new Intl.NumberFormat("es-ES");
const cf = new Intl.NumberFormat("es-ES", { style: "currency", currency: "USD", maximumFractionDigits: 4 });

function fmtDate(v: string | null) {
  if (!v) return "—";
  return new Date(v).toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toCsv(rows: AiUsageUserRow[]): string {
  const head = ["Email", "Admin", "Preguntas hoy", "Preguntas mes", "Preguntas total", "Tokens mes", "Coste mes (USD)", "Última consulta"];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      r.email,
      r.isAdmin ? "sí" : "no",
      r.questionsToday,
      r.questionsMonth,
      r.questionsTotal,
      r.tokensMonth,
      r.costMonthUsd.toFixed(6),
      r.lastAt ?? "",
    ]
      .map((v) => esc(String(v)))
      .join(","),
  );
  return [head.map(esc).join(","), ...lines].join("\n");
}

/** Panel de administración: consumo de IA por usuario. */
export function AiUsageAdminPanel() {
  const [report, setReport] = useState<AiUsageReport | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await listAiUsage());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo cargar el uso de IA");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const all = report?.users ?? [];
    const term = q.trim().toLowerCase();
    return term ? all.filter((r) => r.email.toLowerCase().includes(term)) : all;
  }, [report, q]);

  const limit = report?.dailyLimit ?? 10;

  const budget = report?.monthlyBudgetUsd ?? 0;
  const spent = report?.totals.costMonthUsd ?? 0;
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  const level: "ok" | "warn" | "danger" | "over" =
    budget <= 0 || pct < 75 ? "ok" : pct < 90 ? "warn" : pct < 100 ? "danger" : "over";

  return (
    <section className="rounded-xl border border-border bg-card p-4 text-card-foreground">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Uso de IA</h2>
          <p className="text-xs text-muted-foreground">
            Consumo por usuario, de mayor a menor. Clientes: {limit} consultas/día · administradores: ilimitado.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
            {loading ? "Cargando…" : "Actualizar"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!rows.length}
            onClick={() => {
              const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "uso-ia.csv";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            CSV
          </Button>
        </div>
      </div>

      {report && level !== "ok" && (
        <div
          role="alert"
          className={
            "mb-3 rounded-lg border p-3 text-sm " +
            (level === "warn"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "border-destructive/40 bg-destructive/10 text-destructive")
          }
        >
          <p className="font-semibold">
            {level === "over"
              ? "Límite de créditos de AI Gateway alcanzado"
              : level === "danger"
                ? "Estás muy cerca del límite de créditos de AI Gateway"
                : "Te acercas al límite de créditos de AI Gateway"}
          </p>
          <p className="mt-1 text-xs">
            Llevas {cf.format(spent)} de {cf.format(budget)} este mes ({pct.toFixed(0)}%).{" "}
            {level === "over"
              ? "Las consultas de IA pueden dejar de funcionar hasta que amplíes el límite en Settings → Plans & credits."
              : "Revisa el consumo por usuario o amplía el límite en Settings → Plans & credits antes de que se bloqueen las consultas."}
          </p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
            <div
              className={
                "h-full rounded-full " + (level === "warn" ? "bg-amber-500" : "bg-destructive")
              }
              style={{ width: `${Math.max(4, pct)}%` }}
            />
          </div>
        </div>
      )}

      {report && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ["Preguntas hoy", nf.format(report.totals.questionsToday)],
            ["Preguntas mes", nf.format(report.totals.questionsMonth)],
            ["Tokens mes", nf.format(report.totals.tokensMonth)],
            [
              "Coste mes (est.)",
              budget > 0
                ? `${cf.format(report.totals.costMonthUsd)} / ${cf.format(budget)}`
                : cf.format(report.totals.costMonthUsd),
            ],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-muted/30 p-2">
              <div className="text-[11px] text-muted-foreground">{label}</div>
              <div className="text-sm font-semibold">{value}</div>
            </div>
          ))}
        </div>
      )}

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Buscar por correo…"
        className="mb-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />

      {err && <p className="mb-2 text-sm text-destructive">{err}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-2 pr-3">Correo</th>
              <th className="py-2 pr-3">Hoy</th>
              <th className="py-2 pr-3">Mes</th>
              <th className="py-2 pr-3">Tokens mes</th>
              <th className="py-2 pr-3">Coste mes (est.)</th>
              <th className="py-2 pr-3">Última</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId} className="border-t border-border/60">
                <td className="py-2 pr-3">
                  {r.email}
                  {r.isAdmin && (
                    <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                      admin · ilimitado
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3">
                  {nf.format(r.questionsToday)}
                  {!r.isAdmin && <span className="text-muted-foreground">/{limit}</span>}
                </td>
                <td className="py-2 pr-3">{nf.format(r.questionsMonth)}</td>
                <td className="py-2 pr-3">{nf.format(r.tokensMonth)}</td>
                <td className="py-2 pr-3">{cf.format(r.costMonthUsd)}</td>
                <td className="py-2 pr-3 text-muted-foreground">{fmtDate(r.lastAt)}</td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-muted-foreground">
                  Sin consumo de IA todavía.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        El coste es una estimación a partir de los tokens y del precio del modelo.
      </p>
    </section>
  );
}

