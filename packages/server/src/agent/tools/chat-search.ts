import type { Expression, Kysely } from "kysely";
import { type CrossConversationSearchMessage, createConversationRepository } from "../../db/repositories/conversations";
import type { DB } from "../../db/schema";
import { parseSlackRosterSnapshot } from "../../slack/identity-resolution";
import { renderSlackChannelHistoryMessages } from "./slack-channel-history";
import type { SketchMcpDeps } from "./types";
import { parseWhatsAppGroupRosterSnapshot, renderWhatsAppGroupHistoryMessages } from "./whatsapp-group-history";

export type ChatSearchPlatform = "slack" | "whatsapp";

export interface AllChatsSearchArgs {
  query: string;
  platform?: ChatSearchPlatform;
  afterMessageId?: number;
  beforeMessageId?: number;
  limit?: number;
  includeBotMessages?: boolean;
}

export type AllChatsSearchOutcome =
  | { ok: true; body: { messages: Array<Record<string, unknown>>; hasMore: boolean } }
  | { ok: false; message: string };

/**
 * Verified emails only for cross-conversation authorization: the pooled
 * getAllEmailsForUser includes an unverified primary address, which must not
 * unlock membership-scoped chat content. Existing single-conversation tools
 * are unaffected.
 */
async function resolveVerifiedUserEmails(deps: SketchMcpDeps): Promise<string[]> {
  if (!deps.currentUserId || !deps.userRepo?.getVerifiedEmailsForUser) return [];
  const emails = await deps.userRepo.getVerifiedEmailsForUser(deps.currentUserId);
  return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0))];
}

/**
 * The membership predicate, byte-for-byte the same join the two history tools
 * authorize with, evaluated at conversation granularity. A conversation is
 * searchable only while at least one live (unarchived, not shared-with-everyone)
 * indexed file links one of its slices to an access scope containing the
 * caller's verified email. This inherits every revocation path the slice layer
 * already has: roster reconciliation, Slack disconnect archival, and the
 * archive leak-class fixes from the Slack indexing review rounds.
 *
 * Tenancy invariant: conversations carry no tenant/connector dimension, so
 * this predicate is sound only under one-database-per-tenant with singleton
 * Slack/WhatsApp system connectors.
 */
export function authorizedSearchableConversationIds(
  db: Kysely<DB>,
  userEmails: string[],
  platform?: ChatSearchPlatform,
): Expression<unknown> {
  const slackArm = db
    .selectFrom("conversations")
    .innerJoin("conversation_slices", "conversation_slices.conversation_id", "conversations.id")
    .innerJoin("indexed_files", "indexed_files.id", "conversation_slices.indexed_file_id")
    .innerJoin("access_scopes", "access_scopes.id", "indexed_files.access_scope_id")
    .innerJoin("access_scope_members", "access_scope_members.access_scope_id", "access_scopes.id")
    .select("conversations.id")
    .distinct()
    .where("conversations.platform", "=", "slack")
    .where("conversations.kind", "=", "channel")
    .where("indexed_files.source", "=", "slack")
    .where("indexed_files.is_archived", "=", 0)
    .where("indexed_files.share_with_everyone", "=", 0)
    .whereRef("indexed_files.provider_file_id", "=", "conversation_slices.id")
    .where("access_scopes.scope_type", "=", "slack_channel")
    .whereRef("access_scopes.provider_scope_id", "=", "conversations.provider_conversation_id")
    .where("access_scope_members.email", "in", userEmails);

  const whatsappArm = db
    .selectFrom("conversations")
    .innerJoin("whatsapp_groups", "whatsapp_groups.jid", "conversations.provider_conversation_id")
    .innerJoin("conversation_slices", "conversation_slices.conversation_id", "conversations.id")
    .innerJoin("indexed_files", "indexed_files.id", "conversation_slices.indexed_file_id")
    .innerJoin("access_scopes", "access_scopes.id", "indexed_files.access_scope_id")
    .innerJoin("access_scope_members", "access_scope_members.access_scope_id", "access_scopes.id")
    .select("conversations.id")
    .distinct()
    .where("conversations.platform", "=", "whatsapp")
    .where("conversations.kind", "=", "group")
    .where("whatsapp_groups.index_enabled", "=", 1)
    .where("indexed_files.source", "=", "whatsapp")
    .where("indexed_files.is_archived", "=", 0)
    .where("indexed_files.share_with_everyone", "=", 0)
    .whereRef("indexed_files.provider_file_id", "=", "conversation_slices.id")
    .where("access_scopes.scope_type", "=", "whatsapp_group")
    .whereRef("access_scopes.provider_scope_id", "=", "conversations.provider_conversation_id")
    .where("access_scope_members.email", "in", userEmails);

  if (platform === "slack") return slackArm;
  if (platform === "whatsapp") return whatsappArm;
  return slackArm.union(whatsappArm);
}

interface ConversationRenderGroup {
  platform: string;
  kind: string;
  displayName: string | null;
  messages: CrossConversationSearchMessage[];
}

