import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";

/**
 * Capa de corrientes oceánicas renderizada como STREAMLINES animadas (líneas
 * finas, blancas, continuas), estilo visor oficial de Copernicus Marine.
 *
 * Implementación:
 *   - Se muestrea el campo vectorial `uo/vo` (o `ugos/vgos` en global) con
 *     GetFeatureInfo JSON. NO se decodifican tiles PNG para dirección: el
 *     color del tile es una representación renderizada y puede no coincidir
 *     píxel a píxel con el valor U/V físico publicado por Copernicus.
 *   - Las partículas se integran con RK4 sobre U/V: uo = este positivo,
 *     vo = norte positivo. Luego se proyectan a pantalla con Leaflet.
 *   - Densidad configurable (Baja / Media / Alta) desde el panel de capas.
 *   - Optimizado para móvil: frameRate limitado y densidad de partículas
 *     escalada al viewport.
 */

// ---------- Datasets ----------
const GLOBAL_DATASET =
  "SEALEVEL_GLO_PHY_L4_NRT_008_046/cmems_obs-sl_glo_phy-ssh_nrt_allsat-l4-duacs-0.125deg_P1D_202506";
const GLOBAL_U_VAR = "ugos";
const GLOBAL_V_VAR = "vgos";
const GLOBAL_STYLE = "cmap:RdBu_r,vmin:-1.2,vmax:1.2";

// Producto MEDSEA de corrientes 3D (uo/vo con dimensión de profundidad
// ELEVATION). Usado tanto para superficie (elevation ≈ -1.5 m) como para
// niveles intermedios y fondo, dependiendo del selector de profundidad.
const MED_DATASET =
  "MEDSEA_ANALYSISFORECAST_PHY_006_013/cmems_mod_med_phy-cur_anfc_4.2km_P1D-m_202511";
const MED_U_VAR = "uo";
const MED_V_VAR = "vo";
const MED_STYLE = "cmap:RdBu_r,vmin:-1,vmax:1";
const MED_BBOX = { west: -17, east: 36, south: 30.5, north: 45.8 };

const WMTS_URL = "https://wmts.marine.copernicus.eu/teroWmts";
const PROXY_PREFIX = "/api/tile-proxy?url=";
const VELOCITY_PANE = "ocean-current-streamlines-pane";
const EXACT_VECTOR_SAMPLING = false;

const WORLD_NORTH = 80;
const WORLD_SOUTH = -80;
const WORLD_WEST = -180;
const WORLD_EAST = 180;

export type CurrentDepth = "surface" | 10 | 20 | 30 | 50 | 100 | "bottom";

/** Devuelve el valor ELEVATION (negativo hacia abajo) que se envía al WMTS.
 *  Copernicus interpola/snap al nivel de modelo más cercano. Para "bottom"
 *  usamos un valor deliberadamente profundo (-500 m) — el servidor devuelve
 *  el nivel más profundo válido para cada celda; en la plataforma balear
 *  eso se traduce típicamente en corrientes cerca del sedimento. */
function elevationFor(depth: CurrentDepth): number | null {
  if (depth === "surface") return null;
  if (depth === "bottom") return -500;
  return -depth;
}

interface DataSource {
  dataset: string;
  uVar: string;
  vVar: string;
  style: string;
  tileStyle: string;
  min: number;
  max: number;
  nativeDeg: number;
  elevation: number | null;
}


