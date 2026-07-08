import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { type ConversationSliceRow, createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import type { WhatsAppGroupIndexingConfig } from "../db/repositories/whatsapp-groups";
import { createWhatsAppIdentityCandidateRepository } from "../db/repositories/whatsapp-identity-candidates";
import type { DB } from "../db/schema";
import {
  type WhatsAppRosterParticipantSnapshot,
  type WhatsAppRosterSnapshot,
  buildWhatsAppRosterSnapshot,
  normalizeWhatsAppIdentityPhone,
  stableWhatsAppParticipantJidRef,
} from "../whatsapp/identity-resolution";
import { sanitizeWhatsAppDisplayText } from "../whatsapp/privacy";
import { phoneE164ToWhatsAppJid } from "../whatsapp/provider";
import type { GeminiGenerator } from "./gemini-generate";
import type { EntitySeed, SyncedItem } from "./types";

export const DEFAULT_WHATSAPP_SALIENCE_BATCH_LIMIT = 50;
export const WHATSAPP_EMISSION_REFRESH_DAYS = 7;

const PROMPT_VERSION = "whatsapp-salience-v1";
const DAY_MS = 24 * 60 * 60 * 1000;
const SALIENCE_CLAIM_STALE_MS = 10 * 60 * 1000;
const SALIENCE_SIGNALS = new Set(["decision", "commitment", "question", "named_entity"]);
const PERSON_ENTITY_TYPES = new Set(["person", "people", "human", "individual", "contact"]);
const STRUCTURAL_ENTITY_TYPES = new Set(["company", "project", "product", "tool", "team", "deal"]);
const RAW_WHATSAPP_JID_PATTERN = /[^\s"'<>()[\]{}]+@(?:s\.whatsapp\.net|lid)\b/iu;
const RAW_CONTIGUOUS_PHONE_PATTERN = /\+?[1-9]\d{9,14}\b/u;

export type WhatsAppSalienceSignal = "decision" | "commitment" | "question" | "named_entity";

export interface WhatsAppSalienceEntity {
  name: string;
  type: string;
}

export interface WhatsAppSalienceVerdict {
  salient: boolean;
  signals: WhatsAppSalienceSignal[];
  entities: WhatsAppSalienceEntity[];
}

export interface WhatsAppSalienceRunSummary {
  pendingConsidered: number;
  judged: number;
  kept: number;
  dropped: number;
  failures: number;
  skippedNoScope: number;
  emitted: number;
  candidateObservations: number;
  batchLimit: number;
}

export interface WhatsAppSalienceOptions {
  db: Kysely<DB>;
  groups: WhatsAppGroupIndexingConfig[];
  logger: Logger;
  generator?: GeminiGenerator | null;
  batchLimit?: number;
}

export interface WhatsAppTranscriptMessage {
  id: number;
  senderJid: string;
  senderName: string;
  text: string;
}

interface SliceContext {
  slice: ConversationSliceRow;
  conversationId: number;
  groupJid: string;
  groupName: string;
}

interface RenderedSlice {
  rosterSnapshot: WhatsAppRosterSnapshot;
  serializedRosterSnapshot: string;
  rosterBlock: string;
  transcript: string;
  content: string;
  teammateEmails: string[];
}

interface PendingProcessResult {
  status: "kept" | "dropped" | "failed" | "lost";
  candidateObservations: number;
}

function emptySummary(batchLimit: number): WhatsAppSalienceRunSummary {
  return {
    pendingConsidered: 0,
    judged: 0,
    kept: 0,
    dropped: 0,
    failures: 0,
    skippedNoScope: 0,
    emitted: 0,
    candidateObservations: 0,
    batchLimit,
  };
}

function stableContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeBatchLimit(value: number | undefined): number {
  return Number.isInteger(value) && value && value > 0 ? value : DEFAULT_WHATSAPP_SALIENCE_BATCH_LIMIT;
}

function normalizeEmissionRefreshDays(value: number | undefined): number {
  return Number.isInteger(value) && value && value > 0 ? value : WHATSAPP_EMISSION_REFRESH_DAYS;
}

export function assertNoRawWhatsAppIdentifiers(value: string): void {
  if (RAW_WHATSAPP_JID_PATTERN.test(value) || RAW_CONTIGUOUS_PHONE_PATTERN.test(value)) {
    throw new Error("Rendered WhatsApp indexing content contains a raw phone or WhatsApp identifier");
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function parseDenoisedMessageIds(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.filter((value): value is number => Number.isInteger(value) && value > 0);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

async function listSliceMessages(db: Kysely<DB>, slice: ConversationSliceRow): Promise<WhatsAppTranscriptMessage[]> {
  const denoisedIds = parseDenoisedMessageIds(slice.denoised_message_ids);
  const rows = denoisedIds
    ? await db
        .selectFrom("conversation_messages")
        .select(["id", "sender_jid", "sender_name", "text"])
        .where("id", "in", denoisedIds)
        .execute()
    : await db
        .selectFrom("conversation_messages")
        .select(["id", "sender_jid", "sender_name", "text"])
        .where("conversation_id", "=", slice.conversation_id)
        .where("id", ">=", slice.first_message_id)
        .where("id", "<=", slice.last_message_id)
        .where("is_bot", "=", 0)
        .orderBy("id", "asc")
        .execute();

  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = denoisedIds
    ? denoisedIds.map((id) => byId.get(id)).filter((row): row is (typeof rows)[number] => !!row)
    : rows;
  return ordered.map((row) => ({
    id: row.id,
    senderJid: row.sender_jid,
    senderName: row.sender_name,
    text: row.text,
  }));
}

function rosterBySenderRef(snapshot: WhatsAppRosterSnapshot): Map<string, WhatsAppRosterParticipantSnapshot> {
  const out = new Map<string, WhatsAppRosterParticipantSnapshot>();
  for (const participant of snapshot.participants) {
    for (const senderRef of participant.senderJidRefs) {
      out.set(senderRef, participant);
    }
  }
  return out;
}

function renderFallbackSenderName(message: Pick<WhatsAppTranscriptMessage, "senderName">): string {
  const sanitized = sanitizeWhatsAppDisplayText(message.senderName);
  return sanitized.length > 0 ? sanitized : "External (unknown)";
}

export function renderWhatsAppTranscript(
  snapshot: WhatsAppRosterSnapshot,
  messages: WhatsAppTranscriptMessage[],
): string {
  const bySenderRef = rosterBySenderRef(snapshot);
  const lines = messages
    .map((message) => {
      const senderRef = stableWhatsAppParticipantJidRef(message.senderJid);
      const participant = bySenderRef.get(senderRef);
      const displayName = participant?.displayName ?? renderFallbackSenderName(message);
      const text = sanitizeWhatsAppDisplayText(message.text);
      if (!text) return null;
      return `${displayName}: ${text}`;
    })
    .filter((line): line is string => line !== null);
  const transcript = lines.join("\n");
  assertNoRawWhatsAppIdentifiers(transcript);
  return transcript;
}

export function renderWhatsAppRosterBlock(snapshot: WhatsAppRosterSnapshot): string {
  const lines = snapshot.participants.map((participant) => {
    const details = [participant.resolutionKind, participant.adminRole].filter((value) => Boolean(value));
    const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
    return `- ${participant.displayName}${suffix}`;
  });
  const block = ["WhatsApp roster:", ...(lines.length > 0 ? lines : ["- No roster participants captured"])].join("\n");
  assertNoRawWhatsAppIdentifiers(block);
  return block;
}

function renderPrompt(input: { rosterBlock: string; transcript: string }): string {
  return `Judge whether this frozen WhatsApp group slice should be indexed into a business context graph.

Use only the roster and transcript below. Do not summarize the slice and do not create tasks.

A slice is salient when it contains a business-relevant decision, commitment, open question, or named entity that may be useful later. Casual banter, greetings, acknowledgements, emojis, and logistics with no durable context are not salient.

Return exactly one JSON object:
{
  "salient": boolean,
  "signals": ["decision" | "commitment" | "question" | "named_entity"],
  "entities": [{ "name": string, "type": string }]
}

Allowed signals are decision, commitment, question, named_entity. Entities are mentions grounded in the transcript.

${input.rosterBlock}

Transcript:
${input.transcript}`;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error("WhatsApp salience response must be a JSON object");
}

export function parseWhatsAppSalienceResponse(value: unknown): WhatsAppSalienceVerdict {
  const record = requireRecord(value);
  if (typeof record.salient !== "boolean") {
    throw new Error("WhatsApp salience response missing boolean salient");
  }
  if (!Array.isArray(record.signals)) {
    throw new Error("WhatsApp salience response missing signals array");
  }
  const signals: WhatsAppSalienceSignal[] = [];
  for (const signal of record.signals) {
    if (typeof signal !== "string" || !SALIENCE_SIGNALS.has(signal)) {
      throw new Error("WhatsApp salience response contains an invalid signal");
    }
    signals.push(signal as WhatsAppSalienceSignal);
  }
  if (!Array.isArray(record.entities)) {
    throw new Error("WhatsApp salience response missing entities array");
  }
  const entities = record.entities.map((entity) => {
    const entityRecord = requireRecord(entity);
    if (typeof entityRecord.name !== "string" || typeof entityRecord.type !== "string") {
      throw new Error("WhatsApp salience entity must include name and type");
    }
    const name = sanitizeWhatsAppDisplayText(entityRecord.name);
    const type = entityRecord.type.trim().toLowerCase();
    if (!name || !type) throw new Error("WhatsApp salience entity name and type must be non-empty");
    return { name, type };
  });
  return { salient: record.salient, signals: uniqueStrings(signals) as WhatsAppSalienceSignal[], entities };
}

async function listPendingSliceContexts(
  db: Kysely<DB>,
  groups: WhatsAppGroupIndexingConfig[],
  limit: number,
): Promise<SliceContext[]> {
  if (groups.length === 0) return [];
  const groupByJid = new Map(groups.map((group) => [group.jid, group]));
  const rows = await db
    .selectFrom("conversation_slices")
    .innerJoin("conversations", "conversations.id", "conversation_slices.conversation_id")
    .innerJoin("whatsapp_groups", "whatsapp_groups.jid", "conversations.provider_conversation_id")
    .selectAll("conversation_slices")
    .select(["conversations.provider_conversation_id as group_jid"])
    .where("conversations.platform", "=", "whatsapp")
    .where("conversations.kind", "=", "group")
    .where("whatsapp_groups.index_enabled", "=", 1)
    .where(
      "conversations.provider_conversation_id",
      "in",
      groups.map((group) => group.jid),
    )
    .where("conversation_slices.salience_verdict", "is", null)
    .orderBy("conversation_slices.created_at", "asc")
    .orderBy("conversation_slices.id", "asc")
    .limit(limit)
    .execute();

  return rows.flatMap((row) => {
    const group = groupByJid.get(row.group_jid);
    if (!group) return [];
    return [
      {
        slice: row,
        conversationId: row.conversation_id,
        groupJid: row.group_jid,
        groupName: group.name,
      },
    ];
  });
}

/**
 * Re-emits unlinked slices plus recent linked slices. Recent linked slices refresh
 * indexed content when roster improvements add labels or CRM matches; older linked
 * slices are stable.
 */
async function listKeptSliceContexts(
  db: Kysely<DB>,
  emissionRefreshDays = WHATSAPP_EMISSION_REFRESH_DAYS,
  now = new Date(),
): Promise<SliceContext[]> {
  const refreshCutoff = new Date(
    now.getTime() - normalizeEmissionRefreshDays(emissionRefreshDays) * DAY_MS,
  ).toISOString();
  const rows = await db
    .selectFrom("conversation_slices")
    .innerJoin("conversations", "conversations.id", "conversation_slices.conversation_id")
    .innerJoin("whatsapp_groups", "whatsapp_groups.jid", "conversations.provider_conversation_id")
    .selectAll("conversation_slices")
    .select([
      "conversations.provider_conversation_id as group_jid",
      "conversations.display_name as conversation_display_name",
      "whatsapp_groups.name as group_name",
    ])
    .where("conversations.platform", "=", "whatsapp")
    .where("conversations.kind", "=", "group")
    .where("whatsapp_groups.index_enabled", "=", 1)
    .where("conversation_slices.salience_verdict", "=", "kept")
    .where((eb) =>
      eb.or([
        eb("conversation_slices.indexed_file_id", "is", null),
        eb("conversation_slices.ended_at", ">=", refreshCutoff),
      ]),
    )
    .orderBy("conversation_slices.started_at", "asc")
    .orderBy("conversation_slices.id", "asc")
    .execute();

  return rows.map((row) => ({
    slice: row,
    conversationId: row.conversation_id,
    groupJid: row.group_jid,
    groupName: row.group_name ?? row.conversation_display_name ?? "WhatsApp group",
  }));
}

async function loadTeammateEmails(db: Kysely<DB>, snapshot: WhatsAppRosterSnapshot): Promise<string[]> {
  const userIds = uniqueStrings(
    snapshot.participants
      .filter((participant) => participant.resolutionKind === "teammate" && !!participant.userId)
      .map((participant) => participant.userId as string),
  );
  if (userIds.length === 0) return [];
  const rows = await db
    .selectFrom("users")
    .select(["id", "email"])
    .where("id", "in", userIds)
    .where("email", "is not", null)
    .execute();
  return uniqueStrings(rows.map((row) => row.email?.trim().toLowerCase() ?? "").filter((email) => email.length > 0));
}

async function renderSlice(db: Kysely<DB>, context: SliceContext, logger: Logger): Promise<RenderedSlice> {
  const roster = await buildWhatsAppRosterSnapshot({
    db,
    groupJid: context.groupJid,
    conversationId: context.conversationId,
    logger,
  });
  const messages = await listSliceMessages(db, context.slice);
  const rosterBlock = renderWhatsAppRosterBlock(roster.snapshot);
  const transcript = renderWhatsAppTranscript(roster.snapshot, messages);
  const content = `${rosterBlock}\n\nTranscript:\n${transcript}`;
  assertNoRawWhatsAppIdentifiers(content);
  return {
    rosterSnapshot: roster.snapshot,
    serializedRosterSnapshot: roster.serializedSnapshot,
    rosterBlock,
    transcript,
    content,
    teammateEmails: await loadTeammateEmails(db, roster.snapshot),
  };
}

function serializedSignals(verdict: WhatsAppSalienceVerdict): string {
  return JSON.stringify({
    promptVersion: PROMPT_VERSION,
    signals: verdict.signals,
    entities: verdict.entities,
  });
}

function shouldSeedEntity(entity: WhatsAppSalienceEntity): boolean {
  if (PERSON_ENTITY_TYPES.has(entity.type)) return false;
  return STRUCTURAL_ENTITY_TYPES.has(entity.type);
}

function entitySeedsFromVerdict(sliceId: string, verdict: WhatsAppSalienceVerdict): EntitySeed[] {
  return verdict.entities.filter(shouldSeedEntity).map((entity) => {
    const sourceId = createHash("sha256")
      .update(`${sliceId}:${entity.type}:${entity.name.toLowerCase()}`)
      .digest("hex");
    return {
      name: entity.name,
      sourceType: entity.type,
      source: "whatsapp",
      sourceId: `salience:${sourceId}`,
      metadata: { origin: "whatsapp_salience", sliceId, promptVersion: PROMPT_VERSION },
    };
  });
}

async function recordUnresolvedNumberCandidates(
  db: Kysely<DB>,
  context: SliceContext,
  snapshot: WhatsAppRosterSnapshot,
): Promise<number> {
  const participants = await db
    .selectFrom("whatsapp_group_participants")
    .select(["participant_jid", "phone_e164"])
    .where("group_jid", "=", context.groupJid)
    .where("phone_e164", "is not", null)
    .execute();
  const snapshotByParticipantRef = new Map(
    snapshot.participants.map((participant) => [participant.participantJidRef, participant]),
  );
  const repo = createWhatsAppIdentityCandidateRepository(db);
  let recorded = 0;

  for (const participant of participants) {
    const phone = normalizeWhatsAppIdentityPhone(participant.phone_e164);
    if (!phone) continue;
    const participantRef = stableWhatsAppParticipantJidRef(participant.participant_jid);
    const snapshotParticipant = snapshotByParticipantRef.get(participantRef);
    if (!snapshotParticipant || snapshotParticipant.resolutionKind !== "unresolved") continue;
    const candidateRef = stableWhatsAppParticipantJidRef(phoneE164ToWhatsAppJid(phone));
    await repo.recordObservation({
      groupJid: context.groupJid,
      candidateRef,
      participantJidRef: participantRef,
      displayName: snapshotParticipant.displayName,
      sliceId: context.slice.id,
      seenAt: context.slice.ended_at,
    });
    recorded += 1;
  }

  return recorded;
}

async function processPendingSlice(
  options: WhatsAppSalienceOptions,
  context: SliceContext,
): Promise<PendingProcessResult> {
  const claimToken = randomUUID();
  const now = new Date();
  const claimed = await createConversationSlicesRepository(options.db).claimSalienceIfPending(context.slice.id, {
    claimToken,
    now: now.toISOString(),
    staleBefore: new Date(now.getTime() - SALIENCE_CLAIM_STALE_MS).toISOString(),
  });
  if (!claimed) return { status: "lost", candidateObservations: 0 };

  try {
    const rendered = await renderSlice(options.db, context, options.logger);
    if (!options.generator) {
      throw new Error("WhatsApp salience gate requires an enrichment generator");
    }
    const parsed = await options.generator.generateJSON<unknown>(
      renderPrompt({ rosterBlock: rendered.rosterBlock, transcript: rendered.transcript }),
      { maxTokens: 1024, label: `whatsappSalience:${context.slice.id}` },
    );
    const verdict = parseWhatsAppSalienceResponse(parsed);
    return await options.db.transaction().execute(async (trx) => {
      const repo = createConversationSlicesRepository(trx);
      const updated = await repo.updateSalienceVerdictIfClaimed(context.slice.id, claimToken, {
        verdict: verdict.salient ? "kept" : "dropped",
        signals: serializedSignals(verdict),
        rosterSnapshot: rendered.serializedRosterSnapshot,
      });
      if (!updated) return { status: "lost", candidateObservations: 0 };
      if (!verdict.salient) return { status: "dropped", candidateObservations: 0 };
      const candidateObservations = await recordUnresolvedNumberCandidates(trx, context, rendered.rosterSnapshot);
      return { status: "kept", candidateObservations };
    });
  } catch (err) {
    await createConversationSlicesRepository(options.db).clearSalienceClaim(context.slice.id, claimToken);
    throw err;
  }
}

function formatTimeRange(slice: ConversationSliceRow): string {
  const start = new Date(slice.started_at);
  const end = new Date(slice.ended_at);
  const startText = Number.isNaN(start.getTime()) ? slice.started_at : start.toISOString();
  const endText = Number.isNaN(end.getTime()) ? slice.ended_at : end.toISOString();
  return startText === endText ? startText : `${startText} to ${endText}`;
}

function sourcePathForSlice(context: SliceContext): string {
  const params = new URLSearchParams({
    conversationId: String(context.conversationId),
    firstMessageId: String(context.slice.first_message_id),
    lastMessageId: String(context.slice.last_message_id),
    startedAt: context.slice.started_at,
    endedAt: context.slice.ended_at,
  });
  return `whatsapp://slice/${context.slice.id}?${params.toString()}`;
}

async function syncedItemForKeptSlice(
  db: Kysely<DB>,
  context: SliceContext,
  logger: Logger,
): Promise<{ item: SyncedItem | null; skippedNoScope: boolean }> {
  const rendered = await renderSlice(db, context, logger);
  if (rendered.teammateEmails.length === 0) {
    await archiveLinkedSliceFileIfPresent(db, context);
    logger.warn(
      { sliceId: context.slice.id, conversationId: context.conversationId, groupJid: context.groupJid },
      "Skipped WhatsApp slice indexing because no teammate access scope resolved",
    );
    return { item: null, skippedNoScope: true };
  }
  const titleGroup = sanitizeWhatsAppDisplayText(context.groupName) || "WhatsApp group";
  const content = rendered.content;
  const storedSignals = context.slice.salience_signals ? JSON.parse(context.slice.salience_signals) : null;
  const verdict: WhatsAppSalienceVerdict = {
    salient: true,
    signals: Array.isArray(storedSignals?.signals) ? storedSignals.signals : [],
    entities: Array.isArray(storedSignals?.entities) ? storedSignals.entities : [],
  };
  return {
    skippedNoScope: false,
    item: {
      providerFileId: context.slice.id,
      providerUrl: null,
      fileName: `WhatsApp: ${titleGroup} - ${formatTimeRange(context.slice)}`,
      fileType: "whatsapp_conversation_slice",
      contentCategory: "document",
      content,
      sourcePath: sourcePathForSlice(context),
      contentHash: stableContentHash(content),
      sourceCreatedAt: context.slice.started_at,
      sourceUpdatedAt: context.slice.ended_at,
      threadId: String(context.conversationId),
      accessScope: {
        scopeType: "whatsapp_group",
        providerScopeId: context.groupJid,
        label: titleGroup,
        memberEmails: rendered.teammateEmails,
      },
      entitySeeds: entitySeedsFromVerdict(context.slice.id, verdict),
    },
  };
}

async function archiveLinkedSliceFileIfPresent(db: Kysely<DB>, context: SliceContext): Promise<void> {
  const indexedFileId = context.slice.indexed_file_id;
  if (!indexedFileId) return;
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("file_access").where("indexed_file_id", "=", indexedFileId).execute();
    await trx
      .updateTable("indexed_files")
      .set({ is_archived: 1, access_scope_id: null })
      .where("id", "=", indexedFileId)
      .execute();
    await trx
      .updateTable("conversation_slices")
      .set({ indexed_file_id: null })
      .where("id", "=", context.slice.id)
      .execute();
  });
}

export async function processWhatsAppSalience(options: WhatsAppSalienceOptions): Promise<WhatsAppSalienceRunSummary> {
  const batchLimit = normalizeBatchLimit(options.batchLimit);
  const summary = emptySummary(batchLimit);
  const pending = await listPendingSliceContexts(options.db, options.groups, batchLimit);
  summary.pendingConsidered = pending.length;

  for (const context of pending) {
    try {
      const result = await processPendingSlice(options, context);
      if (result.status === "lost") continue;
      summary.judged += 1;
      if (result.status === "kept") summary.kept += 1;
      if (result.status === "dropped") summary.dropped += 1;
      summary.candidateObservations += result.candidateObservations;
    } catch (err) {
      summary.failures += 1;
      options.logger.warn(
        { err, sliceId: context.slice.id, conversationId: context.conversationId },
        "WhatsApp salience gate failed; slice remains pending",
      );
    }
  }

  options.logger.info(summary, "Completed WhatsApp salience gate run");
  return summary;
}

export async function* emitWhatsAppSyncedItems(options: {
  db: Kysely<DB>;
  logger: Logger;
  emissionRefreshDays?: number;
  now?: Date;
  onSkippedNoScope?: () => void;
}): AsyncGenerator<SyncedItem> {
  const kept = await listKeptSliceContexts(options.db, options.emissionRefreshDays, options.now);
  for (const context of kept) {
    const { item, skippedNoScope } = await syncedItemForKeptSlice(options.db, context, options.logger);
    if (skippedNoScope) options.onSkippedNoScope?.();
    if (item) yield item;
  }
}
