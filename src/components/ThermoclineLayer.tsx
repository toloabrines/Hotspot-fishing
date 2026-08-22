import { useCallback, useEffect, useRef, useState } from "react";
import { Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { fetchThermocline, type ThermoclineResult } from "../lib/thermocline";

interface ThermoclineLayerProps {
  enabled: boolean;
  time?: string;
}

interface ClickInfo {
  lat: number;
  lng: number;
  loading: boolean;
  result: ThermoclineResult | null;
}

/**
 * Capa "Termoclina" — bajo demanda.
 * Cuando está activa, un clic simple en el mapa lanza una consulta puntual
 * al perfil vertical de temperatura (Copernicus thetao) y muestra un popup
 * con la profundidad estimada de la termoclina.
 *
 * No renderiza nada si está apagada y NO recalcula al mover el mapa.
 */
export function ThermoclineLayer({ enabled, time }: ThermoclineLayerProps) {
  const [info, setInfo] = useState<ClickInfo | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const map = useMap();

  const queryAt = useCallback(
    async (lat: number, lng: number) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setInfo({ lat, lng, loading: true, result: null });
      try {
        const result = await fetchThermocline(lat, lng, time, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setInfo({ lat, lng, loading: false, result });
      } catch {
        if (!ctrl.signal.aborted) {
          setInfo({ lat, lng, loading: false, result: null });
        }
      }
    },
    [time],
  );

  // Al activar, calcula directamente en el centro visible para que el botón
  // produzca salida inmediata; después el usuario puede tocar otra zona.
  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      setInfo(null);
      return;
    }

    const center = map.getCenter();
    void queryAt(center.lat, center.lng);
  }, [enabled, map, queryAt]);

  useMapEvents({
    click: async (e: L.LeafletMouseEvent) => {
      if (!enabled) return;
      const target = e.originalEvent.target as HTMLElement | null;
      if (target && target.closest(".leaflet-control, [data-no-map-click]")) return;

      const { lat, lng } = e.latlng;
      await queryAt(lat, lng);
    },
  });

  if (!enabled || !info) return null;

  return (
    <Popup
      position={[info.lat, info.lng]}
      eventHandlers={{ remove: () => setInfo(null) }}
      maxWidth={210}
      minWidth={170}
      className="compact-popup"
    >
      <div
        className="font-body min-w-[160px] max-w-[200px] rounded-md p-1 text-[10px] leading-tight"
        style={{
          background: "linear-gradient(135deg, rgba(99,102,241,0.18), rgba(139,92,246,0.18))",
        }}
      >
        <div
          className="mb-1 text-[9px] font-semibold uppercase tracking-wider"
          style={{ color: "rgb(167,139,250)" }}
        >
          🌊 Termoclina
        </div>

        {info.loading ? (
          <div className="text-[10px]" style={{ color: "var(--muted-foreground)" }}>
            Calculando perfil…
          </div>
        ) : !info.result || info.result.depth == null ? (
          <div className="text-[10px]" style={{ color: "var(--muted-foreground)" }}>
            Sin datos verticales
          </div>
        ) : (
          <div className="space-y-0.5">
            <div className="flex justify-between gap-1 text-[10px]">
              <span style={{ color: "var(--muted-foreground)" }}>Aprox.</span>
              <span className="font-semibold" style={{ color: "var(--foreground)" }}>
                {info.result.depth} m
              </span>
            </div>
            <div className="flex justify-between gap-1 text-[10px]">
              <span style={{ color: "var(--muted-foreground)" }}>Intensidad</span>
              <span className="font-semibold capitalize" style={{ color: "var(--foreground)" }}>
                {info.result.strength}
              </span>
            </div>
            {info.result.gradient != null && (
              <div className="flex justify-between gap-1 text-[10px]">
                <span style={{ color: "var(--muted-foreground)" }}>Gradiente</span>
                <span className="font-mono" style={{ color: "var(--foreground)" }}>
                  {info.result.gradient.toFixed(2)} °C/m
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </Popup>
  );
}