function pickDataSource(bounds: L.LatLngBounds, depth: CurrentDepth): DataSource {
  const elevation = elevationFor(depth);
  const forceMed = depth !== "surface"; // corrientes en profundidad solo con MEDSEA
  const center = bounds.getCenter();
  const cLat = center.lat;
  const cLon = center.lng;
  const centerInMed =
    cLat >= MED_BBOX.south - 1.5 &&
    cLat <= MED_BBOX.north + 1.5 &&
    cLon >= MED_BBOX.west - 2 &&
    cLon <= MED_BBOX.east + 2;

  const medFullyVisible =
    bounds.getWest() <= MED_BBOX.west &&
    bounds.getEast() >= MED_BBOX.east &&
    bounds.getSouth() <= MED_BBOX.south &&
    bounds.getNorth() >= MED_BBOX.north;

  const interW = Math.max(bounds.getWest(), MED_BBOX.west);
  const interE = Math.min(bounds.getEast(), MED_BBOX.east);
  const interS = Math.max(bounds.getSouth(), MED_BBOX.south);
  const interN = Math.min(bounds.getNorth(), MED_BBOX.north);
  const interArea = Math.max(0, interE - interW) * Math.max(0, interN - interS);
  const medArea = (MED_BBOX.east - MED_BBOX.west) * (MED_BBOX.north - MED_BBOX.south);
  const medCoverage = medArea > 0 ? interArea / medArea : 0;

  // Basta con que el viewport toque el Mediterráneo para usar la fuente MEDSEA.
  const useMed = forceMed || centerInMed || medFullyVisible || medCoverage > 0 || interArea > 0;

  if (useMed) {
    return {
      dataset: MED_DATASET,
      uVar: MED_U_VAR,
      vVar: MED_V_VAR,
      style: MED_STYLE,
      tileStyle: "cmap:gray,vmin:-1,vmax:1",
      min: -1,
      max: 1,
      nativeDeg: 1 / 24,
      elevation,
    };
  }
  return {
    dataset: GLOBAL_DATASET,
    uVar: GLOBAL_U_VAR,
    vVar: GLOBAL_V_VAR,
    style: GLOBAL_STYLE,
    tileStyle: "cmap:gray,vmin:-1.2,vmax:1.2",
    min: -1.2,
    max: 1.2,
    nativeDeg: 0.125,
    elevation: null,
  };
}


function isMediterraneanSource(source: DataSource): boolean {
  return source.dataset === MED_DATASET;
}

function getSamplingBounds(bounds: L.LatLngBounds, source: DataSource): L.LatLngBounds | null {
  if (isMediterraneanSource(source)) {
    // Muestreamos viewport + margen (clip al MEDSEA). Así hay corrientes en
    // Baleares y en cualquier parte del Mediterráneo hacia la que hagas pan
    // o zoom, sin saturar la red con miles de puntos fuera de pantalla.
    const lonPad = Math.max(0.5, Math.abs(bounds.getEast() - bounds.getWest()) * 0.3);
    const latPad = Math.max(0.35, Math.abs(bounds.getNorth() - bounds.getSouth()) * 0.3);
    const west = Math.max(MED_BBOX.west, bounds.getWest() - lonPad);
    const east = Math.min(MED_BBOX.east, bounds.getEast() + lonPad);
    const south = Math.max(MED_BBOX.south, bounds.getSouth() - latPad);
    const north = Math.min(MED_BBOX.north, bounds.getNorth() + latPad);
    if (east <= west || north <= south) return null;
    return L.latLngBounds([south, west], [north, east]);
  }
  const limit = { north: WORLD_NORTH, south: WORLD_SOUTH, west: WORLD_WEST, east: WORLD_EAST };
  const north = Math.min(limit.north, bounds.getNorth());
  const south = Math.max(limit.south, bounds.getSouth());
  const west = Math.max(limit.west, bounds.getWest());
  const east = Math.min(limit.east, bounds.getEast());
  if (east <= west || north <= south) return null;
  return L.latLngBounds([south, west], [north, east]);
}

function pickGridSpec(bounds: L.LatLngBounds, source: DataSource) {
  const width = Math.abs(bounds.getEast() - bounds.getWest());
  const height = Math.abs(bounds.getNorth() - bounds.getSouth());
  const extent = Math.max(width, height);
  if (isMediterraneanSource(source)) {
    // Grilla cercana a la resolución nativa del MEDSEA (~1/24°). La dirección
    // local no se inventa por color ni por suavizado: se interpola entre
    // valores físicos U/V muestreados con GetFeatureInfo.
    const targetSpacing =
      extent < 2
        ? source.nativeDeg * 1.6
        : extent < 4
          ? source.nativeDeg * 2.1
          : extent < 8
            ? source.nativeDeg * 3.0
            : Math.max(source.nativeDeg * 4.0, extent / 44);
    const nx = Math.max(16, Math.min(46, Math.round(width / targetSpacing) + 1));
    const ny = Math.max(10, Math.min(32, Math.round(height / targetSpacing) + 1));
    const wmtsZoom = 9;
    return { nx, ny, wmtsZoom };
  }
  const targetSpacing = Math.max(source.nativeDeg * 2.2, extent / 18);
  const nx = Math.max(10, Math.min(22, Math.round(extent / targetSpacing) + 2));
  const ny = Math.max(8, Math.min(18, Math.round(nx * 0.74)));
  let wmtsZoom = 5;
  if (extent < 30) wmtsZoom = 6;
  if (extent < 12) wmtsZoom = 7;
  if (extent < 5) wmtsZoom = 8;
  if (extent < 2) wmtsZoom = 9;
  return { nx, ny, wmtsZoom };
}

