/**
 * Guía paso a paso para importar el KML descargado en Google Earth,
 * tanto en la versión Web como en la app móvil (iOS / Android).
 */

import { useEffect, useState } from "react";

type Platform = "web" | "ios" | "android";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "web";
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "web";
}

const EARTH_WEB = "https://earth.google.com/web/";
// Deep link a la app de Google Earth (si está instalada).
const EARTH_IOS_APP = "comgoogleearth://";
const EARTH_IOS_STORE = "https://apps.apple.com/app/google-earth/id293622097";
const EARTH_ANDROID_APP =
  "intent://earth.google.com/web/#Intent;scheme=https;package=com.google.earth;end";
const EARTH_ANDROID_STORE = "https://play.google.com/store/apps/details?id=com.google.earth";

export interface GoogleEarthImportGuideProps {
  open: boolean;
  onClose: () => void;
  /** Nombre del archivo KML que el usuario acaba de descargar. */
  filename: string;
}

export function GoogleEarthImportGuide({ open, onClose, filename }: GoogleEarthImportGuideProps) {
  const [platform, setPlatform] = useState<Platform>("web");
  const [step, setStep] = useState(1);

  useEffect(() => {
    if (open) {
      setPlatform(detectPlatform());
      setStep(1);
    }
  }, [open]);

  if (!open) return null;

  const openEarth = () => {
    if (platform === "ios") {
      // Intenta abrir la app; si falla, manda al store.
      const t = setTimeout(() => {
        window.open(EARTH_IOS_STORE, "_blank", "noopener");
      }, 1500);
      window.location.href = EARTH_IOS_APP;
      // Si la app abre, normalmente el navegador queda en background y
      // el timeout no se ejecuta. Si no, el usuario verá el store.
      void t;
    } else if (platform === "android") {
      try {
        window.location.href = EARTH_ANDROID_APP;
      } catch {
        window.open(EARTH_ANDROID_STORE, "_blank", "noopener");
      }
    } else {
      window.open(EARTH_WEB, "_blank", "noopener,noreferrer");
    }
  };

  const stepsByPlatform: Record<Platform, { title: string; body: string }[]> = {
    web: [
      {
        title: "1 · KML descargado",
        body: `Acabas de descargar "${filename}". Búscalo en tu carpeta Descargas.`,
      },
      {
        title: "2 · Abre Google Earth Web",
        body: "Pulsa el botón de abajo. Se abrirá earth.google.com/web en una pestaña nueva. Inicia sesión con tu cuenta de Google si te lo pide.",
      },
      {
        title: "3 · Menú ☰ → Proyectos",
        body: "Dentro de Earth pulsa el icono ☰ (arriba a la izquierda) y elige 'Proyectos'.",
      },
      {
        title: "4 · Nuevo proyecto → Importar KML",
        body: "Pulsa 'Nuevo proyecto' → 'Importar archivo KML/KMZ desde el ordenador' y selecciona el archivo descargado.",
      },
      {
        title: "5 · Listo",
        body: "Los frentes aparecerán como polígonos y los corredores como líneas. Earth centrará la vista automáticamente.",
      },
    ],
    ios: [
      {
        title: "1 · KML descargado",
        body: `"${filename}" se ha guardado en la app Archivos → Descargas (o iCloud Drive).`,
      },
      {
        title: "2 · Abre la app Google Earth",
        body: "Pulsa el botón de abajo. Si no la tienes instalada, te llevará al App Store.",
      },
      {
        title: "3 · Vuelve a Archivos",
        body: "Abre la app Archivos → Descargas, mantén pulsado el .kml y elige 'Compartir'.",
      },
      {
        title: "4 · Compartir → Google Earth",
        body: "En la hoja de compartir desliza y elige 'Google Earth'. Se abrirá la app con tus frentes.",
      },
    ],
    android: [
      {
        title: "1 · KML descargado",
        body: `"${filename}" está en la app Archivos / Descargas de tu móvil.`,
      },
      {
        title: "2 · Abre Google Earth",
        body: "Pulsa el botón de abajo. Si no la tienes instalada, te llevará a Play Store.",
      },
      {
        title: "3 · Importar en Earth",
        body: "Dentro de Earth: menú ☰ → Proyectos → Abrir → Importar archivo KML desde el dispositivo y elige el .kml de Descargas.",
      },
      {
        title: "4 · Alternativa: compartir",
        body: "También puedes abrir Archivos → Descargas, pulsar el .kml y elegir 'Abrir con → Google Earth'.",
      },
    ],
  };

  const steps = stepsByPlatform[platform];
  const current = steps[step - 1];
  const isLast = step >= steps.length;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-emerald-400/40 bg-card p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-lg">🌍</span>
          <h2 className="flex-1 text-sm font-semibold text-foreground">Importar a Google Earth</h2>
          <button
            onClick={onClose}
            className="rounded border border-border bg-secondary/70 px-2 py-0.5 text-xs text-foreground hover:bg-secondary"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        {/* Selector de plataforma */}
        <div className="mb-3 flex gap-1 rounded-md bg-background/40 p-1 text-[10px]">
          {(["web", "ios", "android"] as Platform[]).map((p) => (
            <button
              key={p}
              onClick={() => {
                setPlatform(p);
                setStep(1);
              }}
              className={`flex-1 rounded px-2 py-1 font-medium transition-colors ${
                platform === p
                  ? "bg-emerald-500/30 text-emerald-100"
                  : "text-muted-foreground hover:bg-secondary/60"
              }`}
            >
              {p === "web" ? "💻 Web" : p === "ios" ? "📱 iPhone" : "📱 Android"}
            </button>
          ))}
        </div>

        {/* Progreso */}
        <div className="mb-2 flex gap-1">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded ${i + 1 <= step ? "bg-emerald-400" : "bg-border"}`}
            />
          ))}
        </div>

        {/* Paso actual */}
        <div className="mb-3 rounded-lg border border-border/60 bg-background/40 p-3">
          <h3 className="mb-1 text-xs font-semibold text-emerald-200">{current.title}</h3>
          <p className="text-xs leading-relaxed text-foreground/90">{current.body}</p>
        </div>

        {/* Botón de acción para el paso 2 (abrir Earth) */}
        {step === 2 && (
          <button
            onClick={openEarth}
            className="mb-3 w-full rounded-md border border-emerald-400/60 bg-emerald-500/30 px-3 py-2 text-sm font-semibold text-emerald-50 hover:bg-emerald-500/40"
          >
            {platform === "web" ? "🌍 Abrir Google Earth Web" : "🌍 Abrir Google Earth"}
          </button>
        )}

        {/* Navegación */}
        <div className="flex gap-2">
          <button
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1}
            className="rounded-md border border-border bg-secondary/70 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
          >
            ← Atrás
          </button>
          <div className="flex-1 text-center text-[10px] text-muted-foreground">
            Paso {step} de {steps.length}
          </div>
          {!isLast ? (
            <button
              onClick={() => setStep((s) => Math.min(steps.length, s + 1))}
              className="rounded-md border border-emerald-400/60 bg-emerald-500/20 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-emerald-500/30"
            >
              Siguiente →
            </button>
          ) : (
            <button
              onClick={onClose}
              className="rounded-md border border-emerald-400/60 bg-emerald-500/30 px-3 py-1.5 text-xs font-semibold text-emerald-50 hover:bg-emerald-500/40"
            >
              ✓ Hecho
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

