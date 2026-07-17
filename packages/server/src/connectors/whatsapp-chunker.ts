import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { parseSketchCommand } from "../commands";
import {
  type ConversationSliceCursorRow,
  type ConversationSliceFlushReason,
  createConversationSlicesRepository,
} from "../db/repositories/conversation-slices";
import { createWhatsAppBackfillRangeRepository } from "../db/repositories/whatsapp-backfill-ranges";
import type { WhatsAppGroupIndexingConfig } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { MAX_MATERIALIZATION_ATTEMPTS } from "../entities/materialize-replay";
import { isReasoningTextCommand, isToolProgressCommand } from "../progress-settings";
import {
  WHATSAPP_PROVIDER_TIMESTAMP_MAX_FUTURE_MS,
  effectiveWhatsAppMessageTimestamp,
} from "../whatsapp/provider-timestamp";

export const DEFAULT_WHATSAPP_SLICE_GAP_MINUTES = 25;
export const DEFAULT_WHATSAPP_SLICE_MAX_AGE_MINUTES = 120;
export const DEFAULT_WHATSAPP_SLICE_MAX_MESSAGES = 50;
export const DEFAULT_WHATSAPP_BACKFILL_GRAPH_PAGE_MESSAGES = 500;
export const DEFAULT_WHATSAPP_BACKFILL_GRAPH_CYCLE_MESSAGES = 1500;
export const DEFAULT_WHATSAPP_BACKFILL_GRAPH_PENDING_SLICES_MAX = 200;
export const DEFAULT_WHATSAPP_BACKFILL_GRAPH_PENDING_FILES_MAX = 500;
export const DEFAULT_WHATSAPP_BACKFILL_GRAPH_OPEN_FACTS_MAX = 5000;

const MINUTE_MS = 60 * 1000;
const DEFAULT_CLAIM_STALE_MS = 5 * MINUTE_MS;
const SYNTHETIC_ATTACHMENT_TEXT = "see attached files.";
const SINGLE_EMOJI_PATTERN =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\p{Emoji_Modifier}|\uFE0E|\uFE0F)*(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\p{Emoji_Modifier}|\uFE0E|\uFE0F)*)*$/u;

export interface WhatsAppChunkerKnobs {
  gapMinutes: number;
  maxAgeMinutes: number;
  maxMessages: number;
}

export interface WhatsAppBackfillGraphKnobs {
  pageMessages: number;
  cycleMessages: number;
  pendingSlicesMax: number;
  pendingFilesMax: number;
  openFactsMax: number;
}

export interface WhatsAppChunkerMessage {
  id: number;
  providerMessageId: string;
  effectiveAt: string;
  text: string;
  attachments: string | null;
  isBot: boolean;
}

export interface PlannedWhatsAppSlice {
  firstMessageId: number;
  lastMessageId: number;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  denoisedMessageIds: number[];
  flushReason: ConversationSliceFlushReason;
  cursor: {
    lastEffectiveAt: string;
    lastMessageId: number;
  };
}

export interface WhatsAppChunkerPlan {
  slices: PlannedWhatsAppSlice[];
  activeTailMessageIds: number[];
}

export interface WhatsAppChunkerRunSummary {
  conversationsProcessed: number;
  slicesCreated: number;
  lateArrivals: number;
  messagesProcessed: number;
  maxAgeFlushes: number;
  maxSizeFlushes: number;
}

interface SortableChunkerMessage extends WhatsAppChunkerMessage {
  effectiveMs: number;
  rawIndex: number;
}

interface ChunkerRawRow {
  id: number;
  provider_message_id: string;
  is_bot: number;
  text: string;
  attachments: string | null;
  provider_timestamp: string | null;
  received_at: string;
}

interface ChunkerTimestampRow {
  id: number;
  provider_timestamp: string | null;
  received_at: string;
}

interface ChunkWhatsAppGroupOptions {
  db: Kysely<DB>;
  group: WhatsAppGroupIndexingConfig;
  logger: Logger;
  now?: Date;
  claimStaleMs?: number;
  onConversationClaimed?: (conversationId: number) => Promise<void>;
  defaultKnobs?: Partial<WhatsAppChunkerKnobs>;
}

interface ChunkWhatsAppGroupsOptions {
  db: Kysely<DB>;
  groups: WhatsAppGroupIndexingConfig[];
  logger: Logger;
  now?: Date;
  claimStaleMs?: number;
  onConversationClaimed?: (conversationId: number) => Promise<void>;
  defaultKnobs?: Partial<WhatsAppChunkerKnobs>;
  backfillGraphKnobs?: Partial<WhatsAppBackfillGraphKnobs>;
  onBackfillConversationClaimed?: (conversationId: number) => Promise<void>;
  onBackfillSlicesInserted?: (rangeId: string) => Promise<void>;
}

