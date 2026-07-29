import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { createWhatsAppProviderEventRepository } from "../../db/repositories/whatsapp-provider-events";
import type {
  ProviderTemplateSummary,
  createWhatsAppTemplateMappingRepository,
} from "../../db/repositories/whatsapp-template-mappings";
import type { Attachment } from "../../files";
import { mimeToExtension } from "../../files";
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

export const WHATSAPP_WATI_PROVIDER_ID = "wati";

const WATI_CAPABILITIES: WhatsAppCapabilities = {
  text: true,
  media: true,
  quotedReply: true,
  templates: true,
  templateProvisioning: "api",
  interactive: true,
  deliveryStatus: true,
  typing: false,
  reactions: false,
  edit: false,
  groups: false,
};

const MEDIA_MESSAGE_TYPES = new Set(["image", "document", "voice", "audio", "video", "sticker", "media_placeholder"]);
const UNSUPPORTED_INBOUND_MESSAGE_TYPES = new Set(["reaction"]);
const INBOUND_EVENT_TYPES = new Set(["message", "messagereceived", "message_received"]);
const WATI_USER_AGENT = "Sketch/1.0 (+https://getsketch.ai)";

export interface WatiWhatsAppConfig {
  apiEndpoint: string;
  accessToken: string;
  webhookToken: string;
  channelPhoneNumber?: string | null;
  logger: Logger;
  providerEvents?: ReturnType<typeof createWhatsAppProviderEventRepository>;
  templateMappings?: ReturnType<typeof createWhatsAppTemplateMappingRepository>;
  fetch?: typeof fetch;
}

export interface WatiWhatsAppProvider {
  dmProvider: WhatsAppDmProvider;
  inboundProvider: WhatsAppInboundProvider;
  webhookToken: string;
  handleWebhook(payload: unknown): Promise<WatiWebhookHandleResult[]>;
  listTemplates(): Promise<ProviderTemplateSummary[]>;
}

export type WatiWebhookHandleResult =
  | { kind: "message"; providerMessageId: string; senderPhoneE164: string }
  | { kind: "delivery_status"; event: WatiDeliveryStatusEvent }
  | { kind: "ignored"; reason: string }
  | { kind: "unrecognized"; reason: string; eventType: string | null; messageType: string | null };

export interface WatiDeliveryStatusEvent {
  providerId: typeof WHATSAPP_WATI_PROVIDER_ID;
  providerMessageId: string | null;
  providerConversationId: string | null;
  eventType: string | null;
  status: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  providerTimestamp: string | null;
  rawProviderPayload: unknown;
}

type WatiParsedWebhookEvent =
  | { kind: "message"; message: WhatsAppDmInboundMessage }
  | { kind: "delivery_status"; event: WatiDeliveryStatusEvent }
  | { kind: "ignored"; reason: string }
  | { kind: "unrecognized"; reason: string; eventType: string | null; messageType: string | null };

