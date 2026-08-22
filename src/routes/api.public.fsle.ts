/**
 * Endpoint público que calcula LCS (Lagrangian Coherent Structures) a partir
 * del campo FSLE (Finite-Size Lyapunov Exponent) derivado del producto de
 * corrientes de Copernicus Marine.
 *
 * ── Qué es y qué NO es ──────────────────────────────────────────────────
 *
 * Es un **FSLE lagrangiano REAL**, no un proxy de strain:
 *
 *   1. Descarga el campo (u, v) de Copernicus (Med: uo/vo) mediante tiles
 *      WMTS PNG cacheables y los remuestrea sobre una malla regular del bbox.
 *   2. Para cada celda de la malla siembra un par de partículas separadas
 *      por δ₀ y las advecta en el campo con un integrador RK4 de paso fijo.
 *   3. Cronometra τ = tiempo hasta que la separación alcanza δf.
 *   4. FSLE = ln(δf/δ₀) / τ  (día⁻¹).
 *   5. Extrae crestas 2D (non-maximum suppression perpendicular al gradiente)
 *      del campo FSLE y las convierte en polilíneas (LCS).
 *   6. Devuelve GeoJSON FeatureCollection de LineString.
 *   7. Cachea el resultado en Supabase Storage con clave que incluye
 *      fecha + bbox snappeado + resolución + δ₀ + δf.
 *
 * NO es el producto oficial AVISO-FSLE. AVISO integra hacia atrás durante
 * ~30 días con el campo temporal completo. Este endpoint integra con el
 * campo **congelado** del día seleccionado (FSLE cinemático / frozen field),
 * aproximación estándar en la literatura (Waugh & Abraham 2008; d'Ovidio
 * et al.). Captura correctamente las estructuras mesoescala; para
 * submesoescala <2 km haría falta un servicio Python externo con OceanParcels.
 *
 * ── Contrato ────────────────────────────────────────────────────────────
 *
 *   GET /api/public/fsle
 *     ?date=YYYY-MM-DD
 *     &south=<lat>&west=<lng>&north=<lat>&east=<lng>
 *     &res=<int>          (ignorado; resolución bloqueada por servidor)
 *     &delta0=<deg>       (ignorado; separación inicial bloqueada)
 *     &deltaF=<deg>       (ignorado; separación final bloqueada)
 *     &tauMaxDays=<num>   (ignorado; horizonte de integración bloqueado)
 *
 *   → 200 application/geo+json
 *     {
 *       type: "FeatureCollection",
 *       properties: { source, method, params, computedAt, cache },
 *       features: [ { type:"Feature", geometry:{ type:"LineString", coordinates:[[lng,lat]…] },
 *                     properties: { fsle } } ]
 *     }
 */

import { createFileRoute } from "@tanstack/react-router";
import UPNG from "upng-js";


const WMTS = "https://wmts.marine.copernicus.eu/teroWmts";
const BUCKET = "tile-cache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

// ── Modo navegación estable ────────────────────────────────────────────
// Rejilla fija de tiles geográficos de 2°×2° independiente de zoom, pantalla
// o visita. Para un mismo `date` + tile geográfico → mismo cálculo, misma
// caché, mismas líneas. El zoom del cliente sólo cambia el detalle visual.
// Los parámetros de cálculo también quedan bloqueados: cualquier `res`,
// `delta0`, `deltaF` o `tauMaxDays` recibido por query se ignora en la
// clave de caché y en el cómputo.
const TILE_DEG = 2;
// Malla de cómputo: 64×64 sobre el tile de 2° (≈3.5 km/celda a lat Med).
// El muestreo se hace por píxel sobre tiles WMTS PNG cacheables, así que
// aumentar la resolución no multiplica requests upstream — sólo cálculo local.
const CANON_RES = 64;
const CANON_DELTA0 = 0.04;
const CANON_DELTAF = 0.2;
// Integración con campo CONGELADO: por encima de ~10 días el error del
// "frozen field" (Copernicus diario, sin evolución temporal) domina el
// resultado. 7 días es la ventana estándar en literatura FSLE con campo
// fijo (d'Ovidio, Hernández-Carrasco).
const CANON_TAUMAX = 7;
// Solape entre tiles: se calcula FSLE en (tile + halo) y luego se
// recorta al núcleo. Sin halo, cada tile ve un dominio distinto de
// advección junto al borde y las crestas presentan cortes en x=y=2°k.
const TILE_OVERLAP_DEG = 0.25;
// Dirección de integración temporal.
//   'backward' → LCS ATRACTORAS (líneas donde se acumulan cardúmenes,
//                plancton y basura; lo que muestra TIMEZERO/AVISO).
//   'forward'  → LCS REPULSORAS (barreras de dispersión). Uso científico
//                minoritario.
// Se usa backward por defecto porque es el estándar operativo en pesca.
const CANON_DIRECTION: "backward" | "forward" = "backward";
const BBOX_KEY_VERSION = "v16-backward-noBayFill-landStrict-subpixRidge";


const WMTS_ZOOM = 7;
const TILE_PX = 256;
const VELOCITY_MIN = -1;
const VELOCITY_MAX = 1;
const VELOCITY_TILE_STYLE = "cmap:gray,vmin:-1,vmax:1";

type DecodedTile = { width: number; height: number; data: Uint8Array };
const decodedTilePromises = new Map<string, Promise<DecodedTile | null>>();


function tileBboxContaining(south: number, west: number): {
  bbox: Bbox;
  tileId: string;
} {
  const tS = Math.floor(south / TILE_DEG) * TILE_DEG;
  const tW = Math.floor(west / TILE_DEG) * TILE_DEG;
  return {
    bbox: { south: tS, west: tW, north: tS + TILE_DEG, east: tW + TILE_DEG },
    tileId: `y${tS.toFixed(0)}_x${tW.toFixed(0)}`,
  };
}

const MED = {
  bbox: { west: -6, east: 36, south: 30, north: 46 },
  dataset:
    "MEDSEA_ANALYSISFORECAST_PHY_006_013/cmems_mod_med_phy-cur_anfc_4.2km_P1D-m_202511",
  uVar: "uo",
  vVar: "vo",
  style: "cmap:RdBu_r,vmin:-1,vmax:1",
};

// Global de altimetría (produce campo geostrófico). En el catálogo WMTS
// aparece expuesto sólo como la capa "surface_geostrophic_sea_water_velocity",
// que en GetFeatureInfo no separa componentes por variable. Por ahora este
// endpoint sólo garantiza cobertura Mediterráneo; fuera del bbox Med devolvemos
// un 422 informativo para que el cliente no muestre una capa vacía sin motivo.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// ────────────────────────────── utilidades ──────────────────────────────

function snapStepForZoom(res: number): number {
  // Snap del bbox a una rejilla fija para estabilizar la clave de caché.
  if (res <= 12) return 0.5;
  if (res <= 18) return 0.25;
  if (res <= 24) return 0.125;
  return 0.0625;
}
function snap(v: number, step: number, mode: "floor" | "ceil"): number {
  return mode === "floor"
    ? Math.floor(v / step) * step
    : Math.ceil(v / step) * step;
}

interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

function bboxInsideMed(b: Bbox): boolean {
  return (
    b.south >= MED.bbox.south - 0.5 &&
    b.north <= MED.bbox.north + 0.5 &&
    b.west >= MED.bbox.west - 0.5 &&
    b.east <= MED.bbox.east + 0.5
  );
}

function lonLatToTilePixel(
  lat: number,
  lng: number,
  zoom: number,
): { tileX: number; tileY: number; px: number; py: number } {
  const n = Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tileX = Math.floor(x);
  const tileY = Math.floor(y);
  return {
    tileX,
    tileY,
    px: Math.min(TILE_PX - 1, Math.max(0, Math.round((x - tileX) * TILE_PX))),
    py: Math.min(TILE_PX - 1, Math.max(0, Math.round((y - tileY) * TILE_PX))),
  };
}

