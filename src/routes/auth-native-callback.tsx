import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth-native-callback")({
  component: NativeAuthCallbackPage,
  head: () => ({
    meta: [
      { title: "Completando acceso · Hotspot Fishing" },
      { name: "description", content: "Finalizando el acceso seguro a Hotspot Fishing." },
    ],
  }),
});

function NativeAuthCallbackPage() {
  const [message, setMessage] = useState("Completando el acceso…");

  useEffect(() => {
    let done = false;

    const returnToApp = (accessToken: string, refreshToken: string) => {
      if (done) return;
      done = true;
      const url =
        "hotspotfishing://auth/callback#access_token=" +
        encodeURIComponent(accessToken) +
        "&refresh_token=" +
        encodeURIComponent(refreshToken);
      window.location.href = url;
    };

    const trySession = async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        setMessage("No se pudo completar el acceso. Puedes cerrar esta ventana e intentarlo de nuevo.");
        return;
      }
      if (data.session) {
        returnToApp(data.session.access_token, data.session.refresh_token);
      }
    };

    void trySession();

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) returnToApp(session.access_token, session.refresh_token);
    });

    const timeout = window.setTimeout(() => {
      if (!done) {
        setMessage("El acceso está tardando más de lo esperado. Puedes cerrar esta ventana e intentarlo de nuevo.");
      }
    }, 15000);

    return () => {
      window.clearTimeout(timeout);
      authListener.subscription.unsubscribe();
    };
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 text-center shadow-lg">
        <h1 className="text-xl font-bold text-foreground">Hotspot Fishing</h1>
        <p className="mt-3 text-sm text-muted-foreground">{message}</p>
      </div>
    </main>
  );
}
