import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import type { Attachment } from "../../files";
import type { Logger } from "../../logger";
import type { WhatsAppHistoryMessagesHandler, WhatsAppMessage, WhatsAppMessageHandler } from "../bot";
import type { WhatsAppQuotedRef, WhatsAppSocketFacade } from "../facade-contract";
import {
  WHATSAPP_BAILEYS_PROVIDER_ID,
  type WhatsAppCapabilities,
  type WhatsAppDmProvider,
  type WhatsAppGroupMetadata,
  type WhatsAppGroupProvider,
  type WhatsAppInboundMessage,
  type WhatsAppInboundProvider,
  type WhatsAppSendOptions,
  type WhatsAppSendResult,
  type WhatsAppTarget,
  canonicalDmConversationId,
  canonicalGroupConversationId,
  phoneE164ToWhatsAppJid,
  whatsappJidToPhoneE164,
} from "../provider";

const BAILEYS_TEXT_CAPABILITIES: Omit<WhatsAppCapabilities, "groups"> = {
  text: true,
  media: true,
  quotedReply: true,
  templates: false,
  templateProvisioning: "none",
  interactive: false,
  deliveryStatus: false,
  typing: true,
  reactions: true,
  edit: true,
};

export interface BaileysWhatsAppProviders {
  dmProvider: WhatsAppDmProvider;
  groupProvider: WhatsAppGroupProvider;
  inboundProvider: WhatsAppInboundProvider;
}

export interface BaileysWhatsAppInboundSource {
  readonly isConnected: boolean;
  onMessage(handler: WhatsAppMessageHandler): void;
  onHistoryMessages(handler: WhatsAppHistoryMessagesHandler): void;
}

interface MessageReferenceStore {
  rememberMessage(params: {
    providerConversationId: string;
    providerMessageId: string;
    rawProviderPayload: unknown;
  }): void;
}

export function createBaileysWhatsAppProviders(
  whatsapp: WhatsAppSocketFacade,
  inboundSource: BaileysWhatsAppInboundSource,
  logger: Logger,
): BaileysWhatsAppProviders {
  const toProviderConversationId = (target: WhatsAppTarget): string => {
    if (target.kind === "group") return target.groupId;
    return target.providerConversationId ?? phoneE164ToWhatsAppJid(target.phoneE164);
  };

  const toQuotedRef = (
    providerConversationId: string,
    options?: WhatsAppSendOptions,
  ): WhatsAppQuotedRef | undefined => {
    const quoted = options?.quotedMessage?.rawProviderPayload;
    if (!quoted || !isBaileysMessage(quoted)) return undefined;
    rememberMessage(whatsapp, providerConversationId, options.quotedMessage?.providerMessageId ?? "", quoted);
    return {
      kind: "providerMessageId",
      providerConversationId,
      value: options.quotedMessage?.providerMessageId ?? "",
    };
  };

  const sendText = async (
    target: WhatsAppTarget,
    text: string,
    options?: WhatsAppSendOptions,
  ): Promise<WhatsAppSendResult | null> => {
    const providerConversationId = toProviderConversationId(target);
    return whatsapp.send(
      providerConversationId,
      { kind: "text", text },
      {
        quotedRef: toQuotedRef(providerConversationId, options),
        idempotencyKey: randomUUID(),
      },
    );
  };

  const sendFile = async (target: WhatsAppTarget, filePath: string, mimeType: string, fileName: string) => {
    await whatsapp.send(
      toProviderConversationId(target),
      { kind: "file", filePath, mimeType, fileName },
      { idempotencyKey: randomUUID() },
    );
  };

  const startComposing = (target: WhatsAppTarget) => {
    void whatsapp.sendComposing(toProviderConversationId(target), true);
  };

  const stopComposing = (target: WhatsAppTarget) => {
    void whatsapp.sendComposing(toProviderConversationId(target), false);
  };

  const addReaction = async (message: WhatsAppInboundMessage, emoji: string) => {
    const rawMessage = baileysRawMessage(message);
    if (!rawMessage?.key) return;
    rememberMessage(whatsapp, message.providerConversationId, message.providerMessageId, rawMessage);
    const result = await whatsapp.react(reactionJidForMessage(message, rawMessage), providerMessageRef(message), emoji);
    if ("error" in result) {
      logger.warn({ providerMessageId: message.providerMessageId }, "Skipped WhatsApp reaction for unknown message");
    }
  };

  const removeReaction = async (message: WhatsAppInboundMessage) => {
    const rawMessage = baileysRawMessage(message);
    if (!rawMessage?.key) return;
    rememberMessage(whatsapp, message.providerConversationId, message.providerMessageId, rawMessage);
    const result = await whatsapp.react(reactionJidForMessage(message, rawMessage), providerMessageRef(message), "");
    if ("error" in result) {
      logger.warn(
        { providerMessageId: message.providerMessageId },
        "Skipped WhatsApp reaction removal for unknown message",
      );
    }
  };

  const downloadMedia = async (
    message: WhatsAppInboundMessage,
    workspaceDir: string,
    params: { maxFileBytes: number },
  ): Promise<Attachment[]> => {
    const rawMessage = baileysRawMessage(message);
    if (!message.mediaType || !rawMessage) return [];
    rememberMessage(whatsapp, message.providerConversationId, message.providerMessageId, rawMessage);

    try {
      const media = await whatsapp.downloadMedia({
        messageRef: providerMessageRef(message),
        destinationDir: join(workspaceDir, "attachments"),
        maxFileBytes: params.maxFileBytes,
      });
      return media
        ? [
            {
              originalName: media.originalName ?? basename(media.stagedPath),
              mimeType: media.mime,
              localPath: media.stagedPath,
              sizeBytes: media.size,
            },
          ]
        : [];
    } catch (err) {
      logger.warn({ err, mediaType: message.mediaType }, "Failed to download WhatsApp media");
      return [];
    }
  };

  const getGroupMetadata = async (groupId: string): Promise<WhatsAppGroupMetadata | undefined> => {
    return (await whatsapp.groupMetadata(groupId, { refresh: false })) ?? undefined;
  };

  const shared = {
    id: WHATSAPP_BAILEYS_PROVIDER_ID,
    sendText,
    sendFile,
    startComposing,
    stopComposing,
    addReaction,
    removeReaction,
    downloadMedia,
    getGroupMetadata,
    resolveProviderContactToPhone: async (providerContactId: string) => {
      const phoneJid = await whatsapp.resolveLid(providerContactId);
      return phoneJid ? whatsappJidToPhoneE164(phoneJid) : null;
    },
  };

  return {
    dmProvider: {
      ...shared,
      role: "dm",
      get isConnected() {
        return inboundSource.isConnected;
      },
      capabilities: { ...BAILEYS_TEXT_CAPABILITIES, groups: false },
    },
    groupProvider: {
      ...shared,
      role: "group",
      get isConnected() {
        return inboundSource.isConnected;
      },
      capabilities: { ...BAILEYS_TEXT_CAPABILITIES, groups: true },
    },
    inboundProvider: {
      id: WHATSAPP_BAILEYS_PROVIDER_ID,
      onMessage(handler) {
        inboundSource.onMessage((message) => {
          const normalized = normalizeBaileysInboundMessage(message);
          rememberMessage(
            whatsapp,
            normalized.providerConversationId,
            normalized.providerMessageId,
            normalized.rawProviderPayload,
          );
          return handler(normalized);
        });
      },
      onHistoryMessages(handler) {
        inboundSource.onHistoryMessages((messages, metadata) => {
          const normalized = messages.map(normalizeBaileysInboundMessage);
          for (const message of normalized) {
            rememberMessage(
              whatsapp,
              message.providerConversationId,
              message.providerMessageId,
              message.rawProviderPayload,
            );
          }
          return handler(normalized, metadata);
        });
      },
    },
  };
}

