import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
  head: () => ({
    meta: [
      { title: "Nueva contraseña · Hotspot Fishing" },
      {
        name: "description",
        content: "Define una contraseña nueva para tu cuenta de Hotspot Fishing.",
      },
      { property: "og:title", content: "Nueva contraseña · Hotspot Fishing" },
      {
        property: "og:description",
        content: "Restablece el acceso a tu cuenta de Hotspot Fishing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // El enlace del email puede llegar de tres formas: tokens en el hash,
  // ?code= (PKCE) o ?token_hash=&type=recovery. Las procesamos todas.
  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      try {
        const url = new URL(window.location.href);
        const hash = new URLSearchParams(url.hash.replace(/^#/, ""));

        const hashError = hash.get("error_description") || url.searchParams.get("error_description");
        if (hashError) setErr(decodeURIComponent(hashError));

        const access_token = hash.get("access_token");
        const refresh_token = hash.get("refresh_token");
        const code = url.searchParams.get("code");
        const tokenHash = url.searchParams.get("token_hash") || url.searchParams.get("token");
        const type = url.searchParams.get("type");

        if (access_token && refresh_token) {
          await supabase.auth.setSession({ access_token, refresh_token });
        } else if (code) {
          await supabase.auth.exchangeCodeForSession(code);
        } else if (tokenHash && (type === "recovery" || !type)) {
          await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
        }
      } catch {
        /* se refleja abajo con ready=false */
      }

      const { data } = await supabase.auth.getSession();
      if (!cancelled) setReady(Boolean(data.session));
    };

    void boot();

    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session) setReady(true);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);


  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    if (password !== repeat) {
      setErr("Las contraseñas no coinciden.");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setMsg("Contraseña actualizada. Entrando…");
      setTimeout(() => navigate({ to: "/", replace: true }), 1200);
    } catch (e2) {
      const m = e2 instanceof Error ? e2.message : "Error desconocido";
      setErr(
        m.toLowerCase().includes("weak") || m.toLowerCase().includes("pwned")
          ? "Esa contraseña es demasiado común. Usa una más larga y única."
          : m,
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg">
        <h1 className="text-xl font-bold text-foreground">Nueva contraseña</h1>
        {!ready ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Abre esta página desde el enlace que te hemos enviado por email. Si ha caducado, pide
            uno nuevo desde «¿Has olvidado tu contraseña?».
          </p>
        ) : (
          <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="Nueva contraseña (mín. 8 caracteres)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="Repite la contraseña"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {loading ? "Guardando…" : "Guardar contraseña"}
            </button>
          </form>
        )}

        {err && (
          <p className="mt-3 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            {err}
          </p>
        )}
        {msg && (
          <p className="mt-3 rounded border border-primary/40 bg-primary/10 px-2 py-1.5 text-[11px] text-primary">
            {msg}
          </p>
        )}

        <div className="mt-4 text-center">
          <Link to="/auth" className="text-[11px] text-muted-foreground hover:text-foreground">
            ← Volver a iniciar sesión
          </Link>
        </div>
      </div>
    </main>
  );
}

