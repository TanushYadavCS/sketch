import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import {
  type ConversationSliceFlushReason,
  createConversationSlicesRepository,
} from "../db/repositories/conversation-slices";
import type { DB } from "../db/schema";

export const SLACK_CHANNEL_STREAM_KEY = "channel";
export const SLACK_ROUTER_STREAM_KEY = "::router";

export const DEFAULT_SLACK_CHANNEL_GAP_MINUTES = 25;
export const DEFAULT_SLACK_CHANNEL_MAX_AGE_MINUTES = 120;
export const DEFAULT_SLACK_THREAD_IDLE_MINUTES = 480;
export const DEFAULT_SLACK_SLICE_MAX_MESSAGES = 50;

const MINUTE_MS = 60_000;
const DEFAULT_CLAIM_STALE_MS = 15 * MINUTE_MS;

export interface SlackChunkerKnobs {
  gapMinutes: number;
  /** null disables the age flush — thread streams close on idle or size only. */
  maxAgeMinutes: number | null;
  maxMessages: number;
}

export interface SlackChunkerMessage {
  id: number;
  effectiveAt: string;
  text: string;
  attachments: string | null;
  isBot: boolean;
  addressedToSketch: boolean;
}

export interface PlannedSlackSlice {
  firstMessageId: number;
  lastMessageId: number;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  denoisedMessageIds: number[];
  flushReason: ConversationSliceFlushReason;
  cursorLastMessageId: number;
}

export interface SlackChunkerPlan {
  slices: PlannedSlackSlice[];
  activeTailMessageIds: number[];
}

export interface SlackChunkerRunSummary {
  conversationsProcessed: number;
  streamsProcessed: number;
  slicesCreated: number;
  messagesProcessed: number;
}

class StreamClaimLostError extends Error {
  constructor() {
    super("Slack stream cursor claim lost");
  }
}

const JOIN_LEAVE_PATTERN = /^<@U[A-Z0-9]+>\s+has\s+(joined|left)\s+the\s+(channel|group)\.?$/iu;
const EMOJI_ONLY_PATTERN = /^(?:\s|:[a-z0-9_+-]+:|\p{Extended_Pictographic}|\p{Emoji_Component}|‍)+$/u;
const ATTACHMENT_PLACEHOLDER = "see attached files.";

