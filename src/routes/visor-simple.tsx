import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

export const Route = createFileRoute("/visor-simple")({
  component: VisorSimplePage,
  head: () => ({
    meta: [
      { title: "Visor simple — Totymar" },
      {
        name: "description",
        content: "Visor mínimo de prueba con OpenStreetMap y una capa WMS.",
      },
    ],
  }),
});

function VisorSimplePage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;
    if (!containerRef.current) return;
    initializedRef.current = true;

    let map: import("leaflet").Map | null = null;
    let cancelled = false;

    (async () => {
      const [{ default: L }] = await Promise.all([
        import("leaflet"),
        import("leaflet/dist/leaflet.css"),
      ]);
      if (cancelled || !containerRef.current) return;

      map = L.map(containerRef.current, {
        preferCanvas: true,
        zoomAnimation: false,
        fadeAnimation: false,
        markerZoomAnimation: false,
      }).setView([39.85, 3.12], 8);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: "© OpenStreetMap",
      }).addTo(map);

      L.tileLayer
        .wms("https://nrt.cmems-du.eu/thredds/wms/SEALEVEL_GLO_PHY_L4_NRT_OBSERVATIONS", {
          layers: "adt",
          format: "image/png",
          transparent: true,
        })
        .addTo(map);
    })();

    return () => {
      cancelled = true;
      if (map) {
        map.remove();
        map = null;
      }
      initializedRef.current = false;
    };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div ref={containerRef} style={{ height: "100vh", width: "100%" }} />
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          padding: "6px 10px",
          background: "rgba(0,0,0,0.6)",
          color: "white",
          borderRadius: 6,
          fontFamily: "system-ui, sans-serif",
          fontSize: 12,
          zIndex: 1000,
        }}
      >
        Visor simple (prueba de velocidad)
      </div>
    </div>
  );
}