type CurrentSample = number | null;

type StreamlineIntensity = "low" | "medium" | "high";

interface VelocityGrid {
  uValues: CurrentSample[];
  vValues: CurrentSample[];
  west: number;
  east: number;
  north: number;
  south: number;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  time: string;
  source: DataSource;
}

function buildSampleUrl(
  source: DataSource,
  variable: string,
  lat: number,
  lon: number,
  time: string,
  z: number,
): string {
  const n = 2 ** z;
  const x = Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const latRad = (lat * Math.PI) / 180;
  const y = Math.min(
    n - 1,
    Math.max(
      0,
      Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
    ),
  );
  const tileW = 256;
  const lonLeft = (x / n) * 360 - 180;
  const lonRight = ((x + 1) / n) * 360 - 180;
  const latTop = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const latBot = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  const i = Math.min(
    tileW - 1,
    Math.max(0, Math.floor(((lon - lonLeft) / (lonRight - lonLeft)) * tileW)),
  );
  const j = Math.min(
    tileW - 1,
    Math.max(0, Math.floor(((latTop - lat) / (latTop - latBot)) * tileW)),
  );
  const params = new URLSearchParams({
    SERVICE: "WMTS",
    REQUEST: "GetFeatureInfo",
    VERSION: "1.0.0",
    LAYER: `${source.dataset}/${variable}`,
    STYLE: source.style,
    FORMAT: "image/png",
    TILEMATRIXSET: "EPSG:3857",
    TILEMATRIX: String(z),
    TILEROW: String(y),
    TILECOL: String(x),
    INFOFORMAT: "application/json",
    I: String(i),
    J: String(j),
    TIME: `${time.slice(0, 10)}T00:00:00.000Z`,
  });
  if (source.elevation != null) params.set("ELEVATION", String(source.elevation));
  return `${WMTS_URL}?${params.toString()}`;
}

function proxiedUrl(url: string): string {
  return `${PROXY_PREFIX}${encodeURIComponent(url)}`;
}

interface DecodedVelocityTile {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const decodedVelocityTiles = new Map<string, Promise<DecodedVelocityTile | null>>();

function lonLatToTilePixel(lat: number, lon: number, z: number) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tileX = Math.min(n - 1, Math.max(0, Math.floor(x)));
  const tileY = Math.min(n - 1, Math.max(0, Math.floor(y)));
  return {
    tileX,
    tileY,
    px: Math.min(255, Math.max(0, Math.floor((x - tileX) * 256))),
    py: Math.min(255, Math.max(0, Math.floor((y - tileY) * 256))),
  };
}

function buildVelocityTileUrl(
  source: DataSource,
  variable: string,
  tileX: number,
  tileY: number,
  time: string,
  z: number,
): string {
  const params = new URLSearchParams({
    SERVICE: "WMTS",
    REQUEST: "GetTile",
    VERSION: "1.0.0",
    LAYER: `${source.dataset}/${variable}`,
    STYLE: source.tileStyle,
    FORMAT: "image/png",
    TILEMATRIXSET: "EPSG:3857",
    TILEMATRIX: String(z),
    TILEROW: String(tileY),
    TILECOL: String(tileX),
    TIME: `${time.slice(0, 10)}T00:00:00.000Z`,
  });
  if (source.elevation != null) params.set("ELEVATION", String(source.elevation));
  return `${WMTS_URL}?${params.toString()}`;
}

