import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/support")({
  component: SupportPage,
  head: () => ({
    meta: [
      { title: "Soporte · Hotspot Fishing" },
      {
        name: "description",
        content: "Ayuda y contacto de soporte para Hotspot Fishing.",
      },
    ],
  }),
});

function SupportPage() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-3xl font-bold text-foreground">Soporte de Hotspot Fishing</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Si tienes un problema con la app, tu cuenta, el acceso, los mapas o una suscripción,
          puedes contactar con nuestro equipo de soporte.
        </p>

        <section className="mt-6 rounded-xl border border-border bg-card p-5">
          <h2 className="text-lg font-semibold text-foreground">Contacto</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Correo de soporte:
          </p>
          <a
            href="mailto:soporte@hotspotfishing.app"
            className="mt-1 inline-block text-sm font-medium text-primary underline underline-offset-2"
          >
            soporte@hotspotfishing.app
          </a>
        </section>

        <section className="mt-6 rounded-xl border border-border bg-card p-5">
          <h2 className="text-lg font-semibold text-foreground">Ayuda rápida</h2>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>• Problemas para iniciar sesión o recuperar la contraseña.</li>
            <li>• Dudas sobre mapas, batimetría, zonas de pesca o navegación.</li>
            <li>• Problemas con la cuenta o con la eliminación de la cuenta.</li>
            <li>• Consultas sobre suscripciones y acceso a módulos.</li>
          </ul>
        </section>

        <section className="mt-6 rounded-xl border border-border bg-card p-5">
          <h2 className="text-lg font-semibold text-foreground">Eliminar cuenta</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Puedes eliminar tu cuenta desde la propia app, en la sección “Mi cuenta”.
          </p>
          <Link
            to="/cuenta"
            className="mt-3 inline-flex rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary"
          >
            Ir a Mi cuenta
          </Link>
        </section>

        <div className="mt-8 flex gap-4 text-sm">
          <Link to="/" className="text-muted-foreground hover:text-foreground">
            ← Volver al mapa
          </Link>
          <Link to="/privacy" className="text-muted-foreground hover:text-foreground">
            Privacidad
          </Link>
        </div>
      </div>
    </main>
  );
}