async function loadLatestRosterSnapshot(db: Kysely<DB>, conversationId: number): Promise<string | null> {
  const row = await db
    .selectFrom("conversation_slices")
    .select("roster_snapshot")
    .where("conversation_id", "=", conversationId)
    .where("roster_snapshot", "is not", null)
    .orderBy("ended_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.roster_snapshot ?? null;
}

const EMPTY_WHATSAPP_ROSTER = JSON.stringify({
  participants: [],
  resolutionCounts: { totalParticipants: 0, teammate: 0, entity: 0, labeled: 0, unresolved: 0 },
});

type SlackRendererRow = Parameters<typeof renderSlackChannelHistoryMessages>[1][number];

function toSlackRendererRow(message: CrossConversationSearchMessage): SlackRendererRow {
  return {
    id: message.id,
    sender_jid: message.senderJid,
    sender_name: message.senderName,
    text: message.text,
    attachments: JSON.stringify(message.attachments),
    is_thread_reply: message.isThreadReply ? 1 : 0,
    provider_thread_id: message.providerThreadId,
    provider_timestamp: message.providerTimestamp,
    received_at: message.receivedAt,
  } as SlackRendererRow;
}

function conversationRefFor(conversationId: number): string {
  return `conversation:${conversationId}`;
}

/**
 * Renders hits through the proven per-platform sanitizers (roster-backed
 * WhatsApp display names with hashed fallbacks, Slack mention resolution,
 * phone/path stripping) and adds conversation identity. Current-DM hits use
 * the same schema so origin cannot be inferred from field differences.
 * senderJid, senderUserId, provider ids, attachment paths, and numeric rank
 * are never exposed.
 */
export async function renderAllChatsSearchResults(
  db: Kysely<DB>,
  messages: CrossConversationSearchMessage[],
): Promise<Array<Record<string, unknown>>> {
  const groups = new Map<number, ConversationRenderGroup>();
  for (const message of messages) {
    const group = groups.get(message.conversationId) ?? {
      platform: message.conversationPlatform,
      kind: message.conversationKind,
      displayName: message.conversationDisplayName,
      messages: [],
    };
    group.messages.push(message);
    groups.set(message.conversationId, group);
  }

  const renderedById = new Map<number, Record<string, unknown>>();
  for (const [conversationId, group] of groups) {
    const conversation = {
      ref: conversationRefFor(conversationId),
      platform: group.platform,
      kind: group.kind,
      name: group.kind === "dm" ? "Direct chat with Sketch" : (group.displayName ?? "Unknown"),
    };
    if (group.platform === "whatsapp" && group.kind !== "dm") {
      const roster = parseWhatsAppGroupRosterSnapshot(
        (await loadLatestRosterSnapshot(db, conversationId)) ?? EMPTY_WHATSAPP_ROSTER,
      );
      const core = renderWhatsAppGroupHistoryMessages(roster, group.messages);
      group.messages.forEach((message, index) => {
        renderedById.set(message.id, { ...core[index], conversation });
      });
      continue;
    }
    if (group.platform === "slack") {
      const roster = parseSlackRosterSnapshot(await loadLatestRosterSnapshot(db, conversationId));
      const core = renderSlackChannelHistoryMessages(roster, group.messages.map(toSlackRendererRow));
      group.messages.forEach((message, index) => {
        renderedById.set(message.id, { ...core[index], conversation });
      });
      continue;
    }
    const roster = parseWhatsAppGroupRosterSnapshot(EMPTY_WHATSAPP_ROSTER);
    const core = renderWhatsAppGroupHistoryMessages(roster, group.messages);
    group.messages.forEach((message, index) => {
      renderedById.set(message.id, { ...core[index], conversation });
    });
  }

  return messages.map((message) => ({
    ...(renderedById.get(message.id) ?? {}),
    isBot: message.isBot,
    addressedToSketch: message.addressedToSketch,
  }));
}

/**
 * Availability contract: all_chats is authorized purely by the requesting
 * user's membership (currentUserId → verified emails → access scopes), and is
 * allowed from any run context including shared channels and groups. Product
 * decision 2026-07-21: results may surface in shared destinations; the caller's
 * membership is the sole boundary, matching how the user could quote the same
 * content by hand. Runs without an authenticated requesting user (no
 * currentUserId) are denied.
 *
 * The current conversation is additionally always searchable regardless of the
 * scope join: whoever triggered the run can already read it via
 * conversation-scope search, so including it (DM, channel, or group, even an
 * index-disabled WhatsApp group) discloses nothing new. The platform filter
 * still applies to it.
 */
export async function handleAllChatsSearch(
  args: AllChatsSearchArgs,
  deps: SketchMcpDeps,
): Promise<AllChatsSearchOutcome> {
  if (!deps.db) {
    return { ok: false, message: "Cross-chat search is not available in this run." };
  }
  if (!deps.currentUserId) {
    return { ok: false, message: "Cross-chat search requires an authenticated requesting user." };
  }
  const userEmails = await resolveVerifiedUserEmails(deps);
  if (userEmails.length === 0) {
    return { ok: false, message: "Cross-chat search requires a verified account email." };
  }

  let currentConversationId: number | undefined;
  const contextConversationId = deps.conversationContext?.conversationId;
  if (contextConversationId !== undefined) {
    const current = await deps.db
      .selectFrom("conversations")
      .select(["id", "platform", "kind"])
      .where("id", "=", contextConversationId)
      .executeTakeFirst();
    if (current && (!args.platform || current.platform === args.platform)) {
      currentConversationId = current.id;
    }
  }

  const currentMessageId = deps.conversationContext?.currentMessageId;
  const effectiveBeforeMessageId =
    args.beforeMessageId && currentMessageId
      ? Math.min(args.beforeMessageId, currentMessageId)
      : (args.beforeMessageId ?? currentMessageId);

  const conversationRepo = deps.conversationRepo ?? createConversationRepository(deps.db);
  const result = await conversationRepo.searchMessagesAcrossConversations({
    query: args.query,
    authorizedConversationIds: authorizedSearchableConversationIds(deps.db, userEmails, args.platform),
    currentConversationId,
    afterMessageId: args.afterMessageId,
    beforeMessageId: effectiveBeforeMessageId,
    limit: args.limit,
    includeBotMessages: args.includeBotMessages,
  });

  return {
    ok: true,
    body: {
      messages: await renderAllChatsSearchResults(deps.db, result.messages),
      hasMore: result.hasMore,
    },
  };
}
