import { z } from "zod";
import type { WhatsAppSendResult } from "./provider";

export type { WhatsAppSendResult } from "./provider";

export const WHATSAPP_FACADE_CONTRACT_VERSION = "1.2";

export const whatsAppFacadeTargetSchema = z.string().min(1);

export const whatsAppQuotedRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("eventKey"), value: z.string().min(1) }),
  z.object({
    kind: z.literal("providerMessageId"),
    providerConversationId: z.string().min(1),
    value: z.string().min(1),
  }),
]);

export const whatsAppSendContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({
    kind: z.literal("file"),
    filePath: z.string().min(1),
    mimeType: z.string().min(1),
    fileName: z.string().min(1),
  }),
]);

export const whatsAppSendOptionsSchema = z.object({
  quotedRef: whatsAppQuotedRefSchema.optional(),
  idempotencyKey: z.string().min(1),
});

export const whatsAppSendRequestSchema = z.object({
  target: whatsAppFacadeTargetSchema,
  content: whatsAppSendContentSchema,
  opts: whatsAppSendOptionsSchema,
});

export const whatsAppSendResultSchema = z.object({
  providerMessageId: z.string().nullable(),
  providerConversationId: z.string(),
  providerTimestamp: z.string().nullable(),
  rawProviderPayload: z.unknown().optional(),
});

export const whatsAppSendResponseSchema = z.object({
  result: whatsAppSendResultSchema.nullable(),
});

export const whatsAppReactionResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ error: z.literal("unknown-message") }),
]);

export const whatsAppComposingRequestSchema = z.object({
  target: whatsAppFacadeTargetSchema,
  on: z.boolean(),
});

export const whatsAppReactionRequestSchema = z.object({
  target: whatsAppFacadeTargetSchema,
  quotedRef: whatsAppQuotedRefSchema,
  emoji: z.string(),
});

export const whatsAppMediaDownloadRefSchema = z.object({
  messageRef: whatsAppQuotedRefSchema,
  destinationDir: z.string().min(1),
  maxFileBytes: z.number().int().positive(),
});

export const stagedMediaRefSchema = z.object({
  stagedPath: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  originalName: z.string().min(1).optional(),
});

export const normalizedGroupParticipantSchema = z.object({
  jid: z.string().min(1),
  phoneE164: z.string().nullable(),
  lid: z.string().nullable(),
  admin: z.enum(["admin", "superadmin"]).nullable(),
});

export const normalizedGroupMetadataSchema = z.object({
  id: z.string().min(1),
  subject: z.string(),
  desc: z.string().nullable().optional(),
  participants: z.array(normalizedGroupParticipantSchema),
  participantIdentityComplete: z.boolean().optional(),
});

export const whatsAppGroupMetadataOptionsSchema = z.object({ refresh: z.boolean() });
export const whatsAppGroupSyncOptionsSchema = z.object({ force: z.boolean() });
export const whatsAppGroupSyncSummarySchema = z.object({ synced: z.number().int().nonnegative() });
export const whatsAppGroupMetadataRequestSchema = z.object({
  jid: z.string().min(1),
  opts: whatsAppGroupMetadataOptionsSchema,
});
export const whatsAppResolveLidRequestSchema = z.object({ jid: z.string().min(1) });
export const whatsAppEmptyRequestSchema = z.object({});
export const whatsAppOkResponseSchema = z.object({ ok: z.literal(true) });
export const whatsAppReactionResponseSchema = z.object({ result: whatsAppReactionResultSchema });
export const whatsAppMediaDownloadResponseSchema = z.object({ result: stagedMediaRefSchema.nullable() });
export const whatsAppGroupMetadataResponseSchema = z.object({ result: normalizedGroupMetadataSchema.nullable() });
export const whatsAppResolveLidResponseSchema = z.object({ phoneJid: z.string().nullable() });
export const whatsAppHistoryMessageKeySchema = z.object({
  remoteJid: z.string().min(1),
  id: z.string().min(1),
  fromMe: z.boolean(),
});
export const whatsAppHistorySyncRequestSchema = z.object({
  count: z.number().int().min(1).max(50),
  oldestMessageKey: whatsAppHistoryMessageKeySchema,
  oldestMessageTimestamp: z.number().finite().positive(),
});
export const whatsAppHistorySyncResponseSchema = z.object({ requestSessionId: z.string().min(1) });

export const whatsAppPairingStatusSchema = z.object({
  connected: z.boolean(),
  phoneNumber: z.string().nullable(),
  lid: z.string().nullable().optional(),
});

