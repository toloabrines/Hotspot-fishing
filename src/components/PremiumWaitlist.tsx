import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface PremiumWaitlistProps {
  onClose: () => void;
}

export function PremiumWaitlist({ onClose }: PremiumWaitlistProps) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (!emailRegex.test(trimmed) || trimmed.length > 254) {
      setStatus("error");
      setErrorMsg("Introduce un email válido");
      return;
    }

    setStatus("loading");
    const { error } = await supabase
      .from("waitlist")
      .insert({ email: trimmed, source: "premium_modal" });

    if (error) {
      if (error.code === "23505") {
        setStatus("success");
      } else {
        setStatus("error");
        setErrorMsg("No se pudo guardar. Inténtalo de nuevo.");
      }
      return;
    }
    setStatus("success");
  };

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-panel/95 p-6 shadow-2xl backdrop-blur-md">
        <button
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Cerrar"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="mb-4 flex items-center gap-2">
          <span className="text-2xl">🌊</span>
          <h2 className="text-lg font-bold text-foreground">Hotspot Fishing Premium</h2>
          <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent-foreground">
            Próximamente
          </span>
        </div>

        <p className="mb-4 text-sm text-muted-foreground">
          Combina capas oceánicas (SST + clorofila + altimetría) en una misma vista para encontrar
          zonas de pesca, planificar rutas y analizar fenómenos marinos.
        </p>

        <ul className="mb-5 space-y-2 text-xs text-foreground">
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-accent">✓</span>
            <span>Modo multi-capa con superposición</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-accent">✓</span>
            <span>Sin marca de agua ni anuncios</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-accent">✓</span>
            <span>Acceso anticipado y precio reducido</span>
          </li>
        </ul>

        {status === "success" ? (
          <div className="rounded-lg border border-accent/40 bg-accent/10 p-4 text-center">
            <div className="mb-1 text-2xl">🎉</div>
            <p className="text-sm font-semibold text-foreground">¡Estás dentro!</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Te avisaremos por email cuando Premium esté listo.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-2">
            <input
              type="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (status === "error") setStatus("idle");
              }}
              placeholder="tu@email.com"
              disabled={status === "loading"}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none disabled:opacity-60"
            />
            {status === "error" && <p className="text-xs text-destructive">{errorMsg}</p>}
            <button
              type="submit"
              disabled={status === "loading"}
              className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {status === "loading" ? "Guardando…" : "Apuntarme a la lista"}
            </button>
            <p className="text-center text-[10px] text-muted-foreground">
              Sin spam. Solo un aviso cuando Premium esté disponible.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

