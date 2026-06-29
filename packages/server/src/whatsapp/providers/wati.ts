import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
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

export interface WatiWhatsAppConfig {
  apiEndpoint: string;
  accessToken: string;
  webhookToken: string;
  channelPhoneNumber?: string | null;
  logger: Logger;
  fetch?: typeof fetch;
}

export interface WatiWhatsAppProvider {
  dmProvider: WhatsAppDmProvider;
  inboundProvider: WhatsAppInboundProvider;
  webhookToken: string;
  handleWebhook(payload: unknown): Promise<WatiWebhookHandleResult[]>;
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
      await fetchJson(requestFetch, new URL(`${endpoint}/api/v1/sendSessionFile/${encodeURIComponent(phone)}`), {
        method: "POST",
        headers: authorizationHeaders(config.accessToken),
        body: form,
      });
      return;
    }

    form.set("target", `${channelPhoneDigits}:${phone}`);

    await fetchJson(requestFetch, new URL(`${v3Endpoint}/api/ext/v3/conversations/messages/file`), {
      method: "POST",
      headers: authorizationHeaders(config.accessToken),
      body: form,
    });
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
          config.logger.debug(
            {
              providerMessageId: parsed.event.providerMessageId,
              providerConversationId: parsed.event.providerConversationId,
              eventType: parsed.event.eventType,
              status: parsed.event.status,
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

  if (owner === true) {
    const delivery = parseWatiDeliveryStatusEvent(payload);
    return delivery ?? { kind: "ignored", reason: "owner_event" };
  }

  if (eventType && eventType !== "message") {
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

  const configuredChannel = phoneDigits(options.channelPhoneNumber ?? null);
  const eventChannel = phoneDigits(optionalString(payload.channelPhoneNumber));
  if (configuredChannel && eventChannel !== configuredChannel) {
    return { kind: "ignored", reason: "channel_mismatch" };
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
  return { Authorization: `Bearer ${accessToken}` };
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
