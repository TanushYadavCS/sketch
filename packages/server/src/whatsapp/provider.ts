import type { Attachment } from "../files";
import type { WhatsAppTemplateRequest } from "./templates";

export const WHATSAPP_BAILEYS_PROVIDER_ID = "baileys";
export const WHATSAPP_NONE_PROVIDER_ID = "none";

export type WhatsAppDmProviderId = typeof WHATSAPP_BAILEYS_PROVIDER_ID | "wati" | string;
export type WhatsAppGroupProviderId = typeof WHATSAPP_BAILEYS_PROVIDER_ID | typeof WHATSAPP_NONE_PROVIDER_ID | string;

export type WhatsAppTarget =
  | { kind: "dm"; phoneE164: string; providerConversationId?: string | null }
  | { kind: "group"; groupId: string };

export interface WhatsAppCapabilities {
  text: boolean;
  media: boolean;
  quotedReply: boolean;
  templates: boolean;
  templateProvisioning: "none" | "manual" | "api";
  interactive: boolean;
  deliveryStatus: boolean;
  typing: boolean;
  reactions: boolean;
  edit: boolean;
  groups: boolean;
}

export interface WhatsAppQuotedMessage {
  providerMessageId: string;
  participantJid: string | null;
  text: string;
}

interface WhatsAppInboundBase {
  providerId: string;
  providerMessageId: string;
  providerConversationId: string;
  canonicalConversationId: string;
  providerTimestamp: string | null;
  senderName: string;
  senderProviderId: string | null;
  text: string;
  mediaType?: string;
  quotedMessage?: WhatsAppQuotedMessage;
  rawProviderPayload?: unknown;
}

export interface WhatsAppDmInboundMessage extends WhatsAppInboundBase {
  kind: "dm";
  target: Extract<WhatsAppTarget, { kind: "dm" }>;
  senderPhoneE164: string;
}

export interface WhatsAppGroupInboundMessage extends WhatsAppInboundBase {
  kind: "group";
  target: Extract<WhatsAppTarget, { kind: "group" }>;
  senderPhoneE164: string | null;
  isMentioned: boolean;
}

export type WhatsAppInboundMessage = WhatsAppDmInboundMessage | WhatsAppGroupInboundMessage;

export type WhatsAppMessageHandler = (message: WhatsAppInboundMessage) => Promise<void>;

export interface WhatsAppHistorySyncResult {
  persisted: number;
  skippedOld: number;
  skippedDup: number;
}

export type WhatsAppHistoryMessagesHandler = (messages: WhatsAppInboundMessage[]) => Promise<WhatsAppHistorySyncResult>;

export interface WhatsAppInboundProvider {
  id: string;
  onMessage: (handler: WhatsAppMessageHandler) => void;
  onHistoryMessages?: (handler: WhatsAppHistoryMessagesHandler) => void;
}

export interface WhatsAppSendResult {
  providerMessageId: string | null;
  providerConversationId: string;
  providerTimestamp: string | null;
  rawProviderPayload?: unknown;
}

export interface WhatsAppSendOptions {
  quotedMessage?: WhatsAppInboundMessage;
}

export type WhatsAppGroupParticipantAdminRole = "admin" | "superadmin";

export interface WhatsAppGroupParticipantMetadata {
  jid: string;
  phoneE164: string | null;
  lid: string | null;
  admin: WhatsAppGroupParticipantAdminRole | null;
}

export interface WhatsAppGroupMetadata {
  id: string;
  subject: string;
  desc?: string | null;
  participants: WhatsAppGroupParticipantMetadata[];
}

interface WhatsAppProviderBase {
  id: string;
  capabilities: WhatsAppCapabilities;
  isConnected: boolean;
  sendText: (target: WhatsAppTarget, text: string, options?: WhatsAppSendOptions) => Promise<WhatsAppSendResult | null>;
  sendTemplate?: (target: WhatsAppTarget, template: WhatsAppTemplateRequest) => Promise<WhatsAppSendResult | null>;
  sendFile?: (target: WhatsAppTarget, filePath: string, mimeType: string, fileName: string) => Promise<void>;
  startComposing?: (target: WhatsAppTarget) => void;
  stopComposing?: (target: WhatsAppTarget) => void;
  addReaction?: (message: WhatsAppInboundMessage, emoji: string) => Promise<void>;
  removeReaction?: (message: WhatsAppInboundMessage) => Promise<void>;
  downloadMedia?: (
    message: WhatsAppInboundMessage,
    workspaceDir: string,
    params: { maxFileBytes: number },
  ) => Promise<Attachment[]>;
  getGroupMetadata?: (groupId: string) => Promise<WhatsAppGroupMetadata | undefined>;
  resolveProviderContactToPhone?: (providerContactId: string) => Promise<string | null>;
}

export interface WhatsAppDmProvider extends WhatsAppProviderBase {
  role: "dm";
}

export interface WhatsAppGroupProvider extends WhatsAppProviderBase {
  role: "group";
}

export type WhatsAppAnyProvider = WhatsAppDmProvider | WhatsAppGroupProvider;

export function canonicalDmConversationId(phoneE164: string): string {
  return `dm:${phoneE164}`;
}

export function canonicalGroupConversationId(groupId: string): string {
  return `group:${groupId}`;
}

export function isWhatsAppDmPhoneE164(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\+[1-9]\d{6,14}$/u.test(value);
}

export function phoneE164ToWhatsAppJid(phoneE164: string): string {
  return `${phoneE164.replace("+", "")}@s.whatsapp.net`;
}

export function whatsappJidToPhoneE164(jid: string): string {
  if (jid.startsWith("wati:+")) return jid.slice("wati:".length);
  const raw = jid.replace("@s.whatsapp.net", "").replace("@lid", "");
  const number = raw.includes(":") ? raw.split(":")[0] : raw;
  return `+${number}`;
}

export function whatsappTargetFromDeliveryTarget(targetId: string): WhatsAppTarget {
  if (targetId.endsWith("@g.us")) return { kind: "group", groupId: targetId };
  if (targetId.startsWith("dm:+")) return { kind: "dm", phoneE164: targetId.slice("dm:".length) };
  if (targetId.startsWith("wati:+")) {
    return { kind: "dm", phoneE164: targetId.slice("wati:".length), providerConversationId: targetId };
  }
  if (targetId.startsWith("+")) return { kind: "dm", phoneE164: targetId };
  if (targetId.endsWith("@s.whatsapp.net") || targetId.endsWith("@lid")) {
    return { kind: "dm", phoneE164: whatsappJidToPhoneE164(targetId), providerConversationId: targetId };
  }
  return { kind: "dm", phoneE164: "", providerConversationId: targetId };
}

export function whatsappDeliveryTargetFromTarget(target: WhatsAppTarget): string {
  if (target.kind === "group") return target.groupId;
  if (isWhatsAppDmPhoneE164(target.phoneE164)) return canonicalDmConversationId(target.phoneE164);
  return target.providerConversationId ?? canonicalDmConversationId(target.phoneE164);
}
