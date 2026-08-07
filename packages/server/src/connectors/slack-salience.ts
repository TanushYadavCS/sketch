import { createHash, randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import type { Logger } from "pino";
import { createConnectorRepository } from "../db/repositories/connectors";
import { type ConversationSliceRow, createConversationSlicesRepository } from "../db/repositories/conversation-slices";
import type { DB } from "../db/schema";
import {
  type SlackRosterSnapshot,
  accessPrincipalsFromRoster,
  parseSlackRosterSnapshot,
  resolveSlackChannelRoster,
} from "../slack/identity-resolution";
import type { SlackIndexingFacade } from "../slack/indexing-facade";
import type { GeminiGenerator } from "./gemini-generate";
import { SLACK_CONVERSATION_SLICE_FILE_TYPE, type SyncedItem } from "./types";
import { type WhatsAppSalienceVerdict, parseWhatsAppSalienceResponse } from "./whatsapp-salience";

export const DEFAULT_SLACK_SALIENCE_BATCH_LIMIT = 50;
export const SLACK_EMISSION_REFRESH_DAYS = 7;
export const SLACK_SALIENCE_PROMPT_VERSION = "slack-salience-v1";

const SALIENCE_CLAIM_STALE_MS = 15 * 60_000;
const MENTION_TOKEN_PATTERN = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/g;

export interface SlackSalienceRunSummary {
  batchLimit: number;
  pendingConsidered: number;
  judged: number;
  kept: number;
  dropped: number;
  failures: number;
}

export interface SlackSalienceOptions {
  db: Kysely<DB>;
  logger: Logger;
  facade: SlackIndexingFacade;
  generator: GeminiGenerator | null;
  batchLimit?: number;
}

interface SlackSliceContext {
  slice: ConversationSliceRow;
  conversationId: number;
  channelId: string;
  channelName: string;
}

interface RenderedSlackSlice {
  rosterBlock: string;
  transcript: string;
  content: string;
  roster: SlackRosterSnapshot;
  serializedRoster: string;
  accessPrincipals: ReturnType<typeof accessPrincipalsFromRoster>;
}

function emptySummary(batchLimit: number): SlackSalienceRunSummary {
  return { batchLimit, pendingConsidered: 0, judged: 0, kept: 0, dropped: 0, failures: 0 };
}

function stableContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Slack rendering fails closed on membership: a slice's id range interleaves
 * channel and thread rows, so the WhatsApp range fallback would leak text
 * belonging to other slices into the verdict and the indexed file.
 */
function requireMembership(slice: ConversationSliceRow): number[] {
  if (!slice.denoised_message_ids) {
    throw new Error(`Slack slice ${slice.id} has no message membership; refusing range fallback`);
  }
  const parsed = JSON.parse(slice.denoised_message_ids);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((value) => Number.isInteger(value))) {
    throw new Error(`Slack slice ${slice.id} has invalid message membership`);
  }
  return parsed as number[];
}

function resolveMentionTokens(text: string, displayNameBySlackId: Map<string, string>): string {
  return text.replace(MENTION_TOKEN_PATTERN, (_match, slackUserId: string) => {
    const name = displayNameBySlackId.get(slackUserId);
    return name ? `@${name}` : "@unknown";
  });
}

