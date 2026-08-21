import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useState clone que persiste el valor en localStorage bajo `key`.
 * Sobrevive a recargas, cierres de pestaña y reaperturas de la app.
 *
 * Importante para iOS PWA/WebView: escribimos **sincrónicamente** dentro del
 * setter (no en un useEffect posterior). Si iOS recicla el WebView entre el
 * setState y el flush del efecto, el dato se perdía. Además registramos un
 * `pagehide`/`visibilitychange=hidden` que vuelve a volcar el último valor
 * conocido como red de seguridad.
 */
export function usePersistentState<T>(key: string, initial: T) {
  const storageKey = `ov.${key}`;
  const [value, setValue] = useState<T>(initial);
  const hydratedRef = useRef(false);
  const valueRef = useRef<T>(initial);

  // Hidratar una sola vez en el cliente.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw != null) {
        const parsed = JSON.parse(raw) as T;
        valueRef.current = parsed;
        setValue(parsed);
      }
    } catch {
      // storage deshabilitado o JSON corrupto
    } finally {
      hydratedRef.current = true;
    }
  }, [storageKey]);

  const setAndPersist: React.Dispatch<React.SetStateAction<T>> = useCallback(
    (next) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        valueRef.current = resolved;
        if (typeof window !== "undefined") {
          try {
            window.localStorage.setItem(storageKey, JSON.stringify(resolved));
          } catch {
            // quota / storage deshabilitado
          }
        }
        return resolved;
      });
    },
    [storageKey],
  );

  // Red de seguridad: al ocultar la app o al pagehide (iOS la suele matar
  // ahí), re-escribir el último valor por si algún setter sincrónico falló.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = () => {
      if (!hydratedRef.current) return;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(valueRef.current));
      } catch {
        /* ignore */
      }
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [storageKey]);

  return [value, setAndPersist] as const;
}

