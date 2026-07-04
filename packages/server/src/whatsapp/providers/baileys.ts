import { basename, join } from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import type { Attachment } from "../../files";
import { downloadWhatsAppMedia } from "../../files";
import type { Logger } from "../../logger";
import type { WhatsAppBot, WhatsAppMessage } from "../bot";
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

export function createBaileysWhatsAppProviders(whatsapp: WhatsAppBot, logger: Logger): BaileysWhatsAppProviders {
  const toProviderConversationId = (target: WhatsAppTarget): string => {
    if (target.kind === "group") return target.groupId;
    return target.providerConversationId ?? phoneE164ToWhatsAppJid(target.phoneE164);
  };

  const toQuotedOptions = (options?: WhatsAppSendOptions) => {
    const quoted = options?.quotedMessage?.rawProviderPayload;
    return quoted && isBaileysMessage(quoted) ? { quoted } : undefined;
  };

  const sendText = async (
    target: WhatsAppTarget,
    text: string,
    options?: WhatsAppSendOptions,
  ): Promise<WhatsAppSendResult | null> => {
    const providerConversationId = toProviderConversationId(target);
    const sent = await whatsapp.sendText(providerConversationId, text, toQuotedOptions(options));
    return toSendResult(providerConversationId, sent);
  };

  const sendFile = async (target: WhatsAppTarget, filePath: string, mimeType: string, fileName: string) => {
    await whatsapp.sendFile(toProviderConversationId(target), filePath, mimeType, fileName);
  };

  const startComposing = (target: WhatsAppTarget) => {
    whatsapp.startComposing(toProviderConversationId(target));
  };

  const stopComposing = (target: WhatsAppTarget) => {
    whatsapp.stopComposing(toProviderConversationId(target));
  };

  const addReaction = async (message: WhatsAppInboundMessage, emoji: string) => {
    const rawMessage = baileysRawMessage(message);
    if (!rawMessage?.key) return;
    await whatsapp.addReaction(reactionJidForMessage(message, rawMessage), rawMessage.key, emoji);
  };

  const removeReaction = async (message: WhatsAppInboundMessage) => {
    const rawMessage = baileysRawMessage(message);
    if (!rawMessage?.key) return;
    await whatsapp.removeReaction(reactionJidForMessage(message, rawMessage), rawMessage.key);
  };

  const downloadMedia = async (
    message: WhatsAppInboundMessage,
    workspaceDir: string,
    params: { maxFileBytes: number },
  ): Promise<Attachment[]> => {
    const rawMessage = baileysRawMessage(message);
    if (!message.mediaType || !rawMessage || !whatsapp.socket) return [];

    try {
      const attachment = await downloadWhatsAppMedia(
        rawMessage,
        whatsapp.socket,
        join(workspaceDir, "attachments"),
        params.maxFileBytes,
        logger,
      );
      return [attachment];
    } catch (err) {
      logger.warn({ err, mediaType: message.mediaType }, "Failed to download WhatsApp media");
      return [];
    }
  };

  const getGroupMetadata = async (groupId: string): Promise<WhatsAppGroupMetadata | undefined> => {
    const meta = await whatsapp.getGroupMetadata(groupId);
    return meta ? { id: groupId, subject: meta.subject ?? "Unknown Group", desc: meta.desc ?? null } : undefined;
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
    resolveProviderContactToPhone: (providerContactId: string) => whatsapp.resolveJidToPhone(providerContactId),
  };

  return {
    dmProvider: {
      ...shared,
      role: "dm",
      get isConnected() {
        return whatsapp.isConnected;
      },
      capabilities: { ...BAILEYS_TEXT_CAPABILITIES, groups: false },
    },
    groupProvider: {
      ...shared,
      role: "group",
      get isConnected() {
        return whatsapp.isConnected;
      },
      capabilities: { ...BAILEYS_TEXT_CAPABILITIES, groups: true },
    },
    inboundProvider: {
      id: WHATSAPP_BAILEYS_PROVIDER_ID,
      onMessage(handler) {
        whatsapp.onMessage((message) => handler(normalizeBaileysInboundMessage(message)));
      },
      onHistoryMessages(handler) {
        whatsapp.onHistoryMessages((messages) => handler(messages.map(normalizeBaileysInboundMessage)));
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

function toSendResult(providerConversationId: string, sent: WAMessage | null): WhatsAppSendResult | null {
  if (!sent) return null;
  return {
    providerMessageId: sent.key?.id ?? null,
    providerConversationId,
    providerTimestamp: providerTimestamp(sent),
    rawProviderPayload: sent,
  };
}

function providerTimestamp(message: WAMessage | undefined): string | null {
  const timestamp = message?.messageTimestamp;
  if (timestamp == null) return null;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
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