async function listSliceContexts(
  db: Kysely<DB>,
  where: "pending" | "kept",
  limit: number | null,
  refreshedAfter?: string,
): Promise<SlackSliceContext[]> {
  let query = db
    .selectFrom("conversation_slices")
    .innerJoin("conversations", "conversations.id", "conversation_slices.conversation_id")
    .selectAll("conversation_slices")
    .select(["conversations.provider_conversation_id", "conversations.display_name"])
    .where("conversations.platform", "=", "slack")
    .where("conversations.kind", "=", "channel");

  query =
    where === "pending"
      ? query.where("conversation_slices.salience_verdict", "is", null)
      : query.where("conversation_slices.salience_verdict", "=", "kept");
  if (where === "pending") {
    /**
     * A claim left behind by a failed attempt is retry backoff: rows inside
     * the stale window are excluded so they don't occupy batch slots, and
     * never-attempted rows (empty coalesce sorts first) are judged before
     * retries so persistent failures cannot starve fresh slices.
     */
    const staleBefore = new Date(Date.now() - SALIENCE_CLAIM_STALE_MS).toISOString();
    query = query
      .where((eb) =>
        eb.or([
          eb("conversation_slices.salience_claimed_at", "is", null),
          eb("conversation_slices.salience_claimed_at", "<", staleBefore),
        ]),
      )
      .orderBy(sql`coalesce(conversation_slices.salience_claimed_at, '')`, "asc");
  }
  if (where === "kept" && refreshedAfter) {
    query = query.where((eb) =>
      eb.or([
        eb("conversation_slices.indexed_file_id", "is", null),
        eb("conversation_slices.ended_at", ">", refreshedAfter),
      ]),
    );
  }
  query = query.orderBy("conversation_slices.ended_at", "asc");
  if (limit !== null) query = query.limit(limit);

  const rows = await query.execute();
  return rows.map((row) => {
    const { provider_conversation_id, display_name, ...slice } = row;
    return {
      slice: slice as ConversationSliceRow,
      conversationId: slice.conversation_id,
      channelId: provider_conversation_id,
      channelName: display_name ?? provider_conversation_id,
    };
  });
}

async function loadThreadRootLine(
  db: Kysely<DB>,
  context: SlackSliceContext,
  displayNames: Map<string, string>,
): Promise<string | null> {
  if (!context.slice.provider_thread_id) return null;
  const root = await db
    .selectFrom("conversation_messages")
    .select(["sender_name", "text"])
    .where("conversation_id", "=", context.conversationId)
    .where("provider_message_id", "=", context.slice.provider_thread_id)
    .where("is_thread_reply", "=", 0)
    .executeTakeFirst();
  if (!root) return null;
  return `Thread root by ${root.sender_name}: ${resolveMentionTokens(root.text, displayNames)}`;
}

async function renderSlackSlice(
  db: Kysely<DB>,
  facade: SlackIndexingFacade,
  context: SlackSliceContext,
  logger: Logger,
): Promise<RenderedSlackSlice> {
  const membership = requireMembership(context.slice);
  const rows = await db
    .selectFrom("conversation_messages")
    .select(["id", "sender_name", "sender_jid", "text", "provider_timestamp", "received_at"])
    .where("conversation_id", "=", context.conversationId)
    .where("id", "in", membership)
    .orderBy("id", "asc")
    .execute();
  if (rows.length !== membership.length) {
    logger.warn(
      { sliceId: context.slice.id, expected: membership.length, loaded: rows.length },
      "Slack slice membership loaded fewer messages than recorded",
    );
  }

  const existingRoster = parseSlackRosterSnapshot(context.slice.roster_snapshot);
  const roster =
    existingRoster ??
    (await resolveSlackChannelRoster({
      db,
      facade,
      channelId: context.channelId,
      channelName: context.channelName,
      logger,
    }));

  const displayNames = new Map(roster.participants.map((p) => [p.slackUserId, p.displayName]));
  const channelLine = `Channel: #${context.channelName}`;
  const rosterBlock = [
    channelLine,
    "Participants:",
    ...roster.participants.map((participant) => {
      const kindLabel =
        participant.kind === "teammate" ? "teammate" : participant.kind === "entity" ? "CRM contact" : "external";
      return `- ${participant.displayName} (${kindLabel})`;
    }),
  ].join("\n");

  const rootLine = await loadThreadRootLine(db, context, displayNames);
  const transcriptLines = rows.map((row) => {
    const senderName = displayNames.get(row.sender_jid) ?? row.sender_name;
    const timestamp = row.provider_timestamp ?? row.received_at;
    return `[${timestamp}] ${senderName}: ${resolveMentionTokens(row.text, displayNames)}`;
  });
  const transcript = [...(rootLine ? [rootLine, ""] : []), ...transcriptLines].join("\n");

  /**
   * Stored content is transcript-only (plus the channel header), matching the
   * email/Fireflies convention: participant rosters stay out of the body so
   * they never pollute embeddings or the entity extractor. The full roster
   * block still feeds the salience prompt, and ACLs come from the roster
   * snapshot, so nothing downstream loses identity context.
   */
  return {
    rosterBlock,
    transcript,
    content: `${channelLine}\n\n${transcript}`,
    roster,
    serializedRoster: JSON.stringify(roster),
    accessPrincipals: accessPrincipalsFromRoster(roster),
  };
}

