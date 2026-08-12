import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import {
  type ConversationSliceCursorRow,
  type ConversationSliceRow,
  createConversationSlicesRepository,
} from "../db/repositories/conversation-slices";
import { createConversationTopicsRepository } from "../db/repositories/conversation-topics";
import { createWhatsAppIdentityCandidateRepository } from "../db/repositories/whatsapp-identity-candidates";
import type { DB } from "../db/schema";
import {
  buildWhatsAppRosterSnapshot,
  normalizeWhatsAppIdentityPhone,
  stableWhatsAppParticipantJidRef,
} from "../whatsapp/identity-resolution";
import { phoneE164ToWhatsAppJid } from "../whatsapp/provider";
import { estimateTokens } from "./chunking";
import {
  type WhatsAppChunkerMessage,
  type WhatsAppLlmChunkerKnobs,
  isIndexableWhatsAppChunkMessage,
} from "./whatsapp-chunker";

export type { WhatsAppLlmChunkerKnobs } from "./whatsapp-chunker";

export interface WhatsAppLlmChunkerDeps {
  db: Kysely<DB>;
  logger: Logger;
  generate: (
    prompt: string,
    opts: {
      model: string | null;
      reasoningEffort: "low" | "medium" | "high";
      maxTokens?: number;
      label?: string;
    },
  ) => Promise<string>;
  now?: () => number;
  onOpenChunkShrunk?: (indexedFileId: string) => Promise<void>;
}

export interface WhatsAppBoundarySegment {
  start: number;
  end: number;
  threads: string[];
}

export interface WhatsAppLlmBoundaryMessage extends WhatsAppChunkerMessage {
  senderName: string;
}

const CLAIM_STALE_MS = 30 * 60 * 1000;
const IDENTITY_RECORDED_MARKER = "_whatsappIdentityCandidatesRecorded";

interface SortableMessage extends WhatsAppLlmBoundaryMessage {
  effectiveMs: number;
  rawIndex: number;
}

interface RawMessageRow {
  id: number;
  provider_message_id: string;
  sender_jid: string;
  sender_name: string;
  is_bot: number;
  text: string;
  attachments: string | null;
  provider_timestamp: string | null;
  received_at: string;
  effective_at: string | null;
}

interface BoundaryWindow {
  open: ConversationSliceRow | undefined;
  cursor: ConversationSliceCursorRow;
  allRaw: SortableMessage[];
  openMessages: SortableMessage[];
  newMessages: SortableMessage[];
  messages: SortableMessage[];
}

interface PlannedBoundarySlice {
  firstMessageId: number;
  lastMessageId: number;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  denoisedMessageIds: number[];
  threads: string[];
}

interface ApplyResult {
  closed: number;
  openSliceId: string | null;
  shrunkIndexedFileId: string | null;
}

class ClaimLostError extends Error {
  constructor() {
    super("WhatsApp LLM chunking claim was lost");
  }
}

class OverlapGuardError extends Error {
  constructor() {
    super("WhatsApp LLM chunk boundary overlaps an existing effective-time slice");
  }
}

class BoundaryCoverageError extends Error {}

function nowMs(deps: WhatsAppLlmChunkerDeps): number {
  return deps.now?.() ?? Date.now();
}

function nowIso(deps: WhatsAppLlmChunkerDeps): string {
  return new Date(nowMs(deps)).toISOString();
}

function effectiveMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function effectiveAt(row: RawMessageRow): string {
  return row.effective_at ?? row.provider_timestamp ?? row.received_at;
}

function toMessage(row: RawMessageRow): WhatsAppLlmBoundaryMessage {
  return {
    id: row.id,
    providerMessageId: row.provider_message_id,
    effectiveAt: effectiveAt(row),
    text: row.text,
    attachments: row.attachments,
    isBot: row.is_bot === 1,
    senderName: row.sender_name,
  };
}

function sortMessages(messages: WhatsAppLlmBoundaryMessage[]): SortableMessage[] {
  return messages
    .map((message) => ({ ...message, effectiveMs: effectiveMs(message.effectiveAt), rawIndex: 0 }))
    .sort((left, right) => left.effectiveMs - right.effectiveMs || left.id - right.id)
    .map((message, rawIndex) => ({ ...message, rawIndex }));
}

function isAfterCursor(message: SortableMessage, cursor: ConversationSliceCursorRow): boolean {
  if (cursor.last_effective_at === null || cursor.last_message_id === null) return true;
  const cursorMs = effectiveMs(cursor.last_effective_at);
  return message.effectiveMs > cursorMs || (message.effectiveMs === cursorMs && message.id > cursor.last_message_id);
}

function parseDenoisedIds(slice: ConversationSliceRow | undefined): number[] {
  if (!slice?.denoised_message_ids) return [];
  try {
    const parsed = JSON.parse(slice.denoised_message_ids) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === "number") : [];
  } catch {
    return [];
  }
}

