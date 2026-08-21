/**
 * Catálogo manual de spots de pesca conocidos (Baleares + Levante + Cataluña).
 *
 * USO PRINCIPAL: validación / calibración del ranking de pesca de fondo.
 *   - Cuando el usuario analiza una zona que contiene spots conocidos,
 *     calculamos `recall@K` (cuántos del Top K coinciden con un spot conocido
 *     dentro de un radio de tolerancia) para evaluar si los pesos del scoring
 *     están bien calibrados.
 *
 * Las coordenadas y profundidades son aproximadas (centro de la estructura
 * principal del spot), no posiciones exactas de pesca. Ampliable.
 */

export interface KnownSpot {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Rango típico de profundidad útil en metros. */
  depthMin: number;
  depthMax: number;
  /** Tipo de estructura dominante. */
  structure: "cañón" | "monte" | "quiebre" | "veril" | "bajo_rocoso" | "ladera" | "abisal";
  /** Especies típicas (informativo). */
  species?: string[];
  /** Región para filtrado rápido. */
  region: "cataluña" | "levante" | "baleares" | "murcia" | "andalucia_med";
  /** Notas opcionales. */
  notes?: string;
}

export const KNOWN_SPOTS: KnownSpot[] = [
  // ── CATALUÑA ─────────────────────────────────────────────────────
  {
    id: "cap-creus-canyon",
    name: "Cabeza cañón Cap de Creus",
    lat: 42.32,
    lng: 3.34,
    depthMin: 150,
    depthMax: 350,
    structure: "cañón",
    region: "cataluña",
    species: ["merluza", "rape", "gallineta"],
  },
  {
    id: "cap-begur-break",
    name: "Quiebre Cap de Begur",
    lat: 41.96,
    lng: 3.28,
    depthMin: 80,
    depthMax: 200,
    structure: "quiebre",
    region: "cataluña",
    species: ["dentón", "merluza"],
  },
  {
    id: "roses-bay-south",
    name: "Sur Bahía de Rosas",
    lat: 42.2,
    lng: 3.2,
    depthMin: 30,
    depthMax: 100,
    structure: "bajo_rocoso",
    region: "cataluña",
    species: ["dorada", "lubina", "dentón"],
  },
  {
    id: "tarragona-shelf-edge",
    name: "Borde plataforma Tarragona",
    lat: 41.0,
    lng: 1.45,
    depthMin: 100,
    depthMax: 200,
    structure: "quiebre",
    region: "cataluña",
  },
  {
    id: "salou-rocoso",
    name: "Bajos rocosos Cap Salou",
    lat: 41.06,
    lng: 1.18,
    depthMin: 30,
    depthMax: 80,
    structure: "bajo_rocoso",
    region: "cataluña",
  },
  {
    id: "ebro-outer-shelf",
    name: "Plataforma exterior Delta Ebro",
    lat: 40.55,
    lng: 1.15,
    depthMin: 50,
    depthMax: 150,
    structure: "veril",
    region: "cataluña",
    species: ["merluza", "rape"],
  },

  // ── LEVANTE ──────────────────────────────────────────────────────
  {
    id: "columbretes-rocoso",
    name: "Islas Columbretes (perímetro)",
    lat: 39.9,
    lng: 0.69,
    depthMin: 40,
    depthMax: 90,
    structure: "bajo_rocoso",
    region: "levante",
    species: ["dentón", "mero", "pargo"],
  },
  {
    id: "bajo-fuera-columbretes",
    name: "Bajo de Fuera (Columbretes)",
    lat: 39.84,
    lng: 0.63,
    depthMin: 40,
    depthMax: 90,
    structure: "monte",
    region: "levante",
  },
  {
    id: "cabo-nao-veril",
    name: "Veril Cabo La Nao",
    lat: 38.73,
    lng: 0.25,
    depthMin: 50,
    depthMax: 200,
    structure: "veril",
    region: "levante",
    species: ["dentón", "merluza"],
  },
  {
    id: "cabo-san-antonio",
    name: "Cabo San Antonio",
    lat: 38.81,
    lng: 0.21,
    depthMin: 50,
    depthMax: 150,
    structure: "quiebre",
    region: "levante",
  },

  // ── BALEARES ─────────────────────────────────────────────────────
  {
    id: "el-toro-mallorca",
    name: "Reserva El Toro (Mallorca)",
    lat: 39.49,
    lng: 2.4,
    depthMin: 30,
    depthMax: 90,
    structure: "bajo_rocoso",
    region: "baleares",
    species: ["dentón", "mero", "pargo"],
  },
  {
    id: "cabrera-banco-pollo",
    name: "Banco del Pollo (Cabrera)",
    lat: 39.07,
    lng: 2.75,
    depthMin: 80,
    depthMax: 200,
    structure: "monte",
    region: "baleares",
  },
  {
    id: "cabrera-sur",
    name: "Sur de Cabrera",
    lat: 39.1,
    lng: 2.95,
    depthMin: 100,
    depthMax: 300,
    structure: "quiebre",
    region: "baleares",
  },
  {
    id: "cap-salines-sur",
    name: "Sur Cap Salines",
    lat: 39.2,
    lng: 3.05,
    depthMin: 60,
    depthMax: 150,
    structure: "veril",
    region: "baleares",
  },
  {
    id: "cap-formentor",
    name: "Cap Formentor (norte Mallorca)",
    lat: 39.95,
    lng: 3.21,
    depthMin: 50,
    depthMax: 200,
    structure: "quiebre",
    region: "baleares",
    species: ["dentón", "merluza"],
  },
  {
    id: "sa-dragonera-w",
    name: "Oeste Sa Dragonera",
    lat: 39.58,
    lng: 2.31,
    depthMin: 100,
    depthMax: 300,
    structure: "quiebre",
    region: "baleares",
  },
  {
    id: "es-vedra",
    name: "Es Vedrà (SW Ibiza)",
    lat: 38.85,
    lng: 1.18,
    depthMin: 50,
    depthMax: 150,
    structure: "monte",
    region: "baleares",
    species: ["dentón", "mero"],
  },
  {
    id: "tagomago",
    name: "Tagomago (Ibiza)",
    lat: 39.04,
    lng: 1.65,
    depthMin: 30,
    depthMax: 80,
    structure: "bajo_rocoso",
    region: "baleares",
  },
  {
    id: "punta-grossa-ibiza",
    name: "Punta Grossa (Ibiza)",
    lat: 39.08,
    lng: 1.59,
    depthMin: 30,
    depthMax: 100,
    structure: "bajo_rocoso",
    region: "baleares",
  },
  {
    id: "emile-baudot",
    name: "Banco Emile Baudot (sur Mallorca)",
    lat: 39.0,
    lng: 2.7,
    depthMin: 100,
    depthMax: 300,
    structure: "monte",
    region: "baleares",
  },
  {
    id: "canal-mallorca",
    name: "Canal de Mallorca (centro abisal)",
    lat: 39.3,
    lng: 2.1,
    depthMin: 700,
    depthMax: 1200,
    structure: "abisal",
    region: "baleares",
    species: ["gallineta", "sable"],
  },
  {
    id: "canal-ibiza",
    name: "Canal de Ibiza (abisal)",
    lat: 38.85,
    lng: 0.85,
    depthMin: 600,
    depthMax: 900,
    structure: "abisal",
    region: "baleares",
  },

  // ── MURCIA ───────────────────────────────────────────────────────
  {
    id: "cabo-palos-hormigas",
    name: "Cabo Palos / Islas Hormigas",
    lat: 37.63,
    lng: -0.62,
    depthMin: 30,
    depthMax: 100,
    structure: "bajo_rocoso",
    region: "murcia",
    species: ["dentón", "mero", "pargo"],
  },
  {
    id: "cabo-tinoso",
    name: "Cabo Tiñoso",
    lat: 37.53,
    lng: -1.1,
    depthMin: 50,
    depthMax: 200,
    structure: "quiebre",
    region: "murcia",
  },

  // ── ANDALUCÍA MED ────────────────────────────────────────────────
  {
    id: "cabo-gata",
    name: "Cabo de Gata",
    lat: 36.72,
    lng: -2.2,
    depthMin: 50,
    depthMax: 200,
    structure: "quiebre",
    region: "andalucia_med",
    species: ["dentón", "merluza"],
  },
];

