import { z } from "zod";
import type { WhatsAppSendResult } from "./provider";

export type { WhatsAppSendResult } from "./provider";

export const WHATSAPP_FACADE_CONTRACT_VERSION = "1.0";

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

export const whatsAppPairingStatusSchema = z.object({
  connected: z.boolean(),
  phoneNumber: z.string().nullable(),
});

export const whatsAppPairingEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("qr"), qr: z.string().min(1) }),
  z.object({ type: z.literal("connected"), phoneNumber: z.string().min(1) }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export const whatsAppSocketStateSchema = z.enum(["disconnected", "connecting", "connected", "logged-out"]);

export const whatsAppFacadeHealthSchema = z.object({
  socketState: whatsAppSocketStateSchema,
  queueDepth: z.number().int().nonnegative(),
  insertFailures: z.number().int().nonnegative(),
  uptime: z.number().nonnegative(),
  scriptHash: z.string(),
  contractVersion: z.string().min(1),
});

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
