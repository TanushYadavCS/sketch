import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { type WASocket, proto } from "@whiskeysockets/baileys";
import type { Kysely } from "kysely";
import {
  createWhatsAppEventKey,
  createWhatsAppInboundEventsRepository,
} from "../../db/repositories/whatsapp-inbound-events";
import type { DB } from "../../db/schema";
import { downloadWhatsAppMedia } from "../../files";
import type { Logger } from "../../logger";
import type {
  WhatsAppCaptureMetadata,
  WhatsAppHistoryBatchMetadata,
  WhatsAppHistoryBatchResult,
  WhatsAppMessage,
} from "../bot";
import { createWhatsAppConnectionKey } from "../connection-key";
import {
  type StagedMediaRef,
  type WhatsAppMessageEnvelope,
  whatsAppHistoryBatchEnvelopeSchema,
  whatsAppMessageEnvelopeSchema,
} from "../facade-contract";
import { validWhatsAppProviderTimestamp } from "../provider-timestamp";

export const WHATSAPP_HISTORY_CHUNK_MAX_MESSAGES = 100;
export const WHATSAPP_HISTORY_CHUNK_MAX_BYTES = 200 * 1024;
const HISTORY_CHUNK_SIZE_RESERVE_BYTES = 1024;
const HISTORY_REPLY_TOLERANCE_MS = 120_000;

interface PreparedHistoryMessage {
  envelope: WhatsAppMessageEnvelope;
  oversized: boolean;
}

interface PrepareMessageEnvelopeOptions {
  timestamp?: string;
  stageMedia?: boolean;
}

export interface WhatsAppGatewayCaptureDeps {
  db: Kysely<DB>;
  logger: Logger;
  stagingDir: string;
  maxFileBytes: number;
  getSocket: () => WASocket | null;
  rememberMessage: (params: {
    providerConversationId: string;
    providerMessageId: string;
    rawProviderPayload: unknown;
    eventKey?: string;
  }) => void;
  isInitialSyncGeneration: () => boolean;
  wake: () => Promise<void>;
  onPersistFailure: (error: unknown) => void;
  leaseGeneration?: number;
  now?: () => Date;
}

function providerTimestamp(message: WhatsAppMessage, now: () => Date): string {
  const timestamp = message.rawMessage.messageTimestamp;
  const seconds = timestamp == null ? Number.NaN : Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : now().toISOString();
}

function genuineProviderTimestamp(message: WhatsAppMessage, now: () => Date): string | null {
  const timestamp = message.rawMessage.messageTimestamp;
  const seconds = timestamp == null ? Number.NaN : Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return validWhatsAppProviderTimestamp(new Date(seconds * 1000).toISOString(), now());
}

function isOnDemandHistory(metadata: WhatsAppHistoryBatchMetadata): boolean {
  return metadata.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND;
}

function rawProviderIdentity(message: WhatsAppMessage): {
  providerConversationId: string;
  providerMessageId: string | null;
  fromMe: boolean;
} {
  const key = message.rawMessage.key ?? {};
  return {
    providerConversationId: key.remoteJid ?? message.jid,
    providerMessageId: key.id || null,
    fromMe: Boolean(key.fromMe),
  };
}

function compactRawProviderPayload(message: WhatsAppMessage) {
  return {
    key: message.rawMessage.key,
    pushName: message.rawMessage.pushName ?? null,
    messageTimestamp: message.rawMessage.messageTimestamp ?? null,
    text: message.text,
  };
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(serialize(value), "utf8");
}

function asHistoryMetadata(metadata: WhatsAppHistoryBatchMetadata | undefined) {
  return {
    syncType: metadata?.syncType ?? null,
    progress: metadata?.progress ?? null,
    isLatest: metadata?.isLatest ?? null,
    peerDataRequestSessionId: metadata?.peerDataRequestSessionId ?? null,
  };
}

