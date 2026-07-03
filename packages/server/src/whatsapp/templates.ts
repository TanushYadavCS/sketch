export const WHATSAPP_TEMPLATE_KEYS = {
  proactiveUpdate: "whatsapp.proactive_update",
  taskNudge: "whatsapp.task_nudge",
  magicLink: "whatsapp.magic_link",
  introduction: "whatsapp.introduction",
} as const;

export type WhatsAppTemplateKey = (typeof WHATSAPP_TEMPLATE_KEYS)[keyof typeof WHATSAPP_TEMPLATE_KEYS] | string;

export type WhatsAppTemplateParamValue = string | number | boolean | null | undefined;

export interface WhatsAppTemplateRequest {
  key: WhatsAppTemplateKey;
  params: Record<string, WhatsAppTemplateParamValue>;
  fallbackText?: string;
  language?: string;
}

export function buildProactiveUpdateTemplate(params: {
  recipientName?: string | null;
  botName?: string | null;
  messageSummary: string;
  fallbackText?: string;
  language?: string;
}): WhatsAppTemplateRequest {
  return {
    key: WHATSAPP_TEMPLATE_KEYS.proactiveUpdate,
    params: {
      recipientName: params.recipientName ?? "there",
      botName: params.botName ?? "Sketch",
      messageSummary: params.messageSummary,
    },
    fallbackText: params.fallbackText ?? params.messageSummary,
    language: params.language,
  };
}

export function buildTaskNudgeTemplate(params: {
  recipientName?: string | null;
  language?: string;
}): WhatsAppTemplateRequest {
  return {
    key: WHATSAPP_TEMPLATE_KEYS.taskNudge,
    params: {
      recipientName: params.recipientName ?? "there",
    },
    fallbackText: "Sketch just finished running one of your scheduled tasks. Reply to see the details.",
    language: params.language,
  };
}

export function buildMagicLinkTemplate(params: {
  recipientName?: string | null;
  botName?: string | null;
  magicLinkUrl: string;
  fallbackText: string;
  language?: string;
}): WhatsAppTemplateRequest {
  return {
    key: WHATSAPP_TEMPLATE_KEYS.magicLink,
    params: {
      recipientName: params.recipientName ?? "there",
      botName: params.botName ?? "Sketch",
      magicLinkUrl: params.magicLinkUrl,
    },
    fallbackText: params.fallbackText,
    language: params.language,
  };
}

export function buildIntroductionTemplate(params: {
  recipientName?: string | null;
  botName?: string | null;
  orgName?: string | null;
  fallbackText: string;
  language?: string;
}): WhatsAppTemplateRequest {
  return {
    key: WHATSAPP_TEMPLATE_KEYS.introduction,
    params: {
      recipientName: params.recipientName ?? "there",
      botName: params.botName ?? "Sketch",
      orgName: params.orgName?.trim() || "your workspace",
    },
    fallbackText: params.fallbackText,
    language: params.language,
  };
}
