import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { KeepAwake } from "@capacitor-community/keep-awake";
import { useEffect, useRef } from "react";

/**
 * Mantiene la pantalla encendida usando KeepAwake nativo en iOS/Android
 * y Screen Wake Lock API como fallback web. Se reactiva al volver a primer plano.
 */
interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener?: (type: "release", cb: () => void) => void;
}

interface WakeLockNavigator {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
}

export function useWakeLock(active: boolean) {
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);
  const nativeAwakeRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const nav = navigator as unknown as WakeLockNavigator;
    if (!active) return;

    let cancelled = false;
    let retryTimer: number | undefined;

    const scheduleRetry = (delay = 1000) => {
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => {
        if (!cancelled) acquire();
      }, delay);
    };

    const acquire = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        if (Capacitor.isNativePlatform()) {
          const supported = await KeepAwake.isSupported().catch(() => ({ isSupported: false }));
          if (supported.isSupported) {
            const status = await KeepAwake.isKeptAwake().catch(() => ({ isKeptAwake: false }));
            if (status.isKeptAwake && nativeAwakeRef.current) return;
            // iOS puede resetear el idle timer al pausar/reanudar la app;
            // re-aplicarlo es idempotente y evita que la pantalla vuelva a dormir.
            await KeepAwake.keepAwake();
            if (cancelled) {
              await KeepAwake.allowSleep().catch(() => undefined);
              return;
            }
            nativeAwakeRef.current = true;
            return;
          }
        }

        if (sentinelRef.current) return;
        if (!nav?.wakeLock?.request) return;
        const s = await nav.wakeLock!.request("screen");
        if (cancelled) {
          try {
            await s.release();
          } catch {
            // ignorar errores al liberar
          }
          return;
        }
        sentinelRef.current = s;
        s.addEventListener?.("release", () => {
          sentinelRef.current = null;
          if (!cancelled && document.visibilityState === "visible") {
            window.setTimeout(acquire, 250);
          }
        });
      } catch {
        // permiso denegado o no soportado
        scheduleRetry(2500);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !sentinelRef.current) {
        acquire();
      }
    };

    acquire();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", acquire);
    window.addEventListener("pageshow", acquire);
    window.addEventListener("pointerdown", acquire, { passive: true });
    window.addEventListener("touchstart", acquire, { passive: true });
    const watchdog = window.setInterval(() => {
      if (document.visibilityState === "visible") acquire();
    }, 15000);
    const appStateHandle = Capacitor.isNativePlatform()
      ? App.addListener("appStateChange", ({ isActive }) => {
          if (isActive) window.setTimeout(acquire, 150);
        }).catch(() => null)
      : null;
    const appResumeHandle = Capacitor.isNativePlatform()
      ? App.addListener("resume", () => window.setTimeout(acquire, 150)).catch(() => null)
      : null;

    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", acquire);
      window.removeEventListener("pageshow", acquire);
      window.removeEventListener("pointerdown", acquire);
      window.removeEventListener("touchstart", acquire);
      void appStateHandle?.then((handle) => handle?.remove());
      void appResumeHandle?.then((handle) => handle?.remove());
      if (nativeAwakeRef.current) {
        nativeAwakeRef.current = false;
        KeepAwake.allowSleep().catch(() => undefined);
      }
      const s = sentinelRef.current;
      sentinelRef.current = null;
      if (s) {
        try {
          s.release();
        } catch {
          // ignorar errores al liberar
        }
      }
    };
  }, [active]);
}