function decodeVelocityPixel(tile: DecodedTile, px: number, py: number): number | null {
  const i = (py * tile.width + px) * 4;
  const alpha = tile.data[i + 3];
  if (alpha < 8) return null;
  return VELOCITY_MIN + (tile.data[i] / 255) * (VELOCITY_MAX - VELOCITY_MIN);
}

async function fetchDecodedWmtsTile(
  variable: string,
  tileX: number,
  tileY: number,
  time: string,
  signal: AbortSignal,
): Promise<DecodedTile | null> {
  const key = `${variable}:${WMTS_ZOOM}:${tileX}:${tileY}:${time.slice(0, 10)}`;
  const existing = decodedTilePromises.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<DecodedTile | null> => {
    const params = new URLSearchParams({
      SERVICE: "WMTS",
      REQUEST: "GetTile",
      VERSION: "1.0.0",
      LAYER: `${MED.dataset}/${variable}`,
      STYLE: VELOCITY_TILE_STYLE,
      FORMAT: "image/png",
      TILEMATRIXSET: "EPSG:3857",
      TILEMATRIX: String(WMTS_ZOOM),
      TILEROW: String(tileY),
      TILECOL: String(tileX),
      TIME: `${time.slice(0, 10)}T00:00:00.000Z`,
    });
    const url = `${WMTS}?${params.toString()}`;
    const BACKOFFS_MS = [250, 750, 1500];
    for (let attempt = 0; attempt < BACKOFFS_MS.length; attempt++) {
      if (signal.aborted) return null;
      try {
        const res = await fetch(url, { signal, headers: { accept: "image/png" } });
        if (res.status === 429 || res.status === 503) {
          await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt]));
          continue;
        }
        if (!res.ok) {
          console.warn("[fsle] tile fetch status", res.status, variable, tileX, tileY);
          return null;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        try {
          const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
          const rgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
          return { width: decoded.width, height: decoded.height, data: rgba };
        } catch (pngErr) {
          console.error("[fsle] PNG decode failed", (pngErr as Error).message, "bytes=", bytes.length);
          return null;
        }

      } catch (fetchErr) {
        console.warn("[fsle] tile fetch threw", (fetchErr as Error).message, attempt);
        if (attempt >= BACKOFFS_MS.length - 1) return null;
        await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt]));
      }
    }
    return null;
  })();


  decodedTilePromises.set(key, promise);
  if (decodedTilePromises.size > 256) {
    const first = decodedTilePromises.keys().next().value;
    if (first) decodedTilePromises.delete(first);
  }
  return promise;
}

async function copernicusPointFromTile(
  variable: string,
  lat: number,
  lng: number,
  time: string,
  signal: AbortSignal,
): Promise<number | null> {
  const { tileX, tileY, px, py } = lonLatToTilePixel(lat, lng, WMTS_ZOOM);
  const tile = await fetchDecodedWmtsTile(variable, tileX, tileY, time, signal);
  return tile ? decodeVelocityPixel(tile, px, py) : null;
}

// Descarga la malla u,v en el bbox desde tiles WMTS cacheables. Antes se hacía
// un GetFeatureInfo por punto y variable (miles de requests/tesela), lo que
// provocaba 429 y hacía que FSLE no cargase.
async function fetchVelocityGrid(
  bbox: Bbox,
  cols: number,
  rows: number,
  time: string,
  signal: AbortSignal,
): Promise<{ u: Float32Array; v: Float32Array; validCount: number }> {
  const dLon = (bbox.east - bbox.west) / (cols - 1);
  const dLat = (bbox.north - bbox.south) / (rows - 1);
  const u = new Float32Array(cols * rows);
  const v = new Float32Array(cols * rows);
  u.fill(NaN);
  v.fill(NaN);
  // Las llamadas reales se deduplican por tile PNG, así que este paralelismo
  // sólo recorre la malla local; no multiplica peticiones upstream.
  const CONCURRENCY = 24;

  const tasks: Array<() => Promise<void>> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lat = bbox.south + r * dLat;
      const lng = bbox.west + c * dLon;
      const idx = r * cols + c;
      tasks.push(async () => {
        const [uu, vv] = await Promise.all([
            copernicusPointFromTile(MED.uVar, lat, lng, time, signal),
            copernicusPointFromTile(MED.vVar, lat, lng, time, signal),
        ]);
        if (uu != null && vv != null) {
          u[idx] = uu;
          v[idx] = vv;
        }
      });
    }
  }

  let next = 0;
  let valid = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < tasks.length) {
        const my = next++;
        try {
          await tasks[my]();
        } catch {
          /* individual fetch failure → NaN */
        }
      }
    }),
  );
  // (Se eliminó el gap-fill 8-vecinos que rellenaba NaN aislados con la
  // media de vecinos válidos. Riesgo: introducía velocidades sintéticas
  // en celdas de costa donde Copernicus enmascara tierra, permitiendo
  // que las partículas RK4 "rozaran" o cruzaran tierra al ser advectadas.
  // TIMEZERO respeta la máscara del modelo; nosotros ahora también.)

  for (let k = 0; k < u.length; k++) if (Number.isFinite(u[k]) && Number.isFinite(v[k])) valid++;
  return { u, v, validCount: valid };
}

// Interpolación bilineal del campo (u, v) muestreado en la malla del bbox.
// Devuelve velocidad en grados/día (conversión desde m/s dependiente de lat).
function makeBilinearInterpolator(
  u: Float32Array,
  v: Float32Array,
  bbox: Bbox,
  cols: number,
  rows: number,
) {
  const dLon = (bbox.east - bbox.west) / (cols - 1);
  const dLat = (bbox.north - bbox.south) / (rows - 1);

  return function interp(
    lat: number,
    lng: number,
  ): { du: number; dv: number } | null {
    // Fuera del dominio muestreado → null. Antes hacíamos clamp al borde
    // (no-flow implícito) para evitar que las partículas cerca del borde
    // "murieran"; el efecto colateral era que las trayectorias quedaban
    // pegadas al borde y generaban FSLE artificial paralelo al bbox.
    // Como ahora el dominio muestreado (padBbox) siempre incluye halo
    // suficiente alrededor del tile, descartar es lo correcto: si una
    // partícula abandona el dominio de datos, no podemos advectarla más.
    if (lat < bbox.south || lat > bbox.north || lng < bbox.west || lng > bbox.east) return null;
    const fc = (lng - bbox.west) / dLon;
    const fr = (lat - bbox.south) / dLat;
    const c0 = Math.floor(fc);
    const r0 = Math.floor(fr);
    const c1 = Math.min(cols - 1, c0 + 1);
    const r1 = Math.min(rows - 1, r0 + 1);
    const fx = fc - c0;
    const fy = fr - r0;
    const iA = r0 * cols + c0;
    const iB = r0 * cols + c1;
    const iC = r1 * cols + c0;
    const iD = r1 * cols + c1;
    const uA = u[iA], uB = u[iB], uC = u[iC], uD = u[iD];
    const vA = v[iA], vB = v[iB], vC = v[iC], vD = v[iD];
    if (!Number.isFinite(uA) || !Number.isFinite(uB) || !Number.isFinite(uC) || !Number.isFinite(uD)) return null;
    if (!Number.isFinite(vA) || !Number.isFinite(vB) || !Number.isFinite(vC) || !Number.isFinite(vD)) return null;
    const um =
      uA * (1 - fx) * (1 - fy) + uB * fx * (1 - fy) + uC * (1 - fx) * fy + uD * fx * fy;
    const vm =
      vA * (1 - fx) * (1 - fy) + vB * fx * (1 - fy) + vC * (1 - fx) * fy + vD * fx * fy;
    // Conversión m/s → grados/día. 1° lat = 111 km; 1° lon = 111·cos(lat) km.
    const secondsPerDay = 86400;
    const dv = (vm * secondsPerDay) / 111_000;
    const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
    const du = (um * secondsPerDay) / (111_000 * cosLat);
    return { du, dv };
  };
}

