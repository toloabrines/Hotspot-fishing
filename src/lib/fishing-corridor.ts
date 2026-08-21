/**
 * Corredor de pesca pegado a la cresta real del gradiente.
 *
 * La ruta se traza sobre puntos sub-celda calculados desde SST/CHL/ALT: no
 * simplifica a una PCA, no une extremos por estética y se corta cuando la
 * señal oceanográfica deja de ser clara.
 */

import type { LatLng } from "./geo-area";
import type { GradientCell, GradientVariable, GradientZone } from "./gradient-zones.types";

const KM_PER_DEG_LAT = 111;
const MIN_ROUTE_CELLS = 2;
const MIN_EDGE_ALIGNMENT = 0.08;

export interface CorridorOptions {
  /** Mantener por compatibilidad: sólo se aplica micro-suavizado conservador. */
  smoothPasses?: number;
  /** Si es true, el corredor intenta seguir la cresta con más resolución
   *  y menos suavizado, útil para frentes cortos o zonas costeras. */
  detailed?: boolean;
}

export interface CorridorPoint extends LatLng {
  /** Intensidad real del gradiente en este punto (0..1). */
  score: number;
  /** Anchura local recomendada según claridad del frente. */
  widthMeters: number;
  /** Variables (SST/Chl/Alt) cuyo gradiente justifica este punto. */
  vars: GradientVariable[];
  /** Gradiente normalizado (0..1) por variable para este punto. */
  grads: Partial<Record<GradientVariable, number>>;
}

interface CellNode extends GradientCell {
  key: string;
  score: number;
}

interface RidgeGraph {
  nodes: CellNode[];
  map: Map<string, CellNode>;
  strongCutoff: number;
  hardCutoff: number;
  meanScore: number;
}

const NB8 = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const arr = values.slice().sort((a, b) => a - b);
  const idx = q * (arr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

function cellKey(row: number, col: number): string {
  return `${row}_${col}`;
}

function fusedGradientScore(cell: GradientCell): number {
  const weights: Record<GradientVariable, number> = { sst: 0.42, chl: 0.34, alt: 0.24 };
  let weighted = 0;
  let totalWeight = 0;
  let max = 0;
  let contributing = 0;

  for (const variable of Object.keys(weights) as GradientVariable[]) {
    const gradient = cell.grad[variable];
    if (gradient == null || !Number.isFinite(gradient)) continue;
    const g = Math.max(0, Math.min(1, gradient));
    weighted += g * weights[variable];
    totalWeight += weights[variable];
    max = Math.max(max, g);
    if (g >= 0.12) contributing += 1;
  }

  const layerBonus = contributing >= 2 ? 0.08 : 0;
  const fused = totalWeight > 0 ? weighted / totalWeight : cell.score;
  const ridgeStrength = cell.ridge?.strength ?? 0;
  const contrastBonus = Math.min(0.08, Math.max(0, cell.ridge?.localContrast ?? 0) * 1.8);
  return Math.max(
    0,
    Math.min(1, Math.max(cell.score, max, ridgeStrength, fused + layerBonus + contrastBonus)),
  );
}

function buildRidgeGraph(zone: GradientZone): RidgeGraph {
  const scored = zone.cells.map((cell) => ({ cell, score: fusedGradientScore(cell) }));
  const scores = scored.map((item) => item.score).filter(Number.isFinite);
  const p76 = quantile(scores, 0.76);
  const p88 = quantile(scores, 0.88);
  const meanScore = scores.length
    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
    : 0;

  // Mantenemos la cresta del frente pero evitamos filtros tan severos que
  // dejen el grafo vacío en zonas con gradientes moderados.
  const strongCutoff = Math.min(0.7, Math.max(0.12, p88 * 0.9, meanScore * 1.05));
  const hardCutoff = Math.max(0.06, Math.min(strongCutoff * 0.75, p76 * 0.85));
  const nodes: CellNode[] = scored
    .filter((item) => item.score >= hardCutoff)
    .map(({ cell, score }) => ({ ...cell, score, key: cellKey(cell.row, cell.col) }));

  const map = new Map<string, CellNode>();
  for (const node of nodes) map.set(node.key, node);
  return { nodes, map, strongCutoff, hardCutoff, meanScore };
}

function splitIntoComponents(nodes: CellNode[], map: Map<string, CellNode>): CellNode[][] {
  const components: CellNode[][] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (seen.has(node.key)) continue;
    const component: CellNode[] = [];
    const stack = [node];
    seen.add(node.key);

    while (stack.length) {
      const cur = stack.pop()!;
      component.push(cur);
      for (const [dr, dc] of NB8) {
        const next = map.get(cellKey(cur.row + dr, cur.col + dc));
        if (!next || seen.has(next.key)) continue;
        seen.add(next.key);
        stack.push(next);
      }
    }
    components.push(component);
  }

  return components;
}

