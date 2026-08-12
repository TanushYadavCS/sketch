import { randomUUID } from "node:crypto";
import { proto } from "@whiskeysockets/baileys";
import { type Kysely, sql } from "kysely";
import type { Config } from "../config";
import { isIndexableWhatsAppChunkMessage } from "../connectors/whatsapp-chunker";
import { createWhatsAppBackfillRangeRepository } from "../db/repositories/whatsapp-backfill-ranges";
import type {
  WhatsAppBackfillAnchor,
  WhatsAppBackfillRangeRow,
  WhatsAppBackfillTerminalStatus,
} from "../db/repositories/whatsapp-backfill-ranges";
import type { DB } from "../db/schema";
import type { Logger } from "../logger";
import type { WhatsAppAdapterHandlers } from "./adapter";
import type { WhatsAppMessage } from "./bot";
import { createWhatsAppConnectionKey } from "./connection-key";
import {
  type WhatsAppHistoryBatchEnvelope,
  type WhatsAppMessageEnvelope,
  type WhatsAppSocketFacade,
  whatsAppHistoryBatchEnvelopeSchema,
} from "./facade-contract";
import { type WhatsAppInboundMessage, phoneE164ToWhatsAppJid } from "./provider";
import { validWhatsAppProviderTimestamp } from "./provider-timestamp";
import { normalizeBaileysInboundMessage } from "./providers/baileys";

export const WHATSAPP_BACKFILL_FETCH_COUNT = 50;
export const WHATSAPP_BACKFILL_RESPONSE_DEADLINE_MS = 60_000;
export const WHATSAPP_BACKFILL_MAX_RESPONSE_ATTEMPTS = 3;
export const WHATSAPP_BACKFILL_TICK_MS = 1_000;
export const WHATSAPP_BACKFILL_SWEEP_MS = 5 * 60_000;
export const WHATSAPP_BACKFILL_STALE_CLAIM_MS = 2 * 60_000;
export const WHATSAPP_BACKFILL_FETCH_SPACING_MS = 500;
export const WHATSAPP_BACKFILL_MATERIALIZE_BATCH_SIZE = 200;
const DAY_MS = 24 * 60 * 60_000;

interface WhatsAppAccountIdentity {
  jid: string | null;
  lid: string | null;
}

export function isOnDemandWhatsAppHistory(syncType: number | string | null | undefined): boolean {
  return syncType === proto.HistorySync.HistorySyncType.ON_DEMAND;
}

