import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  AdvisorChatRequest,
  AdvisorChatResponse,
  AdvisorRequest,
  AdvisorResponse,
} from "./ai-advisor";

export const askFishingAdvisor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: AdvisorRequest) => input)
  .handler(async ({ data, context }): Promise<AdvisorResponse> => {
    const { runAdvisor } = await import("./ai-advisor.server");
    return runAdvisor(data, { userId: context.userId });
  });

export const chatFishingAdvisor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: AdvisorChatRequest) => input)
  .handler(async ({ data, context }): Promise<AdvisorChatResponse> => {
    const { runAdvisorChat } = await import("./ai-advisor-chat.server");
    return runAdvisorChat(data, { userId: context.userId });
  });

export const transcribeVoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { audioBase64: string; format: string }) => input)
  .handler(async ({ data }): Promise<{ ok: boolean; text: string; message?: string }> => {
    const { transcribeAudio } = await import("./ai-transcribe.server");
    return transcribeAudio(data);
  });

export const analyzeFishingPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { imageDataUrl: string; note?: string | null }) => input)
  .handler(async ({ data, context }) => {
    const { analyzePhoto } = await import("./ai-vision.server");
    return analyzePhoto(data, { userId: context.userId });
  });