export function resolveWhatsAppChunkerKnobs(
  group: WhatsAppGroupIndexingConfig,
  defaults: Partial<WhatsAppChunkerKnobs> = {},
): WhatsAppChunkerKnobs {
  return {
    gapMinutes: group.sliceGapMinutes ?? defaults.gapMinutes ?? DEFAULT_WHATSAPP_SLICE_GAP_MINUTES,
    maxAgeMinutes: group.sliceMaxAgeMinutes ?? defaults.maxAgeMinutes ?? DEFAULT_WHATSAPP_SLICE_MAX_AGE_MINUTES,
    maxMessages: group.sliceMaxMessages ?? defaults.maxMessages ?? DEFAULT_WHATSAPP_SLICE_MAX_MESSAGES,
  };
}

class ConversationSliceClaimLostError extends Error {
  constructor() {
    super("WhatsApp conversation slice claim was lost");
  }
}

class WhatsAppBackfillGraphInvariantError extends Error {
  constructor(
    readonly groupJid: string,
    readonly rangeId: string,
    message: string,
  ) {
    super(message);
  }
}

function effectiveTimeMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Provider timestamp validation lives in TypeScript so SQLite and Postgres use
 * the same floor, skew, and invalid-date behavior without dialect-specific casts.
 */
function effectiveTimestamp(row: ChunkerTimestampRow, now: Date): string {
  return effectiveWhatsAppMessageTimestamp(row.provider_timestamp, row.received_at, now);
}

function isAfterCursor(message: { id: number; effectiveAt: string }, cursor: ConversationSliceCursorRow): boolean {
  if (cursor.last_effective_at === null || cursor.last_message_id === null) return true;
  return (
    message.effectiveAt > cursor.last_effective_at ||
    (message.effectiveAt === cursor.last_effective_at && message.id > cursor.last_message_id)
  );
}

/**
 * Returns a portable SQL lower bound that is only a superset of isAfterCursor.
 * effective_at is provider_timestamp ?? received_at. Any message with
 * effective_at > cursor must have received_at > cursor - 48h: if effective_at is
 * received_at this is direct, and if effective_at is provider_timestamp then a
 * valid provider_timestamp can exceed received_at by at most 48h.
 */
function cursorReceivedAtLowerBound(cursor: ConversationSliceCursorRow): string | null {
  if (cursor.last_effective_at === null || cursor.last_message_id === null) return null;
  const cursorMs = Date.parse(cursor.last_effective_at);
  if (!Number.isFinite(cursorMs)) return null;
  return new Date(cursorMs - WHATSAPP_PROVIDER_TIMESTAMP_MAX_FUTURE_MS).toISOString();
}

function emptyRunSummary(): WhatsAppChunkerRunSummary {
  return {
    conversationsProcessed: 0,
    slicesCreated: 0,
    lateArrivals: 0,
    messagesProcessed: 0,
    maxAgeFlushes: 0,
    maxSizeFlushes: 0,
  };
}

function hasAttachments(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return value.trim().length > 0;
  }
}

function isControlMessage(text: string): boolean {
  const command = parseSketchCommand(text);
  if (command === "new_session" || command === "tool_progress_query" || command === "reasoning_text_query") {
    return true;
  }
  if (command?.startsWith("tool_progress_") || command?.startsWith("reasoning_text_")) return true;
  return isToolProgressCommand(text) || isReasoningTextCommand(text);
}

function isReactionOnly(message: WhatsAppChunkerMessage): boolean {
  const providerId = message.providerMessageId.toLowerCase();
  if (providerId.startsWith("reaction:") || providerId.includes(":reaction:")) return true;
  const text = message.text.trim();
  return text.length > 0 && SINGLE_EMOJI_PATTERN.test(text);
}

function isCaptionlessMedia(message: WhatsAppChunkerMessage): boolean {
  if (!hasAttachments(message.attachments)) return false;
  const text = message.text.trim();
  return text.length === 0 || text.toLowerCase() === SYNTHETIC_ATTACHMENT_TEXT;
}

export function isIndexableWhatsAppChunkMessage(message: WhatsAppChunkerMessage): boolean {
  if (message.isBot) return false;
  if (isControlMessage(message.text)) return false;
  if (isReactionOnly(message)) return false;
  if (isCaptionlessMedia(message)) return false;
  return message.text.trim().length > 0 || hasAttachments(message.attachments);
}

function toSortableMessages(messages: WhatsAppChunkerMessage[]): SortableChunkerMessage[] {
  return messages
    .map((message) => ({ ...message, effectiveMs: effectiveTimeMs(message.effectiveAt), rawIndex: 0 }))
    .sort((left, right) => left.effectiveMs - right.effectiveMs || left.id - right.id)
    .map((message, rawIndex) => ({ ...message, rawIndex }));
}