function nodePoint(node: CellNode): LatLng {
  return node.ridge?.point ?? node.center;
}

function nodeTangent(node: CellNode): LatLng {
  return node.ridge?.tangent ?? { lat: 0, lng: 1 };
}

function robustAxis(
  component: CellNode[],
  fallback: GradientZone["axis"],
): { centroid: LatLng; vx: number; vy: number } {
  if (component.length < 2) {
    const cosLat = Math.cos((fallback.centroid.lat * Math.PI) / 180) || 1;
    const fx = fallback.dir.lng * KM_PER_DEG_LAT * cosLat;
    const fy = fallback.dir.lat * KM_PER_DEG_LAT;
    const fn = Math.hypot(fx, fy) || 1;
    return { centroid: fallback.centroid, vx: fx / fn, vy: fy / fn };
  }

  let lat = 0;
  let lng = 0;
  let weightSum = 0;
  for (const cell of component) {
    const p = nodePoint(cell);
    const weight = 0.2 + cell.score;
    lat += p.lat * weight;
    lng += p.lng * weight;
    weightSum += weight;
  }
  const centroid = { lat: lat / weightSum, lng: lng / weightSum };
  const cosLat = Math.cos((centroid.lat * Math.PI) / 180) || 1;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const cell of component) {
    const p = nodePoint(cell);
    const weight = 0.2 + cell.score;
    const x = (p.lng - centroid.lng) * KM_PER_DEG_LAT * cosLat;
    const y = (p.lat - centroid.lat) * KM_PER_DEG_LAT;
    sxx += x * x * weight;
    syy += y * y * weight;
    sxy += x * y * weight;
  }

  let vx = 1;
  let vy = 0;
  if (Math.abs(sxy) > 1e-9) {
    const trace = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const disc = Math.max(0, (trace * trace) / 4 - det);
    const lambda = trace / 2 + Math.sqrt(disc);
    vx = lambda - syy;
    vy = sxy;
  } else if (syy > sxx) {
    vx = 0;
    vy = 1;
  }
  const norm = Math.hypot(vx, vy) || 1;
  return { centroid, vx: vx / norm, vy: vy / norm };
}

function projectionKm(cell: CellNode, axis: { centroid: LatLng; vx: number; vy: number }): number {
  const p = nodePoint(cell);
  const cosLat = Math.cos((axis.centroid.lat * Math.PI) / 180) || 1;
  const x = (p.lng - axis.centroid.lng) * KM_PER_DEG_LAT * cosLat;
  const y = (p.lat - axis.centroid.lat) * KM_PER_DEG_LAT;
  return x * axis.vx + y * axis.vy;
}

function endpoints(
  component: CellNode[],
  axis: { centroid: LatLng; vx: number; vy: number },
): [CellNode, CellNode] {
  let min = component[0];
  let max = component[0];
  let minProj = Infinity;
  let maxProj = -Infinity;

  for (const cell of component) {
    const proj = projectionKm(cell, axis);
    if (proj < minProj) {
      minProj = proj;
      min = cell;
    }
    if (proj > maxProj) {
      maxProj = proj;
      max = cell;
    }
  }

  return [min, max];
}

function edgeAlignment(cur: CellNode, next: CellNode, dr: number, dc: number): number {
  const len = Math.hypot(dr, dc) || 1;
  const er = dr / len;
  const ec = dc / len;
  const a = nodeTangent(cur);
  const b = nodeTangent(next);
  const alignA = Math.abs(a.lat * er + a.lng * ec);
  const alignB = Math.abs(b.lat * er + b.lng * ec);
  return (alignA + alignB) / 2;
}

