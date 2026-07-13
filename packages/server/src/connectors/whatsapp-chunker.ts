import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { parseSketchCommand } from "../commands";
import {
  type ConversationSliceCursorRow,
  type ConversationSliceFlushReason,
  createConversationSlicesRepository,
} from "../db/repositories/conversation-slices";
import type { WhatsAppGroupIndexingConfig } from "../db/repositories/whatsapp-groups";
import type { DB } from "../db/schema";
import { isReasoningTextCommand, isToolProgressCommand } from "../progress-settings";

export const DEFAULT_WHATSAPP_SLICE_GAP_MINUTES = 25;
export const DEFAULT_WHATSAPP_SLICE_MAX_AGE_MINUTES = 120;
export const DEFAULT_WHATSAPP_SLICE_MAX_MESSAGES = 50;

const MINUTE_MS = 60 * 1000;
const DEFAULT_CLAIM_STALE_MS = 5 * MINUTE_MS;
const PROVIDER_TIMESTAMP_FLOOR_MS = Date.parse("2009-01-01T00:00:00.000Z");
const MAX_PROVIDER_TIMESTAMP_FUTURE_MS = 48 * 60 * 60 * 1000;
const SYNTHETIC_ATTACHMENT_TEXT = "see attached files.";
const SINGLE_EMOJI_PATTERN =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\p{Emoji_Modifier}|\uFE0E|\uFE0F)*(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\p{Emoji_Modifier}|\uFE0E|\uFE0F)*)*$/u;

export interface WhatsAppChunkerKnobs {
  gapMinutes: number;
  maxAgeMinutes: number;
  maxMessages: number;
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

function effectiveTimeMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function validProviderTimestamp(providerTimestamp: string | null | undefined, now: Date): string | null {
  if (!providerTimestamp) return null;
  const timestampMs = Date.parse(providerTimestamp);
  if (!Number.isFinite(timestampMs) || timestampMs <= PROVIDER_TIMESTAMP_FLOOR_MS) return null;
  if (timestampMs >= now.getTime() + MAX_PROVIDER_TIMESTAMP_FUTURE_MS) return null;
  return new Date(timestampMs).toISOString();
}

function normalizeReceivedAt(receivedAt: string): string {
  const receivedAtMs = Date.parse(receivedAt);
  return Number.isFinite(receivedAtMs) ? new Date(receivedAtMs).toISOString() : receivedAt;
}

/**
 * Provider timestamp validation lives in TypeScript so SQLite and Postgres use
 * the same floor, skew, and invalid-date behavior without dialect-specific casts.
 */
function effectiveTimestamp(row: ChunkerTimestampRow, now: Date): string {
  return validProviderTimestamp(row.provider_timestamp, now) ?? normalizeReceivedAt(row.received_at);
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
  return new Date(cursorMs - MAX_PROVIDER_TIMESTAMP_FUTURE_MS).toISOString();
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
    .where("conversation_id", "=", conversationId);
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