// Un paso RK4 sobre el campo (grados/día). dt en días.
function rk4Step(
  lat: number,
  lng: number,
  dt: number,
  interp: (lat: number, lng: number) => { du: number; dv: number } | null,
): [number, number] | null {
  const k1 = interp(lat, lng);
  if (!k1) return null;
  const k2 = interp(lat + 0.5 * dt * k1.dv, lng + 0.5 * dt * k1.du);
  if (!k2) return null;
  const k3 = interp(lat + 0.5 * dt * k2.dv, lng + 0.5 * dt * k2.du);
  if (!k3) return null;
  const k4 = interp(lat + dt * k3.dv, lng + dt * k3.du);
  if (!k4) return null;
  const dLat = (dt / 6) * (k1.dv + 2 * k2.dv + 2 * k3.dv + k4.dv);
  const dLng = (dt / 6) * (k1.du + 2 * k2.du + 2 * k3.du + k4.du);
  return [lat + dLat, lng + dLng];
}

// FSLE por celda: siembra pareja separada δ₀ y avanza hasta separación δf
// o hasta agotar τ_max. Devuelve tiempo en días o null si no separa.
//
// `direction`:
//   'backward' → dt negativo. Detecta LCS ATRACTORAS (líneas de acumulación,
//                lo que TIMEZERO y AVISO-DUACS-FSLE muestran por defecto).
//   'forward'  → dt positivo. Detecta LCS repulsoras (barreras de dispersión).
function computeFsleField(
  interp: (lat: number, lng: number) => { du: number; dv: number } | null,
  bbox: Bbox,
  cols: number,
  rows: number,
  delta0: number,
  deltaF: number,
  tauMaxDays: number,
  direction: "backward" | "forward" = "backward",
): { fsle: Float32Array; anyValid: boolean } {
  const dLon = (bbox.east - bbox.west) / (cols - 1);
  const dLat = (bbox.north - bbox.south) / (rows - 1);
  const fsle = new Float32Array(cols * rows);
  fsle.fill(NaN);
  const dtMag = 2 / 24; // 2 h (RK4)
  const dt = direction === "backward" ? -dtMag : dtMag;
  const steps = Math.ceil(tauMaxDays / dtMag);
  const deltaF2 = deltaF * deltaF;
  const logRatio = Math.log(deltaF / delta0);
  let anyValid = false;


  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lat0 = bbox.south + r * dLat;
      const lng0 = bbox.west + c * dLon;
      if (!interp(lat0, lng0)) continue;
      // 4 vecinos a δ₀ (N/S/E/W). Basta con dos ortogonales para el
      // criterio de FSLE clásico; con cuatro es más robusto al signo.
      const seeds: Array<[number, number]> = [
        [lat0 + delta0, lng0],
        [lat0 - delta0, lng0],
        [lat0, lng0 + delta0],
        [lat0, lng0 - delta0],
      ];
      // Comprobamos que los cuatro vecinos también están sobre agua.
      const alive: Array<[number, number] | null> = seeds.map((p) =>
        interp(p[0], p[1]) ? p : null,
      );
      let center: [number, number] = [lat0, lng0];
      let tau: number | null = null;
      for (let s = 0; s < steps; s++) {
        const next = rk4Step(center[0], center[1], dt, interp);
        if (!next) break;
        center = next;
        let maxSep2 = 0;
        let allDead = true;
        for (let a = 0; a < alive.length; a++) {
          const p = alive[a];
          if (!p) continue;
          const np = rk4Step(p[0], p[1], dt, interp);
          if (!np) {
            alive[a] = null;
            continue;
          }
          alive[a] = np;
          allDead = false;
          const dLatSep = np[0] - center[0];
          const dLngSep =
            (np[1] - center[1]) * Math.cos((center[0] * Math.PI) / 180);
          const d2 = dLatSep * dLatSep + dLngSep * dLngSep;
          if (d2 > maxSep2) maxSep2 = d2;
        }
        if (allDead) break;
        if (maxSep2 >= deltaF2) {
          tau = (s + 1) * dtMag;
          break;
        }
}
      if (tau != null && tau > 0) {
        fsle[r * cols + c] = logRatio / tau;
        anyValid = true;
      } else {
        // Convención estándar FSLE (Aurell/d'Ovidio): pareja sembrada en agua
        // que no alcanza δf dentro de τ_max → λ = 0 (sin estiramiento medido).
        // NaN queda reservado para tierra / sin datos. Sin esto el campo es
        // casi todo NaN y la extracción de crestas no tiene fondo contra el
        // que detectar máximos.
        fsle[r * cols + c] = 0;
        anyValid = true;
      }
    }
  }
  return { fsle, anyValid };
}

// (Se eliminó `fillBayCells`: rellenaba las bahías de Palma/Alcúdia con
// vecino más cercano del FSLE. TIMEZERO no fabrica datos donde el modelo
// no calcula. Preferimos huecos honestos a líneas inventadas.)




// Suavizado gaussiano ligero 3×3 (σ≈1) para estabilizar la extracción de
// crestas frente al ruido del muestreo.
function smoothFsle(fsle: Float32Array, cols: number, rows: number): Float32Array {
  const out = new Float32Array(fsle.length);
  // Kernel gaussiano MUY ligero (σ≈0.6): centro 8, cardinales 2, esquinas 1.
  // Un σ mayor desplaza los máximos hasta 0.3-0.5 celdas (~1.5 km) — TIMEZERO
  // apenas suaviza, así que preferimos crestas ligeramente más "ruidosas"
  // pero geométricamente fieles al FSLE crudo.
  const K = [1, 2, 1, 2, 8, 2, 1, 2, 1];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const center = fsle[r * cols + c];
      // CRÍTICO: no rellenamos celdas NaN con sus vecinos válidos.
      // Si lo hiciéramos, las regiones sin FSLE calculado (tierra, celdas
      // que nunca alcanzan δf, huecos por land-mask) se "inflarían" con
      // los valores del sea-adjacent, produciendo alineaciones artificiales
      // (típicamente rectas verticales u horizontales siguiendo la costa).
      if (!Number.isFinite(center)) {
        out[r * cols + c] = NaN;
        continue;
      }
      let acc = 0;
      let w = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          const val = fsle[rr * cols + cc];
          if (!Number.isFinite(val)) continue;
          const k = K[(dr + 1) * 3 + (dc + 1)];
          acc += val * k;
          w += k;
        }
      }
      out[r * cols + c] = w > 0 ? acc / w : NaN;
    }
  }
  return out;
}