function sliceHasSameContent(row: ConversationSliceRow, planned: PlannedBoundarySlice): boolean {
  return (
    row.first_message_id === planned.firstMessageId &&
    row.last_message_id === planned.lastMessageId &&
    row.started_at === planned.startedAt &&
    row.ended_at === planned.endedAt &&
    row.message_count === planned.messageCount &&
    row.denoised_message_ids === JSON.stringify(planned.denoisedMessageIds)
  );
}

function normalizeThreads(threads: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const thread of threads) {
    const value = thread.trim();
    const key = value.replace(/\s+/gu, " ").toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

function parseBoundaryJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

export function validateWhatsAppBoundarySegments(raw: string, messageCount: number): WhatsAppBoundarySegment[] {
  let parsed: unknown;
  try {
    parsed = parseBoundaryJson(raw);
  } catch {
    throw new BoundaryCoverageError("response is not valid JSON");
  }

  const segments = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "segments" in parsed
      ? (parsed as { segments?: unknown }).segments
      : undefined;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new BoundaryCoverageError("response must contain a non-empty segments array");
  }

  const validated: WhatsAppBoundarySegment[] = [];
  let expectedStart = 1;
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") throw new BoundaryCoverageError("segment is not an object");
    const value = segment as { start?: unknown; end?: unknown; threads?: unknown };
    if (!Number.isInteger(value.start) || !Number.isInteger(value.end)) {
      throw new BoundaryCoverageError("segment boundaries must be integers");
    }
    if (!Array.isArray(value.threads) || value.threads.some((thread) => typeof thread !== "string")) {
      throw new BoundaryCoverageError("segment threads must be strings");
    }
    if (value.start !== expectedStart) throw new BoundaryCoverageError("segments have a gap or overlap");
    if ((value.start as number) < 1 || (value.end as number) < (value.start as number)) {
      throw new BoundaryCoverageError("segment boundaries are out of order");
    }
    if ((value.end as number) > messageCount) throw new BoundaryCoverageError("segment is out of range");
    validated.push({
      start: value.start as number,
      end: value.end as number,
      threads: normalizeThreads(value.threads),
    });
    expectedStart = (value.end as number) + 1;
  }
  if (expectedStart !== messageCount + 1) throw new BoundaryCoverageError("segments do not cover the full window");
  return validated;
}

function segmentCount(segment: WhatsAppBoundarySegment): number {
  return segment.end - segment.start + 1;
}

function mergeSegment(left: WhatsAppBoundarySegment, right: WhatsAppBoundarySegment): WhatsAppBoundarySegment {
  return {
    start: left.start,
    end: right.end,
    threads: normalizeThreads([...left.threads, ...right.threads]),
  };
}

function sharesThread(left: WhatsAppBoundarySegment, right: WhatsAppBoundarySegment): boolean {
  const rightNames = new Set(normalizeThreads(right.threads).map((thread) => thread.toLocaleLowerCase()));
  return normalizeThreads(left.threads).some((thread) => rightNames.has(thread.toLocaleLowerCase()));
}

function consolidateAdjacentSegments(
  segments: WhatsAppBoundarySegment[],
  targetMessages: number,
): WhatsAppBoundarySegment[] {
  const result: WhatsAppBoundarySegment[] = [];
  for (const segment of segments) {
    const previous = result[result.length - 1];
    if (
      previous &&
      sharesThread(previous, segment) &&
      segmentCount(previous) + segmentCount(segment) <= targetMessages
    ) {
      result[result.length - 1] = mergeSegment(previous, segment);
    } else {
      result.push(segment);
    }
  }
  return result;
}

function mergeInteriorBelowFloor(segments: WhatsAppBoundarySegment[], minMessages: number): WhatsAppBoundarySegment[] {
  const result = [...segments];
  let index = 1;
  while (index < result.length - 1) {
    if (segmentCount(result[index] as WhatsAppBoundarySegment) >= minMessages) {
      index += 1;
      continue;
    }
    const current = result[index] as WhatsAppBoundarySegment;
    const left = result[index - 1] as WhatsAppBoundarySegment;
    const right = result[index + 1] as WhatsAppBoundarySegment;
    if (sharesThread(current, left) || !sharesThread(current, right)) {
      result.splice(index - 1, 2, mergeSegment(left, current));
      index = Math.max(1, index - 1);
    } else {
      result.splice(index, 2, mergeSegment(current, right));
    }
  }
  return result;
}

function deferTailAdjacentBreak(segments: WhatsAppBoundarySegment[], minMessages: number): WhatsAppBoundarySegment[] {
  if (segments.length < 2) return segments;
  const tailAdjacentIndex = segments.length - 2;
  const tailAdjacent = segments[tailAdjacentIndex];
  const tail = segments[tailAdjacentIndex + 1];
  if (!tailAdjacent || !tail || segmentCount(tailAdjacent) >= minMessages) return segments;
  return [...segments.slice(0, tailAdjacentIndex), mergeSegment(tailAdjacent, tail)];
}