export class WhatsAppGatewayCapture {
  private readonly events;
  private readonly now: () => Date;
  private insertFailureCount = 0;

  constructor(private readonly deps: WhatsAppGatewayCaptureDeps) {
    this.events = createWhatsAppInboundEventsRepository(deps.db);
    this.now = deps.now ?? (() => new Date());
  }

  get insertFailures(): number {
    return this.insertFailureCount;
  }

  async queueDepth(): Promise<number> {
    const row = await this.deps.db
      .selectFrom("whatsapp_inbound_events")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("status", "in", ["pending", "processing", "captured", "dispatched"])
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async captureMessage(
    message: WhatsAppMessage,
    metadata: WhatsAppCaptureMetadata = { socketGeneration: 0 },
  ): Promise<void> {
    const identity = rawProviderIdentity(message);
    if (metadata.upsertType === "append" && this.deps.isInitialSyncGeneration()) return;
    const kind = metadata.upsertType === "append" ? "history_message" : "message";
    const eventKey = createWhatsAppEventKey(
      identity.providerConversationId,
      identity.providerMessageId ?? "",
      identity.fromMe,
    );
    try {
      if (eventKey && (await this.events.findByEventKey(eventKey))) return;
      const envelope = await this.prepareMessageEnvelope(
        message,
        kind,
        createWhatsAppConnectionKey(this.deps.leaseGeneration ?? 0, metadata.socketGeneration),
        { stageMedia: kind === "message" || metadata.upsertType === "append" },
      );
      const result = await this.events.insert({
        kind,
        origin: "gateway",
        eventKey,
        providerMessageId: identity.providerMessageId,
        envelope: serialize(envelope),
      });
      if (result.inserted) this.pingWake();
    } catch (error) {
      this.recordInsertFailure(error, identity.providerMessageId);
      this.deps.onPersistFailure(error);
    }
  }

  async captureHistory(
    messages: WhatsAppMessage[],
    metadata: WhatsAppHistoryBatchMetadata = { socketGeneration: 0 },
  ): Promise<WhatsAppHistoryBatchResult> {
    const batchId = randomUUID();
    try {
      const connectionKey = createWhatsAppConnectionKey(this.deps.leaseGeneration ?? 0, metadata.socketGeneration);
      const prepared: PreparedHistoryMessage[] = [];
      for (const message of messages) {
        const providerMessageId = rawProviderIdentity(message).providerMessageId;
        const timestamp = genuineProviderTimestamp(message, this.now);
        if (!providerMessageId || !timestamp) continue;
        prepared.push(await this.prepareHistoryMessage(message, connectionKey, timestamp));
      }
      const chunks = this.chunkHistory(batchId, prepared, connectionKey, metadata);
      const results = await this.events.insertManyAtomic(
        chunks.map((chunk) => ({
          kind: "history_batch" as const,
          origin: "gateway" as const,
          envelope: chunk.envelope,
          batchId,
          chunkIndex: chunk.chunkIndex,
          chunkCount: chunks.length,
          requestSessionId: metadata.peerDataRequestSessionId ?? null,
          status: chunk.dead ? ("dead" as const) : ("pending" as const),
          lastError: chunk.dead ? "history message exceeds 200KB after raw payload compaction" : null,
        })),
      );
      for (const [index, result] of results.entries()) {
        if (!result.inserted) continue;
        this.pingWake();
        const chunk = chunks[index];
        if (chunk?.dead) {
          this.deps.logger.warn(
            { batchId, chunkIndex: chunk.chunkIndex },
            "WhatsApp history chunk was dead-lettered at insert; history indexing has a gap",
          );
        }
      }

      let replyInserted = 0;
      let replyDeduplicated = 0;
      if (!this.deps.isInitialSyncGeneration() && !isOnDemandHistory(metadata)) {
        const lease = await this.deps.db
          .selectFrom("whatsapp_session_lease")
          .select(["disconnected_at", "last_live_at"])
          .where("id", "=", "default")
          .executeTakeFirst();
        const watermark = lease?.disconnected_at ?? lease?.last_live_at;
        const cutoff = watermark ? Date.parse(watermark) - HISTORY_REPLY_TOLERANCE_MS : Number.POSITIVE_INFINITY;
        for (const item of prepared) {
          if (item.envelope.fromMe) continue;
          const timestamp = Date.parse(item.envelope.providerTimestamp);
          if (!Number.isFinite(timestamp) || timestamp < cutoff) continue;
          const result = await this.events.insert({
            kind: "history_message",
            origin: "gateway",
            eventKey: item.envelope.eventKey,
            providerMessageId: item.envelope.providerMessageId,
            envelope: serialize({ ...item.envelope, kind: "history_message" }),
          });
          if (result.inserted) {
            replyInserted += 1;
            this.pingWake();
          } else {
            replyDeduplicated += 1;
          }
        }
      }

      return {
        persisted: results.filter((result) => result.inserted).length + replyInserted,
        skippedOld: 0,
        skippedDup: results.filter((result) => !result.inserted).length + replyDeduplicated,
      };
    } catch (error) {
      this.recordInsertFailure(error, null);
      this.deps.onPersistFailure(error);
      return { persisted: 0, skippedOld: 0, skippedDup: 0 };
    }
  }

  private async prepareHistoryMessage(
    message: WhatsAppMessage,
    connectionKey: string,
    timestamp: string,
  ): Promise<PreparedHistoryMessage> {
    let envelope = await this.prepareMessageEnvelope(message, "history_message", connectionKey, { timestamp });
    let oversized = byteLength(envelope) > WHATSAPP_HISTORY_CHUNK_MAX_BYTES - HISTORY_CHUNK_SIZE_RESERVE_BYTES;
    if (oversized) {
      envelope = whatsAppMessageEnvelopeSchema.parse({
        ...envelope,
        message: { ...envelope.message, rawProviderPayload: compactRawProviderPayload(message) },
      });
      oversized = byteLength(envelope) > WHATSAPP_HISTORY_CHUNK_MAX_BYTES - HISTORY_CHUNK_SIZE_RESERVE_BYTES;
    }
    return { envelope, oversized };
  }

  private async prepareMessageEnvelope(
    message: WhatsAppMessage,
    kind: "message" | "history_message",
    connectionKey: string,
    options: PrepareMessageEnvelopeOptions = {},
  ): Promise<WhatsAppMessageEnvelope> {
    const timestamp = options.timestamp ?? providerTimestamp(message, this.now);
    const identity = rawProviderIdentity(message);
    const eventKey = createWhatsAppEventKey(
      identity.providerConversationId,
      identity.providerMessageId ?? "",
      identity.fromMe,
    );
    if (identity.providerMessageId) {
      this.deps.rememberMessage({
        providerConversationId: identity.providerConversationId,
        providerMessageId: identity.providerMessageId,
        rawProviderPayload: message.rawMessage,
        ...(eventKey ? { eventKey } : {}),
      });
    }
    const staged =
      (options.stageMedia ?? kind === "message") ? await this.stageMedia(message) : { ref: null, error: null };
    return whatsAppMessageEnvelopeSchema.parse({
      version: "1.0",
      kind,
      providerTimestamp: timestamp,
      providerConversationId: identity.providerConversationId,
      providerMessageId: identity.providerMessageId,
      eventKey,
      connectionKey,
      fromMe: identity.fromMe,
      message: {
        ...message,
        rawProviderPayload: message.rawMessage,
        stagedMediaRef: staged.ref,
        mediaStagingError: staged.error,
      },
    });
  }

  private async stageMedia(message: WhatsAppMessage): Promise<{ ref: StagedMediaRef | null; error: string | null }> {
    if (!message.mediaType) return { ref: null, error: null };
    const socket = this.deps.getSocket();
    if (!socket) return { ref: null, error: "WhatsApp socket unavailable for media staging" };
    try {
      const attachment = await downloadWhatsAppMedia(
        message.rawMessage as proto.IWebMessageInfo,
        socket,
        this.deps.stagingDir,
        this.deps.maxFileBytes,
        this.deps.logger,
      );
      const stagingRoot = resolve(this.deps.stagingDir);
      const stagedPath = resolve(attachment.localPath);
      if (stagedPath !== stagingRoot && !stagedPath.startsWith(`${stagingRoot}${sep}`)) {
        throw new Error("WhatsApp staged media path escaped the staging root");
      }
      const sha256 = createHash("sha256")
        .update(await readFile(stagedPath))
        .digest("hex");
      return {
        ref: {
          stagedPath,
          mime: attachment.mimeType,
          size: attachment.sizeBytes,
          sha256,
          originalName: attachment.originalName,
        },
        error: null,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn({ error, mediaType: message.mediaType }, "Failed to stage inbound WhatsApp media");
      return { ref: null, error: detail.slice(0, 1024) };
    }
  }

  private chunkHistory(
    batchId: string,
    prepared: PreparedHistoryMessage[],
    connectionKey: string,
    metadata: WhatsAppHistoryBatchMetadata,
  ): Array<{ envelope: string; chunkIndex: number; dead: boolean }> {
    const groups: Array<{ messages: WhatsAppMessageEnvelope[]; dead: boolean }> = [];
    let current: WhatsAppMessageEnvelope[] = [];
    const flush = () => {
      if (current.length === 0) return;
      groups.push({ messages: current, dead: false });
      current = [];
    };

    for (const item of prepared) {
      if (item.oversized) {
        flush();
        groups.push({ messages: [item.envelope], dead: true });
        continue;
      }
      const candidate = [...current, item.envelope];
      const provisional = this.historyEnvelope(batchId, 0, 999_999, candidate, connectionKey, metadata);
      if (
        current.length > 0 &&
        (candidate.length > WHATSAPP_HISTORY_CHUNK_MAX_MESSAGES ||
          byteLength(provisional) > WHATSAPP_HISTORY_CHUNK_MAX_BYTES - HISTORY_CHUNK_SIZE_RESERVE_BYTES)
      ) {
        flush();
      }
      current.push(item.envelope);
    }
    flush();
    if (groups.length === 0) groups.push({ messages: [], dead: false });

    return groups.map((group, chunkIndex) => {
      const envelope = this.historyEnvelope(
        batchId,
        chunkIndex,
        groups.length,
        group.messages,
        connectionKey,
        metadata,
      );
      const serialized = serialize(envelope);
      return {
        envelope: serialized,
        chunkIndex,
        dead: group.dead || Buffer.byteLength(serialized, "utf8") > WHATSAPP_HISTORY_CHUNK_MAX_BYTES,
      };
    });
  }

  private historyEnvelope(
    batchId: string,
    chunkIndex: number,
    chunkCount: number,
    messages: WhatsAppMessageEnvelope[],
    connectionKey: string,
    metadata: WhatsAppHistoryBatchMetadata,
  ) {
    const timestamp = messages
      .map((message) => message.providerTimestamp)
      .sort((left, right) => left.localeCompare(right))[0];
    return whatsAppHistoryBatchEnvelopeSchema.parse({
      version: "1.0",
      kind: "history_batch",
      providerTimestamp: timestamp ?? this.now().toISOString(),
      connectionKey,
      batch: { batchId, chunkIndex, chunkCount, ...asHistoryMetadata(metadata) },
      messages,
    });
  }

  private pingWake(): void {
    void this.deps.wake().catch(() => undefined);
  }

  private recordInsertFailure(error: unknown, providerMessageId: string | null): void {
    this.insertFailureCount += 1;
    this.deps.logger.error({ error, providerMessageId }, "Failed to persist inbound WhatsApp gateway event");
  }
}
