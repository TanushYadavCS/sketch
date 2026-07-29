import { type Expression, type Kysely, sql } from "kysely";
import { type CrossConversationSearchMessage, createConversationRepository } from "../../db/repositories/conversations";
import type { DB } from "../../db/schema";
import { parseSlackRosterSnapshot } from "../../slack/identity-resolution";
import { normalizeWhatsAppIdentityPhone } from "../../whatsapp/identity-resolution";
import { sanitizeWhatsAppDisplayText } from "../../whatsapp/privacy";
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
  | {
      ok: true;
      body: {
        messages: Array<Record<string, unknown>>;
        hasMore: boolean;
        noMatchMeaning?: string;
      };
    }
  | { ok: false; message: string };

export interface ChatHistoryAccessIdentity {
  verifiedEmails: string[];
  whatsappPhone: string | null;
}

/**
 * Slack membership is keyed by verified email, while WhatsApp membership is
 * keyed by the authenticated user's normalized WhatsApp number. The pooled
 * getAllEmailsForUser includes an unverified primary address, so it must not
 * unlock membership-scoped chat content.
 */
export async function resolveChatHistoryAccessIdentity(deps: SketchMcpDeps): Promise<ChatHistoryAccessIdentity> {
  if (!deps.currentUserId || !deps.userRepo) {
    return { verifiedEmails: [], whatsappPhone: null };
  }
  const [emails, user] = await Promise.all([
    deps.userRepo.getVerifiedEmailsForUser?.(deps.currentUserId) ?? Promise.resolve([]),
    deps.userRepo.findById(deps.currentUserId),
  ]);
  return {
    verifiedEmails: [...new Set(emails.map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0))],
    whatsappPhone: normalizeWhatsAppIdentityPhone(user?.whatsapp_number ?? null),
  };
}

/**
 * Raw chat-history authorization is deliberately independent of knowledge
 * indexing. Slack uses the current channel-membership ACL cache maintained by
 * reconciliation. WhatsApp uses the current synced participant roster
 * directly, so index_enabled and the existence or state of slices/indexed
 * files cannot grant or deny access.
 *
 * Tenancy invariant: conversations carry no tenant/connector dimension, so
 * this predicate is sound only under one-database-per-tenant with singleton
 * Slack/WhatsApp system connectors.
 */
export function authorizedSearchableConversationIds(
  db: Kysely<DB>,
  identity: ChatHistoryAccessIdentity,
  platform?: ChatSearchPlatform,
): Expression<unknown> {
  const slackArm = db
    .selectFrom("conversations")
    .innerJoin("access_scopes", "access_scopes.provider_scope_id", "conversations.provider_conversation_id")
    .innerJoin("access_scope_members", "access_scope_members.access_scope_id", "access_scopes.id")
    .select("conversations.id")
    .distinct()
    .where("conversations.platform", "=", "slack")
    .where("conversations.kind", "=", "channel")
    .where("access_scopes.scope_type", "=", "slack_channel")
    .where("access_scope_members.email", "in", identity.verifiedEmails.length > 0 ? identity.verifiedEmails : [""]);

  const whatsappArm = db
    .selectFrom("conversations")
    .innerJoin(
      "whatsapp_group_participants",
      "whatsapp_group_participants.group_jid",
      "conversations.provider_conversation_id",
    )
    .select("conversations.id")
    .distinct()
    .where("conversations.platform", "=", "whatsapp")
    .where("conversations.kind", "=", "group")
    .where("whatsapp_group_participants.phone_e164", "=", identity.whatsappPhone ?? "");

  if (platform === "slack") return slackArm;
  if (platform === "whatsapp") return whatsappArm;
  return slackArm.union(whatsappArm);
}

export async function isChatHistoryConversationAuthorized(
  deps: SketchMcpDeps,
  conversationId: number,
): Promise<boolean> {
  if (!deps.db || !deps.currentUserId) return false;
  if (deps.conversationContext?.conversationId === conversationId) return true;
  const identity = await resolveChatHistoryAccessIdentity(deps);
  if (identity.verifiedEmails.length === 0 && !identity.whatsappPhone) return false;
  const row = await deps.db
    .selectFrom("conversations")
    .select("id")
    .where("id", "=", conversationId)
    .where(sql<boolean>`conversations.id IN (${authorizedSearchableConversationIds(deps.db, identity)})`)
    .executeTakeFirst();
  return row !== undefined;
}

interface ConversationRenderGroup {
  platform: string;
  kind: string;
  displayName: string | null;
  messages: CrossConversationSearchMessage[];
}

/**
 * conversations.display_name for a WhatsApp group can hold the raw group JID
 * until the first metadata refresh, so group names are resolved from
 * whatsapp_groups (the sync-refreshed source reconciliation also labels scopes
 * from) and sanitized, with a generic fallback. The stored display_name is
 * never rendered for groups.
 */
async function loadWhatsAppGroupName(db: Kysely<DB>, conversationId: number): Promise<string | null> {
  const row = await db
    .selectFrom("conversations")
    .innerJoin("whatsapp_groups", "whatsapp_groups.jid", "conversations.provider_conversation_id")
    .select("whatsapp_groups.name")
    .where("conversations.id", "=", conversationId)
    .executeTakeFirst();
  return row?.name ?? null;
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
      const groupName = await loadWhatsAppGroupName(db, conversationId);
      const groupConversation = {
        ...conversation,
        name: sanitizeWhatsAppDisplayText(groupName ?? "") || "WhatsApp group",
      };
      const roster = parseWhatsAppGroupRosterSnapshot(
        (await loadLatestRosterSnapshot(db, conversationId)) ?? EMPTY_WHATSAPP_ROSTER,
      );
      const core = renderWhatsAppGroupHistoryMessages(roster, group.messages);
      group.messages.forEach((message, index) => {
        renderedById.set(message.id, { ...core[index], conversation: groupConversation });
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
 * user's current provider membership and is allowed from any run context
 * including shared channels and groups. Product decision 2026-07-21: current
 * membership grants access to retained history; removal revokes it. Results may
 * surface in shared destinations because the caller's membership is the sole
 * boundary, matching how the user could quote the same content by hand. Runs
 * without an authenticated requesting user are denied.
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
  const identity = await resolveChatHistoryAccessIdentity(deps);
  if (identity.verifiedEmails.length === 0 && !identity.whatsappPhone) {
    return {
      ok: false,
      message: "Cross-chat search requires a verified Slack email or linked WhatsApp number.",
    };
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
    authorizedConversationIds: authorizedSearchableConversationIds(deps.db, identity, args.platform),
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
      ...(result.messages.length === 0
        ? {
            noMatchMeaning:
              "No matching messages were found in chats authorized for this requester. This does not prove that matching messages were never persisted or that inaccessible chats contain no matches.",
          }
        : {}),
    },
  };
}