function forceSplitSegments(
  segments: WhatsAppBoundarySegment[],
  messages: SortableMessage[],
  maxMessages: number,
  maxTokens: number,
): WhatsAppBoundarySegment[] {
  const result: WhatsAppBoundarySegment[] = [];
  for (const segment of segments) {
    let start = segment.start;
    let tokens = 0;
    let count = 0;
    for (let index = segment.start; index <= segment.end; index += 1) {
      const message = messages[index - 1];
      if (!message) continue;
      const messageTokens = estimateTokens(message.text);
      const oversizedSingle = count === 0 && messageTokens > maxTokens;
      const exceeds = count > 0 && (count >= maxMessages || tokens + messageTokens > maxTokens);
      if (exceeds) {
        result.push({ start, end: index - 1, threads: [...segment.threads] });
        start = index;
        count = 0;
        tokens = 0;
      }
      count += 1;
      tokens += messageTokens;
      if (oversizedSingle) {
        result.push({ start, end: index, threads: [...segment.threads] });
        start = index + 1;
        count = 0;
        tokens = 0;
      }
    }
    if (start <= segment.end) result.push({ start, end: segment.end, threads: [...segment.threads] });
  }
  return result;
}

export function enforceWhatsAppBoundarySize(
  segments: WhatsAppBoundarySegment[],
  messages: SortableMessage[],
  knobs: Pick<WhatsAppLlmChunkerKnobs, "minMessages" | "targetMessages" | "maxMessages" | "maxTokens">,
): WhatsAppBoundarySegment[] {
  let result = consolidateAdjacentSegments(segments, knobs.targetMessages);
  result = mergeInteriorBelowFloor(result, knobs.minMessages);
  result = deferTailAdjacentBreak(result, knobs.minMessages);
  result = forceSplitSegments(result, messages, knobs.maxMessages, knobs.maxTokens);
  return result;
}

function buildPlannedSlice(
  sortedRaw: SortableMessage[],
  denoisedMessages: SortableMessage[],
  segment: WhatsAppBoundarySegment,
): PlannedBoundarySlice {
  const kept = denoisedMessages.slice(segment.start - 1, segment.end);
  const firstKept = kept[0];
  const lastKept = kept[kept.length - 1];
  if (!firstKept || !lastKept) throw new Error("Cannot build an empty WhatsApp LLM slice");
  const rawRange = sortedRaw.slice(firstKept.rawIndex, lastKept.rawIndex + 1);
  const rangeIds = rawRange.map((message) => message.id);
  return {
    firstMessageId: Math.min(...rangeIds),
    lastMessageId: Math.max(...rangeIds),
    startedAt: firstKept.effectiveAt,
    endedAt: lastKept.effectiveAt,
    messageCount: kept.length,
    denoisedMessageIds: kept.map((message) => message.id),
    threads: normalizeThreads(segment.threads),
  };
}

async function listRawMessages(db: Kysely<DB>, conversationId: number): Promise<SortableMessage[]> {
  const rows = await db
    .selectFrom("conversation_messages")
    .select([
      "id",
      "provider_message_id",
      "sender_jid",
      "sender_name",
      "is_bot",
      "text",
      "attachments",
      "provider_timestamp",
      "received_at",
      "effective_at",
    ])
    .where("conversation_id", "=", conversationId)
    .orderBy("id", "asc")
    .execute();
  return sortMessages(rows.map((row) => toMessage(row as RawMessageRow)));
}

function findOpenMessages(allRaw: SortableMessage[], open: ConversationSliceRow | undefined): SortableMessage[] {
  if (!open) return [];
  const ids = new Set(parseDenoisedIds(open));
  if (ids.size > 0) return allRaw.filter((message) => ids.has(message.id) && isIndexableWhatsAppChunkMessage(message));
  return allRaw.filter(
    (message) =>
      isIndexableWhatsAppChunkMessage(message) &&
      message.effectiveMs >= effectiveMs(open.started_at) &&
      message.effectiveMs <= effectiveMs(open.ended_at),
  );
}

function takeWindowSuffix(
  openMessages: SortableMessage[],
  newMessages: SortableMessage[],
  knobs: WhatsAppLlmChunkerKnobs,
): SortableMessage[] {
  const currentTokens = openMessages.reduce((sum, message) => sum + estimateTokens(message.text), 0);
  const suffix: SortableMessage[] = [];
  let tokens = currentTokens;
  for (const message of newMessages) {
    const nextCount = openMessages.length + suffix.length + 1;
    const nextTokens = tokens + estimateTokens(message.text);
    const overMessages = suffix.length > 0 && nextCount > knobs.windowMessages;
    const overTokens = suffix.length > 0 && nextTokens > knobs.windowTokens;
    if (overMessages || overTokens) break;
    suffix.push(message);
    tokens = nextTokens;
  }
  if (suffix.length === 0 && newMessages[0]) suffix.push(newMessages[0]);
  return suffix;
}