export function baileysTargetFromPhone(phoneE164: string): Extract<WhatsAppTarget, { kind: "dm" }> {
  return { kind: "dm", phoneE164, providerConversationId: phoneE164ToWhatsAppJid(phoneE164) };
}

function normalizeBaileysInboundMessage(message: WhatsAppMessage): WhatsAppInboundMessage {
  if (message.type === "dm") {
    const providerConversationId = phoneE164ToWhatsAppJid(message.phoneNumber);
    return {
      kind: "dm",
      providerId: WHATSAPP_BAILEYS_PROVIDER_ID,
      providerMessageId: message.messageId,
      providerConversationId,
      canonicalConversationId: canonicalDmConversationId(message.phoneNumber),
      providerTimestamp: providerTimestamp(message.rawMessage as WAMessage),
      senderName: message.pushName,
      senderProviderId: message.jid,
      senderPhoneE164: message.phoneNumber,
      target: { kind: "dm", phoneE164: message.phoneNumber, providerConversationId },
      text: message.text,
      rawProviderPayload: message.rawMessage,
      ...(message.mediaType ? { mediaType: message.mediaType } : {}),
      ...(message.quotedMessage ? { quotedMessage: message.quotedMessage } : {}),
    };
  }

  return {
    kind: "group",
    providerId: WHATSAPP_BAILEYS_PROVIDER_ID,
    providerMessageId: message.messageId,
    providerConversationId: message.jid,
    canonicalConversationId: canonicalGroupConversationId(message.jid),
    providerTimestamp: providerTimestamp(message.rawMessage as WAMessage),
    senderName: message.pushName,
    senderProviderId: message.senderJid,
    senderPhoneE164: message.senderPhone,
    target: { kind: "group", groupId: message.jid },
    text: message.text,
    isMentioned: message.isMentioned,
    rawProviderPayload: message.rawMessage,
    ...(message.mediaType ? { mediaType: message.mediaType } : {}),
    ...(message.quotedMessage ? { quotedMessage: message.quotedMessage } : {}),
  };
}

function providerTimestamp(message: WAMessage | undefined): string | null {
  const timestamp = message?.messageTimestamp;
  if (timestamp == null) return null;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function providerMessageRef(message: WhatsAppInboundMessage): WhatsAppQuotedRef {
  return {
    kind: "providerMessageId",
    providerConversationId: message.providerConversationId,
    value: message.providerMessageId,
  };
}

function rememberMessage(
  facade: WhatsAppSocketFacade,
  providerConversationId: string,
  providerMessageId: string,
  rawProviderPayload: unknown,
): void {
  if (!providerMessageId || !("rememberMessage" in facade)) return;
  (facade as WhatsAppSocketFacade & MessageReferenceStore).rememberMessage({
    providerConversationId,
    providerMessageId,
    rawProviderPayload,
  });
}

function baileysRawMessage(message: WhatsAppInboundMessage): WAMessage | null {
  const raw = message.rawProviderPayload;
  return raw && isBaileysMessage(raw) ? raw : null;
}

function isBaileysMessage(value: unknown): value is WAMessage {
  return Boolean(value && typeof value === "object" && "key" in value);
}

function reactionJidForMessage(message: WhatsAppInboundMessage, rawMessage: WAMessage): string {
  if (message.kind === "group") return message.target.groupId;
  return rawMessage.key?.remoteJid ?? message.providerConversationId;
}

export function fileNameForWhatsAppUpload(filePath: string): string {
  return basename(filePath);
}