async function fetchDecodedVelocityTile(
  source: DataSource,
  variable: string,
  tileX: number,
  tileY: number,
  time: string,
  z: number,
  signal: AbortSignal,
): Promise<DecodedVelocityTile | null> {
  const key = `${source.dataset}:${variable}:${z}:${tileX}:${tileY}:${time.slice(0, 10)}:${source.elevation ?? "s"}`;
  const existing = decodedVelocityTiles.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const url = proxiedUrl(buildVelocityTileUrl(source, variable, tileX, tileY, time, z));
    const backoffs = [120, 300, 700];
    for (let attempt = 0; attempt < backoffs.length; attempt++) {
      try {
        const res = await fetch(url, { signal, cache: "force-cache", headers: { Accept: "image/png" } });
        if (res.status === 429 || res.status === 502 || res.status === 503) {
          await new Promise((r) => window.setTimeout(r, backoffs[attempt]));
          continue;
        }
        if (!res.ok) return null;
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return { width: canvas.width, height: canvas.height, data: img.data };
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") throw err;
        await new Promise((r) => window.setTimeout(r, backoffs[attempt]));
      }
    }
    return null;
  })();

  decodedVelocityTiles.set(key, promise);
  promise.catch(() => {
    if (decodedVelocityTiles.get(key) === promise) decodedVelocityTiles.delete(key);
  });
  if (decodedVelocityTiles.size > 384) {
    const first = decodedVelocityTiles.keys().next().value;
    if (first) decodedVelocityTiles.delete(first);
  }
  return promise;
}

async function sampleValue(
  source: DataSource,
  variable: string,
  lat: number,
  lon: number,
  time: string,
  z: number,
  signal: AbortSignal,
): Promise<CurrentSample> {
  if (!EXACT_VECTOR_SAMPLING && typeof document !== "undefined" && typeof createImageBitmap !== "undefined") {
    const { tileX, tileY, px, py } = lonLatToTilePixel(lat, lon, z);
    const tile = await fetchDecodedVelocityTile(source, variable, tileX, tileY, time, z, signal);
    if (tile) {
      const x = Math.min(tile.width - 1, Math.max(0, px));
      const y = Math.min(tile.height - 1, Math.max(0, py));
      const i = (y * tile.width + x) * 4;
      if (tile.data[i + 3] >= 8) {
        // cmap:gray es lineal en [vmin, vmax] → preserva el signo.
        return source.min + (tile.data[i] / 255) * (source.max - source.min);
      }
      return null;
    }
  }

  const url = proxiedUrl(buildSampleUrl(source, variable, lat, lon, time, z));
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (res.status === 429 || res.status === 503 || res.status === 502) {
        const delay = 250 * Math.pow(2.4, attempt) + Math.random() * 200;
        await new Promise((r) => window.setTimeout(r, delay));
        continue;
      }
      if (!res.ok) return null;
      const json = (await res.json()) as {
        features?: Array<{ properties?: { value?: number | null } }>;
      };
      const v = json.features?.[0]?.properties?.value;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") throw err;
      await new Promise((r) => window.setTimeout(r, 450 * (attempt + 1)));
    }
  }
  return null;
}

async function sampleGrid(
  bounds: L.LatLngBounds,
  time: string,
  depth: CurrentDepth,
  signal: AbortSignal,
  onPartial: (grid: VelocityGrid) => void,
): Promise<void> {
  const source = pickDataSource(bounds, depth);
  const clipped = getSamplingBounds(bounds, source);
  if (!clipped) return;

  const north = clipped.getNorth();
  const south = clipped.getSouth();
  const west = clipped.getWest();
  const east = clipped.getEast();
  const { nx, ny, wmtsZoom } = pickGridSpec(clipped, source);
  const dx = (east - west) / (nx - 1);
  const dy = (north - south) / (ny - 1);
  const total = nx * ny;
  const uValues = new Array<CurrentSample>(total).fill(null);
  const vValues = new Array<CurrentSample>(total).fill(null);

  const points: Array<{ lat: number; lon: number; idx: number }> = [];
  for (let j = 0; j < ny; j++) {
    const lat = north - j * dy;
    for (let i = 0; i < nx; i++) {
      points.push({ lat, lon: west + i * dx, idx: j * nx + i });
    }
  }

  const BATCH = isMediterraneanSource(source) ? 22 : 28;
  const INTER_BATCH_MS = isMediterraneanSource(source) ? 35 : 28;

  let filled = 0;
  let lastReport = 0;
  for (let start = 0; start < total; start += BATCH) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const slice = points.slice(start, start + BATCH);
    await Promise.all(
      slice.map(async (p) => {
        const u = await sampleValue(source, source.uVar, p.lat, p.lon, time, wmtsZoom, signal);
        const v = await sampleValue(source, source.vVar, p.lat, p.lon, time, wmtsZoom, signal);
        uValues[p.idx] = u;
        vValues[p.idx] = v;
        filled += 1;
      }),
    );
    const pct = filled / total;
    if (pct === 1 || pct - lastReport >= 0.12) {
      lastReport = pct;
      onPartial({
        uValues,
        vValues,
        west,
        east,
        north,
        south,
        dx,
        dy,
        nx,
        ny,
        time,
        source,
      });
    }
    await new Promise((r) => window.setTimeout(r, INTER_BATCH_MS));
  }
}

