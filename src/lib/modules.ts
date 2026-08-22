export type ModuleId = "superficie" | "fondo" | "calamar" | "deriva";

/**
 * Los módulos de pago están bloqueados salvo suscripción activa.
 * El acceso general a la app (mapa básico) NUNCA se bloquea.
 */
export const MODULES_UNLOCKED = false;

/** Cuentas de administración con acceso completo mientras Stripe está en pruebas. */
export const ADMIN_EMAILS = ["tolototy@gmail.com", "totymar@totymar.com"];

export function isAdminEmail(email?: string | null): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}

/**
 * Accesos de cortesía (invitados / pruebas): añade aquí el email con el que
 * la persona se registra y qué módulos le regalas.
 *   "all"                        → los tres módulos
 *   ["superficie", "fondo"]      → sólo esos módulos
 * El email debe ir en minúsculas y coincidir con el de su cuenta.
 */
export const FREE_ACCESS: Record<string, "all" | ModuleId[]> = {
  // "amigo@ejemplo.com": "all",
  // "cliente@ejemplo.com": ["fondo"],
};

/** ¿Este email tiene cortesía para este módulo? */
export function hasFreeAccess(email: string | null | undefined, id: ModuleId): boolean {
  if (!email) return false;
  const grant = FREE_ACCESS[email.toLowerCase()];
  if (!grant) return false;
  return grant === "all" || grant.includes(id);
}

/** ¿Tiene cortesía para algún módulo? */
export function hasAnyFreeAccess(email?: string | null): boolean {
  return !!email && !!FREE_ACCESS[email.toLowerCase()];
}

export interface FishingModule {
  id: ModuleId;
  priceId: string;
  name: string;
  tagline: string;
  emoji: string;
  features: string[];
  priceLabel: string;
}

/** Catálogo de los tres módulos independientes de 5 €/mes. */
export const FISHING_MODULES: FishingModule[] = [
  {
    id: "superficie",
    priceId: "superficie_monthly",
    name: "Pesca de Superficie",
    tagline: "Pelágicos, frentes térmicos y corrientes",
    emoji: "🌊",
    priceLabel: "5 €/mes IVA incl.",
    features: [
      "Score de superficie / pelágicos",
      "Frentes térmicos y clorofila",
      "Líneas FSLE (estructuras de corriente)",
      "Corrientes por profundidad y streamlines",
    ],
  },
  {
    id: "fondo",
    priceId: "fondo_monthly",
    name: "Pesca de Fondo",
    tagline: "Batimetría, veriles y relieve 3D",
    emoji: "⚓",
    priceLabel: "5 €/mes IVA incl.",
    features: [
      "Score de pesca de fondo",
      "Batimetría de alta resolución y curvas",
      "Detección de veriles, bajos y cañones",
      "Vista 3D del fondo y ficha de punto",
    ],
  },
  {
    id: "calamar",
    priceId: "calamar_monthly",
    name: "Calamar",
    tagline: "Motor dedicado con luz lunar y crepúsculos",
    emoji: "🦑",
    priceLabel: "5 €/mes IVA incl.",
    features: [
      "Motor de puntuación específico de calamar",
      "Luz lunar y ventanas de crepúsculo",
      "Tipo de fondo y temperatura óptima",
      "Alertas de condiciones favorables",
    ],
  },
  {
    id: "deriva",
    priceId: "deriva_monthly",
    name: "Pesca a la Deriva (Fluixa)",
    tagline: "Bahías y costa: deriva natural sobre depredadores",
    emoji: "🚤",
    priceLabel: "5 €/mes IVA incl.",
    features: [
      "Motor propio de puntuación para la fluixa",
      "Veriles costeros, puntas, cabos y canales",
      "Velocidad real de deriva (corriente + viento)",
      "Abrigo del viento, oleaje y frentes FSLE",
    ],
  },
];

export const MODULE_BY_PRICE_ID: Record<string, FishingModule> = Object.fromEntries(
  FISHING_MODULES.map((m) => [m.priceId, m]),
);

export function moduleById(id: ModuleId): FishingModule {
  return FISHING_MODULES.find((m) => m.id === id)!;
}