function dijkstraOnRidge(
  start: CellNode,
  end: CellNode,
  componentMap: Map<string, CellNode>,
  axis: { centroid: LatLng; vx: number; vy: number },
  graph: RidgeGraph,
): CellNode[] {
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const open = new Set<string>([start.key]);
  const visited = new Set<string>();
  const startProj = projectionKm(start, axis);
  const endProj = projectionKm(end, axis);
  const forwardSign = endProj >= startProj ? 1 : -1;

  dist.set(start.key, 0);
  prev.set(start.key, null);

  while (open.size) {
    let bestKey: string | null = null;
    let bestDist = Infinity;
    for (const key of open) {
      const currentDist = dist.get(key) ?? Infinity;
      if (currentDist < bestDist) {
        bestDist = currentDist;
        bestKey = key;
      }
    }
    if (!bestKey) break;
    open.delete(bestKey);
    visited.add(bestKey);
    if (bestKey === end.key) break;

    const cur = componentMap.get(bestKey)!;
    const curProj = projectionKm(cur, axis);
    for (const [dr, dc] of NB8) {
      const next = componentMap.get(cellKey(cur.row + dr, cur.col + dc));
      if (!next || visited.has(next.key)) continue;

      const align = edgeAlignment(cur, next, dr, dc);
      if (align < MIN_EDGE_ALIGNMENT && next.score < graph.strongCutoff) continue;

      const nextProj = projectionKm(next, axis);
      const progressKm = (nextProj - curProj) * forwardSign;
      const backwardsPenalty = progressKm < -0.04 ? 6 : 0;
      const weakPenalty = next.score < graph.strongCutoff ? 3.6 : (1 - next.score) ** 2 * 1.8;
      const tangentPenalty = (1 - align) ** 2 * 3.2;
      const contrast = Math.max(0, next.ridge?.localContrast ?? 0);
      const contrastReward = -Math.min(0.35, contrast * 2.2);
      const diagonalPenalty = dr !== 0 && dc !== 0 ? 0.05 : 0;
      const cost =
        0.12 + weakPenalty + tangentPenalty + backwardsPenalty + diagonalPenalty + contrastReward;
      const alt = bestDist + Math.max(0.02, cost);

      if (alt < (dist.get(next.key) ?? Infinity)) {
        dist.set(next.key, alt);
        prev.set(next.key, bestKey);
        open.add(next.key);
      }
    }
  }

  if (!prev.has(end.key)) return [];
  const path: CellNode[] = [];
  let key: string | null = end.key;
  while (key != null) {
    const node = componentMap.get(key);
    if (!node) return [];
    path.push(node);
    key = prev.get(key) ?? null;
  }
  return path.reverse();
}

function trimWeakEnds(path: CellNode[], cutoff: number): CellNode[] {
  const trimCutoff = cutoff * 0.7;
  let start = 0;
  let end = path.length - 1;
  while (start <= end && path[start].score < trimCutoff) start += 1;
  while (end >= start && path[end].score < trimCutoff) end -= 1;
  return path.slice(start, end + 1);
}

function strongVarsOf(cell: GradientCell, minGrad = 0.08): GradientVariable[] {
  const out: GradientVariable[] = [];
  for (const v of ["sst", "chl", "alt"] as GradientVariable[]) {
    const g = cell.grad[v];
    if (g != null && Number.isFinite(g) && g >= minGrad) out.push(v);
  }
  return out.length > 0 ? out : cell.vars;
}

function splitOnWeakGaps(path: CellNode[], cutoff: number): CellNode[][] {
  const segments: CellNode[][] = [];
  let current: CellNode[] = [];
  const gapCutoff = cutoff * 0.7;

  for (const node of path) {
    // Frente real = score por encima del umbral Y al menos 1 variable con gradiente real.
    const strongVars = strongVarsOf(node);
    const reliable = node.score >= gapCutoff && strongVars.length >= 1;
    if (!reliable) {
      if (current.length >= MIN_ROUTE_CELLS) segments.push(current);
      current = [];
      continue;
    }
    current.push(node);
  }

  if (current.length >= MIN_ROUTE_CELLS) segments.push(current);
  return segments;
}

function chooseUsefulSegment(
  segments: CellNode[][],
  axis: { centroid: LatLng; vx: number; vy: number },
): CellNode[] {
  let best: CellNode[] = [];
  let bestScore = -Infinity;
  for (const segment of segments) {
    const mean = segment.reduce((sum, node) => sum + node.score, 0) / segment.length;
    const contrast =
      segment.reduce((sum, node) => sum + Math.max(0, node.ridge?.localContrast ?? 0), 0) /
      segment.length;
    const projections = segment.map((node) => projectionKm(node, axis));
    const span = Math.max(...projections) - Math.min(...projections);
    const score = mean * 100 + contrast * 80 + span * 2 + segment.length * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = segment;
    }
  }
  return best;
}

function pointWidthMeters(_node: CellNode, _strongCutoff: number): number {
  return 3704; // 2 millas náuticas fijas
}

