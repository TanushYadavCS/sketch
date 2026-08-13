import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { parseSketchCommand } from "../commands";
import { isPg } from "../db/dialect";
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
import { estimateTokens } from "./chunking";
import { isRetryableProviderError } from "./provider-fallback";
import { purgeConversationalFactsForFile } from "./smart-enrichment";
import { runWithConcurrency } from "./sync-utils";
import { evaluateIdleClose, runLlmChunkingPass } from "./whatsapp-llm-chunker";

export const DEFAULT_WHATSAPP_SLICE_GAP_MINUTES = 25;
export const DEFAULT_WHATSAPP_SLICE_MAX_AGE_MINUTES = 120;
export const DEFAULT_WHATSAPP_SLICE_MAX_MESSAGES = 50;
export const DEFAULT_WHATSAPP_BACKFILL_GRAPH_PAGE_MESSAGES = 500;
export const DEFAULT_WHATSAPP_BACKFILL_GRAPH_PAGE_TOKENS = 20_000;
export const DEFAULT_WHATSAPP_BACKFILL_GRAPH_CYCLE_MESSAGES = 1500;
export const DEFAULT_WHATSAPP_BACKFILL_GRAPH_PENDING_SLICES_MAX = 200;
export const DEFAULT_WHATSAPP_BACKFILL_GRAPH_PENDING_FILES_MAX = 500;
export const DEFAULT_WHATSAPP_BACKFILL_GRAPH_OPEN_FACTS_MAX = 5000;
export const DEFAULT_WHATSAPP_LLM_CHUNK_WINDOW_MESSAGES = 250;
export const DEFAULT_WHATSAPP_LLM_CHUNK_WINDOW_TOKENS = 7500;
export const DEFAULT_WHATSAPP_LLM_CHUNK_MIN_MESSAGES = 10;
export const DEFAULT_WHATSAPP_LLM_CHUNK_TARGET_MESSAGES = 40;
export const DEFAULT_WHATSAPP_LLM_CHUNK_MAX_MESSAGES = 80;
export const DEFAULT_WHATSAPP_LLM_CHUNK_MAX_TOKENS = 1500;
export const DEFAULT_WHATSAPP_LLM_CHUNK_TICK_MINUTES = 30;
export const DEFAULT_WHATSAPP_LLM_CHUNK_IDLE_CLOSE_HOURS = 96;
export const DEFAULT_WHATSAPP_LLM_CHUNK_PROVISIONAL_REFRESH_MESSAGES = 15;
export const DEFAULT_WHATSAPP_LLM_CHUNK_REASONING_EFFORT = "high" as const;
export const DEFAULT_WHATSAPP_LLM_CHUNK_TOPIC_REGISTRY_CAP = 30;
export const DEFAULT_WHATSAPP_LLM_CHUNK_GROUP_WORKER_POOL = 4;

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

export type WhatsAppLlmReasoningEffort = "low" | "medium" | "high";

export interface WhatsAppLlmChunkerKnobs {
  windowMessages: number;
  windowTokens: number;
  minMessages: number;
  targetMessages: number;
  maxMessages: number;
  maxTokens: number;
  tickMinutes: number;
  idleCloseHours: number;
  provisionalRefreshMessages: number;
  model: string | null;
  reasoningEffort: WhatsAppLlmReasoningEffort;
  burstThresholdMessages: number | null;
  topicRegistryCap: number;
  groupWorkerPool: number;
}

export interface WhatsAppLlmChunkerGroupOverrides {
  chunkWindowMessages: number | null;
  chunkWindowTokens: number | null;
  chunkMinMessages: number | null;
  chunkTargetMessages: number | null;
  chunkMaxMessages: number | null;
  chunkMaxTokens: number | null;
  chunkTickMinutes: number | null;
  chunkIdleCloseHours: number | null;
  chunkProvisionalRefreshMessages: number | null;
  chunkModel: string | null;
  chunkReasoningEffort: string | null;
  chunkBurstThresholdMessages: number | null;
  chunkTopicRegistryCap: number | null;
  chunkGroupWorkerPool: number | null;
}

