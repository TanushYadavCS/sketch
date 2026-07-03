import { z } from "zod";
import type { Logger } from "../../logger";
import {
  type WhatsAppCapabilities,
  type WhatsAppDmInboundMessage,
  type WhatsAppDmProvider,
  type WhatsAppInboundProvider,
  type WhatsAppMessageHandler,
  type WhatsAppSendOptions,
  type WhatsAppSendResult,
  type WhatsAppTarget,
  canonicalDmConversationId,
} from "../provider";

export const WHATSAPP_MANAGED_PROVIDER_ID = "managed";

const MANAGED_CAPABILITIES: WhatsAppCapabilities = {
  text: true,
  media: false,
  quotedReply: true,
  templates: false,
  templateProvisioning: "none",
  interactive: false,
  deliveryStatus: false,
  typing: false,
  reactions: false,
  edit: false,
  groups: false,
};

const inboundEventSchema = z.object({
  provider: z.string().trim().min(1),
  providerMessageId: z.string().trim().min(1),
  providerConversationId: z.string().trim().min(1),
  providerTimestamp: z.string().nullable().optional(),
  senderPhoneE164: z.string().trim().min(1),
  senderName: z.string().trim().min(1).optional(),
  tenantUserId: z.string().trim().min(1).optional(),
  tenantUserEmail: z.string().email().nullable().optional(),
  text: z.string().default(""),
  mediaType: z.string().trim().min(1).nullable().optional(),
  quotedMessage: z
    .object({
      providerMessageId: z.string().trim().min(1),
      text: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export interface ManagedWhatsAppConfig {
  platformUrl: string;
  tenantToken: string;
  logger: Logger;
  fetch?: typeof fetch;
}

export interface ManagedWhatsAppProvider {
  dmProvider: WhatsAppDmProvider;
  inboundProvider: WhatsAppInboundProvider;
  handleInboundEvent(payload: unknown): Promise<void>;
}

export function createManagedWhatsAppProvider(config: ManagedWhatsAppConfig): ManagedWhatsAppProvider {
  const platformUrl = config.platformUrl.replace(/\/+$/u, "");
  const requestFetch = config.fetch ?? fetch;
  const handlers = new Set<WhatsAppMessageHandler>();

  const sendText = async (
    target: WhatsAppTarget,
    text: string,
    options?: WhatsAppSendOptions,
  ): Promise<WhatsAppSendResult | null> => {
    if (target.kind !== "dm") throw new Error("Managed WhatsApp cannot send group messages");

    const response = await requestFetch(`${platformUrl}/api/whatsapp/outbound/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.tenantToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: target.phoneE164,
        text,
        providerConversationId: target.providerConversationId,
        quotedProviderMessageId: options?.quotedMessage?.providerMessageId,
      }),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Managed WhatsApp send failed: HTTP ${response.status}`);
    }

    const message = isRecord(body) && isRecord(body.message) ? body.message : {};
    return {
      providerMessageId: optionalString(message.providerMessageId),
      providerConversationId:
        optionalString(message.providerConversationId) ??
        target.providerConversationId ??
        canonicalDmConversationId(target.phoneE164),
      providerTimestamp: optionalString(message.providerTimestamp),
      rawProviderPayload: body,
    };
  };

  return {
    dmProvider: {
      id: WHATSAPP_MANAGED_PROVIDER_ID,
      role: "dm",
      capabilities: MANAGED_CAPABILITIES,
      get isConnected() {
        return Boolean(platformUrl && config.tenantToken);
      },
      sendText,
    },
    inboundProvider: {
      id: WHATSAPP_MANAGED_PROVIDER_ID,
      onMessage(handler) {
        handlers.add(handler);
      },
    },
    async handleInboundEvent(payload) {
      const parsed = inboundEventSchema.safeParse(payload);
      if (!parsed.success) {
        config.logger.warn({ issues: parsed.error.issues }, "Invalid managed WhatsApp inbound event");
        return;
      }

      const event = parsed.data;
      const message: WhatsAppDmInboundMessage = {
        kind: "dm",
        providerId: WHATSAPP_MANAGED_PROVIDER_ID,
        providerMessageId: event.providerMessageId,
        providerConversationId: event.providerConversationId,
        canonicalConversationId: canonicalDmConversationId(event.senderPhoneE164),
        providerTimestamp: event.providerTimestamp ?? null,
        senderName: event.senderName ?? event.senderPhoneE164,
        senderProviderId: event.senderPhoneE164,
        senderPhoneE164: event.senderPhoneE164,
        target: { kind: "dm", phoneE164: event.senderPhoneE164, providerConversationId: event.providerConversationId },
        text: event.text,
        rawProviderPayload: payload,
        ...(event.mediaType ? { mediaType: event.mediaType } : {}),
        ...(event.quotedMessage
          ? {
              quotedMessage: {
                providerMessageId: event.quotedMessage.providerMessageId,
                participantJid: null,
                text: event.quotedMessage.text ?? "",
              },
            }
          : {}),
      };

      for (const handler of handlers) {
        await handler(message);
      }
    },
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