function renderPrompt(input: { rosterBlock: string; transcript: string }): string {
  return [
    `You judge whether a Slack channel conversation slice is worth indexing into an org knowledge base. Prompt version: ${SLACK_SALIENCE_PROMPT_VERSION}.`,
    "",
    "Keep a slice when it contains at least one of: a decision, a commitment (someone agreeing to do something), a substantive question, or discussion of named people, companies, or projects.",
    "Drop slices that are only small talk, greetings, emoji chatter, scheduling back-and-forth with no outcome, or bot noise.",
    "",
    input.rosterBlock,
    "",
    "Transcript:",
    input.transcript,
    "",
    'Respond with JSON only: {"salient": boolean, "signals": ["decision"|"commitment"|"question"|"named_entity"], "entities": [{"name": string, "type": "person"|"company"|"project"}]}',
  ].join("\n");
}

function serializedSignals(verdict: WhatsAppSalienceVerdict): string {
  return JSON.stringify({
    promptVersion: SLACK_SALIENCE_PROMPT_VERSION,
    signals: verdict.signals,
    entities: verdict.entities,
  });
}

/**
 * Slack Web API errors carry the platform code in `data.error`. These codes
 * mean the bot can no longer see the channel (left, kicked, or the channel was
 * archived), so every retry would fail identically.
 */
function isChannelInaccessibleError(err: unknown): boolean {
  const code = (err as { data?: { error?: string } } | null)?.data?.error;
  return code === "channel_not_found" || code === "not_in_channel" || code === "is_archived";
}

async function processPendingSlice(
  options: SlackSalienceOptions,
  context: SlackSliceContext,
): Promise<"lost" | "kept" | "dropped"> {
  const claimToken = randomUUID();
  const now = new Date();
  const repo = createConversationSlicesRepository(options.db);
  const claimed = await repo.claimSalienceIfPending(context.slice.id, {
    claimToken,
    now: now.toISOString(),
    staleBefore: new Date(now.getTime() - SALIENCE_CLAIM_STALE_MS).toISOString(),
  });
  if (!claimed) return "lost";

  try {
    const rendered = await renderSlackSlice(options.db, options.facade, context, options.logger);
    if (!options.generator) {
      throw new Error("Slack salience gate requires an enrichment generator");
    }
    const parsed = await options.generator.generateJSON<unknown>(
      renderPrompt({ rosterBlock: rendered.rosterBlock, transcript: rendered.transcript }),
      { maxTokens: 1024, label: `slackSalience:${context.slice.id}` },
    );
    const verdict = parseWhatsAppSalienceResponse(parsed);
    const updated = await repo.updateSalienceVerdictIfClaimed(context.slice.id, claimToken, {
      verdict: verdict.salient ? "kept" : "dropped",
      signals: serializedSignals(verdict),
      rosterSnapshot: rendered.serializedRoster,
    });
    if (!updated) return "lost";
    return verdict.salient ? "kept" : "dropped";
  } catch (err) {
    /**
     * Membership is the opt-in: a slice whose channel the bot can no longer
     * see must not be indexed, so it is dead-lettered as dropped instead of
     * retrying forever. Any other failure keeps the claim in place — the
     * stale-claim window doubles as retry backoff, and the pending listing
     * skips backed-off rows so persistent failures cannot monopolize the
     * batch.
     */
    if (isChannelInaccessibleError(err)) {
      options.logger.warn(
        { err, sliceId: context.slice.id, channelId: context.channelId },
        "Slack salience dead-lettered slice: channel no longer accessible",
      );
      const updated = await repo.updateSalienceVerdictIfClaimed(context.slice.id, claimToken, {
        verdict: "dropped",
        signals: JSON.stringify({
          promptVersion: SLACK_SALIENCE_PROMPT_VERSION,
          droppedReason: "channel_inaccessible",
        }),
      });
      return updated ? "dropped" : "lost";
    }
    throw err;
  }
}

