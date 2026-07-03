import { z } from "zod";
import type { createWhatsAppTemplateMappingRepository } from "../../db/repositories/whatsapp-template-mappings";
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
import { mapTemplateParams } from "../template-params";
import type { WhatsAppTemplateParamValue, WhatsAppTemplateRequest } from "../templates";

export const WHATSAPP_MANAGED_PROVIDER_ID = "managed";

const MANAGED_CAPABILITIES: WhatsAppCapabilities = {
  text: true,
  media: false,
  quotedReply: true,
  templates: true,
  templateProvisioning: "manual",
  interactive: false,
  deliveryStatus: false,
  typing: false,
  reactions: false,
  edit: false,
  groups: false,
};

const E164_PHONE_PATTERN = /^\+[1-9]\d{6,14}$/u;
const OUTBOUND_TIMEOUT_MS = 30_000;
const ERROR_BODY_SNIPPET_LIMIT = 500;

const e164PhoneSchema = z.string().trim().regex(E164_PHONE_PATTERN);
const optionalStringSchema = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);
const optionalTrimmedStringSchema = z
  .string()
  .trim()
  .min(1)
  .nullish()
  .transform((value) => value ?? undefined);

const inboundEventEnvelopeSchema = z
  .object({
    eventId: z.string().trim().min(1),
    type: z.string().trim().min(1),
  })
  .passthrough();

const inboundMessageEventSchema = z.object({
  eventId: z.string().trim().min(1),
  type: z.literal("message"),
  provider: z.string().trim().min(1),
  providerMessageId: z.string().trim().min(1),
  providerConversationId: z.string().trim().min(1),
  providerTimestamp: optionalStringSchema,
  senderPhoneE164: e164PhoneSchema,
  senderName: optionalTrimmedStringSchema,
  tenantUserId: optionalTrimmedStringSchema,
  tenantUserEmail: optionalTrimmedStringSchema,
  text: optionalStringSchema,
  mediaType: optionalTrimmedStringSchema,
  quotedMessage: z
    .object({
      providerMessageId: z.string().trim().min(1),
      text: optionalStringSchema,
    })
    .nullish()
    .transform((value) => value ?? undefined),
});

export interface ManagedWhatsAppConfig {
  platformUrl: string;
  tenantToken: string;
  logger: Logger;
  templateMappings?: ReturnType<typeof createWhatsAppTemplateMappingRepository>;
  fetch?: typeof fetch;
}

export type ManagedWhatsAppInboundHandleResult =
  | { kind: "message"; eventId: string; providerMessageId: string; senderPhoneE164: string }
  | { kind: "ignored"; eventId: string; type: string };

export class InvalidManagedWhatsAppInboundEventError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    super("Invalid managed WhatsApp inbound event");
    this.name = "InvalidManagedWhatsAppInboundEventError";
  }
}

export class ManagedWhatsAppRequestError extends Error {
  readonly status: number;
  readonly providerCode?: string;
  readonly providerInfo?: string;

  constructor(message: string, params: { status: number; providerCode?: string | null; providerInfo?: string | null }) {
    super(message);
    this.name = "ManagedWhatsAppRequestError";
    this.status = params.status;
    if (params.providerCode) this.providerCode = params.providerCode;
    if (params.providerInfo) this.providerInfo = params.providerInfo;
  }
}

export interface ManagedWhatsAppProvider {
  dmProvider: WhatsAppDmProvider;
  inboundProvider: WhatsAppInboundProvider;
  handleInboundEvent(payload: unknown): Promise<ManagedWhatsAppInboundHandleResult>;
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
    assertValidE164Target(target.phoneE164, config.logger);