export function createWatiWhatsAppProvider(config: WatiWhatsAppConfig): WatiWhatsAppProvider {
  const endpoint = normalizeApiEndpoint(config.apiEndpoint);
  const v3Endpoint = normalizeApiEndpoint(new URL(endpoint).origin);
  const requestFetch = config.fetch ?? fetch;
  const channelPhoneDigits = phoneDigits(config.channelPhoneNumber ?? null);
  const handlers = new Set<WhatsAppMessageHandler>();

  const sendText = async (
    target: WhatsAppTarget,
    text: string,
    options?: WhatsAppSendOptions,
  ): Promise<WhatsAppSendResult | null> => {
    const phone = targetPhoneDigits(target);
    const url = new URL(`${endpoint}/api/v1/sendSessionMessage/${encodeURIComponent(phone)}`);
    const bodyParams = new URLSearchParams({ messageText: text });

    const replyContextId = options?.quotedMessage?.providerMessageId;
    if (replyContextId) bodyParams.set("replyContextId", replyContextId);
    if (channelPhoneDigits) bodyParams.set("channelPhoneNumber", channelPhoneDigits);

    const body = await fetchJson(requestFetch, url, {
      method: "POST",
      headers: { ...authorizationHeaders(config.accessToken), "Content-Type": "application/x-www-form-urlencoded" },
      body: bodyParams,
    });

    return sendResultFromWatiBody(body, target);
  };

  const sendFile = async (target: WhatsAppTarget, filePath: string, mimeType: string, fileName: string) => {
    const phone = targetPhoneDigits(target);
    const form = new FormData();
    const fileBytes = await readFile(filePath);

    form.set("file", new Blob([new Uint8Array(fileBytes)], { type: mimeType }), fileName);

    if (!channelPhoneDigits) {
      const responseBody = await fetchJson(
        requestFetch,
        new URL(`${endpoint}/api/v1/sendSessionFile/${encodeURIComponent(phone)}`),
        {
          method: "POST",
          headers: authorizationHeaders(config.accessToken),
          body: form,
        },
      );
      assertWatiFileSendAccepted(responseBody);
      return;
    }

    form.set("target", `${channelPhoneDigits}:${phone}`);

    const responseBody = await fetchJson(
      requestFetch,
      new URL(`${v3Endpoint}/api/ext/v3/conversations/messages/file`),
      {
        method: "POST",
        headers: authorizationHeaders(config.accessToken),
        body: form,
      },
    );
    assertWatiFileSendAccepted(responseBody);
  };

  const sendTemplate = async (
    target: WhatsAppTarget,
    template: WhatsAppTemplateRequest,
  ): Promise<WhatsAppSendResult | null> => {
    if (!config.templateMappings) throw new Error("WhatsApp template mappings are not configured");
    const mapping = await config.templateMappings.findApprovedMapping(
      WHATSAPP_WATI_PROVIDER_ID,
      template.key,
      template.language,
    );
    if (!mapping) {
      throw Object.assign(new Error(`No approved WhatsApp template mapping configured for ${template.key}`), {
        providerCode: "template_not_found",
      });
    }

    const phone = targetPhoneDigits(target);
    const url = new URL(`${v3Endpoint}/api/ext/v3/messageTemplates/send`);
    const customParams = providerTemplateParameters(mapping.parameterMap, template.params);
    const body = {
      channel: channelPhoneDigits ?? null,
      template_name: mapping.provider_template_name,
      broadcast_name: buildBroadcastName(template.key),
      recipients: [
        {
          phone_number: phone,
          custom_params: customParams,
        },
      ],
    };

    const responseBody = await fetchJson(requestFetch, url, {
      method: "POST",
      headers: { ...authorizationHeaders(config.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return sendResultFromWatiTemplateBody(responseBody, target);
  };

  const listTemplates = async (): Promise<ProviderTemplateSummary[]> => {
    const templates: ProviderTemplateSummary[] = [];
    const pageSize = 100;

    for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
      const url = new URL(`${v3Endpoint}/api/ext/v3/messageTemplates`);
      url.searchParams.set("page_number", String(pageNumber));
      url.searchParams.set("page_size", String(pageSize));
      if (channelPhoneDigits) url.searchParams.set("channel", channelPhoneDigits);

      const body = await fetchJson(requestFetch, url, {
        method: "GET",
        headers: authorizationHeaders(config.accessToken),
      });
      const pageTemplates = parseWatiTemplateList(body);
      templates.push(...pageTemplates);
      if (pageTemplates.length < pageSize) break;
    }

    return templates;
  };

  const downloadMedia = async (
    message: WhatsAppDmInboundMessage,
    workspaceDir: string,
    params: { maxFileBytes: number },
  ): Promise<Attachment[]> => {
    if (!message.mediaType) return [];

    const fileMessageIds = fileMessageIdsForDownload(message);
    if (!fileMessageIds.length) {
      config.logger.warn(
        { providerMessageId: message.providerMessageId, mediaType: message.mediaType },
        "Wati media message has no downloadable id",
      );
      return [];
    }

    let response: Response | null = null;
    for (const [index, fileMessageId] of fileMessageIds.entries()) {
      const url = new URL(`${v3Endpoint}/api/ext/v3/conversations/messages/file/${encodeURIComponent(fileMessageId)}`);
      const attempt = await requestFetch(url, {
        headers: authorizationHeaders(config.accessToken),
      });

      const isLastAttempt = index === fileMessageIds.length - 1;
      if (attempt.ok || isLastAttempt || !shouldTryNextMediaDownloadId(attempt.status)) {
        response = attempt;
        break;
      }

      await attempt.arrayBuffer().catch(() => undefined);
    }

    if (!response?.ok) {
      config.logger.warn(
        {
          status: response?.status ?? null,
          attempts: fileMessageIds.length,
          providerMessageId: message.providerMessageId,
          mediaType: message.mediaType,
        },
        "Failed to download Wati media",
      );
      return [];
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > params.maxFileBytes) {
      config.logger.warn(
        { sizeBytes: contentLength, maxFileBytes: params.maxFileBytes, mediaType: message.mediaType },
        "Wati media exceeds size limit",
      );
      return [];
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > params.maxFileBytes) {
      config.logger.warn(
        { sizeBytes: bytes.length, maxFileBytes: params.maxFileBytes, mediaType: message.mediaType },
        "Wati media exceeds size limit",
      );
      return [];
    }

    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    const originalName =
      fileNameFromHeaders(response.headers) ?? `${message.providerMessageId}.${mimeToExtension(mimeType)}`;
    const safeName = sanitizeFilename(originalName);
    const attachmentsDir = join(workspaceDir, "attachments");
    await mkdir(attachmentsDir, { recursive: true });
    const localPath = join(attachmentsDir, `${Date.now()}_${safeName}`);
    await writeFile(localPath, bytes);

    return [
      {
        originalName: safeName,
        mimeType,
        localPath,
        sizeBytes: bytes.length,
      },
    ];
  };

  const provider: WatiWhatsAppProvider = {
    dmProvider: {
      id: WHATSAPP_WATI_PROVIDER_ID,
      role: "dm",
      capabilities: WATI_CAPABILITIES,
      get isConnected() {
        return Boolean(endpoint && config.accessToken);
      },
      sendText,
      sendTemplate,
      sendFile,
      downloadMedia: (message, workspaceDir, params) =>
        message.kind === "dm" ? downloadMedia(message, workspaceDir, params) : Promise.resolve([]),
    },
    inboundProvider: {
      id: WHATSAPP_WATI_PROVIDER_ID,
      onMessage(handler) {
        handlers.add(handler);
      },
    },
    webhookToken: config.webhookToken,
    listTemplates,
    async handleWebhook(payload) {
      const events = Array.isArray(payload) ? payload : [payload];
      const results: WatiWebhookHandleResult[] = [];

      for (const eventPayload of events) {
        const parsed = parseWatiWebhookEvent(eventPayload, { channelPhoneNumber: config.channelPhoneNumber });
        if (parsed.kind === "message") {
          for (const handler of handlers) {
            await handler(parsed.message);
          }
          results.push({
            kind: "message",
            providerMessageId: parsed.message.providerMessageId,
            senderPhoneE164: parsed.message.senderPhoneE164,
          });
          continue;
        }

        if (parsed.kind === "delivery_status") {
          const recorded = config.providerEvents
            ? await config.providerEvents.upsertDeliveryStatus({
                provider: parsed.event.providerId,
                providerMessageId: parsed.event.providerMessageId,
                providerConversationId: parsed.event.providerConversationId,
                eventType: parsed.event.eventType,
                status: parsed.event.status,
                failureCode: parsed.event.failureCode,
                failureDetail: parsed.event.failureDetail,
                providerTimestamp: parsed.event.providerTimestamp,
                rawProviderPayload: parsed.event.rawProviderPayload,
              })
            : null;
          config.logger.debug(
            {
              providerMessageId: parsed.event.providerMessageId,
              providerConversationId: parsed.event.providerConversationId,
              eventType: parsed.event.eventType,
              status: parsed.event.status,
              inserted: recorded?.inserted ?? null,
            },
            "Parsed Wati delivery/status webhook event",
          );
          results.push(parsed);
          continue;
        }

        if (parsed.kind === "unrecognized") {
          config.logger.warn(
            { eventType: parsed.eventType, messageType: parsed.messageType, reason: parsed.reason },
            "Unrecognized Wati webhook event",
          );
        }

        results.push(parsed);
      }

      return results;
    },
  };

  return provider;
}

export function parseWatiWebhookEvent(
  payload: unknown,
  options: { channelPhoneNumber?: string | null } = {},
): WatiParsedWebhookEvent {
  if (!isRecord(payload)) {
    return { kind: "unrecognized", reason: "payload_not_object", eventType: null, messageType: null };
  }

  const eventType = optionalString(payload.eventType);
  const messageType = optionalString(payload.type);
  const owner = optionalBoolean(payload.owner);
  const normalizedEventType = normalizeEventType(eventType);
  const configuredChannel = phoneDigits(options.channelPhoneNumber ?? null);
  const eventChannel = phoneDigits(optionalString(payload.channelPhoneNumber));

  if (configuredChannel && eventChannel && eventChannel !== configuredChannel) {
    return { kind: "ignored", reason: "channel_mismatch" };
  }

  if (owner === true) {
    const delivery = parseWatiDeliveryStatusEvent(payload);
    return delivery ?? { kind: "ignored", reason: "owner_event" };
  }

  if (eventType && !INBOUND_EVENT_TYPES.has(normalizedEventType)) {
    const delivery = parseWatiDeliveryStatusEvent(payload);
    return (
      delivery ?? {
        kind: "unrecognized",
        reason: "unsupported_event_type",
        eventType,
        messageType,
      }
    );
  }

  if (messageType && UNSUPPORTED_INBOUND_MESSAGE_TYPES.has(messageType)) {
    return { kind: "ignored", reason: "unsupported_message_type" };
  }

  const senderPhoneE164 = normalizeWatiPhoneNumber(payload.waId);
  const providerMessageId = optionalString(payload.whatsappMessageId) ?? optionalString(payload.id);
  if (!senderPhoneE164 && hasWatiUsernameOnlyIdentity(payload)) {
    return { kind: "ignored", reason: "unsupported_sender_identity" };
  }
  if (!senderPhoneE164 || !providerMessageId) {
    return {
      kind: "unrecognized",
      reason: "missing_required_message_fields",
      eventType,
      messageType,
    };
  }

  const providerConversationId =
    optionalString(payload.conversationId) ?? optionalString(payload.ticketId) ?? `wati:${senderPhoneE164}`;
  const replyContextId = optionalString(payload.replyContextId);
  const text = optionalString(payload.text) ?? textFromInteractiveReply(payload) ?? "";
  const mediaType = messageType && MEDIA_MESSAGE_TYPES.has(messageType) ? messageType : undefined;

  return {
    kind: "message",
    message: {
      kind: "dm",
      providerId: WHATSAPP_WATI_PROVIDER_ID,
      providerMessageId,
      providerConversationId,
      canonicalConversationId: canonicalDmConversationId(senderPhoneE164),
      providerTimestamp: parseWatiTimestamp(payload.timestamp) ?? parseWatiTimestamp(payload.created),
      senderName: optionalString(payload.senderName) ?? senderPhoneE164,
      senderProviderId: optionalString(payload.waId) ?? senderPhoneE164,
      senderPhoneE164,
      target: { kind: "dm", phoneE164: senderPhoneE164 },
      text,
      rawProviderPayload: payload,
      ...(mediaType ? { mediaType } : {}),
      ...(replyContextId
        ? { quotedMessage: { providerMessageId: replyContextId, participantJid: null, text: "" } }
        : {}),
    },
  };
}

export function parseWatiDeliveryStatusEvent(
  payload: unknown,
): { kind: "delivery_status"; event: WatiDeliveryStatusEvent } | null {
  if (!isRecord(payload)) return null;

  const eventType = optionalString(payload.eventType);
  const status =
    optionalString(payload.statusString) ??
    optionalString(payload.status) ??
    optionalString(payload.status_string) ??
    optionalString(payload.event);
  const providerMessageId =
    optionalString(payload.localMessageId) ??
    optionalString(payload.local_message_id) ??
    optionalString(payload.whatsappMessageId) ??
    optionalString(payload.messageId) ??
    optionalString(payload.message_id) ??
    optionalString(payload.id);

  if (!status && !providerMessageId) return null;

  return {
    kind: "delivery_status",
    event: {
      providerId: WHATSAPP_WATI_PROVIDER_ID,
      providerMessageId,
      providerConversationId: optionalString(payload.conversationId) ?? optionalString(payload.conversation_id),
      eventType,
      status,
      failureCode: optionalString(payload.failedCode) ?? optionalString(payload.failed_code),
      failureDetail: optionalString(payload.failedDetail) ?? optionalString(payload.failed_detail),
      providerTimestamp:
        parseWatiTimestamp(payload.timestamp) ??
        parseWatiTimestamp(payload.created) ??
        parseWatiTimestamp(payload.updatedAt),
      rawProviderPayload: payload,
    },
  };
}

function providerTemplateParameters(
  parameterMap: Record<string, string> | null,
  params: Record<string, WhatsAppTemplateParamValue>,
): Array<{ name: string; value: string }> {
  return mapTemplateParams(parameterMap, params).map(([providerName, value]) => ({
    name: providerName,
    value,
  }));
}

function buildBroadcastName(key: string): string {
  return `sketch_${key.replace(/[^a-zA-Z0-9]+/gu, "_").slice(0, 48)}_${Date.now()}`;
}

export function normalizeWatiPhoneNumber(value: unknown): string | null {
  const digits = phoneDigits(value);
  if (!digits || !/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

function normalizeApiEndpoint(value: string): string {
  return value.replace(/\/+$/u, "");
}

function targetPhoneDigits(target: WhatsAppTarget): string {
  if (target.kind !== "dm") throw new Error("Wati cannot send WhatsApp group messages");
  const digits = phoneDigits(target.phoneE164);
  if (!digits) throw new Error("Wati target phone number is invalid");
  return digits;
}

function phoneDigits(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).replace(/\D/gu, "");
  return digits || null;
}

function authorizationHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, "User-Agent": WATI_USER_AGENT };
}

async function fetchJson(requestFetch: typeof fetch, url: URL, init: RequestInit): Promise<unknown> {
  const response = await requestFetch(url, init);
  if (!response.ok) {
    throw new Error(`Wati API request failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

function sendResultFromWatiBody(body: unknown, target: WhatsAppTarget): WhatsAppSendResult | null {
  const record = isRecord(body) ? body : {};
  const message = isRecord(record.message) ? record.message : record;
  const failureReason = watiMessageSendFailure(record, message);
  if (failureReason) throw new Error(failureReason);
  const fallbackConversationId =
    target.kind === "dm" ? (target.providerConversationId ?? `wati:${target.phoneE164}`) : target.groupId;

  return {
    providerMessageId:
      optionalString(message.whatsappMessageId) ??
      optionalString(message.id) ??
      optionalString(record.whatsappMessageId) ??
      optionalString(record.id),
    providerConversationId:
      optionalString(message.conversationId) ??
      optionalString(message.conversation_id) ??
      optionalString(record.conversationId) ??
      optionalString(record.conversation_id) ??
      fallbackConversationId,
    providerTimestamp:
      parseWatiTimestamp(message.time) ??
      parseWatiTimestamp(message.timestamp) ??
      parseWatiTimestamp(message.created) ??
      parseWatiTimestamp(record.created),
    rawProviderPayload: body,
  };
}

function watiMessageSendFailure(record: Record<string, unknown>, message: Record<string, unknown>): string | null {
  if (hasWatiSendFailure(record, message)) return "Wati message send failed: provider rejected request";
  return null;
}

function assertWatiFileSendAccepted(body: unknown): void {
  const record = isRecord(body) ? body : {};
  const message = isRecord(record.message) ? record.message : record;
  if (hasWatiSendFailure(record, message)) throw new Error("Wati file send failed: provider rejected request");
}

function hasWatiSendFailure(record: Record<string, unknown>, message: Record<string, unknown>): boolean {
  if (
    isExplicitFalse(record.result) ||
    isExplicitFalse(record.ok) ||
    isExplicitFalse(record.success) ||
    isExplicitFalse(message.result) ||
    isExplicitFalse(message.ok) ||
    isExplicitFalse(message.success) ||
    hasProviderErrors(record.error) ||
    hasProviderErrors(record.errors) ||
    hasProviderErrors(message.error) ||
    hasProviderErrors(message.errors)
  ) {
    return true;
  }

  const status =
    optionalString(message.status) ??
    optionalString(message.statusString) ??
    optionalString(message.result) ??
    optionalString(record.status) ??
    optionalString(record.statusString) ??
    optionalString(record.result);
  return isFailureStatus(status);
}

function sendResultFromWatiTemplateBody(body: unknown, target: WhatsAppTarget): WhatsAppSendResult | null {
  const record = isRecord(body) ? body : {};
  const deliveryRows = Array.isArray(record.recipients)
    ? record.recipients
    : Array.isArray(record.receivers)
      ? record.receivers
      : [];
  const firstReceiver = isRecord(deliveryRows[0]) ? deliveryRows[0] : {};
  const failureReason = watiTemplateSendFailure(record, firstReceiver);
  if (failureReason) throw new Error(failureReason);
  const fallbackConversationId =
    target.kind === "dm"
      ? (target.providerConversationId ?? canonicalDmConversationId(target.phoneE164))
      : target.groupId;
  const providerMessageId =
    optionalString(firstReceiver.localMessageId) ??
    optionalString(firstReceiver.local_message_id) ??
    optionalString(firstReceiver.whatsappMessageId) ??
    optionalString(firstReceiver.id) ??
    optionalString(record.localMessageId) ??
    optionalString(record.whatsappMessageId);
  if (!providerMessageId) {
    throw new Error("Wati template send failed: missing provider message id");
  }

  return {
    providerMessageId,
    providerConversationId:
      optionalString(firstReceiver.conversationId) ??
      optionalString(firstReceiver.conversation_id) ??
      optionalString(record.conversationId) ??
      optionalString(record.conversation_id) ??
      fallbackConversationId,
    providerTimestamp:
      parseWatiTimestamp(firstReceiver.time) ??
      parseWatiTimestamp(firstReceiver.timestamp) ??
      parseWatiTimestamp(record.created),
    rawProviderPayload: body,
  };
}

function watiTemplateSendFailure(
  record: Record<string, unknown>,
  firstReceiver: Record<string, unknown>,
): string | null {
  if (isExplicitFalse(record.result) || hasProviderErrors(record.error)) {
    return "Wati template send failed: provider rejected request";
  }
  if (
    optionalBoolean(firstReceiver.isValidWhatsAppNumber) === false ||
    optionalBoolean(firstReceiver.is_valid_whatsapp_number) === false
  ) {
    return "Wati template send failed: invalid WhatsApp recipient";
  }
  if (hasProviderErrors(firstReceiver.errors) || hasProviderErrors(firstReceiver.error)) {
    return "Wati template send failed: recipient rejected";
  }
  return null;
}

function isExplicitFalse(value: unknown): boolean {
  return value === false || (typeof value === "string" && value.trim().toLowerCase() === "false");
}

function hasProviderErrors(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function isFailureStatus(value: string | null): boolean {
  if (!value) return false;
  return /fail|error|reject/iu.test(value);
}

function parseWatiTemplateList(body: unknown): ProviderTemplateSummary[] {
  const candidates = templateArrayCandidates(body);
  const templates: ProviderTemplateSummary[] = [];

  for (const item of candidates) {
    if (!isRecord(item)) continue;
    const providerTemplateName =
      optionalString(item.elementName) ??
      optionalString(item.templateName) ??
      optionalString(item.template_name) ??
      optionalString(item.name);
    if (!providerTemplateName) continue;
    templates.push({
      providerTemplateName,
      language: templateLanguage(item),
      status: optionalString(item.status),
      category: optionalString(item.category),
      rawProviderPayload: item,
    });
  }

  return templates;
}

function templateArrayCandidates(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return [];
  for (const key of ["messageTemplates", "templates", "data", "items", "result", "results", "rows"]) {
    const value = body[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function templateLanguage(item: Record<string, unknown>): string {
  const language = item.language;
  if (typeof language === "string" && language.trim()) return language.trim();
  if (isRecord(language)) {
    return (
      optionalString(language.code) ??
      optionalString(language.value) ??
      optionalString(language.name) ??
      optionalString(language.text) ??
      "en_US"
    );
  }
  return optionalString(item.languageCode) ?? optionalString(item.language_code) ?? "en_US";
}

function fileMessageIdsForDownload(message: WhatsAppDmInboundMessage): string[] {
  const raw = isRecord(message.rawProviderPayload) ? message.rawProviderPayload : null;
  return uniqueStrings([optionalString(raw?.id), optionalString(raw?.whatsappMessageId), message.providerMessageId]);
}

function shouldTryNextMediaDownloadId(status: number): boolean {
  return status === 400 || status === 403 || status === 404;
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function hasWatiUsernameOnlyIdentity(payload: Record<string, unknown>): boolean {
  return Boolean(
    optionalString(payload.bsuid) ??
      optionalString(payload.senderBsuid) ??
      optionalString(payload.senderBSUID) ??
      optionalString(payload.whatsappUsername) ??
      optionalString(payload.whatsappUserName),
  );
}

function fileNameFromHeaders(headers: Headers): string | null {
  const contentDisposition = headers.get("content-disposition");
  if (!contentDisposition) return null;
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/iu.exec(contentDisposition);
  if (!match?.[1]) return null;
  try {
    return basename(decodeURIComponent(match[1]));
  } catch {
    return basename(match[1]);
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

function parseWatiTimestamp(value: unknown): string | null {
  const input = optionalString(value);
  if (!input) return null;

  if (/^\d+$/u.test(input)) {
    const seconds = Number(input);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(seconds * 1000).toISOString();
  }

  const millis = Date.parse(input);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString();
}

function normalizeEventType(value: string | null): string {
  return (
    value
      ?.trim()
      .replace(/[^a-zA-Z0-9]+/gu, "_")
      .toLowerCase() ?? ""
  );
}

function textFromInteractiveReply(payload: Record<string, unknown>): string | null {
  for (const key of ["listReply", "interactiveButtonReply", "buttonReply"]) {
    const value = payload[key];
    if (!isRecord(value)) continue;

    const text =
      optionalString(value.title) ??
      optionalString(value.text) ??
      optionalString(value.name) ??
      optionalString(value.id) ??
      optionalString(value.value);
    if (text) return text;
  }
  return null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
