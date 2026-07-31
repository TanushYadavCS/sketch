import type { Expression, Kysely } from "kysely";
import { type CrossConversationSearchMessage, createConversationRepository } from "../../db/repositories/conversations";
import type { DB } from "../../db/schema";
import { normalizeWhatsAppIdentityLid, normalizeWhatsAppIdentityPhone } from "../../identity-normalization";
import { parseSlackRosterSnapshot } from "../../slack/identity-resolution";
import { SLACK_MEMBERSHIP_FRESHNESS_MS } from "../../slack/membership-reconciler";
import { sanitizeWhatsAppDisplayText } from "../../whatsapp/privacy";
import { whatsappJidToPhoneE164 } from "../../whatsapp/provider";
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
  slackUserId: string | null;
  whatsappPhone: string | null;
  whatsappLids: string[];
}

/**
 * The resolver only reads identity and membership, so it accepts this narrow
 * slice instead of the whole tool dependency bag. Callers that hold a full
 * SketchMcpDeps still satisfy it.
 */
export type ChatHistoryAccessDeps = Pick<SketchMcpDeps, "db" | "currentUserId" | "userRepo" | "conversationContext">;

/** A channel or group addressed by its provider ID rather than a conversations row. */
export interface ProviderTargetRef {
  platform: ChatSearchPlatform;
  targetId: string;
}

export function providerTargetKey(target: ProviderTargetRef): string {
  return `${target.platform}:${target.targetId}`;
}

export async function resolveChatHistoryAccessIdentity(
  deps: ChatHistoryAccessDeps,
): Promise<ChatHistoryAccessIdentity> {
  if (!deps.currentUserId || !deps.userRepo) {
    return { slackUserId: null, whatsappPhone: null, whatsappLids: [] };
  }
  const user = await deps.userRepo.findById(deps.currentUserId);
  const lids = deps.db
    ? await deps.db.selectFrom("user_whatsapp_lids").select("lid").where("user_id", "=", deps.currentUserId).execute()
    : [];
  return {
    slackUserId: user?.slack_user_id?.trim() || null,
    whatsappPhone: normalizeWhatsAppIdentityPhone(user?.whatsapp_number ?? null),
    whatsappLids: [
      ...new Set(
        [...(user?.whatsapp_lid ? [user.whatsapp_lid] : []), ...lids.map((row) => row.lid)]
          .map((lid) => normalizeWhatsAppIdentityLid(lid))
          .filter((lid): lid is string => lid !== null),
      ),
    ],
  };
}

export function authorizedSearchableConversationIds(db: Kysely<DB>, conversationIds: number[]): Expression<unknown> {
  return db
    .selectFrom("conversations")
    .select("conversations.id")
    .where("conversations.id", "in", conversationIds.length > 0 ? conversationIds : [-1]);
}

type ConversationAccessRow = {
  id: number;
  platform: string;
  kind: string;
  providerConversationId: string;
};

function phoneFromParticipantJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  return normalizeWhatsAppIdentityPhone(whatsappJidToPhoneE164(jid));
}

function lidFromParticipantRow(row: { participant_jid: string; lid: string | null }): string | null {
  return normalizeWhatsAppIdentityLid(row.lid ?? (row.participant_jid.endsWith("@lid") ? row.participant_jid : null));
}

export class ChatHistoryAccessResolver {
  constructor(private readonly deps: ChatHistoryAccessDeps) {}

  async hasUsableIdentity(): Promise<boolean> {
    const identity = await this.loadIdentity();
    return Boolean(identity.slackUserId || identity.whatsappPhone || identity.whatsappLids.length > 0);
  }

  async isConversationAuthorized(conversationId: number, _refresh = false): Promise<boolean> {
    if (!this.deps.db || !this.deps.currentUserId) return false;
    if (this.deps.conversationContext?.conversationId === conversationId) return true;
    return (await this.authorizedConversationIds([conversationId])).includes(conversationId);
  }

  async authorizedConversationIds(conversationIds: number[]): Promise<number[]> {
    if (!this.deps.db || !this.deps.currentUserId || conversationIds.length === 0) return [];
    const uniqueIds = [...new Set(conversationIds)];
    const rows = await this.deps.db
      .selectFrom("conversations")
      .select(["id", "platform", "kind", "provider_conversation_id as providerConversationId"])
      .where("id", "in", uniqueIds)
      .where((eb) =>
        eb.or([
          eb.and([eb("platform", "=", "slack"), eb("kind", "=", "channel")]),
          eb.and([eb("platform", "=", "whatsapp"), eb("kind", "=", "group")]),
        ]),
      )
      .execute();
    const resolved = await this.resolveRows(rows);
    return uniqueIds.filter((id) => resolved.has(id));
  }

  /**
   * Authorizes channels and groups by their provider ID, so a send target can
   * be checked before any message from it has been captured. Same membership
   * rules as the conversation-ID path: fresh Slack roster membership, or a
   * WhatsApp phone match (direct, or through one of the identity's LID aliases).
   */
  async authorizedProviderTargets(targets: ProviderTargetRef[]): Promise<Set<string>> {
    if (!this.deps.db || !this.deps.currentUserId || targets.length === 0) return new Set();
    const authorized = await this.resolveProviderIds(
      targets.filter((target) => target.platform === "slack").map((target) => target.targetId),
      targets.filter((target) => target.platform === "whatsapp").map((target) => target.targetId),
    );
    const granted = new Set<string>();
    for (const target of targets) {
      const ids = target.platform === "slack" ? authorized.slack : authorized.whatsapp;
      if (ids.has(target.targetId)) granted.add(providerTargetKey(target));
    }
    return granted;
  }

