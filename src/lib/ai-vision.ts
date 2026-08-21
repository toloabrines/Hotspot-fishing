/**
 * Tipos compartidos de «Analizar foto» (cliente + servidor).
 */
export interface VisionRequest {
  /** data URL: data:image/jpeg;base64,... */
  imageDataUrl: string;
  /** Pregunta opcional del pescador sobre la foto. */
  note?: string | null;
}

export interface VisionFish {
  commonName: string | null;
  scientificName: string | null;
  family: string | null;
  features: string | null;
  habitat: string | null;
  feeding: string | null;
  technique: string | null;
  confidence: "alto" | "medio" | "bajo" | null;
  similar: string[];
}

export interface VisionAnswer {
  /** Qué se ve en la foto (pez, señuelo, aparejo, sonda, avería, material…). */
  kind: string;
  /** Descripción y consejos en texto claro. */
  observation: string;
  advice: string | null;
  fish: VisionFish | null;
  /** true cuando la IA no puede identificar con seguridad. */
  uncertain: boolean;
  retakeHint: string | null;
}

export interface VisionResponse {
  ok: boolean;
  answer: VisionAnswer | null;
  message: string | null;
  code: "missing_key" | "rate_limited" | "provider_error" | "bad_image" | null;
  usedToday: number;
  dailyLimit: number;
  unlimited?: boolean;
  creditsLeft?: number;
}

