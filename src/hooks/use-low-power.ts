import { useEffect, useState } from "react";

/**
 * Detección de dispositivos con poca memoria/CPU + visibilidad de la pestaña.
 *
 * Se usa para auto-degradar la app en móviles antiguos y para liberar recursos
 * cuando la app pasa a segundo plano (evita que el WebView de iOS la mate).
 */
interface LowPowerInfo {
  /** Dispositivo con poca memoria (deviceMemory <= 2GB) o pocos núcleos (<= 2). */
  isLowMemoryDevice: boolean;
  /** La pestaña/app está en segundo plano. */
  isHidden: boolean;
  /** Ha estado oculta más de 20 s (señal fuerte para liberar capas). */
  isLongHidden: boolean;
}

function detectLowMemoryDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory > 0 && nav.deviceMemory <= 4) {
    return true;
  }
  if (
    typeof nav.hardwareConcurrency === "number" &&
    nav.hardwareConcurrency > 0 &&
    nav.hardwareConcurrency <= 4
  ) {
    return true;
  }
  // Android WebView en gama media/baja sufre con canvas grandes y blur global.
  // Lo tratamos como low-power para activar las degradaciones de la app.
  const ua = typeof nav.userAgent === "string" ? nav.userAgent : "";
  if (/Android/i.test(ua)) return true;
  return false;
}

export function useLowPower(): LowPowerInfo {
  const [isLowMemoryDevice] = useState<boolean>(() => detectLowMemoryDevice());
  const [isHidden, setIsHidden] = useState<boolean>(() =>
    typeof document !== "undefined" ? document.visibilityState === "hidden" : false,
  );
  const [isLongHidden, setIsLongHidden] = useState(false);

  useEffect(() => {
    if (typeof document === "undefined") return;
    let timer: number | null = null;
    const onChange = () => {
      const hidden = document.visibilityState === "hidden";
      setIsHidden(hidden);
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (hidden) {
        timer = window.setTimeout(() => setIsLongHidden(true), 20_000);
      } else {
        setIsLongHidden(false);
      }
    };
    document.addEventListener("visibilitychange", onChange);
    return () => {
      document.removeEventListener("visibilitychange", onChange);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return { isLowMemoryDevice, isHidden, isLongHidden };
}

