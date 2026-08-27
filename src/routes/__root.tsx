import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ensureTrialGrant } from "@/lib/invites.functions";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no",
      },
      { title: "Hotspot Fishing" },
      { name: "description", content: "Visor oceanográfico para pesca: SST, clorofila, corrientes, frentes térmicos y hotspots." },
      { name: "author", content: "Lovable" },
      { name: "theme-color", content: "#0a1929" },
      { name: "application-name", content: "Hotspot Fishing" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Hotspot Fishing" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "format-detection", content: "telephone=no" },
      { property: "og:title", content: "Hotspot Fishing" },
      { property: "og:description", content: "Visor oceanográfico para pesca: SST, clorofila, corrientes, frentes térmicos y hotspots." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:site", content: "@Lovable" },
      { name: "twitter:title", content: "Hotspot Fishing" },
      { name: "twitter:description", content: "Visor oceanográfico para pesca: SST, clorofila, corrientes, frentes térmicos y hotspots." },
      {
        property: "og:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/47d74cb7-6b90-4c72-8838-b9953ce773f9",
      },
      {
        name: "twitter:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/47d74cb7-6b90-4c72-8838-b9953ce773f9",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      { rel: "icon", type: "image/png", sizes: "64x64", href: "/favicon.png" },
      { rel: "icon", type: "image/png", sizes: "192x192", href: "/icon-192.png" },
      { rel: "icon", type: "image/png", sizes: "512x512", href: "/icon-512.png" },
    ],
    scripts: [{ src: "/pwa-register.js?v=1.1.3", defer: true }],
  }),

  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {/* Filtros SVG globales para renderizar capas como contornos coloreados
            (detección de bordes + tinte). Usados por .ocean-pane-chl y
            .ocean-pane-alt cuando el body tiene la clase `ocean-contour-mode`. */}
        <svg
          aria-hidden="true"
          style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
        >
          <defs>
            <filter id="contour-chl" x="0%" y="0%" width="100%" height="100%">
              <feConvolveMatrix
                order="3"
                preserveAlpha="true"
                kernelMatrix="-1 -1 -1  -1  8 -1  -1 -1 -1"
              />
              <feColorMatrix
                type="matrix"
                values="0 0 0 0 0.05  0 0 0 0 0.75  0 0 0 0 0.25  0 0 0 3 0"
              />
            </filter>
            <filter id="contour-alt" x="0%" y="0%" width="100%" height="100%">
              <feConvolveMatrix
                order="3"
                preserveAlpha="true"
                kernelMatrix="-1 -1 -1  -1  8 -1  -1 -1 -1"
              />
              <feColorMatrix
                type="matrix"
                values="0 0 0 0 0.55  0 0 0 0 0.15  0 0 0 0 0.75  0 0 0 3 0"
              />
            </filter>
          </defs>
        </svg>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive || !data.session) return;
      void ensureTrialGrant();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session) void ensureTrialGrant();
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return <Outlet />;
}