// Extracción de crestas con validación moderada para mostrar más LCS:
//   – Test Hessiano: sólo cell con curvatura principal negativa fuerte y
//     anisotropía alta (autovalor λ₂ ≪ 0, |λ₂/λ₁| > anisoMin) — es la
//     forma canónica de detectar crestas 2D (Lindeberg / Steger).
//   – NMS perpendicular al gradiente y umbral P55 sobre el campo FSLE.
//   – Rechaza cadenas que atraviesen celdas por debajo del umbral CRUDO.
//   – Marca cadenas adyacentes a NaN (`nearNaN`).
//   – Devuelve FSLE absoluto por vértice para poder verificarlo en la UI.
//   – Confianza (0..1) = 0.30·continuidad + 0.35·intensidad + 0.35·estabilidad.
//   – Descarta cadenas con confianza < 0.25 o longitud < 3 vértices.
function extractRidges(
  smoothed: Float32Array,
  raw: Float32Array,
  bbox: Bbox,
  cols: number,
  rows: number,
): {
  ridges: Array<{
    points: Array<[number, number]>;
    fsleValues: number[];
    fsleNorm: number;
    fsleAvg: number;
    fsleMax: number;
    lengthKm: number;
    confidence: number;
    nearNaN: boolean;
  }>;
  thresholdAbs: number;
  thresholdStrong: number;
  globalMax: number;
} {
  const dLon = (bbox.east - bbox.west) / (cols - 1);
  const dLat = (bbox.north - bbox.south) / (rows - 1);
  const vals: number[] = [];
  for (let k = 0; k < smoothed.length; k++) if (Number.isFinite(smoothed[k]) && smoothed[k] > 0) vals.push(smoothed[k]);
  if (vals.length < 10) return { ridges: [], thresholdAbs: 0, thresholdStrong: 0, globalMax: 0 };
  vals.sort((a, b) => a - b);
  // P42 = corte de cresta denso; P72 = "cresta fuerte".
  const thresh = vals[Math.floor(vals.length * 0.42)];
  const strong = vals[Math.floor(vals.length * 0.72)];
  const maxVal = vals[vals.length - 1];
  const denom = Math.max(1e-6, maxVal - thresh);

  const isNaNCell = (i: number) => !Number.isFinite(raw[i]);
  const hasNaNNeighbor = (r: number, c: number): boolean => {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) return true;
        if (isNaNCell(rr * cols + cc)) return true;
      }
    }
    return false;
  };

  // Umbral Hessiano: curvatura principal negativa suficientemente fuerte.
  // Normalizamos por el rango global para independizar de la magnitud FSLE.
  const CURVATURE_MIN = 0.025 * maxVal;  // |λ₂| debe superar este valor
  const ANISO_MIN = 0.35;                // |λ₂| / (|λ₁|+ε) — descarta puntos "blob"

  const ridge = new Uint8Array(cols * rows);
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c;
      const val = smoothed[i];
      if (!Number.isFinite(val) || val < thresh) continue;
      const rawVal = raw[i];
      if (!Number.isFinite(rawVal) || rawVal < thresh * 0.85) continue;

      // ── Hessiano por diferencias finitas ──
      const s_l = smoothed[i - 1], s_r = smoothed[i + 1];
      const s_u = smoothed[i - cols], s_d = smoothed[i + cols];
      const s_ul = smoothed[i - cols - 1], s_ur = smoothed[i - cols + 1];
      const s_dl = smoothed[i + cols - 1], s_dr = smoothed[i + cols + 1];
      if (![s_l, s_r, s_u, s_d, s_ul, s_ur, s_dl, s_dr].every(Number.isFinite)) continue;
      const Hxx = s_r - 2 * val + s_l;
      const Hyy = s_d - 2 * val + s_u;
      const Hxy = (s_dr - s_dl - s_ur + s_ul) / 4;
      const tr = Hxx + Hyy;
      const det = Hxx * Hyy - Hxy * Hxy;
      const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      const lam1 = tr / 2 + disc;         // mayor autovalor
      const lam2 = tr / 2 - disc;         // menor autovalor (más negativo)
      // Cresta: λ₂ fuertemente negativo (curvatura perpendicular a la cresta)
      if (lam2 > -CURVATURE_MIN) continue;
      const aniso = Math.abs(lam2) / (Math.abs(lam1) + 1e-9);
      if (aniso < ANISO_MIN) continue;

      // ── NMS perpendicular al gradiente ──
      const gx = (s_r - s_l) / 2;
      const gy = (s_d - s_u) / 2;
      const gm = Math.hypot(gx, gy);
      if (gm < 1e-9) {
        // Meseta: exige máximo estricto en vecindad 3×3.
        let isMax = true;
        for (let dr = -1; dr <= 1 && isMax; dr++) {
          for (let dc = -1; dc <= 1 && isMax; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nv = smoothed[(r + dr) * cols + (c + dc)];
            if (Number.isFinite(nv) && nv > val) isMax = false;
          }
        }
        if (isMax) ridge[i] = 1;
        continue;
      }
      const nx = gx / gm, ny = gy / gm;
      const sampleAt = (fx: number, fy: number): number => {
        const cc = c + fx, rr = r + fy;
        const c0 = Math.floor(cc), r0 = Math.floor(rr);
        const c1 = c0 + 1, r1 = r0 + 1;
        if (c0 < 0 || r0 < 0 || c1 >= cols || r1 >= rows) return NaN;
        const dx = cc - c0, dy = rr - r0;
        const a = smoothed[r0 * cols + c0];
        const b = smoothed[r0 * cols + c1];
        const cc2 = smoothed[r1 * cols + c0];
        const d = smoothed[r1 * cols + c1];
        if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(cc2) || !Number.isFinite(d)) return NaN;
        return a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + cc2 * (1 - dx) * dy + d * dx * dy;
      };
      const fwd = sampleAt(nx, ny);
      const bwd = sampleAt(-nx, -ny);
      // Tolerancia algo permisiva para conservar más crestas finas.
      const TOL = 0.94;
      const fOk = !Number.isFinite(fwd) || val >= fwd * TOL;
      const bOk = !Number.isFinite(bwd) || val >= bwd * TOL;
      if (!Number.isFinite(fwd) && !Number.isFinite(bwd)) continue;
      if (fOk && bOk) ridge[i] = 1;
    }
  }

  const visited = new Uint8Array(cols * rows);
  const ridgeIdx: number[] = [];
  for (let k = 0; k < ridge.length; k++) if (ridge[k]) ridgeIdx.push(k);
  ridgeIdx.sort((a, b) => smoothed[b] - smoothed[a]);

  const NEIGH = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1],
  ] as const;

  const toLatLng = (idx: number): [number, number] => {
    const r = Math.floor(idx / cols);
    const c = idx - r * cols;
    return [bbox.south + r * dLat, bbox.west + c * dLon];
  };

  const growFrom = (startIdx: number, sign: 1 | -1, prevIdx: number | null): number[] => {
    const chain: number[] = [];
    let cur = startIdx;
    let prev = prevIdx;
    let lastDr = 0, lastDc = 0;
    if (prevIdx != null) {
      lastDr = Math.floor(cur / cols) - Math.floor(prevIdx / cols);
      lastDc = (cur % cols) - (prevIdx % cols);
    }
    for (let iter = 0; iter < 64; iter++) {
      let bestIdx = -1, bestVal = -Infinity, bestDr = 0, bestDc = 0;
      const r = Math.floor(cur / cols);
      const c = cur - r * cols;
      for (const [dr, dc] of NEIGH) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        const ni = rr * cols + cc;
        if (!ridge[ni] || visited[ni]) continue;
        if (prev != null && ni === prev) continue;
        if ((lastDr !== 0 || lastDc !== 0) && dr * lastDr + dc * lastDc <= 0) continue;
        const val = smoothed[ni];
        if (val > bestVal) { bestVal = val; bestIdx = ni; bestDr = dr; bestDc = dc; }
      }
      if (bestIdx < 0) break;
      visited[bestIdx] = 1;
      chain.push(bestIdx);
      prev = cur; cur = bestIdx;
      lastDr = bestDr; lastDc = bestDc;
    }
    return sign === -1 ? chain.reverse() : chain;
  };

  const results: Array<{
    points: Array<[number, number]>;
    fsleValues: number[];
    fsleNorm: number;
    fsleAvg: number;
    fsleMax: number;
    lengthKm: number;
    confidence: number;
    nearNaN: boolean;
  }> = [];

  for (const seed of ridgeIdx) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    const back = growFrom(seed, -1, null);
    const fwd = growFrom(seed, 1, back[back.length - 1] ?? null);
    const chain = [...back, seed, ...fwd];
    if (chain.length < 3) continue;

    // Antes se rechazaban por completo las cadenas perfectamente rectas
    // (heurística anti-artefacto). Descartaba LCS reales alineadas con la
    // rejilla. Ahora se conservan y la stability las penaliza si procede.
    const rowsIdx = chain.map((i) => Math.floor(i / cols));
    const colsIdx = chain.map((i) => i - Math.floor(i / cols) * cols);

    // Recortar la cadena al tramo válido más largo (sin celdas bajas/NaN),
    // en lugar de descartarla entera si una sola celda falla.
    let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
    for (let k = 0; k <= chain.length; k++) {
      const valid = k < chain.length && Number.isFinite(raw[chain[k]]) && raw[chain[k]] >= thresh;
      if (valid) {
        if (curStart < 0) curStart = k;
        curLen++;
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      } else {
        curStart = -1; curLen = 0;
      }
    }
    if (bestLen < 3) continue;
    const trimmed = chain.slice(bestStart, bestStart + bestLen);
    const rowsT = rowsIdx.slice(bestStart, bestStart + bestLen);
    const colsT = colsIdx.slice(bestStart, bestStart + bestLen);
    chain.length = 0;
    chain.push(...trimmed);
    rowsIdx.length = 0; rowsIdx.push(...rowsT);
    colsIdx.length = 0; colsIdx.push(...colsT);

    let nearNaN = false;
    let strongCount = 0;
    let sum = 0;
    let maxV = -Infinity;
    const fsleValues: number[] = [];
    for (let k = 0; k < chain.length; k++) {
      const rv = raw[chain[k]];
      fsleValues.push(rv);
      sum += rv;
      if (rv > maxV) maxV = rv;
      if (rv >= strong) strongCount++;
      if (hasNaNNeighbor(rowsIdx[k], colsIdx[k])) nearNaN = true;
    }

    // Refinamiento SUB-PÍXEL de la cresta:
    // La cresta detectada está en el vértice de la rejilla. Perpendicular
    // al gradiente, ajustamos una parábola con los tres valores
    // f(-1), f(0), f(+1) y calculamos el offset del máximo:
    //   Δ = 0.5 · (f(-1) - f(+1)) / (f(-1) - 2·f(0) + f(+1))
    // Esto da una posición dentro de [-0.5, +0.5] celdas → líneas más
    // suaves y fieles al máximo real, sin aplicar smoothing extra.
    const pts: Array<[number, number]> = chain.map((idx) => {
      const r = Math.floor(idx / cols);
      const c = idx - r * cols;
      let subC = c;
      let subR = r;
      if (r > 0 && r < rows - 1 && c > 0 && c < cols - 1) {
        const s_l = smoothed[idx - 1], s_r = smoothed[idx + 1];
        const s_u = smoothed[idx - cols], s_d = smoothed[idx + cols];
        const val = smoothed[idx];
        if ([s_l, s_r, s_u, s_d, val].every(Number.isFinite)) {
          const gx = (s_r - s_l) / 2;
          const gy = (s_d - s_u) / 2;
          const gm = Math.hypot(gx, gy);
          if (gm > 1e-9) {
            const nx = gx / gm, ny = gy / gm;
            // Interpolación bilineal a lo largo del gradiente ±1 celda
            const sampleAt = (fx: number, fy: number): number => {
              const cc = c + fx, rr = r + fy;
              const c0 = Math.floor(cc), r0 = Math.floor(rr);
              const c1 = c0 + 1, r1 = r0 + 1;
              if (c0 < 0 || r0 < 0 || c1 >= cols || r1 >= rows) return NaN;
              const dx = cc - c0, dy = rr - r0;
              const a = smoothed[r0 * cols + c0];
              const b = smoothed[r0 * cols + c1];
              const cc2 = smoothed[r1 * cols + c0];
              const d = smoothed[r1 * cols + c1];
              if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(cc2) || !Number.isFinite(d)) return NaN;
              return a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + cc2 * (1 - dx) * dy + d * dx * dy;
            };
            const fMinus = sampleAt(-nx, -ny);
            const fPlus = sampleAt(nx, ny);
            const denomP = fMinus - 2 * val + fPlus;
            if (Number.isFinite(fMinus) && Number.isFinite(fPlus) && Math.abs(denomP) > 1e-9) {
              let delta = 0.5 * (fMinus - fPlus) / denomP;
              // Clip a media celda para evitar saltos si el ajuste es malo.
              if (delta > 0.5) delta = 0.5;
              if (delta < -0.5) delta = -0.5;
              subC = c + delta * nx;
              subR = r + delta * ny;
            }
          }
        }
      }
      const lat = bbox.south + subR * dLat;
      const lng = bbox.west + subC * dLon;
      return [lng, lat];
    });

    let lengthKm = 0;
    for (let k = 1; k < pts.length; k++) {
      const [lng1, lat1] = pts[k - 1];
      const [lng2, lat2] = pts[k];
      const dLatKm = (lat2 - lat1) * 111;
      const dLngKm = (lng2 - lng1) * 111 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
      lengthKm += Math.hypot(dLatKm, dLngKm);
    }

    const avg = sum / chain.length;
    const norm = Math.max(0, Math.min(1, (avg - thresh) / denom));
    const continuity = Math.min(1, chain.length / 8);
    const intensity = Math.max(0, Math.min(1, (avg - thresh) / Math.max(1e-6, maxVal - thresh)));
    const stability = strongCount / chain.length;
    const confidence = 0.30 * continuity + 0.35 * intensity + 0.35 * stability;
    if (confidence < 0.16) continue;

    results.push({
      points: pts,
      fsleValues: fsleValues.map((v) => Number(v.toFixed(4))),
      fsleNorm: Number(norm.toFixed(3)),
      fsleAvg: Number(avg.toFixed(4)),
      fsleMax: Number(maxV.toFixed(4)),
      lengthKm: Number(lengthKm.toFixed(1)),
      confidence: Number(confidence.toFixed(3)),
      nearNaN,
    });
  }
  return { ridges: results, thresholdAbs: thresh, thresholdStrong: strong, globalMax: maxVal };
}

