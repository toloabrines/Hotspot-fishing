import { classifyLandform, DemGrid, LANDFORM_LABEL, type LandformKind } from "./dem";

export interface SeafloorStructure {
  id: string;
  kind: LandformKind;
  label: string;
  lat: number;
  lng: number;
  depthM: number;
  slopeDeg: number;
  roughnessM: number;
  curvature: number;
  /** Relevancia 0–1 (para ordenar y limitar el número de marcas). */
  score: number;
}

const ICON: Partial<Record<LandformKind, string>> = {
  bajo: "⛰",
  cima: "▲",
  veril: "⧗",
  canon: "▽",
  meseta: "▭",
  agujero: "◉",
};

export function structureIcon(kind: LandformKind) {
  return ICON[kind] ?? "•";
}

/**
 * Detecta automáticamente bajos, veriles, cimas, cañones, mesetas y agujeros
 * sobre la rejilla DEM y devuelve las estructuras más relevantes.
 */
export function detectStructures(
  grid: DemGrid,
  opts: { max?: number; minDepth?: number; maxDepth?: number } = {},
): SeafloorStructure[] {
  const max = opts.max ?? 26;
  const minDepth = opts.minDepth ?? 3;
  const maxDepth = opts.maxDepth ?? 3000;

  const candidates: SeafloorStructure[] = [];
  const dLat = (grid.north - grid.south) / grid.rows;
  const dLng = (grid.east - grid.west) / grid.cols;

  const localExtreme = (r: number, c: number, z: number): "max" | "min" | null => {
    let higher = 0;
    let lower = 0;
    let count = 0;
    for (let rr = -2; rr <= 2; rr++) {
      for (let cc = -2; cc <= 2; cc++) {
        if (!rr && !cc) continue;
        const v = grid.at(r + rr, c + cc);
        if (!Number.isFinite(v)) continue;
        count++;
        if (v > z + 0.3) higher++;
        else if (v < z - 0.3) lower++;
      }
    }
    if (count < 12) return null;
    if (higher === 0 && lower >= count * 0.7) return "max"; // punto más somero
    if (lower === 0 && higher >= count * 0.7) return "min"; // punto más profundo
    return null;
  };

  for (let r = 2; r < grid.rows - 2; r++) {
    for (let c = 2; c < grid.cols - 2; c++) {
      const i = r * grid.cols + c;
      const z = grid.elev[i];
      if (!Number.isFinite(z) || z >= 0) continue;
      const depthM = -z;
      if (depthM < minDepth || depthM > maxDepth) continue;

      const slopeDeg = grid.slope[i];
      const roughnessM = grid.rough[i];
      const curvature = grid.curv[i];
      if (!Number.isFinite(slopeDeg)) continue;

      const ext = localExtreme(r, c, z);
      let kind: LandformKind | null = null;
      let score = 0;

      if (ext === "max") {
        kind = depthM < 60 ? "bajo" : "cima";
        // Relevancia: cuánto sobresale respecto al entorno + pendiente lateral.
        let around = 0;
        let n = 0;
        for (let rr = -3; rr <= 3; rr++) {
          for (let cc = -3; cc <= 3; cc++) {
            const v = grid.at(r + rr, c + cc);
            if (Number.isFinite(v)) {
              around += v;
              n++;
            }
          }
        }
        const relief = n ? z - around / n : 0;
        score = Math.min(1, relief / 25) * 0.7 + Math.min(1, slopeDeg / 25) * 0.3;
      } else if (ext === "min" && curvature < -1) {
        kind = "agujero";
        score = Math.min(1, Math.abs(curvature) / 12) * 0.8;
      } else if (slopeDeg >= 16) {
        kind = curvature < -2 ? "canon" : "veril";
        score = Math.min(1, slopeDeg / 35) * 0.85 + Math.min(1, roughnessM / 12) * 0.15;
      } else if (slopeDeg < 1 && roughnessM < 0.8 && depthM > 120) {
        kind = "meseta";
        score = 0.25;
      }

      if (!kind || score < 0.28) continue;

      candidates.push({
        id: `${kind}-${r}-${c}`,
        kind,
        label: LANDFORM_LABEL[kind],
        lat: grid.north - (r + 0.5) * dLat,
        lng: grid.west + (c + 0.5) * dLng,
        depthM,
        slopeDeg,
        roughnessM: Number.isFinite(roughnessM) ? roughnessM : 0,
        curvature: Number.isFinite(curvature) ? curvature : 0,
        score: Math.min(1, score),
      });
    }
  }

  // Supresión de no-máximos: una marca por vecindad.
  candidates.sort((a, b) => b.score - a.score);
  const minSepLat = Math.abs(dLat) * 6;
  const minSepLng = Math.abs(dLng) * 6;
  const kept: SeafloorStructure[] = [];
  for (const cand of candidates) {
    const clash = kept.some(
      (k) => Math.abs(k.lat - cand.lat) < minSepLat && Math.abs(k.lng - cand.lng) < minSepLng,
    );
    if (clash) continue;
    kept.push(cand);
    if (kept.length >= max) break;
  }
  return kept;
}

/** Clasificación puntual (reexport útil para la ficha del punto). */
export { classifyLandform, LANDFORM_LABEL };