/** Suavizado gaussiano 3×3, además rellena huecos costeros. */
function smoothGrid(grid: VelocityGrid): VelocityGrid {
  const { nx, ny, uValues, vValues } = grid;
  const u = new Array<CurrentSample>(nx * ny).fill(null);
  const v = new Array<CurrentSample>(nx * ny).fill(null);
  const w = [
    [1, 2, 1],
    [2, 4, 2],
    [1, 2, 1],
  ];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let sU = 0;
      let sV = 0;
      let wT = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ny) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= nx) continue;
          const idx = yy * nx + xx;
          const uu = uValues[idx];
          const vv = vValues[idx];
          if (uu == null || vv == null) continue;
          const ww = w[dy + 1][dx + 1];
          sU += uu * ww;
          sV += vv * ww;
          wT += ww;
        }
      }
      if (wT >= 4) {
        u[y * nx + x] = sU / wT;
        v[y * nx + x] = sV / wT;
      }
    }
  }
  return { ...grid, uValues: u, vValues: v };
}

function hasUsableData(grid: VelocityGrid): boolean {
  for (let i = 0; i < grid.uValues.length; i++) {
    const u = grid.uValues[i];
    const v = grid.vValues[i];
    if (u == null || v == null) continue;
    if (Math.sqrt(u * u + v * v) >= 0.003) return true;
  }
  return false;
}

export type { StreamlineIntensity };

interface VelocityLayerProps {
  time: string;
  opacity?: number;
  intensity?: StreamlineIntensity;
  depth?: CurrentDepth;
  onNoData?: () => void;
  refreshKey?: string;
}


interface StreamlineVisualOptions {
  opacity: number;
  intensity: StreamlineIntensity;
  isSmallScreen: boolean;
}

interface Particle {
  x: number;
  y: number;
  age: number;
}

class CurrentStreamlineLayer extends L.Layer {
  private mapRef: L.Map | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private frameId: number | null = null;
  private particles: Particle[] = [];
  private lastFrame = 0;

  constructor(
    private grid: VelocityGrid,
    private visual: StreamlineVisualOptions,
  ) {
    super();
  }

