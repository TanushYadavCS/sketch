import type { Expression, Kysely } from "kysely";
import { authorizedTargets } from "../../access/membership";
import { resolveMembershipPrincipals } from "../../access/principals";
import type { AccessPrincipal } from "../../connectors/types";
import { type CrossConversationSearchMessage, createConversationRepository } from "../../db/repositories/conversations";
import type { DB } from "../../db/schema";
import { parseSlackRosterSnapshot } from "../../slack/identity-resolution";
import { sanitizeWhatsAppDisplayText } from "../../whatsapp/privacy";
import { renderSlackChannelHistoryMessages } from "./slack-channel-history";
import type { SketchMcpDeps } from "./types";
import { parseWhatsAppGroupRosterSnapshot, renderWhatsAppGroupHistoryMessages } from "./whatsapp-group-history";

export type ChatSearchPlatform = "slack" | "whatsapp";

export interface AllChatsReadArgs {
  platform?: ChatSearchPlatform;
  afterTime?: string;
  beforeTime?: string;
  cursor?: { effectiveAt: string; messageId: number };
  snapshotBeforeMessageId?: number;
  order?: "asc" | "desc";
  limit?: number;
  includeBotMessages?: boolean;
}

export type AllChatsReadOutcome =
  | {
      ok: true;
      body: {
        messages: Array<Record<string, unknown>>;
        hasMore: boolean;
        nextCursor?: { effectiveAt: string; messageId: number };
      };
    }
  | { ok: false; message: string };

/**
 * The resolver only reads identity and membership, so it accepts this narrow
 * slice instead of the whole tool dependency bag. Callers that hold a full
 * SketchMcpDeps still satisfy it.
 */
export type ChatHistoryAccessDeps = Pick<
  SketchMcpDeps,
  "db" | "currentUserId" | "userRepo" | "conversationContext" | "slackEntitySyncEnabled" | "publicMcp" | "logger"
>;

/** A channel or group addressed by its provider ID rather than a conversations row. */
export interface ProviderTargetRef {
  platform: ChatSearchPlatform;
  targetId: string;
}