function lightlySmooth(points: CorridorPoint[], passes: number): CorridorPoint[] {
  if (points.length < 4 || passes <= 0) return points;
  let out = points;
  for (let pass = 0; pass < passes; pass++) {
    out = out.map((point, i) => {
      if (i === 0 || i === out.length - 1) return point;
      const prev = out[i - 1];
      const next = out[i + 1];
      return {
        ...point,
        lat: point.lat * 0.72 + (prev.lat + next.lat) * 0.14,
        lng: point.lng * 0.72 + (prev.lng + next.lng) * 0.14,
        widthMeters: point.widthMeters * 0.76 + (prev.widthMeters + next.widthMeters) * 0.12,
      };
    });
  }
  return out;
}

function toCorridorPoints(
  path: CellNode[],
  strongCutoff: number,
  smoothPasses: number,
): CorridorPoint[] {
  const raw: CorridorPoint[] = path.map((node) => {
    const p = nodePoint(node);
    const grads: Partial<Record<GradientVariable, number>> = {};
    for (const v of ["sst", "chl", "alt"] as GradientVariable[]) {
      const g = node.grad[v];
      if (g != null && Number.isFinite(g)) {
        grads[v] = Math.max(0, Math.min(1, g));
      }
    }
    return {
      lat: p.lat,
      lng: p.lng,
      score: node.score,
      widthMeters: pointWidthMeters(node, strongCutoff),
      vars: strongVarsOf(node),
      grads,
    };
  });
  return lightlySmooth(raw, Math.max(0, Math.min(1, smoothPasses)));
}

export function buildFishingCorridor(
  zone: GradientZone,
  opts: CorridorOptions = {},
): CorridorPoint[] {
  const graph = buildRidgeGraph(zone);
  if (graph.nodes.length < MIN_ROUTE_CELLS || graph.meanScore < 0.01) {
    // permitir fallback abajo
  }

  const components = splitIntoComponents(graph.nodes, graph.map)
    .filter((component) => component.length >= MIN_ROUTE_CELLS)
    .sort((a, b) => {
      const am = a.reduce((sum, node) => sum + node.score, 0) / a.length;
      const bm = b.reduce((sum, node) => sum + node.score, 0) / b.length;
      return b.length * bm - a.length * am;
    });

  for (const component of components) {
    const axis = robustAxis(component, zone.axis);
    const [start, end] = endpoints(component, axis);
    if (start.key === end.key) continue;

    const componentMap = new Map<string, CellNode>();
    for (const cell of component) componentMap.set(cell.key, cell);
    const path = dijkstraOnRidge(start, end, componentMap, axis, graph);
    const trimmed = trimWeakEnds(path, graph.strongCutoff);
    const useful = chooseUsefulSegment(splitOnWeakGaps(trimmed, graph.strongCutoff), axis);
    if (useful.length >= MIN_ROUTE_CELLS)
      return toCorridorPoints(
        useful,
        graph.strongCutoff,
        opts.detailed ? 0 : (opts.smoothPasses ?? 1),
      );
  }

  // Sin frente claro y continuo => no se dibuja ruta artificial.
  return [];
}

/** Devuelve el punto más caliente de una zona: la cresta del gradiente con
 *  mayor score, o el centroide si no hay cresta. */
export function pickHotPointFromZone(zone: GradientZone): LatLng {
  let best: LatLng | null = null;
  let bestScore = -Infinity;
  for (const cell of zone.cells) {
    const score = fusedGradientScore(cell);
    const p = cell.ridge?.point ?? cell.center;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best ?? zone.axis.centroid;
}

export function bufferCorridor(centerline: LatLng[], fallbackWidthMeters = 3704): LatLng[] {
  if (centerline.length < 2) return [];
  const left: LatLng[] = [];
  const right: LatLng[] = [];

  for (let i = 0; i < centerline.length; i++) {
    const p = centerline[i] as CorridorPoint;
    const prev = centerline[Math.max(0, i - 1)];
    const next = centerline[Math.min(centerline.length - 1, i + 1)];
    const widthMeters = Number.isFinite(p.widthMeters) ? p.widthMeters : fallbackWidthMeters;
    const halfKm = widthMeters / 2000;
    const cosLat = Math.cos((p.lat * Math.PI) / 180) || 1;
    const tx = (next.lng - prev.lng) * KM_PER_DEG_LAT * cosLat;
    const ty = (next.lat - prev.lat) * KM_PER_DEG_LAT;
    const n = Math.hypot(tx, ty) || 1;
    const nx = -ty / n;
    const ny = tx / n;
    const offLat = (ny * halfKm) / KM_PER_DEG_LAT;
    const offLng = (nx * halfKm) / (KM_PER_DEG_LAT * cosLat);
    left.push({ lat: p.lat + offLat, lng: p.lng + offLng });
    right.push({ lat: p.lat - offLat, lng: p.lng - offLng });
  }

  return [...left, ...right.reverse()];
}