function buildSlice(
  sortedMessages: SortableChunkerMessage[],
  denoisedMessages: SortableChunkerMessage[],
  startIndex: number,
  endIndex: number,
  flushReason: ConversationSliceFlushReason,
): PlannedWhatsAppSlice {
  const kept = denoisedMessages.slice(startIndex, endIndex + 1);
  const firstKept = kept[0];
  const lastKept = kept[kept.length - 1];
  if (!firstKept || !lastKept) {
    throw new Error("Cannot build an empty WhatsApp slice");
  }

  const rawRange = sortedMessages.slice(firstKept.rawIndex, lastKept.rawIndex + 1);
  const rangeIds = rawRange.map((message) => message.id);

  return {
    firstMessageId: Math.min(...rangeIds),
    lastMessageId: Math.max(...rangeIds),
    startedAt: firstKept.effectiveAt,
    endedAt: lastKept.effectiveAt,
    messageCount: kept.length,
    denoisedMessageIds: kept.map((message) => message.id),
    flushReason,
    cursor: {
      lastEffectiveAt: lastKept.effectiveAt,
      lastMessageId: lastKept.id,
    },
  };
}

export function planWhatsAppConversationSlices(
  messages: WhatsAppChunkerMessage[],
  knobs: WhatsAppChunkerKnobs,
  now = new Date(),
): WhatsAppChunkerPlan {
  const sortedMessages = toSortableMessages(messages);
  const denoisedMessages = sortedMessages.filter(isIndexableWhatsAppChunkMessage);
  const slices: PlannedWhatsAppSlice[] = [];
  const gapMs = knobs.gapMinutes * MINUTE_MS;
  const maxAgeMs = knobs.maxAgeMinutes * MINUTE_MS;
  const maxMessages = Math.max(1, knobs.maxMessages);
  let currentStartIndex: number | null = null;

  for (let index = 0; index < denoisedMessages.length; index += 1) {
    const current = denoisedMessages[index];
    if (!current) continue;

    if (currentStartIndex === null) {
      currentStartIndex = index;
      continue;
    }

    const previous = denoisedMessages[index - 1];
    if (previous && current.effectiveMs - previous.effectiveMs >= gapMs) {
      slices.push(buildSlice(sortedMessages, denoisedMessages, currentStartIndex, index - 1, "gap"));
      currentStartIndex = index;
      continue;
    }

    const first = denoisedMessages[currentStartIndex];
    if (!first) continue;
    const messageCount = index - currentStartIndex + 1;
    const ageMs = current.effectiveMs - first.effectiveMs;
    if (messageCount >= maxMessages) {
      slices.push(buildSlice(sortedMessages, denoisedMessages, currentStartIndex, index, "max_size"));
      currentStartIndex = null;
      continue;
    }
    if (ageMs >= maxAgeMs) {
      slices.push(buildSlice(sortedMessages, denoisedMessages, currentStartIndex, index, "max_age"));
      currentStartIndex = null;
    }
  }

  if (currentStartIndex !== null) {
    const lastIndex = denoisedMessages.length - 1;
    const last = denoisedMessages[lastIndex];
    if (last && last.effectiveMs <= now.getTime() - gapMs) {
      slices.push(buildSlice(sortedMessages, denoisedMessages, currentStartIndex, lastIndex, "gap"));
      return { slices, activeTailMessageIds: [] };
    }
    return {
      slices,
      activeTailMessageIds: denoisedMessages.slice(currentStartIndex).map((message) => message.id),
    };
  }

  return { slices, activeTailMessageIds: [] };
}

async function findGroupConversation(db: Kysely<DB>, groupJid: string): Promise<{ id: number } | undefined> {
  return db
    .selectFrom("conversations")
    .select("id")
    .where("platform", "=", "whatsapp")
    .where("kind", "=", "group")
    .where("provider_conversation_id", "=", groupJid)
    .executeTakeFirst();
}

async function listMessagesAfterCursor(
  db: Kysely<DB>,
  conversationId: number,
  cursor: ConversationSliceCursorRow,
  now: Date,
): Promise<WhatsAppChunkerMessage[]> {
  const lowerBound = cursorReceivedAtLowerBound(cursor);
  let query = db
    .selectFrom("conversation_messages")
    .select(["id", "provider_message_id", "is_bot", "text", "attachments", "provider_timestamp", "received_at"])
    .where("conversation_id", "=", conversationId)
    .where("source", "=", "live");
  if (lowerBound) query = query.where("received_at", ">", lowerBound);
  const rows = await query.orderBy("id", "asc").execute();

  return rows
    .map((row: ChunkerRawRow) => ({
      id: row.id,
      providerMessageId: row.provider_message_id,
      effectiveAt: effectiveTimestamp(row, now),
      text: row.text,
      attachments: row.attachments,
      isBot: row.is_bot === 1,
    }))
    .filter((message) => isAfterCursor(message, cursor))
    .sort(
      (left, right) => effectiveTimeMs(left.effectiveAt) - effectiveTimeMs(right.effectiveAt) || left.id - right.id,
    );
}

