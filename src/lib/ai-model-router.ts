/**
 * Modelos de IA de Hotspot Fishing (control de coste).
 *
 * - Clientes: google/gemini-3.1-flash-lite (mucho más barato). La app ya
 *   calcula los hotspots; la IA solo debe explicarlos.
 * - Cuenta de administrador: google/gemini-3.7-flash.
 * - Respuestas cortas (máx. 400 tokens) y sin reenviar historial.
 */
export const MODEL_ADMIN = "google/gemini-3.7-flash";
export const MODEL_USER = "google/gemini-3.1-flash-lite";

/**
 * Tope de tokens de salida por respuesta.
 * La respuesta es JSON estructurado (y el modelo admin además razona), así que
 * con 400 se cortaba a media respuesta y fallaba el parseo. 1200 mantiene el
 * texto corto (~150 palabras) con margen para el JSON.
 */
export const MAX_ANSWER_TOKENS = 1200;

/** Modelo según el rol: solo el admin usa el modelo potente. */
export function modelForUser(isAdmin: boolean): string {
  return isAdmin ? MODEL_ADMIN : MODEL_USER;
}

