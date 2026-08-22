/**
 * Paquetes de consultas extra de IA (pago único, no caducan).
 *
 * Los créditos se suman al saldo del usuario (public.ai_credits) y se
 * consumen SOLO cuando ya se ha agotado el cupo diario gratuito.
 */
export interface AiPack {
  /** lookup_key del precio en Stripe. */
  priceId: string;
  credits: number;
  name: string;
  priceLabel: string;
  emoji: string;
  hint: string;
}

export const AI_PACKS: AiPack[] = [
  {
    priceId: "ai_pack_20_onetime",
    credits: 20,
    name: "20 consultas extra",
    priceLabel: "2,99 € IVA incl.",
    emoji: "⚡",
    hint: "Para un fin de semana de pesca",
  },
  {
    priceId: "ai_pack_50_onetime",
    credits: 50,
    name: "50 consultas extra",
    priceLabel: "5,99 € IVA incl.",
    emoji: "🎣",
    hint: "El más elegido · 0,12 €/consulta",
  },
  {
    priceId: "ai_pack_200_onetime",
    credits: 200,
    name: "200 consultas extra",
    priceLabel: "19,99 € IVA incl.",
    emoji: "🚀",
    hint: "Uso intensivo · 0,10 €/consulta",
  },
];

export const AI_PACK_BY_PRICE_ID: Record<string, AiPack> = Object.fromEntries(
  AI_PACKS.map((p) => [p.priceId, p]),
);

export function isAiPackPriceId(priceId: string): boolean {
  return priceId in AI_PACK_BY_PRICE_ID;
}