async function countLateArrivals(
  db: Kysely<DB>,
  conversationId: number,
  cursor: ConversationSliceCursorRow,
  now: Date,
): Promise<number> {
  if (cursor.last_effective_at === null || cursor.last_message_id === null) return 0;

  const lowerBound = cursorReceivedAtLowerBound(cursor);
  let query = db
    .selectFrom("conversation_messages")
    .select(["id", "provider_timestamp", "received_at"])
    .where("conversation_id", "=", conversationId)
    .where("source", "=", "live")
    .where("id", ">", cursor.last_message_id);
  if (lowerBound) query = query.where("received_at", ">", lowerBound);
  const rows = await query.execute();

  return rows.filter(
    (row: ChunkerTimestampRow) => !isAfterCursor({ id: row.id, effectiveAt: effectiveTimestamp(row, now) }, cursor),
  ).length;
}

async function chunkWhatsAppGroup(options: ChunkWhatsAppGroupOptions): Promise<WhatsAppChunkerRunSummary> {
  const { db, group, logger } = options;
  const now = options.now ?? new Date();
  const conversation = await findGroupConversation(db, group.jid);
  if (!conversation) return emptyRunSummary();

  const claimToken = randomUUID();
  const repo = createConversationSlicesRepository(db);
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - (options.claimStaleMs ?? DEFAULT_CLAIM_STALE_MS)).toISOString();
  const claimed = await repo.claimCursor({
    conversationId: conversation.id,
    claimToken,
    now: nowIso,
    staleBefore,
  });

  if (!claimed) return emptyRunSummary();

  try {
    await options.onConversationClaimed?.(conversation.id);

    return await db.transaction().execute(async (trx) => {
      const txRepo = createConversationSlicesRepository(trx);
      const cursor = await txRepo.getCursor(conversation.id);
      if (!cursor || cursor.claim_token !== claimToken) {
        return emptyRunSummary();
      }

      const enabledGroup = await trx
        .selectFrom("whatsapp_groups")
        .select("index_enabled")
        .where("jid", "=", group.jid)
        .executeTakeFirst();
      if (enabledGroup?.index_enabled !== 1) {
        const released = await txRepo.releaseCursorClaim({ conversationId: conversation.id, claimToken });
        if (!released) throw new ConversationSliceClaimLostError();
        return emptyRunSummary();
      }

      const lateArrivals = await countLateArrivals(trx, conversation.id, cursor, now);
      if (lateArrivals > 0) {
        logger.info({ conversationId: conversation.id, lateArrivals }, "late_arrival_skipped");
      }

      const messages = await listMessagesAfterCursor(trx, conversation.id, cursor, now);
      const plan = planWhatsAppConversationSlices(
        messages,
        resolveWhatsAppChunkerKnobs(group, options.defaultKnobs),
        now,
      );
      let slicesCreated = 0;
      let maxAgeFlushes = 0;
      let maxSizeFlushes = 0;

      for (const planned of plan.slices) {
        if (planned.flushReason === "max_age") maxAgeFlushes += 1;
        if (planned.flushReason === "max_size") maxSizeFlushes += 1;
        const inserted = await txRepo.insertIfAbsent({
          conversationId: conversation.id,
          firstMessageId: planned.firstMessageId,
          lastMessageId: planned.lastMessageId,
          startedAt: planned.startedAt,
          endedAt: planned.endedAt,
          messageCount: planned.messageCount,
          denoisedMessageIds: planned.denoisedMessageIds,
          flushReason: planned.flushReason,
          rosterSnapshot: "[]",
          salienceVerdict: null,
        });

        if (inserted.created) {
          slicesCreated += 1;
          logger.info(
            {
              conversationId: conversation.id,
              messageCount: planned.messageCount,
              durationSeconds: Math.max(
                0,
                Math.round((effectiveTimeMs(planned.endedAt) - effectiveTimeMs(planned.startedAt)) / 1000),
              ),
              flushReason: planned.flushReason,
            },
            "Created WhatsApp conversation slice",
          );
        }
      }

      const lastSlice = plan.slices[plan.slices.length - 1];
      if (lastSlice) {
        const advanced = await txRepo.advanceCursorIfClaimed({
          conversationId: conversation.id,
          lastEffectiveAt: lastSlice.cursor.lastEffectiveAt,
          lastMessageId: lastSlice.cursor.lastMessageId,
          claimToken,
        });
        if (!advanced) throw new ConversationSliceClaimLostError();
      }
      const released = await txRepo.releaseCursorClaim({ conversationId: conversation.id, claimToken });
      if (lastSlice && !released) throw new ConversationSliceClaimLostError();

      logger.info(
        {
          conversationId: conversation.id,
          slicesCreated,
          messagesProcessed: messages.length,
          lateArrivals,
          maxAgeFlushes,
          maxSizeFlushes,
        },
        "Completed WhatsApp conversation chunking",
      );

      return {
        conversationsProcessed: 1,
        slicesCreated,
        lateArrivals,
        messagesProcessed: messages.length,
        maxAgeFlushes,
        maxSizeFlushes,
      };
    });
  } catch (err) {
    await repo.releaseCursorClaim({ conversationId: conversation.id, claimToken });
    if (err instanceof ConversationSliceClaimLostError) return emptyRunSummary();
    throw err;
  }
}

