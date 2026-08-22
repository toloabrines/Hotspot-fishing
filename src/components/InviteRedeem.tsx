import { useState } from "react";
import { redeemInviteCode } from "@/lib/invites.functions";
import type { ModuleId } from "@/lib/modules";
import { moduleById } from "@/lib/modules";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

interface Props {
  grants: { id: string; code: string; modules: string[]; expires_at: string }[];
  onRedeemed: () => void;
}

/** Canje de códigos de invitado (acceso temporal sin pagar). */
export function InviteRedeem({ grants, onRedeemed }: Props) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const res = await redeemInviteCode({ data: { code } });
      const names = res.modules
        .map((m) => moduleById(m as ModuleId)?.name ?? m)
        .join(", ");
      setMsg(`¡Código activado! ${names} hasta el ${fmtDate(res.expiresAt)}.`);
      setCode("");
      onRedeemed();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "No se pudo canjear el código");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 rounded-lg border border-border bg-card p-3">
      <h2 className="text-sm font-semibold text-foreground">Código de invitado</h2>
      <p className="mt-1 text-[11px] text-muted-foreground">
        ¿Tienes un código? Actívalo aquí para desbloquear módulos durante un tiempo limitado.
      </p>
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABCDE-12345"
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm uppercase tracking-wider text-foreground"
        />
        <button
          type="submit"
          disabled={busy || code.trim().length < 4}
          className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Activando…" : "Activar"}
        </button>
      </form>
      {msg && <p className="mt-2 text-[11px] font-medium text-primary">{msg}</p>}
      {err && <p className="mt-2 text-[11px] text-destructive">{err}</p>}

      {grants.length > 0 && (
        <ul className="mt-3 space-y-1">
          {grants.map((g) => (
            <li key={g.id} className="text-[11px] text-muted-foreground">
              <span className="font-mono text-foreground">{g.code}</span> ·{" "}
              {g.modules.map((m) => moduleById(m as ModuleId)?.name ?? m).join(", ")} · hasta el{" "}
              {fmtDate(g.expires_at)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

