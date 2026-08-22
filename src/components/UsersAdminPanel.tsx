import { useCallback, useEffect, useMemo, useState } from "react";
import { listRegisteredUsers, type RegisteredUserRow } from "@/lib/users.functions";
import { Button } from "@/components/ui/button";

function fmt(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toCsv(rows: RegisteredUserRow[]): string {
  const head = ["Email", "Nombre", "Embarcación", "Puerto", "Alta", "Último acceso", "Método", "Confirmado"];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      r.email,
      r.full_name ?? "",
      r.boat_name ?? "",
      r.port ?? "",
      r.created_at,
      r.last_sign_in_at ?? "",
      r.provider,
      r.confirmed ? "sí" : "no",
    ]
      .map((v) => esc(String(v)))
      .join(","),
  );
  return [head.map(esc).join(","), ...lines].join("\n");
}

/** Panel de administración: usuarios registrados. */
export function UsersAdminPanel() {
  const [users, setUsers] = useState<RegisteredUserRow[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listRegisteredUsers();
      setUsers(res.users);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudieron cargar los usuarios");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return users;
    return users.filter((u) =>
      [u.email, u.full_name, u.boat_name, u.port].some((v) =>
        (v ?? "").toLowerCase().includes(needle),
      ),
    );
  }, [q, users]);

  const exportCsv = () => {
    const blob = new Blob([toCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hotspot-usuarios-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="mt-6 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          Usuarios registrados{" "}
          <span className="text-xs font-normal text-muted-foreground">({users.length})</span>
        </h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? "Cargando…" : "Actualizar"}
          </Button>
          <Button size="sm" onClick={exportCsv} disabled={!filtered.length}>
            Exportar CSV
          </Button>
        </div>
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Buscar por email, nombre, barco o puerto…"
        className="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
      />

      {err && (
        <p className="mt-3 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {err}
        </p>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[11px]">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3">Email</th>
              <th className="py-1 pr-3">Nombre</th>
              <th className="py-1 pr-3">Embarcación</th>
              <th className="py-1 pr-3">Puerto</th>
              <th className="py-1 pr-3">Alta</th>
              <th className="py-1 pr-3">Último acceso</th>
              <th className="py-1 pr-3">Método</th>
            </tr>
          </thead>
          <tbody className="text-foreground">
            {filtered.map((u) => (
              <tr key={u.id} className="border-t border-border/60">
                <td className="py-1.5 pr-3">
                  {u.email}
                  {!u.confirmed && <span className="ml-1 text-amber-500">· sin confirmar</span>}
                </td>
                <td className="py-1.5 pr-3">{u.full_name ?? "—"}</td>
                <td className="py-1.5 pr-3">{u.boat_name ?? "—"}</td>
                <td className="py-1.5 pr-3">{u.port ?? "—"}</td>
                <td className="py-1.5 pr-3">{fmt(u.created_at)}</td>
                <td className="py-1.5 pr-3">{fmt(u.last_sign_in_at)}</td>
                <td className="py-1.5 pr-3">{u.provider}</td>
              </tr>
            ))}
            {!filtered.length && !loading && (
              <tr>
                <td colSpan={7} className="py-3 text-center text-muted-foreground">
                  Sin resultados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