    const body = await fetchManagedJson(requestFetch, `${platformUrl}/api/whatsapp/outbound/messages`, {
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

    return sendResultFromManagedBody(body, target);
  };

  const sendTemplate = async (
    target: WhatsAppTarget,
    template: WhatsAppTemplateRequest,
  ): Promise<WhatsAppSendResult | null> => {
    if (target.kind !== "dm") throw new Error("Managed WhatsApp cannot send group messages");
    assertValidE164Target(target.phoneE164, config.logger);
    if (!config.templateMappings) throw new Error("WhatsApp template mappings are not configured");

    const mapping = await config.templateMappings.findApprovedMapping(
      WHATSAPP_MANAGED_PROVIDER_ID,
      template.key,
      template.language,
    );
    if (!mapping) {
      throw new Error(`No approved WhatsApp template mapping configured for ${template.key}`);
    }

    const body = await fetchManagedJson(requestFetch, `${platformUrl}/api/whatsapp/outbound/templates`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.tenantToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: target.phoneE164,
        templateName: mapping.provider_template_name,
        params: providerTemplateParamRecord(mapping.parameterMap, template.params),
        providerConversationId: target.providerConversationId,
      }),
    });

    return sendResultFromManagedBody(body, target);
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
      sendTemplate,
    },
    inboundProvider: {
      id: WHATSAPP_MANAGED_PROVIDER_ID,
      onMessage(handler) {
        handlers.add(handler);
      },
    },
    async handleInboundEvent(payload) {
      const envelope = inboundEventEnvelopeSchema.safeParse(payload);
      if (!envelope.success) {
        config.logger.warn({ issues: envelope.error.issues }, "Invalid managed WhatsApp inbound event");
        throw new InvalidManagedWhatsAppInboundEventError(envelope.error.issues);
      }

      if (envelope.data.type !== "message") {
        config.logger.info(
          { eventId: envelope.data.eventId, type: envelope.data.type, decision: "ignored" },
          "Ignored managed WhatsApp inbound event",
        );
        return { kind: "ignored", eventId: envelope.data.eventId, type: envelope.data.type };
      }

      const parsed = inboundMessageEventSchema.safeParse(payload);
      if (!parsed.success) {
        config.logger.warn(
          { eventId: envelope.data.eventId, issues: parsed.error.issues },
          "Invalid managed WhatsApp inbound message event",
        );
        throw new InvalidManagedWhatsAppInboundEventError(parsed.error.issues);
      }

      const event = parsed.data;
      const text = inboundMessageText(event.text, event.mediaType);
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
        text,
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

      return {
        kind: "message",
        eventId: event.eventId,
        providerMessageId: event.providerMessageId,
        senderPhoneE164: event.senderPhoneE164,
      };
    },
  };
}

function sendResultFromManagedBody(body: unknown, target: Extract<WhatsAppTarget, { kind: "dm" }>): WhatsAppSendResult {
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
}

async function fetchManagedJson(requestFetch: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await requestFetch(url, { ...init, signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
  const text = await response.text().catch(() => "");

  if (!response.ok) {
    throw managedRequestError(response.status, text);
  }

  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function assertValidE164Target(phoneE164: string, logger: Logger): void {
  if (E164_PHONE_PATTERN.test(phoneE164)) return;
  logger.warn({ targetKind: "dm", decision: "rejected", reason: "invalid_e164" }, "Invalid managed WhatsApp target");
  throw new Error("Managed WhatsApp target phone number is invalid");
}

function inboundMessageText(text: string | undefined, mediaType: string | undefined): string {
  if (text?.trim()) return text;
  if (mediaType) return `[WhatsApp media message (${mediaType}) - media content not available]`;
  return text ?? "";
}

function providerTemplateParamRecord(
  parameterMap: Record<string, string> | null,
  params: Record<string, WhatsAppTemplateParamValue>,
): Record<string, string> {
  return Object.fromEntries(mapTemplateParams(parameterMap, params));
}

function managedRequestError(status: number, text: string): ManagedWhatsAppRequestError {
  const parsed = parseJsonObject(text);
  const error = parsed && isRecord(parsed.error) ? parsed.error : null;
  const providerMessage = optionalString(error?.message);
  const providerCode = optionalString(error?.providerCode);
  const providerInfo = optionalString(error?.providerInfo);
  const snippet = boundedResponseSnippet(providerMessage ?? text);
  return new ManagedWhatsAppRequestError(
    `Managed WhatsApp request failed: HTTP ${status}${snippet ? `: ${snippet}` : ""}`,
    { status, providerCode, providerInfo },
  );
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function boundedResponseSnippet(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > ERROR_BODY_SNIPPET_LIMIT ? `${compact.slice(0, ERROR_BODY_SNIPPET_LIMIT)}...` : compact;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
