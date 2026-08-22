import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Seafloor3DView } from "../components/Seafloor3DView";
import { fetchDemGrid, type DemGrid } from "../lib/dem";

export const Route = createFileRoute("/qa3d")({
  component: Qa3d,
  head: () => ({
    meta: [
      { title: "QA visor 3D — Hotspot Fishing" },
      { name: "description", content: "Prueba interna del visor 3D del fondo marino." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function Qa3d() {
  const [grid, setGrid] = useState<DemGrid | null>(null);
  useEffect(() => {
    // Bahía de Alcúdia / Formentor
    fetchDemGrid({ south: 39.72, west: 3.05, north: 39.94, east: 3.28 }, 200).then(setGrid);
  }, []);
  return (
    <Seafloor3DView
      grid={grid}
      gpsPosition={{ lat: 39.83, lng: 3.15, heading: 42, speed: 3.1 }}
      spots={[
        { lat: 39.85, lng: 3.18, rank: 1, score: 0.9 },
        { lat: 39.79, lng: 3.12, rank: 2, score: 0.8 },
        { lat: 39.88, lng: 3.09, rank: 3, score: 0.7 },
      ]}
      waypoints={[{ lat: 39.81, lng: 3.2, name: "WP1" }]}
      onClose={() => undefined}
    />
  );
}

