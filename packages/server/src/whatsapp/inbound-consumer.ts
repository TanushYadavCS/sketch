import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { type Kysely, sql } from "kysely";
import { createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import { createConversationRepository } from "../db/repositories/conversations";
import { createWhatsAppBackfillRangeRepository } from "../db/repositories/whatsapp-backfill-ranges";
import {
  WHATSAPP_ON_DEMAND_CORRELATION_MAX_AGE_MS,
  createWhatsAppInboundEventsRepository,
} from "../db/repositories/whatsapp-inbound-events";
import type { WhatsAppInboundEventRow } from "../db/repositories/whatsapp-inbound-events";
import type { DB } from "../db/schema";
import type { Attachment } from "../files";
import type { Logger } from "../logger";
import type { WhatsAppAdapterHandlers } from "./adapter";
import { isOnDemandWhatsAppHistory } from "./backfill-worker";
import type { WhatsAppMessage } from "./bot";
import {
  type StagedMediaRef,
  type WhatsAppHistoryBatchEnvelope,
  type WhatsAppMessageEnvelope,
  whatsAppInboundEnvelopeSchema,
} from "./facade-contract";
import type { WhatsAppInboundMessage } from "./provider";
import { normalizeBaileysInboundMessage } from "./providers/baileys";

export const WHATSAPP_INBOUND_POLL_INTERVAL_MS = 1_000;

export interface WhatsAppInboundConsumerOptions {
  db: Kysely<DB>;
  logger: Logger;
  handlers: WhatsAppAdapterHandlers;
  shouldHandleInboundMessage: (message: WhatsAppInboundMessage) => boolean;
  stagingDir: string;
  pollIntervalMs?: number;
  backfillWindowDays?: number;
  backfillWorker?: {
    correlateOnDemandSession(requestSessionId: string): Promise<boolean>;
    handleOnDemandResponse(requestSessionId: string): Promise<boolean>;
    adoptPassiveHistory(groupJids: string[]): Promise<void>;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function moveWhatsAppStagedMedia(params: {
  ref: StagedMediaRef;
  eventKey: string | null;
  workspaceDir: string;
  stagingDir: string;
}): Promise<Attachment> {
  const stagingRoot = resolve(params.stagingDir);
  const stagedPath = resolve(params.ref.stagedPath);
  if (!inside(stagingRoot, stagedPath)) throw new Error("WhatsApp staged media path escaped the staging root");
  const attachmentDir = join(params.workspaceDir, "attachments");
  await mkdir(attachmentDir, { recursive: true });
  const resolvedWorkspaceDir = await realpath(params.workspaceDir);
  const resolvedAttachmentDir = await realpath(attachmentDir);
  if (!inside(resolvedWorkspaceDir, resolvedAttachmentDir)) {
    throw new Error("WhatsApp attachment directory escaped the workspace root");
  }
  const extension = extname(params.ref.originalName ?? params.ref.stagedPath).replace(/[^a-zA-Z0-9.]/gu, "");
  const identitySource = params.eventKey ?? "missing-provider-id";
  const identity = /^[a-f0-9]{64}$/u.test(identitySource)
    ? identitySource
    : createHash("sha256").update(identitySource).digest("hex");
  const destination = join(resolvedAttachmentDir, `${identity}-${params.ref.sha256.slice(0, 16)}${extension}`);

  const verify = async (path: string): Promise<boolean> => {
    try {
      const metadata = await stat(path);
      return metadata.size === params.ref.size && (await sha256(path)) === params.ref.sha256;
    } catch {
      return false;
    }
  };

  if (await verify(destination)) {
    return {
      originalName: params.ref.originalName ?? basename(destination),
      mimeType: params.ref.mime,
      localPath: destination,
      sizeBytes: params.ref.size,
    };
  }
  const resolvedStagingRoot = await realpath(stagingRoot).catch(() => null);
  const resolvedStagedPath = await realpath(stagedPath).catch(() => null);
  if (!resolvedStagingRoot || !resolvedStagedPath) throw new Error("staged media missing");
  if (!inside(resolvedStagingRoot, resolvedStagedPath)) {
    throw new Error("WhatsApp staged media path escaped the staging root");
  }
  if (!(await verify(resolvedStagedPath))) throw new Error("WhatsApp staged media hash or size mismatch");
  await rename(resolvedStagedPath, destination);
  return {
    originalName: params.ref.originalName ?? basename(destination),
    mimeType: params.ref.mime,
    localPath: destination,
    sizeBytes: params.ref.size,
  };
}

export class WhatsAppInboundConsumer {
  private readonly events;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private rerun = false;
  private acceptingClaims = false;
  private missingProviderIdEventCount = 0;

  constructor(private readonly options: WhatsAppInboundConsumerOptions) {
    this.events = createWhatsAppInboundEventsRepository(options.db);
  }

  get missingProviderIdEvents(): number {
    return this.missingProviderIdEventCount;
  }

  start(): void {
    if (this.acceptingClaims) return;
    this.acceptingClaims = true;
    this.timer = setInterval(() => void this.wake(), this.options.pollIntervalMs ?? WHATSAPP_INBOUND_POLL_INTERVAL_MS);
    this.timer.unref?.();
    void this.wake();
  }

  async stop(): Promise<void> {
    this.acceptingClaims = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }

  async wake(): Promise<void> {
    if (!this.acceptingClaims) return;
    if (this.active) {
      this.rerun = true;
      await this.active;
      return;
    }
    this.active = this.drain().catch((error) => {
      this.options.logger.error({ error }, "WhatsApp inbound consumer drain failed; retrying on next poll");
    });
    try {
      await this.active;
    } finally {
      this.active = null;
      if (this.rerun && this.acceptingClaims) {
        this.rerun = false;
        await this.wake();
      }
    }
  }

  private async drain(): Promise<void> {
    do {
      this.rerun = false;
      const rows = await this.events.claim(randomUUID());
      for (const row of rows) await this.process(row);
      if (rows.length === 25) this.rerun = true;
    } while (this.rerun && this.acceptingClaims);
  }

  private async process(row: WhatsAppInboundEventRow): Promise<void> {
    const claimToken = row.claim_token;
    if (!claimToken) return;
    try {
      const envelope = whatsAppInboundEnvelopeSchema.parse(JSON.parse(row.envelope));
      if (envelope.kind === "history_batch") {
        await this.processHistory(row, claimToken, envelope);
        return;
      }
      await this.processMessage(row, claimToken, envelope);
    } catch (error) {
      const detail = errorMessage(error);
      if (detail === "staged media missing") {
        await this.events.markDead(row.id, claimToken, detail);
      } else {
        await this.events.revertToCaptured(row.id, claimToken, detail);
      }
      this.options.logger.warn({ error, inboundEventId: row.id }, "WhatsApp inbound event processing failed");
    }
  }

  private async processMessage(
    row: WhatsAppInboundEventRow,
    claimToken: string,
    envelope: WhatsAppMessageEnvelope,
  ): Promise<void> {
    const message = normalizeBaileysInboundMessage({
      ...envelope.message,
      rawMessage: envelope.message.rawProviderPayload,
    } as WhatsAppMessage);
    message.connectionKey = envelope.connectionKey;
    if (!this.options.shouldHandleInboundMessage(message)) {
      await this.consumeFiltered(row, claimToken, message.kind);
      return;
    }
    let captureCommitted = false;
    const capture = await this.options.handlers.captureQueuedMessage(message, {
      eventKey: envelope.eventKey,
      source: envelope.kind === "message" ? "live" : "history",
      connectionKey: envelope.connectionKey,
      fromMe: envelope.fromMe,
      attachmentsForWorkspace: async (workspaceDir) => {
        if (envelope.message.mediaStagingError) {
          this.options.logger.warn(
            { inboundEventId: row.id, mediaStagingError: envelope.message.mediaStagingError },
            "Stored WhatsApp media staging failed; continuing without attachment",
          );
          return [];
        }
        if (!envelope.message.stagedMediaRef) return [];
        return [
          await moveWhatsAppStagedMedia({
            ref: envelope.message.stagedMediaRef,
            eventKey: envelope.eventKey,
            workspaceDir,
            stagingDir: this.options.stagingDir,
          }),
        ];
      },
      commitCapture: async (captureMessage) => {
        const captured = await this.options.db.transaction().execute(async (trx) => {
          const captured = await captureMessage(createConversationRepository(trx));
          if (envelope.kind === "message" && message.kind === "group" && captured) {
            const checkpoint = await createConversationSlicesRepository(trx).recordLiveStartOnce({
              groupJid: message.target.groupId,
              effectiveAt: captured.captured.effectiveAt,
              messageId: captured.captured.id,
            });
            if (checkpoint.live_start_effective_at && checkpoint.live_start_message_id != null) {
              const now = new Date();
              const range = await createWhatsAppBackfillRangeRepository(trx).ensureInitialRange({
                groupJid: message.target.groupId,
                connectionKey: envelope.connectionKey,
                liveStartEffectiveAt: checkpoint.live_start_effective_at,
                liveStartMessageId: checkpoint.live_start_message_id,
                lowerBoundAt: new Date(
                  now.getTime() - (this.options.backfillWindowDays ?? 30) * 24 * 60 * 60_000,
                ).toISOString(),
                now: now.toISOString(),
              });
              if (range.created || range.adopted > 0) {
                this.options.logger.info(
                  { rangeId: range.row.id, rowsAdopted: range.adopted },
                  "WhatsApp initial backfill range created",
                );
              }
            }
          }
          const transition = await trx
            .updateTable("whatsapp_inbound_events")
            .set({ status: "captured", next_attempt_at: sql`CURRENT_TIMESTAMP`, consumed_at: null })
            .where("id", "=", row.id)
            .where("claim_token", "=", claimToken)
            .where("status", "=", "processing")
            .executeTakeFirst();
          if (Number(transition.numUpdatedRows) !== 1) {
            throw new Error("WhatsApp inbound capture lost its claim token");
          }
          return captured;
        });
        captureCommitted = true;
        return captured;
      },
    });
    if (!captureCommitted && !(await this.events.markCaptured(row.id, claimToken))) return;
    if (envelope.fromMe) {
      if (!(await this.events.markConsumed(row.id, claimToken))) return;
      this.options.logger.warn(
        { inboundEventId: row.id },
        "Captured outbound WhatsApp event from the durable inbound queue; dispatch skipped",
      );
      return;
    }
    if (!envelope.providerMessageId) {
      if (!(await this.events.markConsumed(row.id, claimToken))) return;
      this.missingProviderIdEventCount += 1;
      this.options.logger.warn(
        { inboundEventId: row.id },
        "Captured WhatsApp event without provider id; dispatch skipped",
      );
      return;
    }
    if (!(await this.events.markDispatched(row.id, claimToken))) return;
    const accepted = await this.options.handlers.dispatchCapturedMessage(message, capture, {
      onRunStart: () => this.consumeAtDispatchStart(row.id, claimToken),
    });
    if (!accepted) {
      await this.events.revertToCaptured(row.id, claimToken, "channel queue shed inbound event");
    }
  }

  /**
   * The only supported ownership reset runs during a fresh process boot, after
   * the prior process's in-memory queues are gone. A false transition is logged
   * defensively but cannot imply a second live closure, so the admitted run can
   * continue without violating at-most-once replies.
   */
  private async consumeAtDispatchStart(id: number, claimToken: string): Promise<void> {
    if (await this.events.consumeDispatched(id, claimToken)) return;
    this.options.logger.warn(
      { inboundEventId: id },
      "WhatsApp inbound event dispatch started after durable claim ownership was lost",
    );
  }

  private async processHistory(
    row: WhatsAppInboundEventRow,
    claimToken: string,
    envelope: WhatsAppHistoryBatchEnvelope,
  ): Promise<void> {
    if (isOnDemandWhatsAppHistory(envelope.batch.syncType)) {
      await this.processOnDemandHistory(row, claimToken, envelope);
      return;
    }
    const envelopeByMessage = new WeakMap<WhatsAppInboundMessage, WhatsAppMessageEnvelope>();
    const messages = envelope.messages
      .map((item) => {
        const message = normalizeBaileysInboundMessage({
          ...item.message,
          rawMessage: item.message.rawProviderPayload,
        } as WhatsAppMessage);
        message.connectionKey = item.connectionKey ?? envelope.connectionKey;
        envelopeByMessage.set(message, item);
        return message;
      })
      .filter(this.options.shouldHandleInboundMessage);
    if (messages.length === 0) {
      await this.consumeFiltered(row, claimToken, "history batch");
      return;
    }
    const isTerminalChunk = row.batch_id ? await this.events.isBatchCompleteExcluding(row.batch_id, row.id) : false;
    const progress =
      !isTerminalChunk && envelope.batch.progress !== null && envelope.batch.progress >= 100
        ? 99
        : envelope.batch.progress;
    await this.options.handlers.handleHistoryMessages(
      messages,
      {
        syncType: envelope.batch.syncType as never,
        progress,
        isLatest: envelope.batch.isLatest ?? undefined,
        peerDataRequestSessionId: envelope.batch.peerDataRequestSessionId,
      },
      {
        checkpoint: isTerminalChunk,
        captureMetadataForMessage: (message) => {
          const item = envelopeByMessage.get(message);
          return {
            eventKey: item?.eventKey ?? null,
            connectionKey: item?.connectionKey ?? envelope.connectionKey,
            fromMe: item?.fromMe ?? false,
          };
        },
      },
    );
    if (!(await this.events.markCaptured(row.id, claimToken))) return;
    const completion = await this.events.markConsumedAndCheckBatch(row.id, claimToken);
    if (completion.batchComplete) {
      this.options.logger.info(
        { batchId: envelope.batch.batchId },
        "WhatsApp history batch completion barrier reached",
      );
    }
    await this.options.backfillWorker?.adoptPassiveHistory(
      messages.filter((message) => message.kind === "group").map((message) => message.target.groupId),
    );
  }

  private async processOnDemandHistory(
    row: WhatsAppInboundEventRow,
    claimToken: string,
    envelope: WhatsAppHistoryBatchEnvelope,
  ): Promise<void> {
    const requestSessionId = envelope.batch.peerDataRequestSessionId;
    if (!requestSessionId) throw new Error("ON_DEMAND WhatsApp history response lacked request session correlation");
    const correlated = await this.options.backfillWorker?.correlateOnDemandSession(requestSessionId);
    if (!correlated) {
      const result = await this.events.deferCorrelation(
        row.id,
        claimToken,
        "awaiting WhatsApp history request correlation",
      );
      if (result === "dead") {
        this.options.logger.warn(
          {
            inboundEventId: row.id,
            requestSessionId,
            correlationWindowMs: WHATSAPP_ON_DEMAND_CORRELATION_MAX_AGE_MS,
          },
          "Uncorrelated WhatsApp on-demand history response dead-lettered",
        );
      }
      return;
    }
    if (!(await this.events.markCaptured(row.id, claimToken))) return;
    const completion = await this.events.markConsumedAndCheckBatch(row.id, claimToken);
    if (!completion.batchComplete) return;
    await this.options.backfillWorker?.handleOnDemandResponse(requestSessionId);
    this.options.logger.info(
      { batchId: envelope.batch.batchId, requestSessionId },
      "WhatsApp on-demand history batch staged",
    );
  }

  /**
   * Provider-disabled events are terminal because retrying cannot change the
   * configured routing decision. They pass through captured only as a durable
   * queue state transition and never reach conversation capture or dispatch.
   */
  private async consumeFiltered(
    row: WhatsAppInboundEventRow,
    claimToken: string,
    messageKind: WhatsAppInboundMessage["kind"] | "history batch",
  ): Promise<void> {
    if (!(await this.events.markCaptured(row.id, claimToken))) return;
    if (!(await this.events.markConsumed(row.id, claimToken))) return;
    this.options.logger.info(
      { inboundEventId: row.id, messageKind },
      "Consumed WhatsApp inbound event disabled by provider configuration",
    );
  }
}