export function providerTargetKey(target: ProviderTargetRef): string {
  return `${target.platform}:${target.targetId}`;
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

export class ChatHistoryAccessResolver {
  constructor(private readonly deps: ChatHistoryAccessDeps) {}

  async hasUsableIdentity(): Promise<boolean> {
    try {
      return (await resolveMembershipPrincipals(this.deps)).length > 0;
    } catch (error) {
      this.deps.logger?.warn({ err: error }, "Chat history principal resolution failed closed");
      return false;
    }
  }

  async isConversationAuthorized(conversationId: number, _refresh = false): Promise<boolean> {
    if (!this.deps.db || !this.deps.currentUserId) return false;
    if (this.deps.conversationContext?.conversationId === conversationId) {
      const conversation = await this.deps.db
        .selectFrom("conversations")
        .select(["platform", "kind", "provider_conversation_id as providerConversationId"])
        .where("id", "=", conversationId)
        .executeTakeFirst();
      if (!conversation) return false;
      if (conversation.kind === "dm") return true;
      const authorized = await this.authorizedProviderTargets([
        { platform: conversation.platform as ChatSearchPlatform, targetId: conversation.providerConversationId },
      ]);
      return authorized.has(
        providerTargetKey({
          platform: conversation.platform as ChatSearchPlatform,
          targetId: conversation.providerConversationId,
        }),
      );
    }
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
   * be checked before any message from it has been captured. The same resolved
   * principal set and roster gate serves both chat reads and shared-target sends.
   */
  async authorizedProviderTargets(targets: ProviderTargetRef[]): Promise<Set<string>> {
    if (!this.deps.db || !this.deps.currentUserId || targets.length === 0) return new Set();
    let principals: AccessPrincipal[] = [];
    try {
      principals = await resolveMembershipPrincipals(this.deps);
    } catch (error) {
      this.deps.logger?.warn({ err: error }, "Chat history principal resolution failed closed");
    }
    const authorized = await authorizedTargets(this.deps.db, principals, targets, this.deps.logger);
    const granted = new Set<string>();
    for (const target of targets) {
      if (authorized.has(providerTargetKey(target))) granted.add(providerTargetKey(target));
    }
    return granted;
  }

  /**
   * Every conversation the requester may read, without a candidate id list.
   * Answers membership through the same roster gate as every other door, so a
   * broad read cannot grant more than a targeted one.
   */
  async authorizedConversationIdsForAllChats(platform?: ChatSearchPlatform): Promise<number[]> {
    if (!this.deps.db || !this.deps.currentUserId) return [];
    let query = this.deps.db
      .selectFrom("conversations")
      .select(["id", "platform", "provider_conversation_id"])
      .where("kind", "in", ["channel", "group"]);
    if (platform) query = query.where("platform", "=", platform);
    const rows = await query.execute();
    if (rows.length === 0) return [];

    const candidates = rows.filter((row) => row.platform === "slack" || row.platform === "whatsapp");
    const granted = await this.authorizedProviderTargets(
      candidates.map((row) => ({
        platform: row.platform as ChatSearchPlatform,
        targetId: row.provider_conversation_id,
      })),
    );
    return candidates
      .filter((row) =>
        granted.has(
          providerTargetKey({ platform: row.platform as ChatSearchPlatform, targetId: row.provider_conversation_id }),
        ),
      )
      .map((row) => row.id);
  }

  private async resolveRows(rows: ConversationAccessRow[]): Promise<Set<number>> {
    if (!this.deps.db) return new Set();
    const authorizedIds = new Set<number>();
    const authorized = await this.authorizedProviderTargets(
      rows.map((row) => ({
        platform: row.platform as ChatSearchPlatform,
        targetId: row.providerConversationId,
      })),
    );
    for (const row of rows) {
      if (
        authorized.has(
          providerTargetKey({ platform: row.platform as ChatSearchPlatform, targetId: row.providerConversationId }),
        )
      ) {
        authorizedIds.add(row.id);
      }
    }
    return authorizedIds;
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
 * membership rows and is allowed from any run context including shared
 * channels and groups. Results may surface in shared destinations because the
 * caller's membership is the sole boundary, matching how the user could quote
 * the same content by hand. Runs without an authenticated requesting user are
 * denied.
 *
 * The current DM remains searchable from its run context. Current channels and
 * groups must also pass the provider membership gate before they are included.
 * The platform filter still applies to the current conversation.
 */
export async function handleAllChatsRead(
  args: AllChatsReadArgs,
  deps: SketchMcpDeps,
  access = new ChatHistoryAccessResolver(deps),
): Promise<AllChatsReadOutcome> {
  if (!deps.db) {
    return { ok: false, message: "Cross-chat chat history is not available in this run." };
  }
  if (!deps.currentUserId) {
    return { ok: false, message: "Cross-chat chat history requires an authenticated requesting user." };
  }
  const [authorizedConversationIds, candidateCurrentConversationId] = await Promise.all([
    access.authorizedConversationIdsForAllChats(args.platform),
    hasCurrentConversation(deps.db, deps.conversationContext?.conversationId, args.platform),
  ]);
  /**
   * Being inside a conversation is not a grant. The current conversation goes
   * through the same membership gate as every other one, or a user removed
   * from a channel could still read it by asking from inside it.
   */
  const currentConversationId =
    candidateCurrentConversationId && (await access.isConversationAuthorized(candidateCurrentConversationId))
      ? candidateCurrentConversationId
      : undefined;
  if (!currentConversationId && authorizedConversationIds.length === 0 && !(await access.hasUsableIdentity())) {
    return {
      ok: false,
      message: "Cross-chat chat history requires a linked Slack or WhatsApp account.",
    };
  }
  const conversationRepo = deps.conversationRepo ?? createConversationRepository(deps.db);
  const result = await conversationRepo.listMessagesAcrossConversations({
    conversationIds: [...authorizedConversationIds, ...(currentConversationId ? [currentConversationId] : [])],
    afterEffectiveAt: args.afterTime,
    beforeEffectiveAt: args.beforeTime,
    cursor: args.cursor,
    snapshotBeforeMessageId: args.snapshotBeforeMessageId,
    order: args.order,
    limit: args.limit,
    includeBotMessages: args.includeBotMessages,
  });

  return {
    ok: true,
    body: {
      messages: await renderAllChatsSearchResults(deps.db, result.messages),
      hasMore: result.hasMore,
      ...(result.messages.length > 0
        ? {
            nextCursor: {
              effectiveAt: result.messages[result.messages.length - 1].effectiveAt,
              messageId: result.messages[result.messages.length - 1].id,
            },
          }
        : {}),
    },
  };
}
