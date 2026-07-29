import type { Expression, Kysely } from "kysely";
import { type CrossConversationSearchMessage, createConversationRepository } from "../../db/repositories/conversations";
import type { DB } from "../../db/schema";
import { parseSlackRosterSnapshot } from "../../slack/identity-resolution";
import { normalizeWhatsAppIdentityPhone } from "../../whatsapp/identity-resolution";
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
}

/**
 * Raw history uses provider membership rather than knowledge-index ACLs.
 * Slack fails closed when live membership cannot be checked. WhatsApp prefers
 * a complete live roster and falls back to the last persisted roster when the
 * provider is unavailable or returns ambiguous participant identities.
 */
export async function resolveChatHistoryAccessIdentity(deps: SketchMcpDeps): Promise<ChatHistoryAccessIdentity> {
  if (!deps.currentUserId || !deps.userRepo) {
    return { slackUserId: null, whatsappPhone: null };
  }
  const user = await deps.userRepo.findById(deps.currentUserId);
  return {
    slackUserId: user?.slack_user_id?.trim() || null,
    whatsappPhone: normalizeWhatsAppIdentityPhone(user?.whatsapp_number ?? null),
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

type WhatsAppMembershipDecision = "member" | "not-member" | "ambiguous";

const MEMBERSHIP_CHECK_CONCURRENCY = 4;

function phoneFromParticipantJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  return normalizeWhatsAppIdentityPhone(whatsappJidToPhoneE164(jid));
}

async function mapAuthorizedConversations(
  rows: ConversationAccessRow[],
  check: (row: ConversationAccessRow) => Promise<boolean>,
): Promise<number[]> {
  const authorized: number[] = [];
  for (let offset = 0; offset < rows.length; offset += MEMBERSHIP_CHECK_CONCURRENCY) {
    const batch = rows.slice(offset, offset + MEMBERSHIP_CHECK_CONCURRENCY);
    const decisions = await Promise.all(batch.map(async (row) => ({ id: row.id, allowed: await check(row) })));
    for (const decision of decisions) {
      if (decision.allowed) authorized.push(decision.id);
    }
  }
  return authorized;
}

export class ChatHistoryAccessResolver {
  private readonly slackDecisions = new Map<string, Promise<boolean>>();
  private readonly whatsappDecisions = new Map<string, Promise<boolean>>();
  private readonly identity: Promise<ChatHistoryAccessIdentity>;

  constructor(private readonly deps: SketchMcpDeps) {
    this.identity = resolveChatHistoryAccessIdentity(deps);
  }

  async hasUsableIdentity(): Promise<boolean> {
    const identity = await this.identity;
    return Boolean(identity.slackUserId || identity.whatsappPhone);
  }

  async isConversationAuthorized(conversationId: number): Promise<boolean> {
    if (!this.deps.db || !this.deps.currentUserId) return false;
    if (this.deps.conversationContext?.conversationId === conversationId) return true;
    const row = await this.deps.db
      .selectFrom("conversations")
      .select(["id", "platform", "kind", "provider_conversation_id as providerConversationId"])
      .where("id", "=", conversationId)
      .executeTakeFirst();
    if (!row) return false;
    return this.isConversationRowAuthorized(row);
  }

  async authorizedConversationIds(platform?: ChatSearchPlatform): Promise<number[]> {
    if (!this.deps.db || !this.deps.currentUserId) return [];
    let query = this.deps.db
      .selectFrom("conversations")
      .select(["id", "platform", "kind", "provider_conversation_id as providerConversationId"])
      .where((eb) =>
        eb.or([
          eb.and([eb("platform", "=", "slack"), eb("kind", "=", "channel")]),
          eb.and([eb("platform", "=", "whatsapp"), eb("kind", "=", "group")]),
        ]),
      );
    if (platform) query = query.where("platform", "=", platform);
    const rows = await query.execute();
    return mapAuthorizedConversations(rows, (row) => this.isConversationRowAuthorized(row));
  }

  private async isConversationRowAuthorized(row: ConversationAccessRow): Promise<boolean> {
    if (row.platform === "slack" && row.kind === "channel") {
      return this.cachedDecision(this.slackDecisions, row.providerConversationId, () =>
        this.resolveSlackMembership(row.providerConversationId),
      );
    }
    if (row.platform === "whatsapp" && row.kind === "group") {
      return this.cachedDecision(this.whatsappDecisions, row.providerConversationId, () =>
        this.resolveWhatsAppMembership(row.providerConversationId),
      );
    }
    return false;
  }

  private cachedDecision(
    cache: Map<string, Promise<boolean>>,
    key: string,
    resolve: () => Promise<boolean>,
  ): Promise<boolean> {
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = resolve().catch(() => false);
    cache.set(key, pending);
    return pending;
  }

  private async resolveSlackMembership(channelId: string): Promise<boolean> {
    const identity = await this.identity;
    const slack = this.deps.getSlack?.() ?? null;
    if (!identity.slackUserId || !slack) return false;
    try {
      return await slack.isUserInChannel(channelId, identity.slackUserId);
    } catch {
      return false;
    }
  }

  private async resolveWhatsAppMembership(groupJid: string): Promise<boolean> {
    if (!this.deps.db) return false;
    const identity = await this.identity;
    if (!identity.whatsappPhone) return false;
    const fallback = await this.hasPersistedWhatsAppMembership(groupJid, identity.whatsappPhone);
    let provider: ReturnType<NonNullable<SketchMcpDeps["getWhatsApp"]>> = null;
    try {
      provider = this.deps.getWhatsApp?.() ?? null;
    } catch {
      return fallback;
    }
    if (!provider) return fallback;
    const decision = await this.resolveProviderWhatsAppMembership(provider, groupJid, identity.whatsappPhone);
    return decision === "ambiguous" ? fallback : decision === "member";
  }

  private async hasPersistedWhatsAppMembership(groupJid: string, phone: string): Promise<boolean> {
    if (!this.deps.db) return false;
    const row = await this.deps.db
      .selectFrom("whatsapp_group_participants")
      .select("participant_jid")
      .where("group_jid", "=", groupJid)
      .where("phone_e164", "=", phone)
      .executeTakeFirst();
    return row !== undefined;
  }

  private async resolveProviderWhatsAppMembership(
    provider: NonNullable<ReturnType<NonNullable<SketchMcpDeps["getWhatsApp"]>>>,
    groupJid: string,
    requesterPhone: string,
  ): Promise<WhatsAppMembershipDecision> {
    let metadata: Awaited<ReturnType<typeof provider.groupMetadata>>;
    try {
      metadata = await provider.groupMetadata(groupJid, { refresh: true });
    } catch {
      return "ambiguous";
    }
    if (!metadata || metadata.id !== groupJid || metadata.participants.length === 0) return "ambiguous";

    let complete = metadata.participantIdentityComplete === true;
    let matched = false;
    for (const participant of metadata.participants) {
      let participantPhone =
        normalizeWhatsAppIdentityPhone(participant.phoneE164) ?? phoneFromParticipantJid(participant.jid);
      if (!participantPhone) {
        const lid = participant.lid ?? (participant.jid.endsWith("@lid") ? participant.jid : null);
        if (lid) {
          try {
            const phoneJid = await provider.resolveLid(lid);
            participantPhone = phoneJid ? phoneFromParticipantJid(phoneJid) : null;
          } catch {
            participantPhone = null;
          }
        }
      }
      if (!participantPhone) {
        complete = false;
        continue;
      }
      if (participantPhone === requesterPhone) matched = true;
    }
    if (matched) return "member";
    return complete ? "not-member" : "ambiguous";
  }
}

export async function isChatHistoryConversationAuthorized(
  deps: SketchMcpDeps,
  conversationId: number,
  access = new ChatHistoryAccessResolver(deps),
): Promise<boolean> {
  return access.isConversationAuthorized(conversationId);
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
 * Availability contract: all_chats is authorized purely by the requesting
 * user's provider membership and is allowed from any run context including
 * shared channels and groups. Slack requires a live membership confirmation.
 * WhatsApp uses a complete live roster when available and otherwise retains
 * the last-known roster across disconnects or loss of bot group access; a
 * complete live roster that omits the requester revokes access. Results may
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
  access = new ChatHistoryAccessResolver(deps),
): Promise<AllChatsSearchOutcome> {
  if (!deps.db) {
    return { ok: false, message: "Cross-chat search is not available in this run." };
  }
  if (!deps.currentUserId) {
    return { ok: false, message: "Cross-chat search requires an authenticated requesting user." };
  }
  if (!(await access.hasUsableIdentity())) {
    return {
      ok: false,
      message: "Cross-chat search requires a linked Slack or WhatsApp account.",
    };
  }

  const [authorizedConversationIds, currentConversationId] = await Promise.all([
    access.authorizedConversationIds(args.platform),
    hasCurrentConversation(deps.db, deps.conversationContext?.conversationId, args.platform),
  ]);

  const currentMessageId = deps.conversationContext?.currentMessageId;
  const effectiveBeforeMessageId =
    args.beforeMessageId && currentMessageId
      ? Math.min(args.beforeMessageId, currentMessageId)
      : (args.beforeMessageId ?? currentMessageId);

  const conversationRepo = deps.conversationRepo ?? createConversationRepository(deps.db);
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