function plusMilliseconds(timestamp: number, milliseconds: number): string {
  return new Date(timestamp + milliseconds).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messageAnchor(envelope: WhatsAppMessageEnvelope): WhatsAppBackfillAnchor | null {
  if (!envelope.providerMessageId) return null;
  const providerTimestamp = validWhatsAppProviderTimestamp(envelope.providerTimestamp);
  if (!providerTimestamp) return null;
  return {
    remoteJid: envelope.providerConversationId,
    id: envelope.providerMessageId,
    fromMe: envelope.fromMe,
    providerTimestamp,
  };
}

function compareAnchors(left: WhatsAppBackfillAnchor, right: WhatsAppBackfillAnchor): number {
  const timestamp = left.providerTimestamp.localeCompare(right.providerTimestamp);
  if (timestamp !== 0) return timestamp;
  const id = left.id.localeCompare(right.id);
  if (id !== 0) return id;
  return Number(left.fromMe) - Number(right.fromMe);
}

function parseHistoryEnvelope(serialized: string): WhatsAppHistoryBatchEnvelope | null {
  try {
    return whatsAppHistoryBatchEnvelopeSchema.parse(JSON.parse(serialized));
  } catch {
    return null;
  }
}

export interface WhatsAppBackfillWorkerOptions {
  db: Kysely<DB>;
  config: Pick<Config, "WHATSAPP_HISTORY_LOOKBACK_DAYS">;
  logger: Logger;
  facade: WhatsAppSocketFacade;
  handlers: WhatsAppAdapterHandlers;
  shouldHandleInboundMessage: (message: WhatsAppInboundMessage) => boolean;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  tickMs?: number;
  sweepMs?: number;
  responseDeadlineMs?: number;
  maxResponseAttempts?: number;
  onRequestAccepted?: () => Promise<void> | void;
  onMaterializationBatchYield?: () => Promise<void>;
}

export class WhatsAppBackfillWorker {
  private readonly ranges;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private rerun = false;
  private running = false;
  private lastSweepAt = Number.NEGATIVE_INFINITY;
  private lastFetchAt = 0;

  constructor(private readonly options: WhatsAppBackfillWorkerOptions) {
    this.ranges = createWhatsAppBackfillRangeRepository(options.db);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastSweepAt = Number.NEGATIVE_INFINITY;
    this.timer = setInterval(() => void this.wake(), this.options.tickMs ?? WHATSAPP_BACKFILL_TICK_MS);
    this.timer.unref?.();
    void this.wake();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }

  async wake(): Promise<void> {
    if (!this.running) return;
    if (this.active) {
      this.rerun = true;
      await this.active;
      return;
    }
    this.active = this.drain().catch((error) => {
      this.options.logger.error({ error }, "WhatsApp history top-up worker failed");
    });
    try {
      await this.active;
    } finally {
      this.active = null;
      if (this.rerun && this.running) {
        this.rerun = false;
        await this.wake();
      }
    }
  }

  async runOnce(): Promise<void> {
    await this.drain();
  }

  async handleConnected(input: { leaseGeneration: number; socketGeneration: number }): Promise<void> {
    const nowMs = this.now();
    const now = new Date(nowMs).toISOString();
    const connectionKey = createWhatsAppConnectionKey(input.leaseGeneration, input.socketGeneration);
    await this.persistNotifiedTransition(input, connectionKey, now);
    const rearmed = await this.ranges.rearmExhausted(now);
    await this.reconcileState(nowMs, now);
    this.lastSweepAt = nowMs;
    this.options.logger.info(
      { connectionKey, continuationsCreated: rearmed },
      "WhatsApp backfill connected transition reconciled",
    );
    void this.wake();
  }

  async correlateOnDemandSession(requestSessionId: string): Promise<boolean> {
    const range = await this.ranges.getByRequestSession(requestSessionId);
    if (!range) return false;
    await this.ranges.attachStagedEvents(requestSessionId, range.id);
    return true;
  }

  async handleOnDemandResponse(requestSessionId: string): Promise<boolean> {
    const range = await this.ranges.getByRequestSession(requestSessionId);
    if (!range) return false;
    await this.ranges.attachStagedEvents(requestSessionId, range.id);
    const events = await this.ranges.listRequestEvents(requestSessionId);
    const anchors = events
      .flatMap((event) => parseHistoryEnvelope(event.envelope)?.messages ?? [])
      .filter((message) => message.providerConversationId === range.group_jid)
      .map(messageAnchor)
      .filter((anchor): anchor is WhatsAppBackfillAnchor => anchor !== null)
      .sort(compareAnchors);
    const oldest = anchors[0] ?? null;
    const current = this.rangeAnchor(range);
    let terminalStatus: WhatsAppBackfillTerminalStatus | null = null;
    if (!oldest || (current && compareAnchors(oldest, current) >= 0)) {
      terminalStatus = "exhausted";
    } else if (oldest.providerTimestamp <= range.lower_bound_at) {
      terminalStatus = "complete";
    }
    const applied = await this.ranges.applyReceivedPage({
      rangeId: range.id,
      requestSessionId,
      oldest,
      terminalStatus,
      now: new Date(this.now()).toISOString(),
    });
    if (!applied) return false;
    this.options.logger.info(
      {
        rangeId: range.id,
        requestSessionId,
        receivedMessages: anchors.length,
        oldestProviderTimestamp: oldest?.providerTimestamp ?? null,
        terminalStatus,
      },
      "WhatsApp history top-up response matched",
    );
    void this.wake();
    return true;
  }

  async adoptPassiveHistory(groupJids: string[]): Promise<void> {
    const unique = [...new Set(groupJids)];
    const now = new Date(this.now()).toISOString();
    const account = await this.accountIdentity();
    const adopted = await this.reconcileOwnership(now, unique, account);
    const refreshed = await this.ranges.refreshAwaitingAnchors(now, account.jid, account.lid);
    if (adopted > 0 || refreshed > 0) {
      this.options.logger.info({ rowsAdopted: adopted, rangesAnchored: refreshed }, "WhatsApp history rows adopted");
    }
    void this.wake();
  }

  async reconcile(forceSweep = false): Promise<void> {
    const nowMs = this.now();
    const sweepMs = this.options.sweepMs ?? WHATSAPP_BACKFILL_SWEEP_MS;
    if (!forceSweep && nowMs - this.lastSweepAt < sweepMs) return;
    const now = new Date(nowMs).toISOString();
    await this.reconcileState(nowMs, now);
    const olderThan = new Date(nowMs - sweepMs).toISOString();
    const rearmed = await this.ranges.rearmExhausted(now, olderThan);
    this.lastSweepAt = nowMs;
    if (rearmed > 0)
      this.options.logger.info({ continuationsCreated: rearmed }, "WhatsApp exhausted backfill continuations created");
  }

  private async drain(): Promise<void> {
    const nowMs = this.now();
    const now = new Date(nowMs).toISOString();
    await this.reconcile(false);
    const lease = await this.options.db
      .selectFrom("whatsapp_session_lease")
      .select("generation")
      .where("id", "=", "default")
      .executeTakeFirst();
    const reclaimed = await this.ranges.reclaimStale({
      now,
      staleClaimBefore: new Date(nowMs - WHATSAPP_BACKFILL_STALE_CLAIM_MS).toISOString(),
      leaseGeneration: lease?.generation ?? null,
      maxAttempts: this.options.maxResponseAttempts ?? WHATSAPP_BACKFILL_MAX_RESPONSE_ATTEMPTS,
      retryAt: plusMilliseconds(nowMs, WHATSAPP_BACKFILL_FETCH_SPACING_MS),
    });
    if (reclaimed.claims > 0 || reclaimed.requests > 0) {
      this.options.logger.warn(reclaimed, "WhatsApp history top-up ownership reclaimed");
    }

    for (const range of await this.ranges.listMaterializing()) await this.materialize(range);

    const claimToken = randomUUID();
    const range = await this.ranges.claimNext(claimToken, new Date(this.now()).toISOString());
    if (!range) return;
    await this.issueFetch(range, claimToken, lease?.generation ?? null);
  }

  private async issueFetch(
    range: WhatsAppBackfillRangeRow,
    claimToken: string,
    leaseGeneration: number | null,
  ): Promise<void> {
    const anchor = this.rangeAnchor(range);
    const nowMs = this.now();
    if (!anchor || leaseGeneration === null) {
      await this.ranges.releaseClaimAfterFailure({
        rangeId: range.id,
        claimToken,
        error: anchor ? "WhatsApp gateway lease is unavailable" : "WhatsApp history anchor is unavailable",
        nextRetryAt: plusMilliseconds(nowMs, WHATSAPP_BACKFILL_TICK_MS),
        now: new Date(nowMs).toISOString(),
      });
      return;
    }
    const spacing = WHATSAPP_BACKFILL_FETCH_SPACING_MS - (nowMs - this.lastFetchAt);
    if (spacing > 0) await this.sleep(spacing);
    try {
      const requestSessionId = await this.options.facade.fetchMessageHistory({
        count: WHATSAPP_BACKFILL_FETCH_COUNT,
        oldestMessageKey: { remoteJid: anchor.remoteJid, id: anchor.id, fromMe: anchor.fromMe },
        oldestMessageTimestamp: Date.parse(anchor.providerTimestamp) / 1_000,
      });
      const requestedAtMs = this.now();
      this.lastFetchAt = requestedAtMs;
      const accepted = await this.ranges.markRequestAccepted({
        rangeId: range.id,
        claimToken,
        requestSessionId,
        leaseGeneration,
        requestedAt: new Date(requestedAtMs).toISOString(),
        responseDeadlineAt: plusMilliseconds(
          requestedAtMs,
          this.options.responseDeadlineMs ?? WHATSAPP_BACKFILL_RESPONSE_DEADLINE_MS,
        ),
      });
      if (!accepted) return;
      await this.ranges.attachStagedEvents(requestSessionId, range.id);
      await this.options.onRequestAccepted?.();
      this.options.logger.info(
        { rangeId: range.id, requestSessionId, attempt: range.attempts + 1 },
        "WhatsApp history top-up fetch accepted",
      );
    } catch (error) {
      await this.ranges.releaseClaimAfterFailure({
        rangeId: range.id,
        claimToken,
        error: errorMessage(error),
        nextRetryAt: plusMilliseconds(this.now(), WHATSAPP_BACKFILL_TICK_MS),
        now: new Date(this.now()).toISOString(),
      });
      this.options.logger.warn({ error, rangeId: range.id }, "WhatsApp history top-up fetch failed before acceptance");
    }
  }

  private async materialize(range: WhatsAppBackfillRangeRow): Promise<void> {
    const events = await this.ranges.listRangeEvents(range.id);
    const byEventKey = new Map<string, WhatsAppMessageEnvelope>();
    for (const event of events) {
      const envelope = parseHistoryEnvelope(event.envelope);
      if (!envelope) continue;
      for (const message of envelope.messages) {
        if (message.providerConversationId !== range.group_jid || !message.eventKey) continue;
        const timestamp = validWhatsAppProviderTimestamp(message.providerTimestamp);
        if (!timestamp || timestamp < range.lower_bound_at || timestamp >= range.upper_bound_at) continue;
        byEventKey.set(message.eventKey, message);
      }
    }
    const envelopes = [...byEventKey.values()].sort((left, right) => {
      const timestamp = left.providerTimestamp.localeCompare(right.providerTimestamp);
      return timestamp !== 0 ? timestamp : (left.eventKey ?? "").localeCompare(right.eventKey ?? "");
    });
    const metadata = new WeakMap<WhatsAppInboundMessage, WhatsAppMessageEnvelope>();
    const messages = envelopes
      .map((envelope) => {
        const message = normalizeBaileysInboundMessage({
          ...envelope.message,
          rawMessage: envelope.message.rawProviderPayload,
        } as WhatsAppMessage);
        message.connectionKey = envelope.connectionKey;
        metadata.set(message, envelope);
        return message;
      })
      .filter(this.options.shouldHandleInboundMessage);

    const batches = messages.length === 0 ? [messages] : [];
    for (let offset = 0; offset < messages.length; offset += WHATSAPP_BACKFILL_MATERIALIZE_BATCH_SIZE) {
      batches.push(messages.slice(offset, offset + WHATSAPP_BACKFILL_MATERIALIZE_BATCH_SIZE));
    }
    for (const [index, batch] of batches.entries()) {
      await this.options.handlers.handleHistoryMessages(
        batch,
        { syncType: proto.HistorySync.HistorySyncType.ON_DEMAND },
        {
          checkpoint: false,
          range: { id: range.id, lowerBoundAt: range.lower_bound_at, upperBoundAt: range.upper_bound_at },
          captureMetadataForMessage: (message) => {
            const envelope = metadata.get(message);
            return {
              eventKey: envelope?.eventKey ?? null,
              connectionKey: envelope?.connectionKey ?? range.connection_key,
              fromMe: envelope?.fromMe ?? false,
            };
          },
        },
      );
      if (index < batches.length - 1) {
        await (this.options.onMaterializationBatchYield?.() ?? this.sleep(0));
      }
    }
    const finalized = await this.options.db
      .transaction()
      .execute((trx) =>
        createWhatsAppBackfillRangeRepository(trx).finalizeMaterialized(range.id, new Date(this.now()).toISOString()),
      );
    const terminal = finalized.range;
    if (!terminal || (terminal.status !== "complete" && terminal.status !== "exhausted")) return;
    this.options.logger.info(
      {
        rangeId: range.id,
        status: terminal.status,
        messages: messages.length,
        stagedRowsDeleted: finalized.stagedRowsDeleted,
      },
      "WhatsApp backfill range materialized ascending",
    );
  }

  private async reconcileInitialRanges(nowMs: number, now: string, account: WhatsAppAccountIdentity): Promise<void> {
    const checkpoints = await this.options.db
      .selectFrom("whatsapp_backfill_checkpoints as checkpoint")
      .innerJoin("whatsapp_groups as group", "group.jid", "checkpoint.group_jid")
      .select(["checkpoint.group_jid", "checkpoint.live_start_effective_at", "checkpoint.live_start_message_id"])
      .where("checkpoint.live_start_effective_at", "is not", null)
      .where("checkpoint.live_start_message_id", "is not", null)
      .execute();
    for (const checkpoint of checkpoints) {
      if (!checkpoint.live_start_effective_at || checkpoint.live_start_message_id == null) continue;
      const liveStart = await this.options.db
        .selectFrom("conversation_messages")
        .select("connection_key")
        .where("id", "=", checkpoint.live_start_message_id)
        .executeTakeFirst();
      const oldestUnownedKey = await this.options.db
        .selectFrom("conversation_messages as message")
        .innerJoin("conversations as conversation", "conversation.id", "message.conversation_id")
        .select("message.connection_key")
        .where("conversation.provider_conversation_id", "=", checkpoint.group_jid)
        .where("message.source", "=", "history")
        .where("message.backfill_range_id", "is", null)
        .where("message.connection_key", "is not", null)
        .orderBy("message.connection_key", "desc")
        .executeTakeFirst();
      const result = await this.ranges.ensureInitialRange({
        groupJid: checkpoint.group_jid,
        connectionKey: liveStart?.connection_key ?? oldestUnownedKey?.connection_key ?? null,
        liveStartEffectiveAt: checkpoint.live_start_effective_at,
        liveStartMessageId: checkpoint.live_start_message_id,
        lowerBoundAt: new Date(nowMs - this.options.config.WHATSAPP_HISTORY_LOOKBACK_DAYS * DAY_MS).toISOString(),
        now,
        accountJid: account.jid,
        accountLid: account.lid,
      });
      if (result.created || result.adopted > 0) {
        this.options.logger.info(
          { rangeId: result.row.id, rowsAdopted: result.adopted },
          "WhatsApp initial backfill range reconciled",
        );
      }
    }
  }

  private async reconcileState(nowMs: number, now: string): Promise<void> {
    const account = await this.accountIdentity();
    await this.reconcileInitialRanges(nowMs, now, account);
    await this.reconcileConnectionTransitions(now, account);
    await this.reconcileOwnership(now, undefined, account);
    await this.ranges.refreshAwaitingAnchors(now, account.jid, account.lid);
  }

  private async reconcileOwnership(
    now: string,
    groupJids: string[] | undefined,
    account: WhatsAppAccountIdentity,
  ): Promise<number> {
    await this.releaseStrandedGraphRows(groupJids);
    let query = this.options.db
      .selectFrom("conversation_messages as message")
      .innerJoin("conversations as conversation", "conversation.id", "message.conversation_id")
      .innerJoin("whatsapp_groups as group", "group.jid", "conversation.provider_conversation_id")
      .innerJoin(
        "whatsapp_backfill_checkpoints as checkpoint",
        "checkpoint.group_jid",
        "conversation.provider_conversation_id",
      )
      .select(["conversation.provider_conversation_id as group_jid", "message.connection_key"])
      .distinct()
      .where("message.source", "=", "history")
      .where("message.backfill_range_id", "is", null)
      .where("message.connection_key", "is not", null)
      .where("checkpoint.live_start_message_id", "is not", null);
    if (groupJids && groupJids.length > 0)
      query = query.where("conversation.provider_conversation_id", "in", groupJids);
    const orphans = await query.execute();
    let adopted = 0;
    for (const orphan of orphans) {
      if (!orphan.connection_key) continue;
      let result = await this.ranges.reconcileUnownedConnection({
        groupJid: orphan.group_jid,
        connectionKey: orphan.connection_key,
        now,
      });
      if (result.adopted === 0 && !result.supplementalCreated) {
        const range = await this.ranges.ensureGapRange({
          groupJid: orphan.group_jid,
          connectionKey: orphan.connection_key,
          lowerBoundAt: new Date(
            this.now() - this.options.config.WHATSAPP_HISTORY_LOOKBACK_DAYS * DAY_MS,
          ).toISOString(),
          upperBoundAt: now,
          now,
          accountJid: account.jid,
          accountLid: account.lid,
        });
        result = await this.ranges.reconcileUnownedConnection({
          groupJid: orphan.group_jid,
          connectionKey: orphan.connection_key,
          now,
        });
        result.adopted += range.adopted;
      }
      adopted += result.adopted;
      if (result.supplementalCreated || result.adopted > 0) {
        this.options.logger.info(
          {
            groupJid: orphan.group_jid,
            connectionKey: orphan.connection_key,
            rowsAdopted: result.adopted,
            supplementalCreated: result.supplementalCreated,
          },
          "WhatsApp orphaned connection key reconciled",
        );
      }
    }
    return adopted;
  }

  private async releaseStrandedGraphRows(groupJids: string[] | undefined): Promise<number> {
    let query = this.options.db
      .selectFrom("conversation_messages as message")
      .innerJoin("conversations as conversation", "conversation.id", "message.conversation_id")
      .innerJoin("whatsapp_backfill_ranges as range", "range.id", "message.backfill_range_id")
      .select([
        "message.id",
        "message.provider_message_id",
        "message.text",
        "message.attachments",
        "message.effective_at",
        "message.is_bot",
        "message.backfill_range_id",
      ])
      .where("message.source", "=", "history")
      .where("message.effective_at", "is not", null)
      .where("range.graph_completed_at", "is not", null)
      .where("range.graph_cursor_effective_at", "is not", null)
      .where("range.graph_cursor_message_id", "is not", null)
      .where(
        sql<boolean>`(
          message.effective_at < range.graph_cursor_effective_at
          OR (
            message.effective_at = range.graph_cursor_effective_at
            AND message.id <= range.graph_cursor_message_id
          )
        )`,
      )
      .where(
        sql<boolean>`NOT EXISTS (
          SELECT 1
          FROM conversation_slices AS slice
          WHERE slice.conversation_id = message.conversation_id
            AND slice.status IN ('closed', 'open')
            AND message.id BETWEEN slice.first_message_id AND slice.last_message_id
            AND message.effective_at BETWEEN slice.started_at AND slice.ended_at
        )`,
      );
    if (groupJids && groupJids.length > 0)
      query = query.where("conversation.provider_conversation_id", "in", groupJids);
    const candidates = await query.execute();
    const stranded = candidates.filter((message) =>
      isIndexableWhatsAppChunkMessage({
        id: message.id,
        providerMessageId: message.provider_message_id ?? "",
        effectiveAt: message.effective_at as string,
        text: message.text,
        attachments: message.attachments,
        isBot: message.is_bot === 1,
      }),
    );
    let released = 0;
    for (const message of stranded) {
      if (!message.backfill_range_id) continue;
      const result = await this.options.db
        .updateTable("conversation_messages")
        .set({ backfill_range_id: null })
        .where("id", "=", message.id)
        .where("backfill_range_id", "=", message.backfill_range_id)
        .executeTakeFirst();
      released += Number(result.numUpdatedRows);
    }
    return released;
  }

  private async reconcileConnectionTransitions(now: string, account: WhatsAppAccountIdentity): Promise<void> {
    const transitions = await this.options.db
      .selectFrom("whatsapp_connection_transitions")
      .selectAll()
      .where("reconciled_at", "is", null)
      .orderBy("connected_at", "asc")
      .orderBy("connection_key", "asc")
      .execute();
    if (transitions.length === 0) return;
    const groups = await this.options.db
      .selectFrom("whatsapp_backfill_checkpoints as checkpoint")
      .innerJoin("whatsapp_groups as group", "group.jid", "checkpoint.group_jid")
      .select("checkpoint.group_jid")
      .where("checkpoint.live_start_message_id", "is not", null)
      .execute();
    for (const transition of transitions) {
      if (transition.disconnected_at) {
        for (const group of groups) {
          await this.ranges.ensureGapRange({
            groupJid: group.group_jid,
            connectionKey: transition.connection_key,
            lowerBoundAt: transition.disconnected_at,
            upperBoundAt: transition.connected_at,
            now,
            accountJid: account.jid,
            accountLid: account.lid,
          });
        }
      }
      await this.options.db
        .updateTable("whatsapp_connection_transitions")
        .set({ reconciled_at: now })
        .where("connection_key", "=", transition.connection_key)
        .where("reconciled_at", "is", null)
        .execute();
    }
  }

  private async persistNotifiedTransition(
    input: { leaseGeneration: number; socketGeneration: number },
    connectionKey: string,
    connectedAt: string,
  ): Promise<void> {
    const lease = await this.options.db
      .selectFrom("whatsapp_session_lease")
      .select(["generation", "disconnected_at"])
      .where("id", "=", "default")
      .executeTakeFirst();
    if (lease?.generation !== input.leaseGeneration) return;
    await this.options.db
      .insertInto("whatsapp_connection_transitions")
      .values({
        connection_key: connectionKey,
        lease_generation: input.leaseGeneration,
        socket_generation: input.socketGeneration,
        disconnected_at: lease.disconnected_at,
        connected_at: connectedAt,
        reconciled_at: null,
      })
      .onConflict((oc) => oc.column("connection_key").doNothing())
      .execute();
  }

  private async accountIdentity(): Promise<WhatsAppAccountIdentity> {
    const status = await this.options.facade.pairing.status().catch(() => null);
    return {
      jid: status?.phoneNumber ? phoneE164ToWhatsAppJid(status.phoneNumber) : null,
      lid: status?.lid ?? null,
    };
  }

  private rangeAnchor(range: WhatsAppBackfillRangeRow): WhatsAppBackfillAnchor | null {
    if (
      !range.cursor_remote_jid ||
      !range.cursor_message_id ||
      range.cursor_from_me === null ||
      !range.cursor_provider_timestamp
    ) {
      return null;
    }
    return {
      remoteJid: range.cursor_remote_jid,
      id: range.cursor_message_id,
      fromMe: range.cursor_from_me === 1,
      providerTimestamp: range.cursor_provider_timestamp,
    };
  }
}