/** Distancia haversine aproximada en metros. */
function distMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Spots conocidos contenidos en un bounding box. */
export function getKnownSpotsInBounds(bounds: {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}): KnownSpot[] {
  return KNOWN_SPOTS.filter(
    (s) =>
      s.lat >= bounds.minLat &&
      s.lat <= bounds.maxLat &&
      s.lng >= bounds.minLng &&
      s.lng <= bounds.maxLng,
  );
}

/**
 * Recall@K: fracción de spots conocidos en la zona analizada que aparecen
 * dentro del Top-K del ranking, considerando "match" si la candidata está
 * a menos de `toleranceM` metros del spot conocido.
 *
 * También devuelve el MRR (mean reciprocal rank) del primer match por spot.
 */
export function evaluateRecallAtK(
  topCandidates: { lat: number; lng: number }[],
  knownSpotsInArea: KnownSpot[],
  k: number = 5,
  toleranceM: number = 5000,
): {
  recall: number;
  matched: number;
  total: number;
  mrr: number;
  matches: { spot: KnownSpot; rank: number; distM: number }[];
} {
  if (knownSpotsInArea.length === 0) {
    return { recall: 0, matched: 0, total: 0, mrr: 0, matches: [] };
  }
  const top = topCandidates.slice(0, k);
  const matches: { spot: KnownSpot; rank: number; distM: number }[] = [];
  let rrSum = 0;
  for (const spot of knownSpotsInArea) {
    let bestRank = -1;
    let bestDist = Infinity;
    for (let i = 0; i < top.length; i++) {
      const d = distMeters([spot.lat, spot.lng], [top[i].lat, top[i].lng]);
      if (d <= toleranceM && d < bestDist) {
        bestDist = d;
        bestRank = i + 1;
      }
    }
    if (bestRank > 0) {
      matches.push({ spot, rank: bestRank, distM: bestDist });
      rrSum += 1 / bestRank;
    }
  }
  return {
    recall: matches.length / knownSpotsInArea.length,
    matched: matches.length,
    total: knownSpotsInArea.length,
    mrr: rrSum / knownSpotsInArea.length,
    matches,
  };
}