export const whatsAppPairingEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("qr"), qr: z.string().min(1) }),
  z.object({ type: z.literal("connected"), phoneNumber: z.string().min(1) }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export const whatsAppSocketStateSchema = z.enum(["disconnected", "connecting", "connected", "logged-out"]);

export const whatsAppSocketStateChangeSchema = z.object({
  ownerToken: z.string().min(1),
  generation: z.number().int().positive(),
  socketGeneration: z.number().int().positive(),
  socketState: whatsAppSocketStateSchema,
  occurredAt: z.string().datetime({ offset: true }).optional(),
  statusCode: z.number().int().optional(),
  reason: z.string().min(1).max(256).optional(),
});

export type WhatsAppSocketStateChange = z.infer<typeof whatsAppSocketStateChangeSchema>;

export const whatsAppFacadeHealthSchema = z.object({
  socketState: whatsAppSocketStateSchema,
  queueDepth: z.number().int().nonnegative(),
  insertFailures: z.number().int().nonnegative(),
  uptime: z.number().nonnegative(),
  scriptHash: z.string(),
  contractVersion: z.string().min(1),
});

export const whatsAppInboundEnvelopeVersionSchema = z.string().regex(/^1\.\d+$/u);
export const whatsAppIsoUtcTimestampSchema = z.string().datetime({ offset: true });
export const whatsAppConnectionKeySchema = z.string().regex(/^\d{12}:\d{12}$/u);

export const whatsAppInboundMessageSchema = z.object({
  type: z.enum(["dm", "group"]),
  text: z.string(),
  jid: z.string().min(1),
  messageId: z.string(),
  pushName: z.string(),
  mediaType: z.string().optional(),
  quotedMessage: z
    .object({
      providerMessageId: z.string(),
      participantJid: z.string().nullable(),
      text: z.string(),
    })
    .optional(),
  phoneNumber: z.string().optional(),
  isMentioned: z.boolean().optional(),
  senderJid: z.string().optional(),
  senderPhone: z.string().nullable().optional(),
  rawProviderPayload: z.unknown(),
  stagedMediaRef: stagedMediaRefSchema.nullable(),
  mediaStagingError: z.string().nullable(),
});

export const whatsAppMessageEnvelopeSchema = z.object({
  version: whatsAppInboundEnvelopeVersionSchema,
  kind: z.enum(["message", "history_message"]),
  providerTimestamp: whatsAppIsoUtcTimestampSchema,
  providerConversationId: z.string().min(1),
  providerMessageId: z.string().nullable(),
  eventKey: z.string().nullable(),
  connectionKey: whatsAppConnectionKeySchema.nullable().optional().default(null),
  fromMe: z.boolean(),
  message: whatsAppInboundMessageSchema,
});

export const whatsAppHistoryBatchMetadataSchema = z.object({
  batchId: z.string().min(1),
  chunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive(),
  syncType: z.union([z.number(), z.string()]).nullable(),
  progress: z.number().nullable(),
  isLatest: z.boolean().nullable(),
  peerDataRequestSessionId: z.string().min(1).nullable().optional().default(null),
});

export const whatsAppHistoryBatchEnvelopeSchema = z.object({
  version: whatsAppInboundEnvelopeVersionSchema,
  kind: z.literal("history_batch"),
  providerTimestamp: whatsAppIsoUtcTimestampSchema,
  connectionKey: whatsAppConnectionKeySchema.nullable().optional().default(null),
  batch: whatsAppHistoryBatchMetadataSchema,
  messages: z.array(whatsAppMessageEnvelopeSchema),
});

export const whatsAppInboundEnvelopeSchema = z.union([
  whatsAppMessageEnvelopeSchema,
  whatsAppHistoryBatchEnvelopeSchema,
]);

export type WhatsAppQuotedRef = z.infer<typeof whatsAppQuotedRefSchema>;
export type WhatsAppSendContent = z.infer<typeof whatsAppSendContentSchema>;
export type WhatsAppFacadeSendOptions = z.infer<typeof whatsAppSendOptionsSchema>;
export type WhatsAppReactionResult = z.infer<typeof whatsAppReactionResultSchema>;
export type WhatsAppMediaDownloadRef = z.infer<typeof whatsAppMediaDownloadRefSchema>;
export type StagedMediaRef = z.infer<typeof stagedMediaRefSchema>;
export type NormalizedGroupParticipant = z.infer<typeof normalizedGroupParticipantSchema>;
export type NormalizedGroupMetadata = z.infer<typeof normalizedGroupMetadataSchema>;
export type WhatsAppGroupSyncSummary = z.infer<typeof whatsAppGroupSyncSummarySchema>;
export type WhatsAppPairingStatus = z.infer<typeof whatsAppPairingStatusSchema>;
export type WhatsAppPairingEvent = z.infer<typeof whatsAppPairingEventSchema>;
export type WhatsAppFacadeHealth = z.infer<typeof whatsAppFacadeHealthSchema>;
export type WhatsAppHistorySyncRequest = z.infer<typeof whatsAppHistorySyncRequestSchema>;
export type WhatsAppMessageEnvelope = z.infer<typeof whatsAppMessageEnvelopeSchema>;
export type WhatsAppHistoryBatchEnvelope = z.infer<typeof whatsAppHistoryBatchEnvelopeSchema>;
export type WhatsAppInboundEnvelope = z.infer<typeof whatsAppInboundEnvelopeSchema>;

export interface WhatsAppSocketFacade {
  send(
    target: string,
    content: WhatsAppSendContent,
    opts: WhatsAppFacadeSendOptions,
  ): Promise<WhatsAppSendResult | null>;
  sendComposing(target: string, on: boolean): Promise<void>;
  react(target: string, quotedRef: WhatsAppQuotedRef, emoji: string): Promise<WhatsAppReactionResult>;
  downloadMedia(ref: WhatsAppMediaDownloadRef): Promise<StagedMediaRef | null>;
  groupMetadata(jid: string, opts: { refresh: boolean }): Promise<NormalizedGroupMetadata | null>;
  syncAllGroups(opts: { force: boolean }): Promise<WhatsAppGroupSyncSummary>;
  resolveLid(jid: string): Promise<string | null>;
  fetchMessageHistory(request: WhatsAppHistorySyncRequest): Promise<string>;
  pairing: {
    startQr(onEvent: (event: WhatsAppPairingEvent) => Promise<void>): Promise<void>;
    status(): Promise<WhatsAppPairingStatus>;
    cancel(): Promise<void>;
    logout(): Promise<void>;
  };
  shutdown(): Promise<void>;
  health(): Promise<WhatsAppFacadeHealth>;
}

/**
 * rawProviderPayload audit: no WhatsApp socket facade consumer reads
 * WhatsAppSendResult.rawProviderPayload. Current consumers persist only
 * providerMessageId and providerTimestamp. Inbound rawProviderPayload usage is
 * separate and remains confined to provider normalization, quoted-message and
 * reaction lookup, media download, and inbound provider-event persistence.
 */