export async function processSlackSalience(options: SlackSalienceOptions): Promise<SlackSalienceRunSummary> {
  const batchLimit = Math.max(1, options.batchLimit ?? DEFAULT_SLACK_SALIENCE_BATCH_LIMIT);
  const summary = emptySummary(batchLimit);
  const pending = await listSliceContexts(options.db, "pending", batchLimit);
  summary.pendingConsidered = pending.length;

  if (!options.generator && pending.length > 0) {
    summary.failures = pending.length;
    options.logger.warn(
      { pendingSlices: pending.length },
      "Slack salience gate skipped: no enrichment generator configured; slices remain pending",
    );
    return summary;
  }

  for (const context of pending) {
    try {
      const result = await processPendingSlice(options, context);
      if (result === "lost") continue;
      summary.judged += 1;
      if (result === "kept") summary.kept += 1;
      if (result === "dropped") summary.dropped += 1;
    } catch (err) {
      summary.failures += 1;
      options.logger.warn(
        { err, sliceId: context.slice.id, conversationId: context.conversationId },
        "Slack salience gate failed; slice remains pending",
      );
    }
  }

  options.logger.info(summary, "Completed Slack salience gate run");
  return summary;
}

function formatTimeRange(slice: ConversationSliceRow): string {
  return slice.started_at === slice.ended_at ? slice.started_at : `${slice.started_at} to ${slice.ended_at}`;
}

function sourcePathForSlice(context: SlackSliceContext): string {
  const params = new URLSearchParams({
    conversationId: String(context.conversationId),
    channelId: context.channelId,
    firstMessageId: String(context.slice.first_message_id),
    lastMessageId: String(context.slice.last_message_id),
    ...(context.slice.provider_thread_id ? { threadTs: context.slice.provider_thread_id } : {}),
  });
  return `slack://slice/${context.slice.id}?${params.toString()}`;
}

/**
 * Requeued slices (migration 155 cleared their indexed_file_id) still own a
 * live file row keyed by provider_file_id = slice id. Without the fallback
 * lookup, a slice whose channel no longer resolves any teammate would leave
 * that old file active under stale ACLs forever.
 */
async function findSliceFileId(db: Kysely<DB>, sliceId: string): Promise<string | null> {
  const row = await db
    .selectFrom("indexed_files")
    .select("id")
    .where("provider_file_id", "=", sliceId)
    .where("file_type", "=", SLACK_CONVERSATION_SLICE_FILE_TYPE)
    .where("is_archived", "=", 0)
    .executeTakeFirst();
  return row?.id ?? null;
}

