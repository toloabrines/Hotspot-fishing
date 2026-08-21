import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — Hotspot Fishing" },
      {
        name: "description",
        content: "Privacy Policy for Hotspot Fishing / Política de Privacidad de Hotspot Fishing.",
      },
      { property: "og:title", content: "Privacy Policy — Hotspot Fishing" },
      {
        property: "og:description",
        content: "Privacy Policy for Hotspot Fishing / Política de Privacidad de Hotspot Fishing.",
      },
      { property: "og:url", content: "https://hotspot-fishing.lovable.app/privacy" },
    ],
    links: [{ rel: "canonical", href: "https://hotspot-fishing.lovable.app/privacy" }],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  const lastUpdated = "June 5, 2026";
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <nav className="mb-8 text-sm">
          <Link to="/" className="text-primary hover:underline">
            ← Home
          </Link>
        </nav>

        <header className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight">Privacy Policy</h1>
          <p className="mt-2 text-muted-foreground">
            Hotspot Fishing — Last updated: {lastUpdated}
          </p>
        </header>

        {/* English */}
        <section className="prose prose-invert max-w-none">
          <h2 className="text-2xl font-semibold mt-8 mb-4">English</h2>

          <h3 className="text-xl font-semibold mt-6 mb-2">1. Introduction</h3>
          <p className="mb-4">
            This Privacy Policy describes how Hotspot Fishing ("we", "us", or "the App") collects,
            uses, and protects your information when you use our mobile and web application.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">2. Information We Collect</h3>
          <ul className="list-disc pl-6 mb-4 space-y-1">
            <li>
              <strong>Location data:</strong> with your permission, to display your position on the
              map and provide nearby fishing information.
            </li>
            <li>
              <strong>Saved waypoints and preferences:</strong> stored locally on your device or in
              your account if you sign in.
            </li>
            <li>
              <strong>Technical data:</strong> device type, OS version, and anonymous usage logs to
              improve stability.
            </li>
          </ul>

          <h3 className="text-xl font-semibold mt-6 mb-2">3. How We Use Your Information</h3>
          <p className="mb-4">
            We use the information to operate the App, display oceanographic maps, save your fishing
            spots, and improve the user experience. We do not sell your personal data.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">4. Data Sharing</h3>
          <p className="mb-4">
            We do not share personal information with third parties except when required by law or
            to operate essential services (e.g., map and tile providers) under their own privacy
            policies.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">5. Data Security</h3>
          <p className="mb-4">
            We apply reasonable technical and organizational measures to protect your information.
            No method of transmission over the Internet is 100% secure.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">6. Your Rights</h3>
          <p className="mb-4">
            You may request access, correction, or deletion of your personal data, and withdraw
            location permissions at any time from your device settings.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">7. Children's Privacy</h3>
          <p className="mb-4">
            The App is not directed to children under 13. We do not knowingly collect personal
            information from them.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">8. Changes to this Policy</h3>
          <p className="mb-4">
            We may update this Policy from time to time. The "Last updated" date above reflects the
            latest revision.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">9. Contact</h3>
          <p className="mb-4">
            For questions about this Privacy Policy, contact us at{" "}
            <a href="mailto:support@hotspotfishing.app" className="text-primary hover:underline">
              support@hotspotfishing.app
            </a>
            .
          </p>
        </section>

        <hr className="my-12 border-border" />

        {/* Spanish */}
        <section className="prose prose-invert max-w-none">
          <h2 className="text-2xl font-semibold mt-8 mb-4">Español</h2>

          <h3 className="text-xl font-semibold mt-6 mb-2">1. Introducción</h3>
          <p className="mb-4">
            Esta Política de Privacidad describe cómo Hotspot Fishing ("nosotros" o "la App")
            recopila, utiliza y protege tu información cuando usas nuestra aplicación móvil y web.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">2. Información que Recopilamos</h3>
          <ul className="list-disc pl-6 mb-4 space-y-1">
            <li>
              <strong>Datos de ubicación:</strong> con tu permiso, para mostrar tu posición en el
              mapa y ofrecerte información de pesca cercana.
            </li>
            <li>
              <strong>Waypoints y preferencias guardadas:</strong> almacenadas localmente en tu
              dispositivo o en tu cuenta si inicias sesión.
            </li>
            <li>
              <strong>Datos técnicos:</strong> tipo de dispositivo, versión del sistema operativo y
              registros anónimos de uso para mejorar la estabilidad.
            </li>
          </ul>

          <h3 className="text-xl font-semibold mt-6 mb-2">3. Uso de la Información</h3>
          <p className="mb-4">
            Utilizamos la información para operar la App, mostrar mapas oceanográficos, guardar tus
            zonas de pesca y mejorar la experiencia de usuario. No vendemos tus datos personales.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">4. Compartición de Datos</h3>
          <p className="mb-4">
            No compartimos información personal con terceros, salvo cuando sea requerido por ley o
            necesario para operar servicios esenciales (por ejemplo, proveedores de mapas) bajo sus
            propias políticas de privacidad.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">5. Seguridad de los Datos</h3>
          <p className="mb-4">
            Aplicamos medidas técnicas y organizativas razonables para proteger tu información.
            Ningún método de transmisión por Internet es 100% seguro.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">6. Tus Derechos</h3>
          <p className="mb-4">
            Puedes solicitar acceso, corrección o eliminación de tus datos personales, y revocar los
            permisos de ubicación en cualquier momento desde la configuración de tu dispositivo.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">7. Privacidad de Menores</h3>
          <p className="mb-4">
            La App no está dirigida a menores de 13 años. No recopilamos conscientemente información
            personal de ellos.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">8. Cambios en esta Política</h3>
          <p className="mb-4">
            Podemos actualizar esta Política ocasionalmente. La fecha de "Última actualización"
            indica la revisión más reciente.
          </p>

          <h3 className="text-xl font-semibold mt-6 mb-2">9. Contacto</h3>
          <p className="mb-4">
            Para consultas sobre esta Política, escríbenos a{" "}
            <a href="mailto:support@hotspotfishing.app" className="text-primary hover:underline">
              support@hotspotfishing.app
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}