interface WhatsAppBackfillGraphBacklog {
  pendingSlices: number;
  pendingFiles: number;
  openFacts: number;
}

interface WhatsAppBackfillGraphChatResult {
  claimed: boolean;
  messagesRead: number;
  slicesCreated: number;
  rangeCompleted: boolean;
}

function resolveWhatsAppBackfillGraphKnobs(
  overrides: Partial<WhatsAppBackfillGraphKnobs> = {},
): WhatsAppBackfillGraphKnobs {
  return {
    pageMessages: overrides.pageMessages ?? DEFAULT_WHATSAPP_BACKFILL_GRAPH_PAGE_MESSAGES,
    cycleMessages: overrides.cycleMessages ?? DEFAULT_WHATSAPP_BACKFILL_GRAPH_CYCLE_MESSAGES,
    pendingSlicesMax: overrides.pendingSlicesMax ?? DEFAULT_WHATSAPP_BACKFILL_GRAPH_PENDING_SLICES_MAX,
    pendingFilesMax: overrides.pendingFilesMax ?? DEFAULT_WHATSAPP_BACKFILL_GRAPH_PENDING_FILES_MAX,
    openFactsMax: overrides.openFactsMax ?? DEFAULT_WHATSAPP_BACKFILL_GRAPH_OPEN_FACTS_MAX,
  };
}

async function readWhatsAppBackfillGraphBacklog(db: Kysely<DB>): Promise<WhatsAppBackfillGraphBacklog> {
  const [pendingSlices, pendingFiles, openFacts] = await Promise.all([
    db
      .selectFrom("conversation_slices")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("salience_verdict", "is", null)
      .executeTakeFirst(),
    db
      .selectFrom("indexed_files")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("is_archived", "=", 0)
      .where((eb) =>
        eb.or([eb("embedding_status", "in", ["pending", "failed"]), eb("summary_status", "in", ["pending", "failed"])]),
      )
      .executeTakeFirst(),
    db
      .selectFrom("indexed_file_facts")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("deleted_at", "is", null)
      .where("materialized_at", "is", null)
      .where("materialization_attempts", "<", MAX_MATERIALIZATION_ATTEMPTS)
      .executeTakeFirst(),
  ]);
  return {
    pendingSlices: Number(pendingSlices?.count ?? 0),
    pendingFiles: Number(pendingFiles?.count ?? 0),
    openFacts: Number(openFacts?.count ?? 0),
  };
}

function exceedsWhatsAppBackfillGraphPressure(
  backlog: WhatsAppBackfillGraphBacklog,
  knobs: WhatsAppBackfillGraphKnobs,
): boolean {
  return (
    backlog.pendingSlices > knobs.pendingSlicesMax ||
    backlog.pendingFiles > knobs.pendingFilesMax ||
    backlog.openFacts > knobs.openFactsMax
  );
}

function sameSliceMembership(row: { denoised_message_ids: string | null }, planned: PlannedWhatsAppSlice): boolean {
  return row.denoised_message_ids === JSON.stringify(planned.denoisedMessageIds);
}