async function archiveLinkedSliceFileIfPresent(db: Kysely<DB>, context: SlackSliceContext): Promise<void> {
  const indexedFileId = context.slice.indexed_file_id ?? (await findSliceFileId(db, context.slice.id));
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

/**
 * Emits kept Slack slices as SyncedItems. The roster is re-resolved at
 * emission so the access scope reflects current channel membership, not
 * membership at judgment time. Emission-time teammate emails are retained as
 * capture audit stamps; current scope membership is the read-time access grant.
 */
export async function* emitSlackSyncedItems(options: {
  db: Kysely<DB>;
  logger: Logger;
  facade: SlackIndexingFacade;
  emissionRefreshDays?: number;
  now?: Date;
  onSkippedNoScope?: () => void;
  slackEntitySyncEnabled?: boolean;
}): AsyncGenerator<SyncedItem> {
  const refreshDays = options.emissionRefreshDays ?? SLACK_EMISSION_REFRESH_DAYS;
  const now = options.now ?? new Date();
  const refreshedAfter = new Date(now.getTime() - refreshDays * 24 * 60 * 60_000).toISOString();
  const kept = await listSliceContexts(options.db, "kept", null, refreshedAfter);
  const rosterCache = new Map<string, SlackRosterSnapshot>();

  for (const context of kept) {
    let roster = rosterCache.get(context.channelId);
    if (!roster) {
      try {
        roster = await resolveSlackChannelRoster({
          db: options.db,
          facade: options.facade,
          channelId: context.channelId,
          channelName: context.channelName,
          logger: options.logger,
        });
      } catch (err) {
        options.logger.warn({ err, channelId: context.channelId }, "Slack emission roster resolution failed");
        continue;
      }
      rosterCache.set(context.channelId, roster);
    }

    const serializedRoster = JSON.stringify(roster);
    if (serializedRoster !== context.slice.roster_snapshot) {
      await options.db
        .updateTable("conversation_slices")
        .set({ roster_snapshot: serializedRoster })
        .where("id", "=", context.slice.id)
        .execute();
      context.slice = { ...context.slice, roster_snapshot: serializedRoster };
    }

    const accessPrincipals = accessPrincipalsFromRoster(roster);
    if (accessPrincipals.length === 0) {
      await archiveLinkedSliceFileIfPresent(options.db, context);
      options.onSkippedNoScope?.();
      options.logger.warn(
        { sliceId: context.slice.id, channelId: context.channelId },
        "Skipped Slack slice indexing because no teammate access scope resolved",
      );
      continue;
    }

    let rendered: RenderedSlackSlice;
    try {
      rendered = await renderSlackSlice(options.db, options.facade, context, options.logger);
    } catch (err) {
      options.logger.warn({ err, sliceId: context.slice.id }, "Slack slice render failed; skipping emission");
      continue;
    }

    yield {
      providerFileId: context.slice.id,
      providerUrl: null,
      fileName: `Slack: #${context.channelName} - ${formatTimeRange(context.slice)}`,
      fileType: SLACK_CONVERSATION_SLICE_FILE_TYPE,
      contentCategory: "document",
      content: rendered.content,
      sourcePath: sourcePathForSlice(context),
      contentHash: stableContentHash(rendered.content),
      sourceCreatedAt: context.slice.started_at,
      sourceUpdatedAt: context.slice.ended_at,
      threadId: String(context.conversationId),
      accessScope: {
        scopeType: "slack_channel",
        providerScopeId: context.channelId,
        label: `#${context.channelName}`,
        members: rendered.accessPrincipals,
      },
      accessPrincipals:
        options.slackEntitySyncEnabled === false
          ? undefined
          : rendered.accessPrincipals.filter((principal) => principal.type === "email"),
    };
  }
}

/**
 * Membership reconciliation independent of content emission. Without this a
 * quiet channel outside the re-emission window would retain a departed
 * teammate's access indefinitely, and a channel the bot was removed from
 * would keep serving its indexed slices forever.
 */
/**
 * Disconnect handling archives indexed channel files when the bot can no
 * longer verify channel membership.
 */
export async function archiveAllSlackChannelFiles(options: {
  db: Kysely<DB>;
  logger: Logger;
  connectorConfigId: string;
  slackEntitySyncEnabled?: boolean;
}): Promise<number> {
  const repo = createConnectorRepository(options.db);
  const scopes = await repo.listAccessScopesForConnector(options.connectorConfigId, "slack_channel");
  if (scopes.length === 0) return 0;
  const filesArchived = await repo.archiveFilesForAccessScopes(scopes.map((scope) => scope.id));
  if (filesArchived > 0) {
    options.logger.info({ filesArchived }, "Archived Slack slices: Slack is disconnected");
  }
  return filesArchived;
}

/**
 * Propagates a channel rename into stored state: updates the conversation
 * display name (source for slice rendering and file names) and unlinks kept
 * slices' indexed files so the next emission re-renders them under the new
 * name. Emission upserts by provider_file_id, so the existing file rows are
 * updated in place — verdicts persist and no salience re-runs. Called from the
 * live channel_name event handler and from ACL reconciliation, which covers
 * renames that happen while the bot is offline.
 */
export async function refreshSlackChannelName(options: {
  db: Kysely<DB>;
  logger: Logger;
  channelId: string;
  channelName: string;
}): Promise<boolean> {
  const conversation = await options.db
    .selectFrom("conversations")
    .select(["id", "display_name"])
    .where("platform", "=", "slack")
    .where("kind", "=", "channel")
    .where("provider_conversation_id", "=", options.channelId)
    .executeTakeFirst();
  if (!conversation || conversation.display_name === options.channelName) return false;

  await options.db
    .updateTable("conversations")
    .set({ display_name: options.channelName, updated_at: new Date().toISOString() })
    .where("id", "=", conversation.id)
    .execute();
  const unlinked = await createConversationSlicesRepository(options.db).unlinkKeptSliceFiles(conversation.id);
  options.logger.info(
    { channelId: options.channelId, channelName: options.channelName, slicesUnlinked: unlinked },
    "Refreshed Slack channel name; kept slices queued for re-emission",
  );
  return true;
}

export async function reconcileSlackChannelAcls(options: {
  db: Kysely<DB>;
  logger: Logger;
  facade: SlackIndexingFacade;
  connectorConfigId: string;
  slackEntitySyncEnabled?: boolean;
}): Promise<{ scopesRefreshed: number; scopesArchived: number; filesArchived: number }> {
  const repo = createConnectorRepository(options.db);
  const scopes = await repo.listAccessScopesForConnector(options.connectorConfigId, "slack_channel");
  if (scopes.length === 0) return { scopesRefreshed: 0, scopesArchived: 0, filesArchived: 0 };

  const visible = new Map((await options.facade.listMemberChannels()).map((channel) => [channel.id, channel.name]));
  let scopesRefreshed = 0;
  let scopesArchived = 0;
  let filesArchived = 0;
  for (const scope of scopes) {
    const channelName = visible.get(scope.providerScopeId);
    if (channelName === undefined) {
      filesArchived += await repo.archiveFilesForAccessScopes([scope.id]);
      scopesArchived += 1;
      options.logger.info(
        { channelId: scope.providerScopeId },
        "Archived Slack slices for channel no longer visible to the bot",
      );
      continue;
    }

    let roster: SlackRosterSnapshot;
    try {
      roster = await resolveSlackChannelRoster({
        db: options.db,
        facade: options.facade,
        channelId: scope.providerScopeId,
        channelName,
        logger: options.logger,
      });
    } catch (err) {
      options.logger.warn({ err, channelId: scope.providerScopeId }, "Slack ACL reconciliation roster failed");
      continue;
    }

    const accessPrincipals = accessPrincipalsFromRoster(roster);
    if (accessPrincipals.length === 0) {
      filesArchived += await repo.archiveFilesForAccessScopes([scope.id]);
      scopesArchived += 1;
      continue;
    }

    await repo.upsertAccessScope(options.connectorConfigId, {
      scopeType: "slack_channel",
      providerScopeId: scope.providerScopeId,
      label: `#${channelName}`,
      members: accessPrincipals,
    });
    scopesRefreshed += 1;

    await refreshSlackChannelName({
      db: options.db,
      logger: options.logger,
      channelId: scope.providerScopeId,
      channelName,
    });
  }

  const summary = { scopesRefreshed, scopesArchived, filesArchived };
  options.logger.info(summary, "Completed Slack channel ACL reconciliation");
  return summary;
}