  private async resolveRows(rows: ConversationAccessRow[]): Promise<Set<number>> {
    if (!this.deps.db) return new Set();
    const slackRows = rows.filter((row) => row.platform === "slack");
    const whatsappRows = rows.filter((row) => row.platform === "whatsapp");
    const authorized = await this.resolveProviderIds(
      slackRows.map((row) => row.providerConversationId),
      whatsappRows.map((row) => row.providerConversationId),
    );

    const authorizedIds = new Set<number>();
    for (const row of slackRows) {
      if (authorized.slack.has(row.providerConversationId)) authorizedIds.add(row.id);
    }
    for (const row of whatsappRows) {
      if (authorized.whatsapp.has(row.providerConversationId)) authorizedIds.add(row.id);
    }
    return authorizedIds;
  }

  private async resolveProviderIds(
    slackChannelIds: string[],
    whatsappGroupIds: string[],
  ): Promise<{ slack: Set<string>; whatsapp: Set<string> }> {
    const slack = new Set<string>();
    const whatsapp = new Set<string>();
    if (!this.deps.db) return { slack, whatsapp };
    const identity = await this.loadIdentity();

    if (identity.slackUserId && slackChannelIds.length > 0) {
      const freshAfter = new Date(Date.now() - SLACK_MEMBERSHIP_FRESHNESS_MS).toISOString();
      const memberChannels = await this.deps.db
        .selectFrom("slack_channel_participants")
        .select("channel_id")
        .where("channel_id", "in", [...new Set(slackChannelIds)])
        .where("slack_user_id", "=", identity.slackUserId)
        .where("last_seen_at", ">=", freshAfter)
        .execute();
      for (const row of memberChannels) slack.add(row.channel_id);
    }

    if ((identity.whatsappPhone || identity.whatsappLids.length > 0) && whatsappGroupIds.length > 0) {
      const participants = await this.deps.db
        .selectFrom("whatsapp_group_participants")
        .select(["group_jid", "participant_jid", "phone_e164", "lid"])
        .where("group_jid", "in", [...new Set(whatsappGroupIds)])
        .execute();
      const aliases = new Set(identity.whatsappLids);
      for (const row of participants) {
        const matchesPhone =
          identity.whatsappPhone !== null &&
          (normalizeWhatsAppIdentityPhone(row.phone_e164) === identity.whatsappPhone ||
            phoneFromParticipantJid(row.participant_jid) === identity.whatsappPhone);
        if (matchesPhone) {
          whatsapp.add(row.group_jid);
          continue;
        }
        const lid = lidFromParticipantRow(row);
        if (lid !== null && aliases.has(lid)) whatsapp.add(row.group_jid);
      }
    }

    return { slack, whatsapp };
  }

  private loadIdentity(): Promise<ChatHistoryAccessIdentity> {
    return resolveChatHistoryAccessIdentity(this.deps);
  }
}

export async function isChatHistoryConversationAuthorized(
  deps: SketchMcpDeps,
  conversationId: number,
  access = new ChatHistoryAccessResolver(deps),
  refresh = false,
): Promise<boolean> {
  return access.isConversationAuthorized(conversationId, refresh);
}

async function hasCurrentConversation(
  db: Kysely<DB>,
  conversationId: number | undefined,
  platform: ChatSearchPlatform | undefined,
): Promise<number | undefined> {
  if (conversationId === undefined) return undefined;
  const row = await db
    .selectFrom("conversations")
    .select(["id", "platform"])
    .where("id", "=", conversationId)
    .executeTakeFirst();
  return row && (!platform || row.platform === platform) ? row.id : undefined;
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
 * Availability contract: all_chats is authorized from passive provider
 * membership snapshots and is allowed from any run context including shared
 * channels and groups. Slack snapshots expire after the reconciliation
 * validity window. WhatsApp retains the last successfully persisted roster
 * across disconnects or loss of bot group access. Results may surface in
 * shared destinations because the caller's membership is the sole boundary,
 * matching how the user could quote the same content by hand. Runs without an
 * authenticated requesting user are denied.
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
  access = new ChatHistoryAccessResolver(deps),
): Promise<AllChatsSearchOutcome> {
  if (!deps.db) {
    return { ok: false, message: "Cross-chat search is not available in this run." };
  }
  if (!deps.currentUserId) {
    return { ok: false, message: "Cross-chat search requires an authenticated requesting user." };
  }
  const currentMessageId = deps.conversationContext?.currentMessageId;
  const effectiveBeforeMessageId =
    args.beforeMessageId && currentMessageId
      ? Math.min(args.beforeMessageId, currentMessageId)
      : (args.beforeMessageId ?? currentMessageId);

  const conversationRepo = deps.conversationRepo ?? createConversationRepository(deps.db);
  const [candidateConversationIds, currentConversationId] = await Promise.all([
    conversationRepo.findMatchingConversationIds({
      query: args.query,
      platform: args.platform,
      afterMessageId: args.afterMessageId,
      beforeMessageId: effectiveBeforeMessageId,
      includeBotMessages: args.includeBotMessages,
    }),
    hasCurrentConversation(deps.db, deps.conversationContext?.conversationId, args.platform),
  ]);
  if (!currentConversationId && !(await access.hasUsableIdentity())) {
    return {
      ok: false,
      message: "Cross-chat search requires a linked Slack or WhatsApp account.",
    };
  }
  const authorizedConversationIds = await access.authorizedConversationIds(
    candidateConversationIds.filter((id) => id !== currentConversationId),
  );
  const result = await conversationRepo.searchMessagesAcrossConversations({
    query: args.query,
    authorizedConversationIds: authorizedSearchableConversationIds(deps.db, authorizedConversationIds),
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