async function admitWhatsAppBackfillGraphChat(input: {
  db: Kysely<DB>;
  group: WhatsAppGroupIndexingConfig;
  conversationId: number;
  rangeId: string;
  pageLimit: number;
  now: Date;
  logger: Logger;
  claimStaleMs?: number;
  defaultKnobs?: Partial<WhatsAppChunkerKnobs>;
  onBackfillConversationClaimed?: (conversationId: number) => Promise<void>;
  onBackfillSlicesInserted?: (rangeId: string) => Promise<void>;
}): Promise<WhatsAppBackfillGraphChatResult> {
  const claimToken = randomUUID();
  const nowIso = input.now.toISOString();
  const staleBefore = new Date(input.now.getTime() - (input.claimStaleMs ?? DEFAULT_CLAIM_STALE_MS)).toISOString();
  const sliceRepo = createConversationSlicesRepository(input.db);
  if (
    !(await sliceRepo.claimCursor({
      conversationId: input.conversationId,
      claimToken,
      now: nowIso,
      staleBefore,
    }))
  ) {
    return { claimed: false, messagesRead: 0, slicesCreated: 0, rangeCompleted: false };
  }

  try {
    await input.onBackfillConversationClaimed?.(input.conversationId);
    const result = await input.db.transaction().execute(async (trx) => {
      const txSliceRepo = createConversationSlicesRepository(trx);
      const txRangeRepo = createWhatsAppBackfillRangeRepository(trx);
      const cursorClaim = await txSliceRepo.getCursor(input.conversationId);
      if (cursorClaim?.claim_token !== claimToken) throw new ConversationSliceClaimLostError();

      const range = await txRangeRepo.getById(input.rangeId);
      if (!range || !["complete", "exhausted"].includes(range.status) || range.graph_completed_at) {
        throw new ConversationSliceClaimLostError();
      }
      const checkpoint = await trx
        .selectFrom("whatsapp_backfill_checkpoints")
        .innerJoin("whatsapp_groups", "whatsapp_groups.jid", "whatsapp_backfill_checkpoints.group_jid")
        .select(["whatsapp_backfill_checkpoints.graph_halted_at", "whatsapp_groups.index_enabled"])
        .where("whatsapp_backfill_checkpoints.group_jid", "=", range.group_jid)
        .executeTakeFirst();
      if (!checkpoint || checkpoint.index_enabled !== 1 || checkpoint.graph_halted_at) {
        throw new ConversationSliceClaimLostError();
      }

      const olderIncomplete = await trx
        .selectFrom("whatsapp_backfill_ranges")
        .select("id")
        .where("group_jid", "=", range.group_jid)
        .where("graph_completed_at", "is", null)
        .where("id", "!=", range.id)
        .where((eb) =>
          eb.or([
            eb("lower_bound_at", "<", range.lower_bound_at),
            eb.and([eb("lower_bound_at", "=", range.lower_bound_at), eb("upper_bound_at", "<", range.upper_bound_at)]),
            eb.and([
              eb("lower_bound_at", "=", range.lower_bound_at),
              eb("upper_bound_at", "=", range.upper_bound_at),
              eb("created_at", "<", range.created_at),
            ]),
            eb.and([
              eb("lower_bound_at", "=", range.lower_bound_at),
              eb("upper_bound_at", "=", range.upper_bound_at),
              eb("created_at", "=", range.created_at),
              eb("id", "<", range.id),
            ]),
          ]),
        )
        .executeTakeFirst();
      if (olderIncomplete) throw new ConversationSliceClaimLostError();

      const invalidTimestamp = await trx
        .selectFrom("conversation_messages")
        .select("id")
        .where("conversation_id", "=", input.conversationId)
        .where("source", "=", "history")
        .where("backfill_range_id", "=", range.id)
        .where("effective_at", "is", null)
        .executeTakeFirst();
      if (invalidTimestamp) {
        throw new WhatsAppBackfillGraphInvariantError(
          range.group_jid,
          range.id,
          "terminal WhatsApp backfill range contains a row without persisted effective_at",
        );
      }

      let pageQuery = trx
        .selectFrom("conversation_messages")
        .select(["id", "provider_message_id", "is_bot", "text", "attachments", "effective_at"])
        .where("conversation_id", "=", input.conversationId)
        .where("source", "=", "history")
        .where("backfill_range_id", "=", range.id)
        .where("effective_at", "is not", null);
      if (range.graph_cursor_effective_at !== null && range.graph_cursor_message_id !== null) {
        pageQuery = pageQuery.where((eb) =>
          eb.or([
            eb("effective_at", ">", range.graph_cursor_effective_at as string),
            eb.and([
              eb("effective_at", "=", range.graph_cursor_effective_at as string),
              eb("id", ">", range.graph_cursor_message_id as number),
            ]),
          ]),
        );
      }
      const rows = await pageQuery.orderBy("effective_at", "asc").orderBy("id", "asc").limit(input.pageLimit).execute();
      const messages: WhatsAppChunkerMessage[] = rows.map((row) => ({
        id: row.id,
        providerMessageId: row.provider_message_id,
        effectiveAt: row.effective_at as string,
        text: row.text,
        attachments: row.attachments,
        isBot: row.is_bot === 1,
      }));
      const plan = planWhatsAppConversationSlices(
        messages,
        resolveWhatsAppChunkerKnobs(input.group, input.defaultKnobs),
        input.now,
      );
      let slicesCreated = 0;
      for (const planned of plan.slices) {
        const inserted = await txSliceRepo.insertIfAbsent({
          conversationId: input.conversationId,
          firstMessageId: planned.firstMessageId,
          lastMessageId: planned.lastMessageId,
          startedAt: planned.startedAt,
          endedAt: planned.endedAt,
          messageCount: planned.messageCount,
          denoisedMessageIds: planned.denoisedMessageIds,
          flushReason: planned.flushReason,
          rosterSnapshot: "[]",
          salienceVerdict: null,
        });
        if (!inserted.created && !sameSliceMembership(inserted.row, planned)) {
          throw new WhatsAppBackfillGraphInvariantError(
            range.group_jid,
            range.id,
            `conversation slice membership conflict for first message ${planned.firstMessageId}`,
          );
        }
        if (inserted.created) slicesCreated += 1;
      }
      await input.onBackfillSlicesInserted?.(range.id);

      const lastSlice = plan.slices[plan.slices.length - 1];
      const lastPageMessage = messages[messages.length - 1];
      const admittedThrough =
        plan.activeTailMessageIds.length === 0 && lastPageMessage
          ? { effectiveAt: lastPageMessage.effectiveAt, messageId: lastPageMessage.id }
          : lastSlice
            ? { effectiveAt: lastSlice.cursor.lastEffectiveAt, messageId: lastSlice.cursor.lastMessageId }
            : range.graph_cursor_effective_at !== null && range.graph_cursor_message_id !== null
              ? { effectiveAt: range.graph_cursor_effective_at, messageId: range.graph_cursor_message_id }
              : null;

      let nextQuery = trx
        .selectFrom("conversation_messages")
        .select(["id", "effective_at"])
        .where("conversation_id", "=", input.conversationId)
        .where("source", "=", "history")
        .where("backfill_range_id", "=", range.id)
        .where("effective_at", "is not", null);
      if (admittedThrough) {
        nextQuery = nextQuery.where((eb) =>
          eb.or([
            eb("effective_at", ">", admittedThrough.effectiveAt),
            eb.and([eb("effective_at", "=", admittedThrough.effectiveAt), eb("id", ">", admittedThrough.messageId)]),
          ]),
        );
      }
      const next = await nextQuery.orderBy("effective_at", "asc").orderBy("id", "asc").executeTakeFirst();
      const rangeCompleted = plan.activeTailMessageIds.length === 0 && !next;
      await trx
        .updateTable("whatsapp_backfill_ranges")
        .set({
          ...(admittedThrough
            ? {
                graph_cursor_effective_at: admittedThrough.effectiveAt,
                graph_cursor_message_id: admittedThrough.messageId,
              }
            : {}),
          graph_completed_at: rangeCompleted ? nowIso : null,
          updated_at: nowIso,
        })
        .where("id", "=", range.id)
        .where("status", "in", ["complete", "exhausted"])
        .where("graph_completed_at", "is", null)
        .execute();
      await trx
        .updateTable("whatsapp_backfill_checkpoints")
        .set({ graph_last_served_at: nowIso, updated_at: nowIso })
        .where("group_jid", "=", range.group_jid)
        .where("graph_halted_at", "is", null)
        .execute();

      const remaining = next
        ? await trx
            .selectFrom("conversation_messages")
            .select((eb) => eb.fn.countAll().as("count"))
            .where("conversation_id", "=", input.conversationId)
            .where("source", "=", "history")
            .where("backfill_range_id", "=", range.id)
            .where((eb) =>
              admittedThrough
                ? eb.or([
                    eb("effective_at", ">", admittedThrough.effectiveAt),
                    eb.and([
                      eb("effective_at", "=", admittedThrough.effectiveAt),
                      eb("id", ">", admittedThrough.messageId),
                    ]),
                  ])
                : eb("id", ">", 0),
            )
            .executeTakeFirst()
        : null;
      return {
        claimed: true,
        messagesRead: messages.length,
        slicesCreated,
        rangeCompleted,
        remainingMessages: Number(remaining?.count ?? 0),
        backlogOldestEffectiveAt: next?.effective_at ?? null,
        cursorEffectiveAt: admittedThrough?.effectiveAt ?? null,
        cursorMessageId: admittedThrough?.messageId ?? null,
        groupJid: range.group_jid,
      };
    });

    await sliceRepo.releaseCursorClaim({ conversationId: input.conversationId, claimToken });
    input.logger.info(
      {
        groupJid: result.groupJid,
        conversationId: input.conversationId,
        rangeId: input.rangeId,
        messagesRead: result.messagesRead,
        slicesCreated: result.slicesCreated,
        remainingMessages: result.remainingMessages,
        rangeCompleted: result.rangeCompleted,
        cursorEffectiveAt: result.cursorEffectiveAt,
        cursorMessageId: result.cursorMessageId,
        backlogAgeSeconds: result.backlogOldestEffectiveAt
          ? Math.max(0, Math.floor((input.now.getTime() - Date.parse(result.backlogOldestEffectiveAt)) / 1000))
          : 0,
      },
      "Admitted WhatsApp backfill history into context graph slices",
    );
    return result;
  } catch (err) {
    if (err instanceof WhatsAppBackfillGraphInvariantError) {
      await createWhatsAppBackfillRangeRepository(input.db).haltGraphAdmission(err.groupJid, err.message, nowIso);
      input.logger.error(
        { err, groupJid: err.groupJid, conversationId: input.conversationId, rangeId: err.rangeId },
        "Halted WhatsApp backfill graph admission after invariant failure",
      );
    }
    await sliceRepo.releaseCursorClaim({ conversationId: input.conversationId, claimToken });
    if (err instanceof ConversationSliceClaimLostError || err instanceof WhatsAppBackfillGraphInvariantError) {
      return { claimed: false, messagesRead: 0, slicesCreated: 0, rangeCompleted: false };
    }
    throw err;
  }
}

