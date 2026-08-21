/**
 * Transcripción de voz (solo servidor) vía Lovable AI Gateway.
 * Recibe el audio grabado en base64 y devuelve el texto dictado.
 */
export async function transcribeAudio(input: {
  audioBase64: string;
  format: string;
}): Promise<{ ok: boolean; text: string; message?: string }> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) return { ok: false, text: "", message: "IA no configurada." };
  if (!input.audioBase64) return { ok: false, text: "", message: "Audio vacío." };

  const format = ["wav", "mp3", "webm", "m4a", "ogg", "aac", "flac"].includes(input.format)
    ? input.format
    : "webm";

  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
      },
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-lite",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Transcribe literalmente este audio en español (contexto: pesca en Mallorca). " +
                  "Devuelve solo el texto transcrito, sin comillas ni comentarios.",
              },
              { type: "input_audio", input_audio: { data: input.audioBase64, format } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      return { ok: false, text: "", message: "No se pudo transcribir el audio." };
    }
    const json: any = await res.json();
    const text = String(json?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) return { ok: false, text: "", message: "No se entendió el audio." };
    return { ok: true, text };
  } catch {
    return { ok: false, text: "", message: "Error de conexión al transcribir." };
  }
}

