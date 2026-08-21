import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "../integrations/supabase/client";
import { lovable } from "../integrations/lovable";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
  head: () => ({
    meta: [
      { title: "Iniciar sesión · Hotspot Fishing" },
      { name: "description", content: "Accede para guardar tus waypoints en la nube" },
    ],
  }),
});

function AuthPage() {
  const navigate = useNavigate();
  // Por defecto mostramos "Crear cuenta": la primera acción al llegar a la app
  // es registrarse (7 días gratis). Quien ya tenga cuenta usa el enlace inferior.
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [boatName, setBoatName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Si ya hay sesión, vuelve al mapa.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/" });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session) navigate({ to: "/" });
    });
    return () => sub.subscription.unsubscribe();
  }, [navigate]);

  const translateError = (message: string): string => {
    const m = message.toLowerCase();
    if (m.includes("weak") || m.includes("pwned"))
      return "Esa contraseña es demasiado común y ha aparecido en filtraciones. Usa una más larga y única (mín. 8 caracteres, mezcla letras, números y símbolos).";
    if (m.includes("invalid login credentials"))
      return "Email o contraseña incorrectos. Si creaste la cuenta con Google, entra con el botón «Continuar con Google».";
    if (m.includes("already registered") || m.includes("user already"))
      return "Ya existe una cuenta con este email. Inicia sesión o entra con Google.";
    if (m.includes("email not confirmed"))
      return "Tienes que confirmar tu email antes de entrar. Revisa tu bandeja de entrada.";
    if (m.includes("password should be at least"))
      return "La contraseña debe tener al menos 6 caracteres.";
    return message;
  };

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setLoading(true);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin,
            data: {
              full_name: fullName.trim().slice(0, 100),
              boat_name: boatName.trim().slice(0, 100),
            },
          },
        });
        if (error) throw error;
        // Supabase devuelve un usuario "vacío" (sin identities) si el email ya existe.
        if (data.user && data.user.identities && data.user.identities.length === 0) {
          setErr(
            "Ya existe una cuenta con este email. Inicia sesión con tu contraseña o con Google.",
          );
          setMode("signin");
          return;
        }
        setMsg("Cuenta creada. Revisa tu email para confirmar tu dirección.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (e) {
      setErr(translateError(e instanceof Error ? e.message : "Error desconocido"));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    setErr(null);
    setMsg(null);
    if (!email.trim()) {
      setErr("Escribe tu email arriba y vuelve a pulsar «¿Has olvidado tu contraseña?».");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setMsg(
        "Te hemos enviado un email con un enlace para crear una contraseña nueva. Revisa también la carpeta de spam.",
      );
    } catch (e) {
      setErr(translateError(e instanceof Error ? e.message : "Error desconocido"));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setErr(null);
    setLoading(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if (result.error) {
        setErr(result.error.message || "Error al iniciar sesión con Google");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg">
        <h1 className="text-xl font-bold text-foreground">
          {mode === "signin" ? "Iniciar sesión" : "Crear cuenta"}
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Descubre las mejores zonas de pesca con datos profesionales en tiempo real.
        </p>
        <p className="mt-2 rounded-md border border-primary/30 bg-primary/10 px-2 py-1.5 text-[11px] font-medium text-primary">
          🎁 7 días gratis al crear cuenta. Sin tarjeta. Cancela cuando quieras.
        </p>

        <button
          type="button"
          onClick={handleGoogle}
          disabled={loading}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-60"
        >
          <svg className="h-4 w-4" viewBox="0 0 48 48" aria-hidden="true">
            <path
              fill="#FFC107"
              d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
            />
            <path
              fill="#FF3D00"
              d="M6.3 14.7l6.6 4.8C14.6 16.1 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
            />
            <path
              fill="#4CAF50"
              d="M24 44c5.2 0 9.8-2 13.3-5.2l-6.1-5.2C29.2 35 26.7 36 24 36c-5.3 0-9.7-3.1-11.3-7.9l-6.5 5C9.6 39.6 16.2 44 24 44z"
            />
            <path
              fill="#1976D2"
              d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.2 5.6l6.1 5.2C40.9 35.6 44 30.3 44 24c0-1.3-.1-2.4-.4-3.5z"
            />
          </svg>
          Continuar con Google
        </button>

        <div className="my-4 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          o con email
          <span className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={handleEmail} className="flex flex-col gap-3">
          {mode === "signup" && (
            <>
              <input
                type="text"
                required
                maxLength={100}
                autoComplete="name"
                placeholder="Nombre y apellidos"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              />
              <input
                type="text"
                maxLength={100}
                placeholder="Embarcación (opcional)"
                value={boatName}
                onChange={(e) => setBoatName(e.target.value)}
                className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              />
            </>
          )}
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="email@ejemplo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
          <input
            type="password"
            required
            minLength={8}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            placeholder="Contraseña (mín. 8 caracteres)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {loading ? "Procesando…" : mode === "signin" ? "Entrar" : "Crear cuenta"}
          </button>
        </form>

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

        <button
          type="button"
          onClick={handleReset}
          disabled={loading}
          className="mt-3 w-full text-center text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
        >
          ¿Has olvidado tu contraseña?
        </button>

        <button
          type="button"
          onClick={() => {
            setErr(null);
            setMsg(null);
            setMode(mode === "signin" ? "signup" : "signin");
          }}
          className="mt-4 w-full text-center text-[11px] text-muted-foreground hover:text-foreground"
        >
          {mode === "signin" ? "¿No tienes cuenta? Crear una" : "¿Ya tienes cuenta? Iniciar sesión"}
        </button>

        <div className="mt-4 text-center">
          <Link to="/" className="text-[11px] text-muted-foreground hover:text-foreground">
            ← Volver al mapa
          </Link>
        </div>
      </div>
    </main>
  );
}

