import type { Expression, Kysely } from "kysely";
import { authorizedTargets } from "../../access/membership";
import { resolveViewerPrincipals } from "../../access/principals";
import type { AccessPrincipal } from "../../connectors/types";
import { type CrossConversationSearchMessage, createConversationRepository } from "../../db/repositories/conversations";
import type { DB } from "../../db/schema";
import { parseSlackRosterSnapshot } from "../../slack/identity-resolution";
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
      return (await resolveViewerPrincipals(this.deps)).length > 0;
    } catch (error) {
      this.deps.logger?.warn({ err: error }, "Chat history principal resolution failed closed");
      return false;
    }
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
   * be checked before any message from it has been captured. The same resolved
   * principal set and roster gate serves both chat reads and shared-target sends.
   */
  async authorizedProviderTargets(targets: ProviderTargetRef[]): Promise<Set<string>> {
    if (!this.deps.db || !this.deps.currentUserId || targets.length === 0) return new Set();
    let principals: AccessPrincipal[] = [];
    try {
      principals = await resolveViewerPrincipals(this.deps);
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