  onAdd(map: L.Map): this {
    this.mapRef = map;
    const pane = map.getPane(VELOCITY_PANE) ?? map.createPane(VELOCITY_PANE);
    pane.style.zIndex = "640";
    pane.style.pointerEvents = "none";
    pane.style.background = "transparent";

    const canvas = L.DomUtil.create(
      "canvas",
      "leaflet-layer leaflet-zoom-hide velocity-overlay ocean-current-streamlines-canvas",
      pane,
    ) as HTMLCanvasElement;
    canvas.style.pointerEvents = "none";
    canvas.style.mixBlendMode = "normal";
    canvas.style.filter = "drop-shadow(0 0 0.6px rgba(0,0,0,0.6))";
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });

    map.on("moveend zoomend resize", this.handleMapChanged, this);
    this.resizeCanvas();
    this.resetParticles();
    this.start();
    return this;
  }

  onRemove(map: L.Map): this {
    map.off("moveend zoomend resize", this.handleMapChanged, this);
    if (this.frameId != null) window.cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.particles = [];
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.mapRef = null;
    return this;
  }

  setGrid(grid: VelocityGrid) {
    this.grid = grid;
    this.clearCanvas();
    this.resetParticles();
  }

  setVisualOptions(visual: StreamlineVisualOptions) {
    this.visual = visual;
    if (this.canvas) {
      const eff = Math.min(1, Math.max(0.65, visual.opacity));
      this.canvas.style.opacity = String(eff);
    }
    this.resetParticles();
  }

  private handleMapChanged = () => {
    this.resizeCanvas();
    this.clearCanvas();
    this.resetParticles();
  };

  private resizeCanvas() {
    if (!this.mapRef || !this.canvas) return;
    const size = this.mapRef.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(size.x * dpr));
    this.canvas.height = Math.max(1, Math.round(size.y * dpr));
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.canvas.style.opacity = String(Math.min(1, Math.max(0.65, this.visual.opacity)));
    L.DomUtil.setPosition(this.canvas, this.mapRef.containerPointToLayerPoint([0, 0]));
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private clearCanvas() {
    if (!this.ctx || !this.mapRef) return;
    const size = this.mapRef.getSize();
    this.ctx.clearRect(0, 0, size.x, size.y);
  }

  private density(): number {
    // Densidad muy reducida — estilo TimeZero/Windy: sólo circulación principal.
    if (this.visual.intensity === "low") return this.visual.isSmallScreen ? 0.00025 : 0.00040;
    if (this.visual.intensity === "medium") return this.visual.isSmallScreen ? 0.00045 : 0.00070;
    return this.visual.isSmallScreen ? 0.00075 : 0.00110;
  }

  private particleTarget(): number {
    if (!this.mapRef) return 0;
    const size = this.mapRef.getSize();
    const maxParticles = this.visual.isSmallScreen ? 260 : 850;
    return Math.max(60, Math.min(maxParticles, Math.round(size.x * size.y * this.density())));
  }

  private resetParticles() {
    if (!this.mapRef) return;
    const count = this.particleTarget();
    this.particles = [];
    for (let i = 0; i < count; i++) {
      this.particles.push(this.randomParticle(true));
    }
  }

  private randomParticle(randomAge = false): Particle {
    const size = this.mapRef?.getSize() ?? L.point(1, 1);
    const maxAge = this.visual.isSmallScreen ? 58 : 72;
    for (let attempt = 0; attempt < 70; attempt++) {
      const x = Math.random() * size.x;
      const y = Math.random() * size.y;
      if (this.vectorAtCanvasPoint(x, y)) {
        return { x, y, age: randomAge ? Math.floor(Math.random() * maxAge) : 0 };
      }
    }
    return {
      x: Math.random() * size.x,
      y: Math.random() * size.y,
      age: maxAge,
    };
  }

  private vectorAtCanvasPoint(x: number, y: number) {
    if (!this.mapRef) return null;
    const ll = this.mapRef.containerPointToLatLng(L.point(x, y));
    return this.interpolateVector(ll.lat, ll.lng);
  }

  private interpolateVector(lat: number, lon: number) {
    const { west, east, north, south, dx, dy, nx, ny, uValues, vValues } = this.grid;
    if (lon < west || lon > east || lat < south || lat > north || dx <= 0 || dy <= 0) return null;
    const gx = (lon - west) / dx;
    const gy = (north - lat) / dy;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    if (x0 < 0 || y0 < 0 || x0 >= nx - 1 || y0 >= ny - 1) return null;
    const tx = gx - x0;
    const ty = gy - y0;
    const idx00 = y0 * nx + x0;
    const idx10 = idx00 + 1;
    const idx01 = idx00 + nx;
    const idx11 = idx01 + 1;
    const samples = [idx00, idx10, idx01, idx11].map((idx) => ({ u: uValues[idx], v: vValues[idx] }));
    if (samples.some((s) => s.u == null || s.v == null)) return null;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    const u = samples[0].u! * w00 + samples[1].u! * w10 + samples[2].u! * w01 + samples[3].u! * w11;
    const v = samples[0].v! * w00 + samples[1].v! * w10 + samples[2].v! * w01 + samples[3].v! * w11;
    const speed = Math.sqrt(u * u + v * v);
    // Las streamlines siguen el FLUJO FÍSICO real (hacia donde va el agua),
    // igual que los visores oceanográficos. Los textos del panel siguen
    // indicando la procedencia ("de NO"), que es lo inverso a esta animación.
    return speed >= 0.002 ? { u, v, speed, lat, lon } : null;
  }

  private derivativeAt(lat: number, lon: number) {
    const vector = this.interpolateVector(lat, lon);
    if (!vector) return null;
    const metersPerDegLat = 110_540;
    const metersPerDegLon = Math.max(20_000, 111_320 * Math.cos((lat * Math.PI) / 180));
    return {
      dLat: vector.v / metersPerDegLat,
      dLon: vector.u / metersPerDegLon,
      speed: vector.speed,
    };
  }

  private stepForVector(vector: { u: number; v: number; speed: number; lat: number; lon: number }) {
    if (!this.mapRef) return null;
    // Integración RK4 en coordenadas geográficas. uo = este positivo, vo =
    // norte positivo; después se proyecta a píxel Leaflet. Así no se invierten
    // ejes ni signos de pantalla y la trayectoria respeta el sentido físico.
    const seconds = this.visual.isSmallScreen ? 2600 : 2100;
    const k1 = this.derivativeAt(vector.lat, vector.lon);
    if (!k1) return null;
    const k2 = this.derivativeAt(
      vector.lat + k1.dLat * seconds * 0.5,
      vector.lon + k1.dLon * seconds * 0.5,
    );
    if (!k2) return null;
    const k3 = this.derivativeAt(
      vector.lat + k2.dLat * seconds * 0.5,
      vector.lon + k2.dLon * seconds * 0.5,
    );
    if (!k3) return null;
    const k4 = this.derivativeAt(vector.lat + k3.dLat * seconds, vector.lon + k3.dLon * seconds);
    if (!k4) return null;
    const nextLat =
      vector.lat + (seconds / 6) * (k1.dLat + 2 * k2.dLat + 2 * k3.dLat + k4.dLat);
    const nextLon =
      vector.lon + (seconds / 6) * (k1.dLon + 2 * k2.dLon + 2 * k3.dLon + k4.dLon);
    const p0 = this.mapRef.latLngToContainerPoint([vector.lat, vector.lon]);
    const p1 = this.mapRef.latLngToContainerPoint([nextLat, nextLon]);
    let sx = p1.x - p0.x;
    let sy = p1.y - p0.y;
    const len = Math.sqrt(sx * sx + sy * sy);
    if (!Number.isFinite(len) || len < 0.02) return null;
    // Cap superior para que corrientes muy fuertes no den saltos que rompan
    // la curvatura visual; NO hay mínimo — las débiles avanzan poco.
    const maxStep = this.visual.isSmallScreen ? 3.2 : 2.6;
    if (len > maxStep) {
      sx = (sx / len) * maxStep;
      sy = (sy / len) * maxStep;
    }
    return { sx, sy };
  }

  private start() {
    const frame = (now: number) => {
      this.frameId = window.requestAnimationFrame(frame);
      const targetMs = 1000 / (this.visual.isSmallScreen ? 18 : 24);
      if (now - this.lastFrame < targetMs) return;
      this.lastFrame = now;
      this.drawFrame();
    };
    this.frameId = window.requestAnimationFrame(frame);
  }

  private drawFrame() {
    if (!this.ctx || !this.mapRef || !this.canvas) return;
    const ctx = this.ctx;
    const size = this.mapRef.getSize();
    const maxAge = this.visual.isSmallScreen ? 58 : 72;

    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "rgba(0, 0, 0, 0.93)";
    ctx.fillRect(0, 0, size.x, size.y);
    ctx.restore();

    // Pre-compute segments so we can stroke a dark halo first, then a bright
    // white line on top — this gives high contrast on any base map.
    const segments: Array<[number, number, number, number]> = [];
    // Puntas de flecha repetidas a lo largo de la trayectoria: indican el
    // sentido FÍSICO real del agua (hacia dónde va), coherente con u/v de
    // Copernicus (u = este +, v = norte +).
    const arrows: Array<{ x: number; y: number; dx: number; dy: number }> = [];
    const arrowEvery = this.visual.isSmallScreen ? 7 : 9;
    for (const particle of this.particles) {
      if (particle.age > maxAge) {
        Object.assign(particle, this.randomParticle(false));
        continue;
      }
      const vector = this.vectorAtCanvasPoint(particle.x, particle.y);
      const step = vector ? this.stepForVector(vector) : null;
      if (!vector || !step) {
        Object.assign(particle, this.randomParticle(false));
        continue;
      }
      const x2 = particle.x + step.sx;
      const y2 = particle.y + step.sy;
      if (x2 < 0 || y2 < 0 || x2 > size.x || y2 > size.y || !this.vectorAtCanvasPoint(x2, y2)) {
        Object.assign(particle, this.randomParticle(false));
        continue;
      }
      segments.push([particle.x, particle.y, x2, y2]);
      const len = Math.hypot(step.sx, step.sy);
      if (len > 0.15 && particle.age % arrowEvery === 0) {
        arrows.push({ x: x2, y: y2, dx: step.sx / len, dy: step.sy / len });
      }
      particle.x = x2;
      particle.y = y2;
      particle.age += 1;
    }


    // Halo oscuro fino — sólo para contraste, sin engordar la línea.
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = this.visual.isSmallScreen ? 1.6 : 1.4;
    ctx.strokeStyle = "rgba(0, 10, 25, 0.55)";
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of segments) {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
    ctx.restore();

    // Núcleo blanco fino y elegante.
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = this.visual.isSmallScreen ? 0.75 : 0.65;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of segments) {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
    ctx.restore();

    // Puntas de flecha (chevrons) apuntando hacia donde circula el agua.
    if (arrows.length) {
      const headLen = this.visual.isSmallScreen ? 5.2 : 6;
      const spread = 0.55; // radianes de apertura del chevron
      const drawHeads = () => {
        ctx.beginPath();
        for (const a of arrows) {
          const ang = Math.atan2(a.dy, a.dx);
          const lx = a.x - headLen * Math.cos(ang - spread);
          const ly = a.y - headLen * Math.sin(ang - spread);
          const rx = a.x - headLen * Math.cos(ang + spread);
          const ry = a.y - headLen * Math.sin(ang + spread);
          ctx.moveTo(lx, ly);
          ctx.lineTo(a.x, a.y);
          ctx.lineTo(rx, ry);
        }
        ctx.stroke();
      };

      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = this.visual.isSmallScreen ? 2.6 : 2.4;
      ctx.strokeStyle = "rgba(0, 10, 25, 0.65)";
      drawHeads();
      ctx.lineWidth = this.visual.isSmallScreen ? 1.3 : 1.2;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.98)";
      drawHeads();
      ctx.restore();
    }
  }

}