// ────────────────────────── caché en Storage ───────────────────────────

async function probeCachedJson(key: string): Promise<{ ageMs: number } | null> {
  // Consulta rápida (usada sólo por ?probe=1). Un round-trip a Storage.list().
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const lastSlash = key.lastIndexOf("/");
    const folder = key.slice(0, lastSlash);
    const file = key.slice(lastSlash + 1);
    const list = await supabaseAdmin.storage.from(BUCKET).list(folder, { limit: 1, search: file });
    const obj = list.data?.find((o) => o.name === file);
    if (!obj?.created_at) return null;
    const ageMs = Date.now() - new Date(obj.created_at).getTime();
    if (ageMs > CACHE_TTL_MS) return null;
    return { ageMs };
  } catch {
    return null;
  }
}

async function readCachedJson(
  key: string,
): Promise<{ payload: unknown; ageMs: number } | null> {
  // Camino rápido: un único round-trip. Descarga directa; si el objeto no
  // existe → MISS. La edad se deriva de `properties.storedAt` embebido en
  // el JSON al escribir. Esto reduce a la mitad la latencia de HIT (antes
  // hacíamos list+download → ~400-800 ms; ahora ~200 ms).
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const dl = await supabaseAdmin.storage.from(BUCKET).download(key);
    if (dl.error || !dl.data) return null;
    const text = await dl.data.text();
    const payload = JSON.parse(text) as { properties?: { storedAt?: string } };
    const storedAt = payload?.properties?.storedAt;
    const ageMs = storedAt ? Date.now() - new Date(storedAt).getTime() : 0;
    if (ageMs > CACHE_TTL_MS) return null;
    return { payload, ageMs };
  } catch {
    return null;
  }
}

async function writeCachedJson(key: string, payload: unknown): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Insertamos `storedAt` para que `readCachedJson` pueda calcular la edad
    // sin un segundo round-trip a Storage.list().
    const stamped =
      payload && typeof payload === "object"
        ? {
            ...(payload as Record<string, unknown>),
            properties: {
              ...((payload as { properties?: Record<string, unknown> }).properties ?? {}),
              storedAt: new Date().toISOString(),
            },
          }
        : payload;
    const blob = new Blob([JSON.stringify(stamped)], { type: "application/json" });
    await supabaseAdmin.storage.from(BUCKET).upload(key, blob, {
      contentType: "application/json",
      upsert: true,
      cacheControl: "86400",
    });
  } catch {
    /* best-effort */
  }
}