export interface WhatsAppBackfillGraphKnobs {
  pageMessages: number;
  pageTokens: number;
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
  defaultLlmKnobs?: Partial<WhatsAppLlmChunkerKnobs>;
  llmGenerate?: WhatsAppLlmGenerate;
  onOpenChunkShrunk?: (indexedFileId: string) => Promise<void>;
}

interface ChunkWhatsAppGroupsOptions {
  db: Kysely<DB>;
  groups: WhatsAppGroupIndexingConfig[];
  logger: Logger;
  now?: Date;
  claimStaleMs?: number;
  onConversationClaimed?: (conversationId: number) => Promise<void>;
  defaultKnobs?: Partial<WhatsAppChunkerKnobs>;
  defaultLlmKnobs?: Partial<WhatsAppLlmChunkerKnobs>;
  llmGenerate?: WhatsAppLlmGenerate;
  onOpenChunkShrunk?: (indexedFileId: string) => Promise<void>;
  backfillGraphKnobs?: Partial<WhatsAppBackfillGraphKnobs>;
  onBackfillConversationClaimed?: (conversationId: number) => Promise<void>;
  onBackfillSlicesInserted?: (rangeId: string) => Promise<void>;
}

type WhatsAppLlmGenerate = (
  prompt: string,
  opts: {
    model: string | null;
    reasoningEffort: WhatsAppLlmReasoningEffort;
    maxTokens?: number;
    label?: string;
  },
) => Promise<string>;

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

function positiveInteger(value: number | null | undefined): number | undefined {
  return value != null && Number.isInteger(value) && value > 0 ? value : undefined;
}

function resolvePositiveInteger(
  groupValue: number | null | undefined,
  defaultValue: number | undefined,
  builtInValue: number,
): number {
  return positiveInteger(groupValue) ?? positiveInteger(defaultValue) ?? builtInValue;
}

function resolveModel(groupValue: string | null | undefined, defaultValue: string | null | undefined): string | null {
  const model = groupValue?.trim() || defaultValue?.trim();
  return model || null;
}

function resolveReasoningEffort(
  groupValue: string | null | undefined,
  defaultValue: WhatsAppLlmReasoningEffort | undefined,
): WhatsAppLlmReasoningEffort {
  if (groupValue === "low" || groupValue === "medium" || groupValue === "high") return groupValue;
  return defaultValue ?? DEFAULT_WHATSAPP_LLM_CHUNK_REASONING_EFFORT;
}