async function loadWindow(
  db: Kysely<DB>,
  conversationId: number,
  knobs: WhatsAppLlmChunkerKnobs,
  pendingMessageIds?: ReadonlySet<number>,
): Promise<BoundaryWindow> {
  const sliceRepo = createConversationSlicesRepository(db);
  const cursor = await sliceRepo.getCursor(conversationId);
  if (!cursor) throw new Error("WhatsApp LLM chunking cursor was not claimed");
  const open = await sliceRepo.getOpenSlice(conversationId);
  const allRaw = await listRawMessages(db, conversationId);
  const openMessages = findOpenMessages(allRaw, open);
  const newMessages = allRaw.filter(
    (message) =>
      isIndexableWhatsAppChunkMessage(message) &&
      isAfterCursor(message, cursor) &&
      (!pendingMessageIds || pendingMessageIds.has(message.id)),
  );
  const suffix = takeWindowSuffix(openMessages, newMessages, knobs);
  return {
    open,
    cursor,
    allRaw,
    openMessages,
    newMessages,
    messages: [...openMessages, ...suffix],
  };
}

function renderBoundaryPrompt(
  registry: Array<{ name: string; one_liner: string | null }>,
  messages: SortableMessage[],
  openIds: Set<number>,
): string {
  const registryBlock = registry.length
    ? registry.map((topic) => `- ${topic.name}${topic.one_liner ? ` — ${topic.one_liner}` : ""}`).join("\n")
    : "- None";
  const messageBlock = messages
    .map((message, index) => {
      const marker = openIds.has(message.id) ? "OPEN CHUNK" : "NEW";
      return `${index + 1}. [${marker}] ${message.effectiveAt} ${message.senderName}: ${message.text}`;
    })
    .join("\n");
  return [
    "You are the WhatsApp conversation boundary engine.",
    "Identify contiguous topic segments over the numbered messages.",
    "The OPEN CHUNK messages are atomic context, but its boundary may be revised.",
    'Return JSON only with ordered segments: {"segments":[{"start":1,"end":2,"threads":["topic name"]}]}.',
    "Segments must cover every message exactly once. Return boundaries and thread names only; no summaries or commentary.",
    "Topic registry:",
    registryBlock,
    "Messages:",
    messageBlock,
  ].join("\n");
}

async function generateBoundarySegments(
  deps: WhatsAppLlmChunkerDeps,
  prompt: string,
  knobs: WhatsAppLlmChunkerKnobs,
  messageCount: number,
): Promise<WhatsAppBoundarySegment[] | undefined> {
  let firstOutput = "";
  let firstError = "";
  try {
    firstOutput = await deps.generate(prompt, {
      model: knobs.model,
      reasoningEffort: knobs.reasoningEffort,
      maxTokens: 2048,
      label: "whatsappLlmBoundary",
    });
    return validateWhatsAppBoundarySegments(firstOutput, messageCount);
  } catch (error) {
    firstError = error instanceof Error ? error.message : "boundary response failed";
  }

  const repairPrompt = [
    prompt,
    "The previous response failed validation.",
    `Validation error: ${firstError}`,
    "Repair the response. Return JSON only, with contiguous in-range segments covering every message exactly once.",
    firstOutput ? `Previous response:\n${firstOutput}` : "No usable previous response was returned.",
  ].join("\n\n");
  try {
    const repairedOutput = await deps.generate(repairPrompt, {
      model: knobs.model,
      reasoningEffort: knobs.reasoningEffort,
      maxTokens: 2048,
      label: "whatsappLlmBoundaryRepair",
    });
    return validateWhatsAppBoundarySegments(repairedOutput, messageCount);
  } catch {
    return undefined;
  }
}

function cursorMatches(left: ConversationSliceCursorRow, right: ConversationSliceCursorRow): boolean {
  return left.last_effective_at === right.last_effective_at && left.last_message_id === right.last_message_id;
}