function hasAttachments(attachments: string | null): boolean {
  if (!attachments) return false;
  try {
    const parsed = JSON.parse(attachments);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/**
 * Denoise gate for Slack slices. Bot rows and Sketch-directed chatter are
 * agent conversation, not team knowledge; join/leave patterns cover rows
 * captured before the capture-side subtype blocklist shipped.
 */
export function isIndexableSlackChunkMessage(message: SlackChunkerMessage): boolean {
  if (message.isBot) return false;
  if (message.addressedToSketch) return false;
  const trimmed = message.text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.toLowerCase() === ATTACHMENT_PLACEHOLDER) return false;
  if (JOIN_LEAVE_PATTERN.test(trimmed)) return false;
  if (EMOJI_ONLY_PATTERN.test(trimmed)) return false;
  return true;
}

interface SortableSlackMessage extends SlackChunkerMessage {
  effectiveMs: number;
  rawIndex: number;
}

function toSortableMessages(messages: SlackChunkerMessage[]): SortableSlackMessage[] {
  return messages
    .map((message) => ({ ...message, effectiveMs: Date.parse(message.effectiveAt) || 0, rawIndex: 0 }))
    .sort((left, right) => left.effectiveMs - right.effectiveMs || left.id - right.id)
    .map((message, rawIndex) => ({ ...message, rawIndex }));
}

function buildSlice(
  sortedMessages: SortableSlackMessage[],
  denoisedMessages: SortableSlackMessage[],
  startIndex: number,
  endIndex: number,
  flushReason: ConversationSliceFlushReason,
): PlannedSlackSlice {
  const kept = denoisedMessages.slice(startIndex, endIndex + 1);
  const firstKept = kept[0];
  const lastKept = kept[kept.length - 1];
  if (!firstKept || !lastKept) {
    throw new Error("Cannot build an empty Slack slice");
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
    cursorLastMessageId: lastKept.id,
  };
}

/**
 * Plans slices for one Slack stream (the channel top-level stream or a single
 * thread). Same shape as the WhatsApp planner: gap/size/age flushes over the
 * denoised sequence, with an active tail left open until the stream has been
 * idle past the gap. Thread streams pass maxAgeMinutes: null — a thread is a
 * single conversation regardless of how long it stays alive, so only idle and
 * size close it.
 */
export function planSlackStreamSlices(
  messages: SlackChunkerMessage[],
  knobs: SlackChunkerKnobs,
  now = new Date(),
): SlackChunkerPlan {
  const sortedMessages = toSortableMessages(messages);
  const denoisedMessages = sortedMessages.filter(isIndexableSlackChunkMessage);
  const slices: PlannedSlackSlice[] = [];
  const gapMs = knobs.gapMinutes * MINUTE_MS;
  const maxAgeMs = knobs.maxAgeMinutes === null ? null : knobs.maxAgeMinutes * MINUTE_MS;
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
    if (messageCount >= maxMessages) {
      slices.push(buildSlice(sortedMessages, denoisedMessages, currentStartIndex, index, "max_size"));
      currentStartIndex = null;
      continue;
    }
    if (maxAgeMs !== null && current.effectiveMs - first.effectiveMs >= maxAgeMs) {
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

interface StreamActivityRow {
  streamKey: string;
  maxMessageId: number;
}

/**
 * One aggregate query resolves per-stream activity: top-level rows fold into
 * the channel stream, replies into their thread stream.
 */
async function listStreamActivity(db: Kysely<DB>, conversationId: number): Promise<StreamActivityRow[]> {
  const rows = await db
    .selectFrom("conversation_messages")
    .select(({ fn }) => ["is_thread_reply", "provider_thread_id", fn.max("id").as("max_id")])
    .where("conversation_id", "=", conversationId)
    .where("source", "=", "live")
    .groupBy(["is_thread_reply", "provider_thread_id"])
    .execute();

  const activity = new Map<string, number>();
  for (const row of rows) {
    const streamKey =
      row.is_thread_reply === 1 && row.provider_thread_id ? row.provider_thread_id : SLACK_CHANNEL_STREAM_KEY;
    const maxId = Number(row.max_id);
    activity.set(streamKey, Math.max(activity.get(streamKey) ?? 0, maxId));
  }
  return [...activity.entries()].map(([streamKey, maxMessageId]) => ({ streamKey, maxMessageId }));
}

async function listStreamMessages(
  db: Kysely<DB>,
  conversationId: number,
  streamKey: string,
  afterMessageId: number | null,
): Promise<SlackChunkerMessage[]> {
  let query = db
    .selectFrom("conversation_messages")
    .select(["id", "text", "attachments", "is_bot", "addressed_to_sketch", "provider_timestamp", "received_at"])
    .where("conversation_id", "=", conversationId)
    .where("source", "=", "live");

  query =
    streamKey === SLACK_CHANNEL_STREAM_KEY
      ? query.where("is_thread_reply", "=", 0)
      : query.where("is_thread_reply", "=", 1).where("provider_thread_id", "=", streamKey);
  if (afterMessageId !== null) query = query.where("id", ">", afterMessageId);

  const rows = await query.orderBy("id", "asc").execute();
  return rows.map((row) => ({
    id: row.id,
    effectiveAt: row.provider_timestamp ?? row.received_at,
    text: row.text,
    attachments: row.attachments,
    isBot: row.is_bot === 1,
    addressedToSketch: row.addressed_to_sketch === 1,
  }));
}

export interface ChunkSlackConversationsOptions {
  db: Kysely<DB>;
  logger: Logger;
  now?: Date;
  claimStaleMs?: number;
  channelKnobs?: Partial<SlackChunkerKnobs>;
  threadKnobs?: Partial<SlackChunkerKnobs>;
}

function resolveKnobs(streamKey: string, options: ChunkSlackConversationsOptions): SlackChunkerKnobs {
  if (streamKey === SLACK_CHANNEL_STREAM_KEY) {
    return {
      gapMinutes: options.channelKnobs?.gapMinutes ?? DEFAULT_SLACK_CHANNEL_GAP_MINUTES,
      maxAgeMinutes: options.channelKnobs?.maxAgeMinutes ?? DEFAULT_SLACK_CHANNEL_MAX_AGE_MINUTES,
      maxMessages: options.channelKnobs?.maxMessages ?? DEFAULT_SLACK_SLICE_MAX_MESSAGES,
    };
  }
  return {
    gapMinutes: options.threadKnobs?.gapMinutes ?? DEFAULT_SLACK_THREAD_IDLE_MINUTES,
    maxAgeMinutes: options.threadKnobs?.maxAgeMinutes ?? null,
    maxMessages: options.threadKnobs?.maxMessages ?? DEFAULT_SLACK_SLICE_MAX_MESSAGES,
  };
}

async function processStream(
  options: ChunkSlackConversationsOptions,
  conversationId: number,
  streamKey: string,
  now: Date,
): Promise<{ slicesCreated: number; messagesProcessed: number }> {
  const { db, logger } = options;
  const repo = createConversationSlicesRepository(db);
  const claimToken = randomUUID();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - (options.claimStaleMs ?? DEFAULT_CLAIM_STALE_MS)).toISOString();

  const claimed = await repo.claimStreamCursorIfPending({
    conversationId,
    streamKey,
    claimToken,
    now: nowIso,
    staleBefore,
  });
  if (!claimed) return { slicesCreated: 0, messagesProcessed: 0 };

  try {
    return await db.transaction().execute(async (trx) => {
      const txRepo = createConversationSlicesRepository(trx);
      const cursor = await txRepo.getStreamCursor(conversationId, streamKey);
      if (!cursor || cursor.claim_token !== claimToken) throw new StreamClaimLostError();

      const messages = await listStreamMessages(trx, conversationId, streamKey, cursor.last_message_id);
      const plan = planSlackStreamSlices(messages, resolveKnobs(streamKey, options), now);

      let slicesCreated = 0;
      for (const planned of plan.slices) {
        const inserted = await txRepo.insertIfAbsent({
          conversationId,
          firstMessageId: planned.firstMessageId,
          lastMessageId: planned.lastMessageId,
          startedAt: planned.startedAt,
          endedAt: planned.endedAt,
          messageCount: planned.messageCount,
          denoisedMessageIds: planned.denoisedMessageIds,
          flushReason: planned.flushReason,
          rosterSnapshot: "[]",
          salienceVerdict: null,
          providerThreadId: streamKey === SLACK_CHANNEL_STREAM_KEY ? null : streamKey,
        });
        if (inserted.created) {
          slicesCreated += 1;
          logger.info(
            { conversationId, streamKey, messageCount: planned.messageCount, flushReason: planned.flushReason },
            "Created Slack conversation slice",
          );
        }
      }

      const lastSlice = plan.slices[plan.slices.length - 1];
      if (lastSlice) {
        const advanced = await txRepo.advanceStreamCursorIfClaimed({
          conversationId,
          streamKey,
          lastMessageId: lastSlice.cursorLastMessageId,
          claimToken,
        });
        if (!advanced) throw new StreamClaimLostError();
      }
      const released = await txRepo.releaseStreamCursorClaim({ conversationId, streamKey, claimToken });
      if (lastSlice && !released) throw new StreamClaimLostError();

      return { slicesCreated, messagesProcessed: messages.length };
    });
  } catch (err) {
    if (err instanceof StreamClaimLostError) return { slicesCreated: 0, messagesProcessed: 0 };
    await repo.releaseStreamCursorClaim({ conversationId, streamKey, claimToken }).catch(() => undefined);
    throw err;
  }
}

/**
 * Chunks every Slack channel conversation into per-stream slices. Membership
 * is the gate: any channel Sketch was added to has a conversation row, and
 * everything captured there is eligible.
 */
export async function chunkSlackConversations(
  options: ChunkSlackConversationsOptions,
): Promise<SlackChunkerRunSummary> {
  const { db, logger } = options;
  const now = options.now ?? new Date();
  const summary: SlackChunkerRunSummary = {
    conversationsProcessed: 0,
    streamsProcessed: 0,
    slicesCreated: 0,
    messagesProcessed: 0,
  };

  const conversations = await db
    .selectFrom("conversations")
    .select(["id"])
    .where("platform", "=", "slack")
    .where("kind", "=", "channel")
    .orderBy("id", "asc")
    .execute();

  for (const conversation of conversations) {
    const repo = createConversationSlicesRepository(db);
    const activity = await listStreamActivity(db, conversation.id);
    if (activity.length === 0) continue;

    const routerHighWater = Math.max(...activity.map((row) => row.maxMessageId));
    await db.transaction().execute(async (trx) => {
      await createConversationSlicesRepository(trx).ensureStreamCursorsAndAdvanceRouter({
        conversationId: conversation.id,
        routerStreamKey: SLACK_ROUTER_STREAM_KEY,
        streamKeys: activity.map((row) => row.streamKey),
        routerHighWaterMessageId: routerHighWater,
      });
    });

    const cursors = await repo.listStreamCursors(conversation.id);
    const cursorByKey = new Map(cursors.map((cursor) => [cursor.stream_key, cursor]));
    let conversationTouched = false;

    for (const { streamKey, maxMessageId } of activity) {
      const cursor = cursorByKey.get(streamKey);
      const lastMessageId = cursor?.last_message_id ?? null;
      if (lastMessageId !== null && lastMessageId >= maxMessageId) continue;

      const result = await processStream(options, conversation.id, streamKey, now);
      summary.streamsProcessed += 1;
      summary.slicesCreated += result.slicesCreated;
      summary.messagesProcessed += result.messagesProcessed;
      conversationTouched = true;
    }

    if (conversationTouched) summary.conversationsProcessed += 1;
  }

  logger.info(summary, "Completed Slack conversation chunking");
  return summary;
}