export function VelocityLayer({
  time,
  opacity = 0.9,
  intensity = "high",
  depth = "surface",
  onNoData,
  refreshKey,
}: VelocityLayerProps) {
  const map = useMap();
  const layerRef = useRef<CurrentStreamlineLayer | null>(null);

  useEffect(() => {
    return () => {
      if (layerRef.current) {
        try {
          map.removeLayer(layerRef.current);
        } catch {
          // no-op
        }
        layerRef.current = null;
      }
    };
  }, [map]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const isSmallScreen = typeof window !== "undefined" && window.innerWidth < 900;

    function ensureLayer(grid: VelocityGrid) {
      const visual = { opacity, intensity, isSmallScreen };
      if (!layerRef.current) {
        const layer = new CurrentStreamlineLayer(grid, visual);
        layer.addTo(map);
        layerRef.current = layer;
      } else {
        layerRef.current.setVisualOptions(visual);
        layerRef.current.setGrid(grid);
      }
    }

    async function refresh() {
      if (cancelled) return;
      try {
        await sampleGrid(map.getBounds(), time, depth, controller.signal, (grid: VelocityGrid) => {
          if (cancelled) return;
          if (!hasUsableData(grid)) return;
          // No suavizamos U/V: alterar promedios cambia el rumbo local. La
          // continuidad visual sale de la interpolación bilineal + RK4.
          ensureLayer(grid);
        });
        if (cancelled) return;
        if (!layerRef.current) onNoData?.();
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.warn("VelocityLayer: fallo al muestrear Copernicus", err);
          onNoData?.();
        }
      }
    }

    void refresh();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [map, time, opacity, intensity, depth, onNoData, refreshKey]);


  return null;
}