function parseSignals(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function recordIdentityCandidatesIfNeeded(
  db: Kysely<DB>,
  groupJid: string,
  slice: ConversationSliceRow,
): Promise<void> {
  const signals = parseSignals(slice.salience_signals);
  if (signals[IDENTITY_RECORDED_MARKER] === true) return;
  let roster: { participants?: Array<{ participantJidRef: string; displayName: string; resolutionKind: string }> } = {};
  try {
    const parsed = JSON.parse(slice.roster_snapshot) as unknown;
    if (parsed && typeof parsed === "object") roster = parsed as typeof roster;
  } catch {
    roster = {};
  }
  const participants = await db
    .selectFrom("whatsapp_group_participants")
    .select(["participant_jid", "phone_e164"])
    .where("group_jid", "=", groupJid)
    .where("phone_e164", "is not", null)
    .execute();
  const snapshotByParticipantRef = new Map(
    (roster.participants ?? []).map((participant) => [participant.participantJidRef, participant]),
  );
  const repo = createWhatsAppIdentityCandidateRepository(db);
  for (const participant of participants) {
    const phone = normalizeWhatsAppIdentityPhone(participant.phone_e164);
    if (!phone) continue;
    const participantRef = stableWhatsAppParticipantJidRef(participant.participant_jid);
    const snapshotParticipant = snapshotByParticipantRef.get(participantRef);
    if (!snapshotParticipant || snapshotParticipant.resolutionKind !== "unresolved") continue;
    await repo.recordObservation({
      groupJid,
      candidateRef: stableWhatsAppParticipantJidRef(phoneE164ToWhatsAppJid(phone)),
      participantJidRef: participantRef,
      displayName: snapshotParticipant.displayName,
      sliceId: slice.id,
      seenAt: slice.ended_at,
    });
  }
  await db
    .updateTable("conversation_slices")
    .set({ salience_signals: JSON.stringify({ ...signals, [IDENTITY_RECORDED_MARKER]: true }) })
    .where("id", "=", slice.id)
    .where("status", "=", "closed")
    .execute();
}

async function buildRosterSnapshot(
  deps: WhatsAppLlmChunkerDeps,
  conversationId: number,
  groupJid: string,
  fallback: string,
): Promise<string> {
  try {
    return (
      await buildWhatsAppRosterSnapshot({
        db: deps.db,
        groupJid,
        conversationId,
        logger: deps.logger,
        enrichEntityAliases: true,
      })
    ).serializedSnapshot;
  } catch {
    return fallback;
  }
}

/**
 * The candidate window is contiguous, so only slices whose raw id range or
 * effective-time span can intersect it are relevant — loading the whole
 * conversation history here would make every pass O(all slices).
 */
async function ensureNoOverlap(
  db: Kysely<DB>,
  conversationId: number,
  planned: PlannedBoundarySlice[],
  ignoredOpenId: string | undefined,
): Promise<void> {
  if (planned.length === 0) return;
  const minMessageId = Math.min(...planned.map((candidate) => candidate.firstMessageId));
  const maxMessageId = Math.max(...planned.map((candidate) => candidate.lastMessageId));
  const minStartedAt = planned.reduce(
    (min, candidate) => (candidate.startedAt < min ? candidate.startedAt : min),
    planned[0].startedAt,
  );
  const maxEndedAt = planned.reduce(
    (max, candidate) => (candidate.endedAt > max ? candidate.endedAt : max),
    planned[0].endedAt,
  );
  const existing = await db
    .selectFrom("conversation_slices")
    .selectAll()
    .where("conversation_id", "=", conversationId)
    .where((eb) =>
      eb.or([
        eb.and([eb("first_message_id", "<=", maxMessageId), eb("last_message_id", ">=", minMessageId)]),
        eb.and([eb("started_at", "<=", maxEndedAt), eb("ended_at", ">=", minStartedAt)]),
      ]),
    )
    .execute();
  for (const candidate of planned) {
    const exact = existing.find((row) => row.status === "closed" && sliceHasSameContent(row, candidate));
    if (exact) continue;
    const overlap = existing.some((row) => {
      if (row.id === ignoredOpenId || (row.status === "open" && row.id === ignoredOpenId)) return false;
      if (row.last_message_id < candidate.firstMessageId || row.first_message_id > candidate.lastMessageId)
        return false;
      return row.started_at <= candidate.endedAt && row.ended_at >= candidate.startedAt;
    });
    if (overlap) throw new OverlapGuardError();
  }
}

async function persistPlannedSlice(
  db: Kysely<DB>,
  conversationId: number,
  planned: PlannedBoundarySlice,
  rosterSnapshot: string,
  status: "open" | "closed",
): Promise<ConversationSliceRow> {
  const repo = createConversationSlicesRepository(db);
  const inserted = await repo.insertIfAbsent({
    id: randomUUID(),
    conversationId,
    firstMessageId: planned.firstMessageId,
    lastMessageId: planned.lastMessageId,
    startedAt: planned.startedAt,
    endedAt: planned.endedAt,
    messageCount: planned.messageCount,
    denoisedMessageIds: planned.denoisedMessageIds,
    flushReason: "llm_boundary",
    rosterSnapshot,
    salienceVerdict: "kept",
    status,
  });
  if (inserted.row.status !== status) throw new OverlapGuardError();
  return inserted.row;
}

async function applyBoundaryWindow(
  deps: WhatsAppLlmChunkerDeps,
  params: { conversationId: number; groupJid: string; claimToken: string },
  state: BoundaryWindow,
  segments: WhatsAppBoundarySegment[],
  knobs: WhatsAppLlmChunkerKnobs,
  rosterSnapshot: string,
): Promise<ApplyResult> {
  const sortedRaw = state.allRaw;
  const planned = segments.map((segment) => buildPlannedSlice(sortedRaw, state.messages, segment));
  const previousOpen = state.open;
  const newCursorMessage =
    state.newMessages.find((message) => message.id === state.messages[state.messages.length - 1]?.id) ??
    state.newMessages[0];
  const cursorMessage = state.messages[state.messages.length - 1];
  const applyResult = await deps.db.transaction().execute(async (trx) => {
    const sliceRepo = createConversationSlicesRepository(trx);
    const currentCursor = await sliceRepo.getCursor(params.conversationId);
    if (
      !currentCursor ||
      currentCursor.claim_token !== params.claimToken ||
      !cursorMatches(currentCursor, state.cursor)
    ) {
      throw new ClaimLostError();
    }
    const currentOpen = await sliceRepo.getOpenSlice(params.conversationId);
    if (currentOpen?.id !== previousOpen?.id) throw new ClaimLostError();
    await ensureNoOverlap(trx, params.conversationId, planned, previousOpen?.id);

    const topicRepo = createConversationTopicsRepository(trx);
    const topicIdsBySegment: string[][] = [];
    for (const item of planned) {
      const topicIds: string[] = [];
      for (const thread of item.threads) {
        const topic = await topicRepo.upsertTopic({
          conversationId: params.conversationId,
          name: thread,
          activityAt: item.endedAt,
          recordMerge: true,
        });
        topicIds.push(topic.topic.id);
      }
      topicIdsBySegment.push(topicIds);
    }

    let closed = 0;
    let openSliceId: string | null = null;
    if (planned.length === 1 && previousOpen) {
      const updated = await sliceRepo.updateOpenSlice({
        sliceId: previousOpen.id,
        firstMessageId: planned[0].firstMessageId,
        lastMessageId: planned[0].lastMessageId,
        startedAt: planned[0].startedAt,
        endedAt: planned[0].endedAt,
        messageCount: planned[0].messageCount,
        denoisedMessageIds: planned[0].denoisedMessageIds,
        rosterSnapshot,
      });
      if (!updated) throw new ClaimLostError();
      await topicRepo.replaceSliceTopics(updated.id, topicIdsBySegment[0] ?? []);
      openSliceId = updated.id;
    } else {
      for (let index = 0; index < planned.length - 1; index += 1) {
        const item = planned[index];
        if (!item) continue;
        let closedSlice: ConversationSliceRow;
        if (index === 0 && previousOpen) {
          const closedExisting = await sliceRepo.closeOpenSlice(previousOpen.id);
          if (!closedExisting) throw new ClaimLostError();
          closedSlice = {
            ...closedExisting,
            first_message_id: item.firstMessageId,
            last_message_id: item.lastMessageId,
            started_at: item.startedAt,
            ended_at: item.endedAt,
            message_count: item.messageCount,
            denoised_message_ids: JSON.stringify(item.denoisedMessageIds),
            roster_snapshot: rosterSnapshot,
          };
          const updated = await trx
            .updateTable("conversation_slices")
            .set({
              first_message_id: item.firstMessageId,
              last_message_id: item.lastMessageId,
              started_at: item.startedAt,
              ended_at: item.endedAt,
              message_count: item.messageCount,
              denoised_message_ids: JSON.stringify(item.denoisedMessageIds),
              roster_snapshot: rosterSnapshot,
            })
            .where("id", "=", previousOpen.id)
            .executeTakeFirst();
          if (Number(updated.numUpdatedRows ?? 0) !== 1) throw new ClaimLostError();
          closedSlice = (await sliceRepo.getById(previousOpen.id)) as ConversationSliceRow;
        } else {
          const existing = await trx
            .selectFrom("conversation_slices")
            .selectAll()
            .where("conversation_id", "=", params.conversationId)
            .where("first_message_id", "=", item.firstMessageId)
            .where("status", "=", "closed")
            .executeTakeFirst();
          if (existing && !sliceHasSameContent(existing, item)) throw new OverlapGuardError();
          const reusedExisting = Boolean(existing);
          closedSlice =
            existing ?? (await persistPlannedSlice(trx, params.conversationId, item, rosterSnapshot, "closed"));
          if (reusedExisting) {
            closed += 1;
            continue;
          }
        }
        await topicRepo.replaceSliceTopics(closedSlice.id, topicIdsBySegment[index] ?? []);
        await recordIdentityCandidatesIfNeeded(trx, params.groupJid, closedSlice);
        closed += 1;
      }

      const last = planned[planned.length - 1];
      if (!last) throw new Error("No final WhatsApp LLM segment");
      const insertedOpen = await persistPlannedSlice(trx, params.conversationId, last, rosterSnapshot, "open");
      await topicRepo.replaceSliceTopics(insertedOpen.id, topicIdsBySegment[planned.length - 1] ?? []);
      openSliceId = insertedOpen.id;
    }

    if (!cursorMessage || !newCursorMessage) throw new Error("WhatsApp LLM window has no new message");
    const advanced = await sliceRepo.advanceCursorIfClaimed({
      conversationId: params.conversationId,
      lastEffectiveAt: cursorMessage.effectiveAt,
      lastMessageId: cursorMessage.id,
      claimToken: params.claimToken,
    });
    if (!advanced) throw new ClaimLostError();
    const renewed = await sliceRepo.renewCursorClaim({
      conversationId: params.conversationId,
      claimToken: params.claimToken,
      now: nowIso(deps),
    });
    if (!renewed) throw new ClaimLostError();

    const finalPlanned = planned[planned.length - 1];
    if (!finalPlanned) throw new Error("No final WhatsApp LLM segment");
    const shrank =
      previousOpen?.indexed_file_id &&
      parseDenoisedIds(previousOpen).some((id) => !finalPlanned.denoisedMessageIds.includes(id))
        ? previousOpen.indexed_file_id
        : null;
    return { closed, openSliceId, shrunkIndexedFileId: shrank };
  });

  if (applyResult.shrunkIndexedFileId) await deps.onOpenChunkShrunk?.(applyResult.shrunkIndexedFileId);
  return applyResult;
}

async function advanceNoiseCursor(
  deps: WhatsAppLlmChunkerDeps,
  conversationId: number,
  claimToken: string,
  cursor: ConversationSliceCursorRow,
  message: SortableMessage,
): Promise<void> {
  await deps.db.transaction().execute(async (trx) => {
    const repo = createConversationSlicesRepository(trx);
    const current = await repo.getCursor(conversationId);
    if (!current || current.claim_token !== claimToken || !cursorMatches(current, cursor)) throw new ClaimLostError();
    const advanced = await repo.advanceCursorIfClaimed({
      conversationId,
      lastEffectiveAt: message.effectiveAt,
      lastMessageId: message.id,
      claimToken,
    });
    if (!advanced) throw new ClaimLostError();
    if (!(await repo.renewCursorClaim({ conversationId, claimToken, now: nowIso(deps) }))) throw new ClaimLostError();
  });
}

async function decideAndApply(
  deps: WhatsAppLlmChunkerDeps,
  params: { conversationId: number; groupJid: string; claimToken: string },
  state: BoundaryWindow,
  knobs: WhatsAppLlmChunkerKnobs,
): Promise<ApplyResult | undefined> {
  const openIds = new Set(state.openMessages.map((message) => message.id));
  const registry = await createConversationTopicsRepository(deps.db).listPromptRegistry(
    params.conversationId,
    state.messages[state.messages.length - 1]?.effectiveAt ?? nowIso(deps),
    knobs.topicRegistryCap,
  );
  const prompt = renderBoundaryPrompt(registry, state.messages, openIds);
  const initial = await generateBoundarySegments(deps, prompt, knobs, state.messages.length);
  if (!initial) return undefined;
  const normalized = enforceWhatsAppBoundarySize(initial, state.messages, knobs);
  const rosterSnapshot = await buildRosterSnapshot(
    deps,
    params.conversationId,
    params.groupJid,
    state.open?.roster_snapshot ?? "[]",
  );
  return applyBoundaryWindow(deps, params, state, normalized, knobs, rosterSnapshot);
}

async function findConversationId(db: Kysely<DB>, groupJid: string): Promise<number | undefined> {
  const row = await db
    .selectFrom("conversations")
    .select("id")
    .where("platform", "=", "whatsapp")
    .where("kind", "=", "group")
    .where("provider_conversation_id", "=", groupJid)
    .executeTakeFirst();
  return row?.id;
}

function emptyResult(openSliceId: string | null, skippedReason?: string) {
  return { windowsProcessed: 0, slicesClosed: 0, openSliceId, ...(skippedReason ? { skippedReason } : {}) };
}

export async function runLlmChunkingPass(
  deps: WhatsAppLlmChunkerDeps,
  params: {
    conversationId: number;
    groupJid: string;
    knobs: WhatsAppLlmChunkerKnobs;
    mode: "live" | "backfill";
    maxWindows?: number;
    pendingMessageIds?: number[];
  },
): Promise<{
  windowsProcessed: number;
  slicesClosed: number;
  openSliceId: string | null;
  skippedReason?: string;
}> {
  const actualConversationId = await findConversationId(deps.db, params.groupJid);
  if (actualConversationId !== params.conversationId) return emptyResult(null, "conversation_not_found");
  const claimToken = randomUUID();
  const claimNow = nowIso(deps);
  const claimed = await createConversationSlicesRepository(deps.db).claimCursor({
    conversationId: params.conversationId,
    claimToken,
    now: claimNow,
    staleBefore: new Date(nowMs(deps) - CLAIM_STALE_MS).toISOString(),
  });
  if (!claimed) return emptyResult(null, "claim_unavailable");

  let windowsProcessed = 0;
  let slicesClosed = 0;
  let openSliceId: string | null = null;
  let skippedReason: string | undefined;
  const maxWindows = Math.max(1, params.maxWindows ?? Number.MAX_SAFE_INTEGER);
  const pendingMessageIds = params.pendingMessageIds ? new Set(params.pendingMessageIds) : undefined;
  try {
    while (windowsProcessed < maxWindows) {
      const state = await loadWindow(deps.db, params.conversationId, params.knobs, pendingMessageIds);
      openSliceId = state.open?.id ?? null;
      const pendingRaw = state.allRaw.filter(
        (message) => isAfterCursor(message, state.cursor) && (!pendingMessageIds || pendingMessageIds.has(message.id)),
      );
      if (state.newMessages.length === 0) {
        const lastPendingRaw = pendingRaw[pendingRaw.length - 1];
        if (lastPendingRaw) {
          await advanceNoiseCursor(deps, params.conversationId, claimToken, state.cursor, lastPendingRaw);
        }
        break;
      }

      const suffix = state.messages.slice(state.openMessages.length);
      const fullState = { ...state, messages: [...state.openMessages, ...suffix] };
      const applied = await decideAndApply(
        deps,
        { conversationId: params.conversationId, groupJid: params.groupJid, claimToken },
        fullState,
        params.knobs,
      );
      if (applied) {
        windowsProcessed += 1;
        slicesClosed += applied.closed;
        openSliceId = applied.openSliceId;
        continue;
      }

      if (suffix.length <= 1) {
        skippedReason = "boundary_validation_failed";
        deps.logger.warn(
          { conversationId: params.conversationId, groupJid: params.groupJid, mode: params.mode },
          "whatsapp_llm_chunking_skipped",
        );
        break;
      }

      const splitAt = Math.ceil(suffix.length / 2);
      const firstState = { ...state, messages: [...state.openMessages, ...suffix.slice(0, splitAt)] };
      const firstApplied = await decideAndApply(
        deps,
        { conversationId: params.conversationId, groupJid: params.groupJid, claimToken },
        firstState,
        params.knobs,
      );
      if (!firstApplied) {
        skippedReason = "boundary_validation_failed";
        deps.logger.warn(
          { conversationId: params.conversationId, groupJid: params.groupJid, mode: params.mode },
          "whatsapp_llm_chunking_skipped",
        );
        break;
      }
      windowsProcessed += 1;
      slicesClosed += firstApplied.closed;
      openSliceId = firstApplied.openSliceId;
      if (windowsProcessed >= maxWindows) break;

      const secondState = await loadWindow(deps.db, params.conversationId, params.knobs, pendingMessageIds);
      const secondApplied = await decideAndApply(
        deps,
        { conversationId: params.conversationId, groupJid: params.groupJid, claimToken },
        secondState,
        params.knobs,
      );
      if (!secondApplied) {
        skippedReason = "boundary_validation_failed";
        deps.logger.warn(
          { conversationId: params.conversationId, groupJid: params.groupJid, mode: params.mode },
          "whatsapp_llm_chunking_skipped",
        );
        break;
      }
      windowsProcessed += 1;
      slicesClosed += secondApplied.closed;
      openSliceId = secondApplied.openSliceId;
    }
  } catch (error) {
    if (error instanceof ClaimLostError) skippedReason = "claim_lost";
    else if (error instanceof OverlapGuardError) skippedReason = "overlap_guard";
    else throw error;
  } finally {
    await createConversationSlicesRepository(deps.db).releaseCursorClaim({
      conversationId: params.conversationId,
      claimToken,
    });
  }
  return { windowsProcessed, slicesClosed, openSliceId, ...(skippedReason ? { skippedReason } : {}) };
}

async function nextPendingMessage(
  db: Kysely<DB>,
  conversationId: number,
  cursor: ConversationSliceCursorRow,
): Promise<SortableMessage | undefined> {
  const raw = await listRawMessages(db, conversationId);
  return raw.find((message) => isAfterCursor(message, cursor));
}

export async function evaluateIdleClose(
  deps: WhatsAppLlmChunkerDeps,
  params: { conversationId: number; knobs: WhatsAppLlmChunkerKnobs; mode: "live" | "backfill" },
): Promise<boolean> {
  const claimToken = randomUUID();
  const now = nowMs(deps);
  const claimed = await createConversationSlicesRepository(deps.db).claimCursor({
    conversationId: params.conversationId,
    claimToken,
    now: new Date(now).toISOString(),
    staleBefore: new Date(now - CLAIM_STALE_MS).toISOString(),
  });
  if (!claimed) return false;
  try {
    return await deps.db.transaction().execute(async (trx) => {
      const sliceRepo = createConversationSlicesRepository(trx);
      const cursor = await sliceRepo.getCursor(params.conversationId);
      const open = await sliceRepo.getOpenSlice(params.conversationId);
      if (!cursor || cursor.claim_token !== claimToken || !open) return false;
      const conversation = await trx
        .selectFrom("conversations")
        .select("provider_conversation_id")
        .where("id", "=", params.conversationId)
        .executeTakeFirst();
      if (!conversation) return false;
      const tailIds = parseDenoisedIds(open);
      const tailId = tailIds[tailIds.length - 1];
      if (tailId === undefined) return false;
      const tail = await trx
        .selectFrom("conversation_messages")
        .select(["effective_at", "provider_timestamp", "received_at"])
        .where("id", "=", tailId)
        .executeTakeFirst();
      if (!tail) return false;
      const tailEffective = tail.effective_at ?? tail.provider_timestamp ?? tail.received_at;
      const idleMs = params.knobs.idleCloseHours * 60 * 60 * 1000;
      const isIdle =
        params.mode === "live"
          ? now - Date.parse(tail.received_at) > idleMs
          : ((await nextPendingMessage(trx, params.conversationId, cursor))?.effectiveMs ?? Number.NaN) -
              effectiveMs(tailEffective) >
            idleMs;
      if (!isIdle) return false;
      const closed = await sliceRepo.closeOpenSlice(open.id);
      if (!closed) throw new ClaimLostError();
      await recordIdentityCandidatesIfNeeded(trx, conversation.provider_conversation_id, closed);
      return true;
    });
  } finally {
    await createConversationSlicesRepository(deps.db).releaseCursorClaim({
      conversationId: params.conversationId,
      claimToken,
    });
  }
}