async function admitWhatsAppBackfillGraphPages(options: ChunkWhatsAppGroupsOptions): Promise<{
  chatsServed: number;
  messagesRead: number;
  slicesCreated: number;
  rangesCompleted: number;
  skippedForPressure: boolean;
}> {
  const knobs = resolveWhatsAppBackfillGraphKnobs(options.backfillGraphKnobs);
  const groupsByJid = new Map(options.groups.map((group) => [group.jid, group]));
  const servedGroupJids: string[] = [];
  let messagesRead = 0;
  let slicesCreated = 0;
  let rangesCompleted = 0;
  let skippedForPressure = false;

  while (messagesRead < knobs.cycleMessages) {
    const backlog = await readWhatsAppBackfillGraphBacklog(options.db);
    if (exceedsWhatsAppBackfillGraphPressure(backlog, knobs)) {
      skippedForPressure = true;
      options.logger.info(
        {
          ...backlog,
          pendingSlicesMax: knobs.pendingSlicesMax,
          pendingFilesMax: knobs.pendingFilesMax,
          openFactsMax: knobs.openFactsMax,
        },
        "Skipped WhatsApp backfill graph admission under pipeline backpressure",
      );
      break;
    }
    const candidate = await createWhatsAppBackfillRangeRepository(options.db).findNextGraphCandidate({
      groupJids: [...groupsByJid.keys()],
      excludedGroupJids: servedGroupJids,
    });
    if (!candidate) break;
    const group = groupsByJid.get(candidate.range.group_jid);
    if (!group) break;
    const result = await admitWhatsAppBackfillGraphChat({
      db: options.db,
      group,
      conversationId: candidate.conversationId,
      rangeId: candidate.range.id,
      pageLimit: Math.min(knobs.pageMessages, knobs.cycleMessages - messagesRead),
      now: options.now ?? new Date(),
      logger: options.logger,
      claimStaleMs: options.claimStaleMs,
      defaultKnobs: options.defaultKnobs,
      onBackfillConversationClaimed: options.onBackfillConversationClaimed,
      onBackfillSlicesInserted: options.onBackfillSlicesInserted,
    });
    servedGroupJids.push(candidate.range.group_jid);
    if (!result.claimed) continue;
    messagesRead += result.messagesRead;
    slicesCreated += result.slicesCreated;
    if (result.rangeCompleted) rangesCompleted += 1;
  }

  return {
    chatsServed: servedGroupJids.length,
    messagesRead,
    slicesCreated,
    rangesCompleted,
    skippedForPressure,
  };
}

export async function chunkWhatsAppIndexingGroups(
  options: ChunkWhatsAppGroupsOptions,
): Promise<WhatsAppChunkerRunSummary> {
  const summary = emptyRunSummary();

  for (const group of options.groups) {
    const result = await chunkWhatsAppGroup({ ...options, group });
    summary.conversationsProcessed += result.conversationsProcessed;
    summary.slicesCreated += result.slicesCreated;
    summary.lateArrivals += result.lateArrivals;
    summary.messagesProcessed += result.messagesProcessed;
    summary.maxAgeFlushes += result.maxAgeFlushes;
    summary.maxSizeFlushes += result.maxSizeFlushes;
  }

  const backfill = await admitWhatsAppBackfillGraphPages(options);
  options.logger.info(backfill, "Completed WhatsApp backfill graph admission run");

  options.logger.info(
    {
      conversationsProcessed: summary.conversationsProcessed,
      slicesCreated: summary.slicesCreated,
      lateArrivals: summary.lateArrivals,
      messagesProcessed: summary.messagesProcessed,
      maxAgeFlushes: summary.maxAgeFlushes,
      maxSizeFlushes: summary.maxSizeFlushes,
    },
    "Completed WhatsApp chunker run",
  );

  return summary;
}
