import { useCallback, useEffect, useState } from "react";
import {
  createInviteCode,
  listInviteCodes,
  listInviteRedemptions,
  revokeInviteCode,
  type InviteCodeRow,
  type InviteRedemptionRow,
} from "@/lib/invites.functions";
import { FISHING_MODULES, type ModuleId } from "@/lib/modules";
import { Button } from "@/components/ui/button";

const ALL: ModuleId[] = ["superficie", "fondo", "calamar", "deriva"];

function fmtDate(value: string) {
  return new Date(value).toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function daysLeft(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

/** Panel de administración: generar y gestionar códigos de invitado. */
export function InviteAdminPanel() {
  const [codes, setCodes] = useState<InviteCodeRow[]>([]);
  const [redemptions, setRedemptions] = useState<InviteRedemptionRow[]>([]);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [modules, setModules] = useState<ModuleId[]>(ALL);
  const [days, setDays] = useState(30);
  const [maxUses, setMaxUses] = useState(1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [res, hist] = await Promise.all([listInviteCodes(), listInviteRedemptions()]);
      setCodes(res.codes);
      setRedemptions(hist.redemptions);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudieron cargar los códigos");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);


  const toggle = (id: ModuleId) =>
    setModules((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));

  const generate = async () => {
    setErr(null);
    setBusy(true);
    try {
      const result = await createInviteCode({ data: { modules, days, maxUses, note: note || null } });
      setNote("");
      await load();
      setCopied(result.code);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo crear el código");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (code: string) => {
    setErr(null);
    try {
      await revokeInviteCode({ data: { code } });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo borrar el código");
    }
  };

  const copy = async (code: string) => {
    const text = `${code} — Tu código de acceso a Hotspot Fishing. Entra en Mi cuenta → Código de invitado y actívalo.`;
    let ok = false;
    try {
        await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "Código Hotspot Fishing", text });
        setCopied(code);
        setTimeout(() => setCopied(null), 2000);
        return;
      } catch {
        if (ok) {
          setCopied(code);
          setTimeout(() => setCopied(null), 2000);
          return;
        }
      }
    }
    setCopied(ok ? code : "__fail__");
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <section className="mt-6 rounded-lg border border-border bg-card p-3">
      <h2 className="text-sm font-semibold text-foreground">Códigos de invitado (admin)</h2>

      <div className="mt-3 flex flex-wrap gap-2">
        {FISHING_MODULES.map((m) => (
          <Button
            key={m.id}
            type="button"
            onClick={() => toggle(m.id)}
            variant={modules.includes(m.id) ? "default" : "outline"}
            size="sm"
            className="h-7 rounded-full px-2.5 text-[11px]"
          >
            {m.emoji} {m.name}
          </Button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-[11px] text-muted-foreground">
          Días de acceso
          <input
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="mt-1 block w-24 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>
        <label className="text-[11px] text-muted-foreground">
          Usos máximos
          <input
            type="number"
            min={1}
            max={500}
            value={maxUses}
            onChange={(e) => setMaxUses(Number(e.target.value))}
            className="mt-1 block w-24 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>
        <label className="flex-1 text-[11px] text-muted-foreground">
          Nota (opcional)
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Para quién es"
            className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </label>
        <Button
          type="button"
          onClick={generate}
          disabled={busy || !modules.length}
          size="sm"
        >
          {busy ? "Generando…" : "Generar código"}
        </Button>
      </div>

      {err && <p className="mt-2 text-[11px] text-destructive">{err}</p>}

      <ul className="mt-4 space-y-2">
        {codes.map((c) => {
          const dead = c.uses >= c.max_uses;
          const remaining = Math.max(0, c.max_uses - c.uses);
          const history = redemptions.filter((r) => r.code === c.code);
          const open = openCode === c.code;
          return (
            <li
              key={c.code}
              className="rounded-md border border-border bg-background px-2.5 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-sm text-foreground">{c.code}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {c.modules.join(" · ")} · {c.days} días · {c.uses}/{c.max_uses} usos ·{" "}
                    {dead ? "agotado" : `quedan ${remaining}`}
                    {c.note ? ` · ${c.note}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    type="button"
                    onClick={() => setOpenCode(open ? null : c.code)}
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[10px]"
                  >
                    {open ? "Ocultar" : `Historial (${history.length})`}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => copy(c.code)}
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[10px]"
                  >
                    {copied === c.code
                      ? "Copiado ✓"
                      : copied === "__fail__"
                        ? "No copiado"
                        : "Compartir"}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => revoke(c.code)}
                    variant="destructive"
                    size="sm"
                    className="h-7 px-2 text-[10px]"
                  >
                    Borrar
                  </Button>
                </div>
              </div>
              {open && (
                <ul className="mt-2 space-y-1 border-t border-border pt-2">
                  {history.map((r) => (
                    <li key={r.id} className="text-[10px] text-muted-foreground">
                      <span className="text-foreground">{r.email}</span> · usado el{" "}
                      {fmtDate(r.created_at)} · caduca {fmtDate(r.expires_at)}
                      <br />
                      <span
                        className={
                          r.grant_status === "activa"
                            ? "font-semibold text-primary"
                            : "font-semibold text-destructive"
                        }
                      >
                        {r.grant_status === "activa"
                          ? `Acceso activo · quedan ${daysLeft(r.expires_at)} día${daysLeft(r.expires_at) === 1 ? "" : "s"}`
                          : "Acceso caducado"}
                      </span>{" "}
                      ·{" "}
                      {r.effect === "amplio_acceso"
                        ? "amplió una suscripción de pago"
                        : "activó el acceso (sin suscripción de pago)"}
                      {r.subscription_status
                        ? ` · suscripción: ${r.subscription_status === "canceled" ? "cancelada" : r.subscription_status}`
                        : " · sin suscripción"}
                    </li>
                  ))}
                  {!history.length && (
                    <li className="text-[10px] text-muted-foreground">
                      Nadie ha canjeado este código todavía.
                    </li>
                  )}
                </ul>
              )}

            </li>
          );
        })}

        {!codes.length && (
          <li className="text-[11px] text-muted-foreground">Todavía no has generado códigos.</li>
        )}
      </ul>
    </section>
  );
}

