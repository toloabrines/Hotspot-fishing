import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/support")({
  component: SupportPage,
  head: () => ({
    meta: [
      { title: "Soporte · Hotspot Fishing" },
      {
        name: "description",
        content: "Contacta con el equipo de soporte de Hotspot Fishing.",
      },
      { property: "og:title", content: "Soporte · Hotspot Fishing" },
      {
        property: "og:description",
        content: "Ayuda y contacto para Hotspot Fishing.",
      },
      { property: "og:url", content: "https://hotspot-fishing.lovable.app/support" },
    ],
    links: [{ rel: "canonical", href: "https://hotspot-fishing.lovable.app/support" }],
  }),
});

function SupportPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <nav className="mb-8 text-sm">
          <Link to="/" className="text-primary hover:underline">
            ← Volver a Hotspot Fishing
          </Link>
        </nav>

        <h1 className="text-3xl font-bold tracking-tight">Soporte de Hotspot Fishing</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Si necesitas ayuda con la app, tus módulos, el acceso a tu cuenta o una incidencia,
          escríbenos y te atenderemos.
        </p>

        <section className="mt-8 rounded-lg border border-border bg-card p-5">
          <h2 className="text-lg font-semibold">Contacto</h2>
          <p className="mt-2 text-sm text-muted-foreground">Correo de soporte:</p>
          <a
            href="mailto:support@hotspotfishing.app"
            className="mt-1 inline-block text-sm font-medium text-primary underline underline-offset-4"
          >
            support@hotspotfishing.app
          </a>
          <p className="mt-4 text-sm text-muted-foreground">
            Para ayudarnos a resolverlo, indica el modelo de tu dispositivo, la versión de la app y
            qué estabas haciendo cuando apareció el problema. No envíes tu contraseña.
          </p>
        </section>

        <section className="mt-6 rounded-lg border border-border bg-card p-5">
          <h2 className="text-lg font-semibold">Account support</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            For help with the app, your modules, account access or a technical issue, email our
            support team. Please include your device model, app version and the steps that caused
            the issue. Never send your password.
          </p>
          <a
            href="mailto:support@hotspotfishing.app"
            className="mt-3 inline-block text-sm font-medium text-primary underline underline-offset-4"
          >
            support@hotspotfishing.app
          </a>
        </section>
      </div>
    </main>
  );
}