/**
 * Muestrea (u, v) en un punto usando EXACTAMENTE el mismo pipeline de datos
 * que las streamlines: GetFeatureInfo JSON de Copernicus para `uo/vo`.
 * Esto evita que el rumbo salga de colores de tiles renderizados y garantiza
 * coherencia entre crosshair, flecha de pesca y líneas.
 */
export async function sampleCurrentTileAt(
  lat: number,
  lng: number,
  depth: CurrentDepth,
  time: string,
  signal: AbortSignal,
): Promise<{ u: number; v: number } | null> {
  if (typeof window === "undefined") return null;
  // pickDataSource necesita un bounds; construimos uno mínimo alrededor del punto.
  const bounds = L.latLngBounds([lat - 0.01, lng - 0.01], [lat + 0.01, lng + 0.01]);
  const source = pickDataSource(bounds, depth);
  const z = isMediterraneanSource(source)
    ? 9
    : Math.max(4, Math.min(8, Math.round(Math.log2(360 / Math.max(source.nativeDeg, 0.01)))));
  const [u, v] = await Promise.all([
    sampleValue(source, source.uVar, lat, lng, time, z, signal),
    sampleValue(source, source.vVar, lat, lng, time, z, signal),
  ]);
  if (u == null || v == null) return null;
  return { u, v };
}



