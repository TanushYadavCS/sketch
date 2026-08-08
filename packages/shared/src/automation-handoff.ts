import { z } from "zod";

export const automationDraftHandoffSchema = z.object({
  kind: z.literal("automation-draft"),
  taskId: z.string().trim().min(1),
  sourceConversationId: z.string().trim().min(1),
  builderUrl: z.string().trim().min(1),
  status: z.literal("paused"),
});

export type AutomationDraftHandoff = z.infer<typeof automationDraftHandoffSchema>;