// ──────────────────────────── ruta HTTP ───────────────────────────────

export const Route = createFileRoute("/api/public/fsle")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const q = url.searchParams;

        const date = (q.get("date") || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return json({ error: "date=YYYY-MM-DD required" }, 400);
        }
        // ── Entrada del cliente ───────────────────────────────────────
        // Aceptamos DOS modalidades:
        //   a) `tileSouth` + `tileWest` (nuevo, preferido) — el cliente ya
        //      resolvió a qué tile de 2° pertenece la vista.
        //   b) `south`/`west`/`north`/`east` (compat) — el servidor deriva
        //      el tile a partir del bbox pedido.
        const qTileS = Number(q.get("tileSouth"));
        const qTileW = Number(q.get("tileWest"));
        let seedSouth: number;
        let seedWest: number;
        if (Number.isFinite(qTileS) && Number.isFinite(qTileW)) {
          seedSouth = qTileS;
          seedWest = qTileW;
        } else {
          const south = Number(q.get("south"));
          const west = Number(q.get("west"));
          const north = Number(q.get("north"));
          const east = Number(q.get("east"));
          if (![south, west, north, east].every(Number.isFinite) || south >= north || west >= east) {
            return json({ error: "tileSouth/tileWest o bbox válido requerido" }, 400);
          }
          seedSouth = south;
          seedWest = west;
        }

        // Parámetros bloqueados: cualquier valor recibido se ignora. Para un
        // mismo `date` + tile, el cálculo es idéntico entre visitas.
        const delta0 = CANON_DELTA0;
        const deltaF = CANON_DELTAF;
        const tauMaxDays = CANON_TAUMAX;

        // Tile geográfico fijo (2°×2°). El núcleo (`coreBbox`) es lo que se
        // publica al cliente; el cómputo se hace sobre `computeBbox` = núcleo
        // + halo `TILE_OVERLAP_DEG` para evitar discontinuidades entre tiles.
        const { bbox: coreBbox, tileId } = tileBboxContaining(seedSouth, seedWest);
        const computeBbox: Bbox = {
          south: Math.max(MED.bbox.south, coreBbox.south - TILE_OVERLAP_DEG),
          north: Math.min(MED.bbox.north, coreBbox.north + TILE_OVERLAP_DEG),
          west: Math.max(MED.bbox.west, coreBbox.west - TILE_OVERLAP_DEG),
          east: Math.min(MED.bbox.east, coreBbox.east + TILE_OVERLAP_DEG),
        };
        // Escalamos la resolución para preservar el tamaño de celda (≈5.5 km).
        const scale =
          ((computeBbox.east - computeBbox.west) +
            (computeBbox.north - computeBbox.south)) /
          (2 * TILE_DEG);
        const res = Math.max(CANON_RES, Math.round(CANON_RES * scale));
        // Alias legacy: gran parte del código downstream ya usaba `bbox`.
        const bbox = computeBbox;
        const datasetTime = `${date}T00:00:00.000Z`;

        if (!bboxInsideMed(coreBbox)) {
          return json(
            {
              error:
                "Sólo Mediterráneo por ahora. La cobertura global (ugos/vgos) requiere un dataset WMTS que Copernicus no expone por variable; queda pendiente para un backend Python externo.",
              bbox: coreBbox,
              tileId,
            },
            422,
          );
        }

        // Clave de caché: SOLO date + tile_id + versión. Sin res/delta0/deltaF/tauMax.
        // Los parámetros están bloqueados en constantes canónicas; incluirlos en la
        // clave sería redundante y permitiría fragmentar accidentalmente la caché.
        const cacheKey = `fsle/${BBOX_KEY_VERSION}/${date}/${tileId}.json`;

        // Probe: consulta rápida de estado de caché (sin descargar ni calcular).
        if (q.get("probe") === "1") {
          const probe = await probeCachedJson(cacheKey);
          return new Response(
            JSON.stringify(
              probe
                ? { cache: "HIT", ageMs: probe.ageMs, tileId, datasetTime, resolution: res }
                : { cache: "MISS", tileId, datasetTime, resolution: res },
            ),
            {
              status: 200,
              headers: {
                ...CORS,
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "X-FSLE-Cache": probe ? "HIT" : "MISS",
                "X-FSLE-Tile": tileId,
              },
            },
          );
        }

        // 1) Caché. Para un mismo (date, tileId) el payload es idéntico entre
        // visitas: bbox_key, resolución y parámetros están bloqueados.
        {
          const cached = await readCachedJson(cacheKey);
          if (cached) {
            // Mutamos properties.cache="HIT" y añadimos tile_id/dataset_time
            // por si el JSON en caché es anterior a este endpoint.
            const p = cached.payload as { properties?: Record<string, unknown> };
            if (p && typeof p === "object" && p.properties) {
              p.properties.cache = "HIT";
              p.properties.tile_id = tileId;
              p.properties.dataset_time = datasetTime;
              p.properties.resolution = res;
              p.properties.bbox_key = `${BBOX_KEY_VERSION}:${tileId}`;
            }
            return new Response(JSON.stringify(cached.payload), {
              status: 200,
              headers: {
                ...CORS,
                "Content-Type": "application/geo+json",
                "Cache-Control": "public, max-age=3600, s-maxage=86400",
                "X-FSLE-Cache": "HIT",
                "X-FSLE-Age-Ms": String(cached.ageMs),
                "X-FSLE-Tile": tileId,
              },
            });
          }
        }

        // 2) Compute
        const controller = new AbortController();
        request.signal?.addEventListener("abort", () => controller.abort(), { once: true });

        try {
          const t0 = Date.now();
          // ── Dominio de velocidad AMPLIADO alrededor del bbox de vista.
          // CRÍTICO: sin margen, las partículas quedan confinadas al bbox
          // (clamp en el borde) y las parejas casi nunca alcanzan δf →
          // campo FSLE prácticamente vacío y cero crestas. El margen da
          // espacio real de advección/separación fuera de la vista.
          const cellLon = (bbox.east - bbox.west) / (res - 1);
          const cellLat = (bbox.north - bbox.south) / (res - 1);
          const padDeg = Math.max(0.4, deltaF * 2);
          // El muestreo de velocidad se hace vía tiles WMTS PNG cacheables:
          // ampliar la malla no dispara requests upstream. Subimos el límite
          // para permitir res=64 + halo cómodamente (≈80×80 ≈ 6400 puntos).
          const MAX_POINTS = 8000;
          let padCellsX = Math.ceil(padDeg / cellLon);
          let padCellsY = Math.ceil(padDeg / cellLat);
          let padCols = res + 2 * padCellsX;
          let padRows = res + 2 * padCellsY;
          while (padCols * padRows > MAX_POINTS && (padCellsX > 2 || padCellsY > 2)) {
            if (padCellsX > 2) padCellsX--;
            if (padCellsY > 2) padCellsY--;
            padCols = res + 2 * padCellsX;
            padRows = res + 2 * padCellsY;
          }
          const padBbox: Bbox = {
            south: Math.max(MED.bbox.south, bbox.south - padCellsY * cellLat),
            north: Math.min(MED.bbox.north, bbox.north + padCellsY * cellLat),
            west: Math.max(MED.bbox.west, bbox.west - padCellsX * cellLon),
            east: Math.min(MED.bbox.east, bbox.east + padCellsX * cellLon),
          };

          const { u, v, validCount } = await fetchVelocityGrid(
            padBbox,
            padCols,
            padRows,
            date,
            controller.signal,
          );
          if (validCount < Math.max(20, res * 2)) {
            return json(
              {
                error:
                  "Datos u/v insuficientes de Copernicus para esta fecha/zona (celdas válidas < umbral).",
                validCount,
              },
              422,
            );
          }

          // ── Métricas u/v (m/s): media, varianza y % NaN.
          const totalPts = padCols * padRows;
          let uN = 0, vN = 0, uSum = 0, vSum = 0, uSum2 = 0, vSum2 = 0;
          let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
          for (let k = 0; k < totalPts; k++) {
            const uk = u[k], vk = v[k];
            if (Number.isFinite(uk)) {
              uN++; uSum += uk; uSum2 += uk * uk;
              if (uk < uMin) uMin = uk; if (uk > uMax) uMax = uk;
            }
            if (Number.isFinite(vk)) {
              vN++; vSum += vk; vSum2 += vk * vk;
              if (vk < vMin) vMin = vk; if (vk > vMax) vMax = vk;
            }
          }
          const uMean = uN > 0 ? uSum / uN : 0;
          const vMean = vN > 0 ? vSum / vN : 0;
          const uVar = uN > 0 ? Math.max(0, uSum2 / uN - uMean * uMean) : 0;
          const vVar = vN > 0 ? Math.max(0, vSum2 / vN - vMean * vMean) : 0;
          const uNaNPct = 100 * (1 - uN / totalPts);
          const vNaNPct = 100 * (1 - vN / totalPts);

          const interp = makeBilinearInterpolator(u, v, padBbox, padCols, padRows);

          // ── Sanity bilinear: en el centro de una celda, la interpolación
          // debe aproximarse a la media de sus 4 esquinas (grados/día).
          let bilinearOk = false;
          let bilinearErr: number | null = null;
          {
            const dLonP = (padBbox.east - padBbox.west) / (padCols - 1);
            const dLatP = (padBbox.north - padBbox.south) / (padRows - 1);
            for (let r = 0; r < padRows - 1 && !bilinearOk; r++) {
              for (let c = 0; c < padCols - 1 && !bilinearOk; c++) {
                const uA = u[r * padCols + c], uB = u[r * padCols + c + 1];
                const uC = u[(r + 1) * padCols + c], uD = u[(r + 1) * padCols + c + 1];
                const vA = v[r * padCols + c], vB = v[r * padCols + c + 1];
                const vC = v[(r + 1) * padCols + c], vD = v[(r + 1) * padCols + c + 1];
                if (![uA, uB, uC, uD, vA, vB, vC, vD].every(Number.isFinite)) continue;
                const latMid = padBbox.south + (r + 0.5) * dLatP;
                const lngMid = padBbox.west + (c + 0.5) * dLonP;
                const iv = interp(latMid, lngMid);
                if (!iv) continue;
                // Reconstruimos u/v esperados en m/s desde grados/día invirtiendo la conversión.
                const cosLat = Math.max(0.15, Math.cos((latMid * Math.PI) / 180));
                const uHat = (iv.du * 111_000 * cosLat) / 86400;
                const vHat = (iv.dv * 111_000) / 86400;
                const uExp = (uA + uB + uC + uD) / 4;
                const vExp = (vA + vB + vC + vD) / 4;
                bilinearErr = Math.hypot(uHat - uExp, vHat - vExp);
                bilinearOk = bilinearErr < 1e-3; // ≈ 1 mm/s
                break;
              }
            }
          }

          // ── Movilidad de partículas: sembrar N puntos aleatorios del bbox
          // interior, integrar 24 h y medir desplazamiento medio (km).
          let mobilityKm: number | null = null;
          let mobilityN = 0;
          {
            const SAMPLES = 24;
            const dtM = 1 / 24;
            const stepsM = 24; // 24 h
            let sumKm = 0;
            // PRNG determinista (Mulberry32) sembrado con fecha+bbox para que
            // la métrica de movilidad no varíe entre llamadas idénticas.
            let seed =
              (date.charCodeAt(0) * 131 + date.charCodeAt(3) * 17 + date.charCodeAt(8)) ^
              Math.floor((bbox.south + 90) * 1000) ^
              (Math.floor((bbox.west + 180) * 1000) << 5);
            const rand = () => {
              seed |= 0;
              seed = (seed + 0x6d2b79f5) | 0;
              let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
              t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
              return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
            for (let s = 0; s < SAMPLES; s++) {
              const lat0 = bbox.south + rand() * (bbox.north - bbox.south);
              const lng0 = bbox.west + rand() * (bbox.east - bbox.west);
              if (!interp(lat0, lng0)) continue;
              let lat = lat0, lng = lng0;
              let ok = true;
              for (let k = 0; k < stepsM; k++) {
                const nx = rk4Step(lat, lng, dtM, interp);
                if (!nx) { ok = false; break; }
                lat = nx[0]; lng = nx[1];
              }
              if (!ok) continue;
              const dLatKm = (lat - lat0) * 111;
              const dLngKm = (lng - lng0) * 111 * Math.cos((lat0 * Math.PI) / 180);
              sumKm += Math.hypot(dLatKm, dLngKm);
              mobilityN++;
            }
            mobilityKm = mobilityN > 0 ? sumKm / mobilityN : null;
          }

          const { fsle, anyValid } = computeFsleField(
            interp,
            bbox,
            res,
            res,
            delta0,
            deltaF,
            tauMaxDays,
            CANON_DIRECTION,
          );

          if (!anyValid) {
            return json(
              {
                error: "El campo FSLE no produjo separaciones válidas.",
                diag: { gridUvValid: validCount, gridPoints: padCols * padRows, padBbox },
              },
              422,
            );
          }
          // (Sin bay-fill: si Copernicus no da datos en Palma/Alcúdia, no
          // los inventamos.)

          const smoothed = smoothFsle(fsle, res, res);
          const ridgeResult = extractRidges(smoothed, fsle, bbox, res, res);
          const ridges = ridgeResult.ridges;

          // Estadísticas del campo FSLE CRUDO (sin suavizado adicional).
          let fsleValid = 0;
          let fsleMin = Infinity;
          let fsleMax = -Infinity;
          let fsleSum = 0;
          for (let k = 0; k < fsle.length; k++) {
            const val = fsle[k];
            if (!Number.isFinite(val)) continue;
            fsleValid++;
            fsleSum += val;
            if (val < fsleMin) fsleMin = val;
            if (val > fsleMax) fsleMax = val;
          }

          // ── Cobertura de datos Copernicus (%)
          const coveragePct = totalPts > 0 ? (100 * validCount) / totalPts : 0;
          const coverageWarn = coveragePct < 90;

          // ── Longitudes / máximos por cresta (para el informe).
          const ridgeLenAvg = ridges.length
            ? ridges.reduce((s, r) => s + r.lengthKm, 0) / ridges.length
            : 0;
          const ridgeFsleMax = ridges.length ? Math.max(...ridges.map((r) => r.fsleMax)) : 0;
          const ridgeFsleAvg = ridges.length
            ? ridges.reduce((s, r) => s + r.fsleAvg, 0) / ridges.length
            : 0;
          const ridgeConfAvg = ridges.length
            ? ridges.reduce((s, r) => s + r.confidence, 0) / ridges.length
            : 0;
          const nearNaNCount = ridges.filter((r) => r.nearNaN).length;

          // ── Raster FSLE completo (SIN suavizado adicional) — SIEMPRE.
          //     Se pinta con paleta amarillo→rojo en el cliente.
          const rasterFeatures: Array<{
            type: "Feature";
            properties: Record<string, unknown>;
            geometry: { type: "Polygon"; coordinates: [number, number][][] };
          }> = [];
          {
            const dLon = (bbox.east - bbox.west) / (res - 1);
            const dLat = (bbox.north - bbox.south) / (res - 1);
            const half = 0.5;
            const fmax = Number.isFinite(fsleMax) ? fsleMax : 1;
            const fmin = Math.max(0, Number.isFinite(fsleMin) ? fsleMin : 0);
            const rng = Math.max(1e-6, fmax - fmin);
            for (let r = 0; r < res; r++) {
              for (let c = 0; c < res; c++) {
                const val = fsle[r * res + c]; // CRUDO — sin suavizado adicional
                if (!Number.isFinite(val)) continue;
                const lat = bbox.south + r * dLat;
                const lng = bbox.west + c * dLon;
                // Recorte al núcleo (half-open): cada celda pertenece a un
                // único tile, evitando raster duplicado en el solape entre
                // tiles vecinos.
                if (lat < coreBbox.south || lat >= coreBbox.north) continue;
                if (lng < coreBbox.west || lng >= coreBbox.east) continue;
                const nrm = Math.max(0, Math.min(1, (val - fmin) / rng));
                rasterFeatures.push({
                  type: "Feature",
                  properties: { kind: "fsle_cell", value: Number(val.toFixed(4)), norm: Number(nrm.toFixed(3)) },
                  geometry: {
                    type: "Polygon",
                    coordinates: [[
                      [lng - dLon * half, lat - dLat * half],
                      [lng + dLon * half, lat - dLat * half],
                      [lng + dLon * half, lat + dLat * half],
                      [lng - dLon * half, lat + dLat * half],
                      [lng - dLon * half, lat - dLat * half],
                    ]],
                  },
                });
              }
            }
          }

          // ── Filtrado de crestas al núcleo del tile ───────────────────
          // Se computa sobre `computeBbox` (núcleo + halo `TILE_OVERLAP_DEG`)
          // para garantizar continuidad de LCS entre tiles vecinos, pero
          // sólo publicamos las crestas cuyo punto medio cae en `coreBbox`
          // (half-open). Así cada LCS pertenece a un único tile y no se
          // duplica al unir tiles adyacentes.
          const ridgesInCore = ridges.filter((rr) =>
            rr.points.some(([lng, lat]) =>
              lat >= coreBbox.south && lat < coreBbox.north &&
              lng >= coreBbox.west && lng < coreBbox.east,
            ),
          );

          const warnings: string[] = [];
          if (coverageWarn) warnings.push(`Cobertura Copernicus baja: ${coveragePct.toFixed(1)}% (<90%).`);
          if (nearNaNCount > 0) warnings.push(`${nearNaNCount}/${ridges.length} crestas adyacentes a celdas NaN.`);
          if (ridgesInCore.length === 0) warnings.push("No hay crestas que superen los criterios de validación (P42 + confianza ≥ 0.16 + Hessiano).");

          const payload = {
            type: "FeatureCollection" as const,
            properties: {
              source: "Copernicus Marine WMTS (MEDSEA_ANALYSISFORECAST_PHY_006_013)",
              method:
                "FSLE lagrangiano cinemático (campo congelado día seleccionado) con integrador RK4 dt=2h",
              legend:
                "Raster FSLE crudo (amarillo→rojo) + crestas LCS (Hessian ridge detection)",
              technical_info:
                "No es AVISO-FSLE oficial. Es FSLE lagrangiano calculado con RK4 sobre uo/vo del día seleccionado, con detección Hessiana de crestas y solape entre tiles para continuidad.",
              params: { date, bbox: coreBbox, computeBbox, res, delta0, deltaF, tauMaxDays },
              // Anclajes fijos (modo navegación estable):
              tile_id: tileId,
              dataset_time: datasetTime,
              resolution: res,
              bbox_key: `${BBOX_KEY_VERSION}:${tileId}`,
              locked: { res, delta0, deltaF, tauMaxDays, tileDeg: TILE_DEG, tileOverlapDeg: TILE_OVERLAP_DEG },
              thresholds: {
                percentileCut: 0.42,
                strongPercentile: 0.72,
                nmsTol: 0.94,
                hessianCurvatureMinPct: 0.025,
                hessianAnisotropyMin: 0.35,
                minChainLength: 4,
                minConfidence: 0.16,
                confidenceWeights: { continuity: 0.30, intensity: 0.35, stability: 0.35 },
              },
              computedAt: new Date().toISOString(),
              computeMs: Date.now() - t0,
              cache: "MISS",
              ridgeCount: ridgesInCore.length,
              warnings,
              report: {
                coveragePct: Number(coveragePct.toFixed(1)),
                validCells: validCount,
                totalCells: totalPts,
                ridgeCount: ridges.length,
                ridgeAvgLengthKm: Number(ridgeLenAvg.toFixed(2)),
                ridgeFsleMax: Number(ridgeFsleMax.toFixed(4)),
                ridgeFsleAvg: Number(ridgeFsleAvg.toFixed(4)),
                ridgeConfidenceAvg: Number(ridgeConfAvg.toFixed(3)),
                ridgesNearNaN: nearNaNCount,
                thresholdAbs: Number(ridgeResult.thresholdAbs.toFixed(4)),
                thresholdStrong: Number(ridgeResult.thresholdStrong.toFixed(4)),
                globalFsleMax: Number(ridgeResult.globalMax.toFixed(4)),
              },
              diag: {
                gridPoints: totalPts,
                gridUvValid: validCount,
                uMean: Number(uMean.toFixed(4)),
                vMean: Number(vMean.toFixed(4)),
                uVar: Number(uVar.toFixed(6)),
                vVar: Number(vVar.toFixed(6)),
                uRange: Number.isFinite(uMin) ? [Number(uMin.toFixed(3)), Number(uMax.toFixed(3))] : null,
                vRange: Number.isFinite(vMin) ? [Number(vMin.toFixed(3)), Number(vMax.toFixed(3))] : null,
                uNaNPct: Number(uNaNPct.toFixed(1)),
                vNaNPct: Number(vNaNPct.toFixed(1)),
                bilinearOk,
                bilinearErr: bilinearErr != null ? Number(bilinearErr.toFixed(6)) : null,
                mobilityKm24h: mobilityKm != null ? Number(mobilityKm.toFixed(2)) : null,
                mobilitySamples: mobilityN,
                fsleValid,
                fsleMin: Number.isFinite(fsleMin) ? Number(fsleMin.toFixed(4)) : null,
                fsleMax: Number.isFinite(fsleMax) ? Number(fsleMax.toFixed(4)) : null,
                fsleMean: fsleValid > 0 ? Number((fsleSum / fsleValid).toFixed(4)) : null,
              },
            },
            features: [
              ...rasterFeatures,
              ...ridgesInCore.map((r) => ({
                type: "Feature" as const,
                properties: {
                  kind: "ridge",
                  fsle: r.fsleNorm,
                  fsleValues: r.fsleValues,
                  fsleAvg: r.fsleAvg,
                  fsleMax: r.fsleMax,
                  lengthKm: r.lengthKm,
                  confidence: r.confidence,
                  nearNaN: r.nearNaN,
                },
                geometry: { type: "LineString" as const, coordinates: r.points },
              })),
            ],
          };

          // fire-and-forget cache write.
          // CRÍTICO: si el cliente cerró la app antes de acabar, `controller`
          // habrá abortado y parte de la malla u/v puede haberse quedado con
          // celdas NaN por fetches cancelados. En ese caso NO guardamos: una
          // caché parcial se serviría en la siguiente visita como si fuera
          // el resultado "definitivo" y rompería la reproducibilidad.
          if (!controller.signal.aborted) {
            void writeCachedJson(cacheKey, payload);
          }


          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: {
              ...CORS,
              "Content-Type": "application/geo+json",
              "Cache-Control": "public, max-age=3600, s-maxage=86400",
              "X-FSLE-Cache": "MISS",
              "X-FSLE-Tile": tileId,
            },
          });
        } catch (err) {
          return json({ error: (err as Error).message || "compute failed" }, 500);
        }
      },
    },
  },
});

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