export function resolveWhatsAppLlmChunkerKnobs(
  group: WhatsAppGroupIndexingConfig & Partial<WhatsAppLlmChunkerGroupOverrides>,
  defaults: Partial<WhatsAppLlmChunkerKnobs> = {},
): WhatsAppLlmChunkerKnobs {
  return {
    windowMessages: resolvePositiveInteger(
      group.chunkWindowMessages,
      defaults.windowMessages,
      DEFAULT_WHATSAPP_LLM_CHUNK_WINDOW_MESSAGES,
    ),
    windowTokens: resolvePositiveInteger(
      group.chunkWindowTokens,
      defaults.windowTokens,
      DEFAULT_WHATSAPP_LLM_CHUNK_WINDOW_TOKENS,
    ),
    minMessages: resolvePositiveInteger(
      group.chunkMinMessages,
      defaults.minMessages,
      DEFAULT_WHATSAPP_LLM_CHUNK_MIN_MESSAGES,
    ),
    targetMessages: resolvePositiveInteger(
      group.chunkTargetMessages,
      defaults.targetMessages,
      DEFAULT_WHATSAPP_LLM_CHUNK_TARGET_MESSAGES,
    ),
    maxMessages: resolvePositiveInteger(
      group.chunkMaxMessages,
      defaults.maxMessages,
      DEFAULT_WHATSAPP_LLM_CHUNK_MAX_MESSAGES,
    ),
    maxTokens: resolvePositiveInteger(group.chunkMaxTokens, defaults.maxTokens, DEFAULT_WHATSAPP_LLM_CHUNK_MAX_TOKENS),
    tickMinutes: resolvePositiveInteger(
      group.chunkTickMinutes,
      defaults.tickMinutes,
      DEFAULT_WHATSAPP_LLM_CHUNK_TICK_MINUTES,
    ),
    idleCloseHours: resolvePositiveInteger(
      group.chunkIdleCloseHours,
      defaults.idleCloseHours,
      DEFAULT_WHATSAPP_LLM_CHUNK_IDLE_CLOSE_HOURS,
    ),
    provisionalRefreshMessages: resolvePositiveInteger(
      group.chunkProvisionalRefreshMessages,
      defaults.provisionalRefreshMessages,
      DEFAULT_WHATSAPP_LLM_CHUNK_PROVISIONAL_REFRESH_MESSAGES,
    ),
    model: resolveModel(group.chunkModel, defaults.model),
    reasoningEffort: resolveReasoningEffort(group.chunkReasoningEffort, defaults.reasoningEffort),
    burstThresholdMessages:
      positiveInteger(group.chunkBurstThresholdMessages) ?? positiveInteger(defaults.burstThresholdMessages) ?? null,
    topicRegistryCap: resolvePositiveInteger(
      group.chunkTopicRegistryCap,
      defaults.topicRegistryCap,
      DEFAULT_WHATSAPP_LLM_CHUNK_TOPIC_REGISTRY_CAP,
    ),
    groupWorkerPool: resolvePositiveInteger(
      group.chunkGroupWorkerPool,
      defaults.groupWorkerPool,
      DEFAULT_WHATSAPP_LLM_CHUNK_GROUP_WORKER_POOL,
    ),
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
  openFirstMessageId?: number,
): Promise<WhatsAppChunkerMessage[]> {
  const lowerBound = cursorReceivedAtLowerBound(cursor);
  const open = await createConversationSlicesRepository(db).getOpenSlice(conversationId);
  const historyStartId = open?.first_message_id ?? openFirstMessageId;
  let query = db
    .selectFrom("conversation_messages")
    .select(["id", "provider_message_id", "is_bot", "text", "attachments", "provider_timestamp", "received_at"])
    .where("conversation_id", "=", conversationId);
  query = query.where((eb) =>
    eb.or([
      eb.and([eb("source", "=", "live"), ...(lowerBound ? [eb("received_at", ">", lowerBound)] : [])]),
      ...(historyStartId !== undefined ? [eb.and([eb("source", "=", "history"), eb("id", ">=", historyStartId)])] : []),
    ]),
  );
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

async function runLlmChunkingWithBackoff(
  options: ChunkWhatsAppGroupOptions,
  params: Parameters<typeof runLlmChunkingPass>[1],
): Promise<Awaited<ReturnType<typeof runLlmChunkingPass>>> {
  if (!options.llmGenerate) return { windowsProcessed: 0, slicesClosed: 0, openSliceId: null };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runLlmChunkingPass(
        {
          db: options.db,
          logger: options.logger,
          generate: options.llmGenerate,
          now: () => (options.now ?? new Date()).getTime(),
          onOpenChunkShrunk:
            options.onOpenChunkShrunk ??
            ((indexedFileId) => purgeConversationalFactsForFile(options.db, indexedFileId)),
        },
        params,
      );
    } catch (error) {
      if (!isRetryableProviderError(error) || attempt >= 2) throw error;
      const waitMs = Math.min(100 * 2 ** attempt, 1000);
      options.logger.warn({ groupJid: params.groupJid, attempt: attempt + 1, waitMs }, "WhatsApp LLM provider backoff");
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function chunkWhatsAppGroup(options: ChunkWhatsAppGroupOptions): Promise<WhatsAppChunkerRunSummary> {
  const { db, group, logger } = options;
  const now = options.now ?? new Date();
  const conversation = await findGroupConversation(db, group.jid);
  if (!conversation) return emptyRunSummary();
  const repo = createConversationSlicesRepository(db);
  const knobs = resolveWhatsAppLlmChunkerKnobs(group, options.defaultLlmKnobs);
  const openBeforeIdleClose = await repo.getOpenSlice(conversation.id);
  await evaluateIdleClose(
    {
      db,
      logger,
      generate: options.llmGenerate ?? (async () => ""),
      now: () => now.getTime(),
      onOpenChunkShrunk: options.onOpenChunkShrunk,
    },
    { conversationId: conversation.id, knobs, mode: "live" },
  );
  const coordinationToken = randomUUID();
  const coordinated = await repo.claimCursor({
    conversationId: conversation.id,
    claimToken: coordinationToken,
    now: now.toISOString(),
    staleBefore: new Date(now.getTime() - (options.claimStaleMs ?? DEFAULT_CLAIM_STALE_MS)).toISOString(),
  });
  if (!coordinated) return emptyRunSummary();
  try {
    await options.onConversationClaimed?.(conversation.id);
    const enabledGroup = await db
      .selectFrom("whatsapp_groups")
      .select("index_enabled")
      .where("jid", "=", group.jid)
      .executeTakeFirst();
    if (enabledGroup?.index_enabled !== 1) return emptyRunSummary();
  } finally {
    await repo.releaseCursorClaim({ conversationId: conversation.id, claimToken: coordinationToken });
  }
  const cursor = await repo.getCursor(conversation.id);
  if (!cursor) return emptyRunSummary();
  const messages = await listMessagesAfterCursor(
    db,
    conversation.id,
    cursor,
    now,
    openBeforeIdleClose?.first_message_id,
  );
  const denoisedMessages = messages.filter(isIndexableWhatsAppChunkMessage);
  const lateArrivals = await countLateArrivals(db, conversation.id, cursor, now);
  if (lateArrivals > 0) logger.info({ conversationId: conversation.id, lateArrivals }, "late_arrival_skipped");
  if (denoisedMessages.length === 0 || !options.llmGenerate) {
    return { ...emptyRunSummary(), conversationsProcessed: 1, lateArrivals };
  }

  const lastAttemptMs = group.chunkLastLlmAttemptAt ? Date.parse(group.chunkLastLlmAttemptAt) : Number.NaN;
  const open = await repo.getOpenSlice(conversation.id);
  const burstThreshold = knobs.burstThresholdMessages ?? Math.max(1, knobs.windowMessages - (open?.message_count ?? 0));
  if (
    Number.isFinite(lastAttemptMs) &&
    now.getTime() - lastAttemptMs < knobs.tickMinutes * MINUTE_MS &&
    denoisedMessages.length < burstThreshold
  ) {
    return emptyRunSummary();
  }

  await db
    .updateTable("whatsapp_groups")
    .set({ chunk_last_llm_attempt_at: now.toISOString() })
    .where("jid", "=", group.jid)
    .where("index_enabled", "=", 1)
    .execute();

  try {
    const result = await runLlmChunkingWithBackoff(options, {
      conversationId: conversation.id,
      groupJid: group.jid,
      knobs,
      mode: "live",
      pendingMessageIds: messages.map((message) => message.id),
    });
    return {
      conversationsProcessed: 1,
      slicesCreated: result.slicesClosed,
      lateArrivals,
      messagesProcessed: messages.length,
      maxAgeFlushes: 0,
      maxSizeFlushes: 0,
    };
  } catch (error) {
    logger.warn({ err: error, conversationId: conversation.id, groupJid: group.jid }, "WhatsApp LLM chunking failed");
    return emptyRunSummary();
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

async function isBackfillRangeCovered(
  db: Kysely<DB>,
  conversationId: number,
  rangeId: string,
  cursor: ConversationSliceCursorRow,
): Promise<boolean> {
  if (cursor.last_effective_at === null || cursor.last_message_id === null) return false;
  const next = await db
    .selectFrom("conversation_messages")
    .select(["id", "effective_at"])
    .where("conversation_id", "=", conversationId)
    .where("source", "=", "history")
    .where("backfill_range_id", "=", rangeId)
    .where("effective_at", "is not", null)
    .where((eb) =>
      eb.or([
        eb("effective_at", ">", cursor.last_effective_at as string),
        eb.and([
          eb("effective_at", "=", cursor.last_effective_at as string),
          eb("id", ">", cursor.last_message_id as number),
        ]),
      ]),
    )
    .executeTakeFirst();
  if (next) return false;

  const messages = await db
    .selectFrom("conversation_messages")
    .select(["id", "provider_message_id", "text", "attachments", "effective_at", "is_bot"])
    .where("conversation_id", "=", conversationId)
    .where("source", "=", "history")
    .where("backfill_range_id", "=", rangeId)
    .where("effective_at", "is not", null)
    .execute();
  const slices = await db
    .selectFrom("conversation_slices")
    .select(["status", "first_message_id", "last_message_id", "started_at", "ended_at"])
    .where("conversation_id", "=", conversationId)
    .execute();
  return messages
    .filter((message) =>
      isIndexableWhatsAppChunkMessage({
        id: message.id,
        providerMessageId: message.provider_message_id,
        effectiveAt: message.effective_at as string,
        text: message.text,
        attachments: message.attachments,
        isBot: message.is_bot === 1,
      }),
    )
    .every((message) =>
      slices.some((slice) => {
        const inSpan =
          message.id >= slice.first_message_id &&
          message.id <= slice.last_message_id &&
          (message.effective_at as string) >= slice.started_at &&
          (message.effective_at as string) <= slice.ended_at;
        const inClosedSlice = slice.status === "closed" && inSpan;
        const inOpenTail = slice.status === "open" && inSpan;
        return inClosedSlice || inOpenTail;
      }),
    );
}

function resolveWhatsAppBackfillGraphKnobs(
  overrides: Partial<WhatsAppBackfillGraphKnobs> = {},
): WhatsAppBackfillGraphKnobs {
  return {
    pageMessages: overrides.pageMessages ?? DEFAULT_WHATSAPP_BACKFILL_GRAPH_PAGE_MESSAGES,
    pageTokens: overrides.pageTokens ?? DEFAULT_WHATSAPP_BACKFILL_GRAPH_PAGE_TOKENS,
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

async function admitWhatsAppBackfillGraphChat(input: {
  db: Kysely<DB>;
  group: WhatsAppGroupIndexingConfig;
  conversationId: number;
  rangeId: string;
  pageLimit: number;
  pageTokenLimit: number;
  now: Date;
  logger: Logger;
  claimStaleMs?: number;
  defaultLlmKnobs?: Partial<WhatsAppLlmChunkerKnobs>;
  llmGenerate?: WhatsAppLlmGenerate;
  onOpenChunkShrunk?: (indexedFileId: string) => Promise<void>;
  onBackfillConversationClaimed?: (conversationId: number) => Promise<void>;
  onBackfillSlicesInserted?: (rangeId: string) => Promise<void>;
}): Promise<WhatsAppBackfillGraphChatResult> {
  const nowIso = input.now.toISOString();
  let page: {
    groupJid: string;
    rows: Array<{
      id: number;
      provider_message_id: string;
      is_bot: number;
      text: string;
      attachments: string | null;
      effective_at: string | null;
    }>;
  };
  try {
    page = await input.db.transaction().execute(async (trx) => {
      let rangeQuery = trx.selectFrom("whatsapp_backfill_ranges").selectAll().where("id", "=", input.rangeId);
      if (isPg(trx)) rangeQuery = rangeQuery.forUpdate();
      const range = await rangeQuery.executeTakeFirst();
      if (!range || !["complete", "exhausted"].includes(range.status) || range.graph_completed_at) {
        throw new ConversationSliceClaimLostError();
      }
      if (range.parent_range_id) {
        const parent = await trx
          .selectFrom("whatsapp_backfill_ranges")
          .select("graph_completed_at")
          .where("id", "=", range.parent_range_id)
          .executeTakeFirst();
        if (!parent?.graph_completed_at) throw new ConversationSliceClaimLostError();
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
      const boundedRows = await pageQuery
        .orderBy("effective_at", "asc")
        .orderBy("id", "asc")
        .limit(input.pageLimit)
        .execute();
      const rows: typeof boundedRows = [];
      let pageTokens = 0;
      for (const row of boundedRows) {
        const rowTokens = estimateTokens(row.text);
        if (rows.length > 0 && pageTokens + rowTokens > input.pageTokenLimit) break;
        rows.push(row);
        pageTokens += rowTokens;
      }
      return { groupJid: range.group_jid, rows };
    });
  } catch (error) {
    if (error instanceof WhatsAppBackfillGraphInvariantError) {
      await createWhatsAppBackfillRangeRepository(input.db).haltGraphAdmission(input.group.jid, error.message, nowIso);
      input.logger.error(
        { err: error, groupJid: error.groupJid, conversationId: input.conversationId, rangeId: error.rangeId },
        "Halted WhatsApp backfill graph admission after invariant failure",
      );
    }
    if (error instanceof ConversationSliceClaimLostError || error instanceof WhatsAppBackfillGraphInvariantError) {
      return { claimed: false, messagesRead: 0, slicesCreated: 0, rangeCompleted: false };
    }
    throw error;
  }

  await input.onBackfillConversationClaimed?.(input.conversationId);
  await evaluateIdleClose(
    {
      db: input.db,
      logger: input.logger,
      generate: input.llmGenerate ?? (async () => ""),
      now: () => input.now.getTime(),
      onOpenChunkShrunk: input.onOpenChunkShrunk,
    },
    {
      conversationId: input.conversationId,
      knobs: resolveWhatsAppLlmChunkerKnobs(input.group, input.defaultLlmKnobs),
      mode: "backfill",
    },
  );
  if (page.rows.length === 0) {
    const completed = await input.db
      .updateTable("whatsapp_backfill_ranges")
      .set({ graph_completed_at: nowIso, updated_at: nowIso })
      .where("id", "=", input.rangeId)
      .where("status", "in", ["complete", "exhausted"])
      .where("graph_completed_at", "is", null)
      .executeTakeFirst();
    await input.db
      .updateTable("whatsapp_backfill_checkpoints")
      .set({ graph_last_served_at: nowIso, updated_at: nowIso })
      .where("group_jid", "=", page.groupJid)
      .where("graph_halted_at", "is", null)
      .execute();
    return {
      claimed: true,
      messagesRead: 0,
      slicesCreated: 0,
      rangeCompleted: Number(completed.numUpdatedRows ?? 0) === 1,
    };
  }
  const llmResult = await runLlmChunkingWithBackoff(
    {
      db: input.db,
      group: input.group,
      logger: input.logger,
      now: input.now,
      claimStaleMs: input.claimStaleMs,
      defaultLlmKnobs: input.defaultLlmKnobs,
      llmGenerate: input.llmGenerate,
      onOpenChunkShrunk: input.onOpenChunkShrunk,
    },
    {
      conversationId: input.conversationId,
      groupJid: page.groupJid,
      knobs: resolveWhatsAppLlmChunkerKnobs(input.group, input.defaultLlmKnobs),
      mode: "backfill",
      pendingMessageIds: page.rows.map((row) => row.id),
    },
  );
  if (llmResult.skippedReason === "overlap_guard") {
    const reason = "WhatsApp LLM boundary overlapped existing slice membership";
    await createWhatsAppBackfillRangeRepository(input.db).haltGraphAdmission(input.group.jid, reason, nowIso);
    input.logger.error(
      { groupJid: input.group.jid, conversationId: input.conversationId, rangeId: input.rangeId, reason },
      "Halted WhatsApp backfill graph admission after invariant failure",
    );
    return { claimed: false, messagesRead: page.rows.length, slicesCreated: 0, rangeCompleted: false };
  }
  if (llmResult.windowsProcessed > 0) await input.onBackfillSlicesInserted?.(input.rangeId);
  const cursor = await createConversationSlicesRepository(input.db).getCursor(input.conversationId);
  if (!cursor) return { claimed: true, messagesRead: page.rows.length, slicesCreated: 0, rangeCompleted: false };

  const result = await input.db.transaction().execute(async (trx) => {
    const range = await trx
      .selectFrom("whatsapp_backfill_ranges")
      .selectAll()
      .where("id", "=", input.rangeId)
      .executeTakeFirst();
    if (!range || range.graph_completed_at) return null;
    const rangeCompleted = await isBackfillRangeCovered(trx, input.conversationId, input.rangeId, cursor);
    const next = await trx
      .selectFrom("conversation_messages")
      .select("effective_at")
      .where("conversation_id", "=", input.conversationId)
      .where("source", "=", "history")
      .where("backfill_range_id", "=", input.rangeId)
      .where("effective_at", "is not", null)
      .where((eb) =>
        eb.or([
          eb("effective_at", ">", cursor.last_effective_at as string),
          eb.and([
            eb("effective_at", "=", cursor.last_effective_at as string),
            eb("id", ">", cursor.last_message_id as number),
          ]),
        ]),
      )
      .orderBy("effective_at", "asc")
      .orderBy("id", "asc")
      .executeTakeFirst();
    const remaining = next
      ? await trx
          .selectFrom("conversation_messages")
          .select((eb) => eb.fn.countAll().as("count"))
          .where("conversation_id", "=", input.conversationId)
          .where("source", "=", "history")
          .where("backfill_range_id", "=", input.rangeId)
          .where((eb) =>
            eb.or([
              eb("effective_at", ">", cursor.last_effective_at as string),
              eb.and([
                eb("effective_at", "=", cursor.last_effective_at as string),
                eb("id", ">", cursor.last_message_id as number),
              ]),
            ]),
          )
          .executeTakeFirst()
      : null;
    await trx
      .updateTable("whatsapp_backfill_ranges")
      .set({
        graph_cursor_effective_at: cursor.last_effective_at,
        graph_cursor_message_id: cursor.last_message_id,
        graph_completed_at: rangeCompleted ? nowIso : null,
        updated_at: nowIso,
      })
      .where("id", "=", input.rangeId)
      .where("status", "in", ["complete", "exhausted"])
      .where("graph_completed_at", "is", null)
      .execute();
    await trx
      .updateTable("whatsapp_backfill_checkpoints")
      .set({ graph_last_served_at: nowIso, updated_at: nowIso })
      .where("group_jid", "=", range.group_jid)
      .where("graph_halted_at", "is", null)
      .execute();
    return {
      groupJid: range.group_jid,
      remainingMessages: Number(remaining?.count ?? 0),
      backlogOldestEffectiveAt: next?.effective_at ?? null,
      rangeCompleted,
    };
  });
  if (!result) return { claimed: true, messagesRead: page.rows.length, slicesCreated: 0, rangeCompleted: false };
  input.logger.info(
    {
      groupJid: result.groupJid,
      conversationId: input.conversationId,
      rangeId: input.rangeId,
      messagesRead: page.rows.length,
      slicesCreated: llmResult.slicesClosed,
      remainingMessages: result.remainingMessages,
      rangeCompleted: result.rangeCompleted,
      cursorEffectiveAt: cursor.last_effective_at,
      cursorMessageId: cursor.last_message_id,
      backlogAgeSeconds: result.backlogOldestEffectiveAt
        ? Math.max(0, Math.floor((input.now.getTime() - Date.parse(result.backlogOldestEffectiveAt)) / 1000))
        : 0,
    },
    "Admitted WhatsApp backfill history into context graph slices",
  );
  return {
    claimed: true,
    messagesRead: page.rows.length,
    slicesCreated: llmResult.slicesClosed,
    rangeCompleted: result.rangeCompleted,
  };
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
  const rangeRepo = createWhatsAppBackfillRangeRepository(options.db);

  while (messagesRead < knobs.cycleMessages) {
    const candidate = await rangeRepo.findNextGraphCandidate({
      groupJids: [...groupsByJid.keys()],
      excludedGroupJids: servedGroupJids,
    });
    if (!candidate) break;
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
    const group = groupsByJid.get(candidate.range.group_jid);
    if (!group) break;
    const result = await admitWhatsAppBackfillGraphChat({
      db: options.db,
      group,
      conversationId: candidate.conversationId,
      rangeId: candidate.range.id,
      pageLimit: Math.min(knobs.pageMessages, knobs.cycleMessages - messagesRead),
      pageTokenLimit: knobs.pageTokens,
      now: options.now ?? new Date(),
      logger: options.logger,
      claimStaleMs: options.claimStaleMs,
      defaultLlmKnobs: options.defaultLlmKnobs,
      llmGenerate: options.llmGenerate,
      onOpenChunkShrunk: options.onOpenChunkShrunk,
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
  const results: WhatsAppChunkerRunSummary[] = [];
  const groupWorkerPool = Math.max(
    1,
    ...options.groups.map((group) => resolveWhatsAppLlmChunkerKnobs(group, options.defaultLlmKnobs).groupWorkerPool),
  );
  await runWithConcurrency(options.groups, groupWorkerPool, async (group) => {
    const result = await chunkWhatsAppGroup({ ...options, group });
    results.push(result);
  });

  for (const result of results) {
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
