import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import {
  type CrossConversationSearchMessage,
  type StoredConversationMessage,
  createConversationRepository,
} from "../../db/repositories/conversations";
import type { Attachment } from "../../files";
import {
  ChatHistoryAccessResolver,
  handleAllChatsRead,
  isChatHistoryConversationAuthorized,
  renderAllChatsSearchResults,
} from "./chat-search";
import type { SketchMcpDeps, ToolResult } from "./types";

export const READ_CHAT_HISTORY_TOOL_NAME = "ReadChatHistory";

/**
 * Row ids are 32-bit `integer`/`serial` columns under Postgres. Every row-id
 * field advertises this as its schema maximum: zod renders a bare `.int()` as
 * `maximum: 9007199254740991` in the JSON Schema the model reads, and a model
 * asked for an upper bound reasonably echoes back the largest value we said we
 * accept — which then overflows the bind parameter and surfaces a raw driver
 * error as tool output. Capping the advertised ceiling keeps that echo valid.
 * SQLite stores 64-bit integers and never reproduces the overflow.
 */
const INT4_MAX = 2_147_483_647;

/**
 * Clamps a range bound rather than rejecting it: no stored row id can exceed
 * the ceiling, so a clamped upper bound is unbounded and a clamped lower bound
 * matches nothing — the same rows the oversized value asked for.
 */
/** Guards ids that address one specific row, where clamping would retarget the lookup. */
function isStorableRowId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= INT4_MAX;
}

function renderAttachment(attachment: Attachment): Record<string, unknown> {
  return {
    name: attachment.originalName,
    mimeType: attachment.mimeType,
    localPath: attachment.localPath,
    sizeBytes: attachment.sizeBytes,
    transcription: attachment.transcription,
  };
}

function renderMessage(message: StoredConversationMessage & { rank?: number }): Record<string, unknown> {
  return {
    id: message.id,
    ...(message.rank !== undefined ? { rank: message.rank } : {}),
    senderName: message.senderName,
    senderJid: message.senderJid || null,
    senderUserId: message.senderUserId,
    isBot: message.isBot,
    addressedToSketch: message.addressedToSketch,
    text: message.text,
    attachments: message.attachments.map(renderAttachment),
    providerThreadId: message.providerThreadId,
    providerParentMessageId: message.providerParentMessageId,
    isThreadReply: message.isThreadReply,
    providerTimestamp: message.providerTimestamp,
    receivedAt: message.receivedAt,
  };
}

function parseConversationRef(value: string): number | null {
  const match = /^conversation:(\d+)$/u.exec(value);
  if (!match) return null;
  const id = Number(match[1]);
  return isStorableRowId(id) ? id : null;
}

function unavailableCrossConversationResult(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: "The requested chat history is unavailable or you no longer have access to it.",
      },
    ],
  };
}

type CrossReadDirection = "older" | "newer";

interface CrossReadPageToken {
  version: 1;
  conversationId: number;
  anchorMessageId: number;
  direction: CrossReadDirection;
  boundaryMessageId: number;
  snapshotBeforeMessageId: number | null;
  includeBotMessages: boolean;
}

interface AllChatsPageToken {
  version: 2;
  scope: "all_chats";
  lastEffectiveAt: string;
  lastMessageId: number;
  snapshotBeforeMessageId: number | null;
  afterTime: string | null;
  beforeTime: string | null;
  platform: "slack" | "whatsapp" | null;
  includeBotMessages: boolean;
  order: "asc" | "desc";
}

interface CrossReadStream {
  providerThreadId?: string | null;
  isThreadReply?: boolean;
}

interface CrossReadPage {
  messages: StoredConversationMessage[];
  hasMore: boolean;
  olderPageToken?: string;
  newerPageToken?: string;
}

function encodeCrossReadPageToken(token: CrossReadPageToken): string {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

export function encodeChatHistoryBacklogPageToken(params: {
  conversationId: number;
  anchorMessageId: number;
  boundaryMessageId: number;
}): string {
  return encodeCrossReadPageToken({
    version: 1,
    conversationId: params.conversationId,
    anchorMessageId: params.anchorMessageId,
    direction: "older",
    boundaryMessageId: params.boundaryMessageId,
    snapshotBeforeMessageId: params.anchorMessageId,
    includeBotMessages: false,
  });
}

function parseCrossReadPageToken(value: string): CrossReadPageToken | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CrossReadPageToken>;
    if (
      parsed.version !== 1 ||
      !isStorableRowId(parsed.conversationId) ||
      !isStorableRowId(parsed.anchorMessageId) ||
      (parsed.direction !== "older" && parsed.direction !== "newer") ||
      !isStorableRowId(parsed.boundaryMessageId) ||
      (parsed.snapshotBeforeMessageId !== null && !isStorableRowId(parsed.snapshotBeforeMessageId)) ||
      typeof parsed.includeBotMessages !== "boolean"
    ) {
      return null;
    }
    return parsed as CrossReadPageToken;
  } catch {
    return null;
  }
}

function normalizeTime(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function parseAllChatsPageToken(value: string): AllChatsPageToken | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<AllChatsPageToken>;
    const validTime = (time: unknown): time is string | null =>
      time === null || (typeof time === "string" && normalizeTime(time) === time);
    if (
      parsed.version !== 2 ||
      parsed.scope !== "all_chats" ||
      typeof parsed.lastEffectiveAt !== "string" ||
      normalizeTime(parsed.lastEffectiveAt) !== parsed.lastEffectiveAt ||
      !isStorableRowId(parsed.lastMessageId) ||
      (parsed.snapshotBeforeMessageId !== null && !isStorableRowId(parsed.snapshotBeforeMessageId)) ||
      !validTime(parsed.afterTime) ||
      !validTime(parsed.beforeTime) ||
      (parsed.platform !== null && parsed.platform !== "slack" && parsed.platform !== "whatsapp") ||
      typeof parsed.includeBotMessages !== "boolean" ||
      (parsed.order !== "asc" && parsed.order !== "desc")
    ) {
      return null;
    }
    return parsed as AllChatsPageToken;
  } catch {
    return null;
  }
}

function encodeAllChatsPageToken(token: AllChatsPageToken): string {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

async function readAroundMessage(
  repo: ReturnType<typeof createConversationRepository>,
  conversationId: number,
  anchorMessageId: number,
  options: {
    limit?: number;
    includeBotMessages?: boolean;
    beforeMessageId?: number;
    stream: CrossReadStream;
  },
): Promise<CrossReadPage> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  const beforeLimit = Math.floor((limit - 1) / 2);
  const afterLimit = limit - beforeLimit;
  const beforeProbe = await repo.listMessages(conversationId, {
    beforeMessageId: anchorMessageId,
    limit: Math.max(1, beforeLimit),
    order: "desc",
    includeBotMessages: options.includeBotMessages,
    ...options.stream,
  });
  const beforeMessages = beforeLimit > 0 ? beforeProbe.messages : [];
  const after = await repo.listMessages(conversationId, {
    afterMessageId: anchorMessageId - 1,
    beforeMessageId: options.beforeMessageId,
    limit: afterLimit,
    order: "asc",
    includeBotMessages: options.includeBotMessages,
    ...options.stream,
  });
  if (!after.messages.some((message) => message.id === anchorMessageId)) {
    return { messages: [], hasMore: false };
  }
  const olderAvailable = beforeLimit === 0 ? beforeProbe.messages.length > 0 : beforeProbe.hasMore;
  const firstMessageId = beforeMessages.at(-1)?.id ?? anchorMessageId;
  const lastMessageId = after.messages.at(-1)?.id ?? anchorMessageId;
  const tokenBase = {
    version: 1 as const,
    conversationId,
    anchorMessageId,
    snapshotBeforeMessageId: options.beforeMessageId ?? null,
    includeBotMessages: options.includeBotMessages === true,
  };
  return {
    messages: [...beforeMessages.reverse(), ...after.messages],
    hasMore: olderAvailable || after.hasMore,
    ...(olderAvailable
      ? {
          olderPageToken: encodeCrossReadPageToken({
            ...tokenBase,
            direction: "older",
            boundaryMessageId: firstMessageId,
          }),
        }
      : {}),
    ...(after.hasMore
      ? {
          newerPageToken: encodeCrossReadPageToken({
            ...tokenBase,
            direction: "newer",
            boundaryMessageId: lastMessageId,
          }),
        }
      : {}),
  };
}

async function readCrossConversationPage(
  repo: ReturnType<typeof createConversationRepository>,
  token: CrossReadPageToken,
  stream: CrossReadStream,
  limit?: number,
): Promise<CrossReadPage> {
  const pageLimit = Math.max(1, Math.min(limit ?? 50, 100));
  if (token.direction === "older") {
    const result = await repo.listMessages(token.conversationId, {
      beforeMessageId: token.boundaryMessageId,
      limit: pageLimit,
      order: "desc",
      includeBotMessages: token.includeBotMessages,
      ...stream,
    });
    const messages = result.messages.reverse();
    return {
      messages,
      hasMore: result.hasMore,
      ...(result.hasMore && messages.length > 0
        ? {
            olderPageToken: encodeCrossReadPageToken({
              ...token,
              boundaryMessageId: messages[0].id,
            }),
          }
        : {}),
    };
  }
  const result = await repo.listMessages(token.conversationId, {
    afterMessageId: token.boundaryMessageId,
    beforeMessageId: token.snapshotBeforeMessageId ?? undefined,
    limit: pageLimit,
    order: "asc",
    includeBotMessages: token.includeBotMessages,
    ...stream,
  });
  return {
    messages: result.messages,
    hasMore: result.hasMore,
    ...(result.hasMore && result.messages.length > 0
      ? {
          newerPageToken: encodeCrossReadPageToken({
            ...token,
            boundaryMessageId: result.messages.at(-1)?.id ?? token.boundaryMessageId,
          }),
        }
      : {}),
  };
}

async function renderCrossConversationRead(
  deps: SketchMcpDeps,
  conversationId: number,
  messages: StoredConversationMessage[],
): Promise<Array<Record<string, unknown>> | null> {
  if (!deps.db) return null;
  const conversation = await deps.db
    .selectFrom("conversations")
    .select(["platform", "kind", "display_name"])
    .where("id", "=", conversationId)
    .executeTakeFirst();
  if (!conversation) return null;
  const enriched: CrossConversationSearchMessage[] = messages.map((message) => ({
    ...message,
    conversationPlatform: conversation.platform,
    conversationKind: conversation.kind,
    conversationDisplayName: conversation.display_name,
  }));
  return renderAllChatsSearchResults(deps.db, enriched);
}

async function loadCrossConversationAnchorStream(
  deps: SketchMcpDeps,
  conversationId: number,
  anchorMessageId: number,
): Promise<{ ok: true; stream: CrossReadStream } | { ok: false }> {
  if (!deps.db) return { ok: false };
  const row = await deps.db
    .selectFrom("conversation_messages")
    .innerJoin("conversations", "conversations.id", "conversation_messages.conversation_id")
    .select(["conversations.platform", "conversation_messages.provider_thread_id"])
    .where("conversation_messages.conversation_id", "=", conversationId)
    .where("conversation_messages.id", "=", anchorMessageId)
    .executeTakeFirst();
  if (!row) return { ok: false };
  if (row.platform !== "slack") return { ok: true, stream: {} };
  if (row.provider_thread_id === null) return { ok: true, stream: { providerThreadId: null } };
  return { ok: true, stream: { providerThreadId: row.provider_thread_id } };
}

async function boundaryBelongsToCrossReadStream(
  deps: SketchMcpDeps,
  token: CrossReadPageToken,
  stream: CrossReadStream,
): Promise<boolean> {
  if (!deps.db) return false;
  let query = deps.db
    .selectFrom("conversation_messages")
    .select("id")
    .where("conversation_id", "=", token.conversationId)
    .where("id", "=", token.boundaryMessageId);
  if (stream.providerThreadId !== undefined) {
    query =
      stream.providerThreadId === null
        ? query.where("provider_thread_id", "is", null)
        : query.where("provider_thread_id", "=", stream.providerThreadId);
  }
  if (stream.isThreadReply !== undefined) {
    query = query.where("is_thread_reply", "=", stream.isThreadReply ? 1 : 0);
  }
  return (await query.executeTakeFirst()) !== undefined;
}

export function createReadChatHistoryTool(deps: SketchMcpDeps, access = new ChatHistoryAccessResolver(deps)) {
  return tool(
    READ_CHAT_HISTORY_TOOL_NAME,
    "Read persisted messages chronologically from the current chat, an authorized conversation, or every Slack channel and WhatsApp group the requester belongs to. Use all_chats for broad chronological history and continue it with nextPageToken as pageToken. Use conversationRef with anchorMessageId for a specific authorized chat.",
    {
      conversationRef: z
        .string()
        .optional()
        .describe("Opaque conversation ref such as conversation:42. Omit to read the current chat."),
      anchorMessageId: z
        .number()
        .int()
        .positive()
        .max(INT4_MAX)
        .optional()
        .describe("Center a specific-chat read around this message row id."),
      pageToken: z.string().optional().describe("Opaque continuation token returned by a prior read."),
      scope: z
        .enum(["conversation", "current_thread", "all_chats"])
        .optional()
        .describe(
          "Read the current conversation, only the active Slack thread, or all authorized chats. Defaults to current_thread when a Slack thread is active, otherwise conversation.",
        ),
      afterTime: z.string().optional().describe("Inclusive ISO-8601 lower bound on the message effective time."),
      beforeTime: z.string().optional().describe("Inclusive ISO-8601 upper bound on the message effective time."),
      platform: z
        .enum(["slack", "whatsapp"])
        .optional()
        .describe("With scope all_chats only, restrict results to one platform."),
      limit: z.number().int().positive().max(100).optional().describe("Max messages to return. Default 50, max 100."),
      order: z.enum(["asc", "desc"]).optional().describe("Message effective-time order. Default asc."),
      includeBotMessages: z.boolean().optional().describe("Include Sketch's persisted visible replies. Default false."),
    },
    async ({
      conversationRef,
      anchorMessageId,
      pageToken,
      scope,
      afterTime: requestedAfterTime,
      beforeTime: requestedBeforeTime,
      platform: requestedPlatform,
      limit,
      order,
      includeBotMessages,
    }) => {
      if (
        pageToken &&
        (conversationRef ||
          anchorMessageId ||
          scope ||
          requestedAfterTime ||
          requestedBeforeTime ||
          requestedPlatform ||
          order ||
          includeBotMessages !== undefined)
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "pageToken can only be combined with limit.",
            },
          ],
        };
      }
      const allChatsPageToken = pageToken ? parseAllChatsPageToken(pageToken) : null;
      const crossReadPageToken = pageToken ? parseCrossReadPageToken(pageToken) : null;
      if (pageToken && !allChatsPageToken && !crossReadPageToken) return unavailableCrossConversationResult();

      const normalizedAfterTime = allChatsPageToken
        ? (allChatsPageToken.afterTime ?? undefined)
        : normalizeTime(requestedAfterTime);
      const normalizedBeforeTime = allChatsPageToken
        ? (allChatsPageToken.beforeTime ?? undefined)
        : normalizeTime(requestedBeforeTime);
      if (
        (requestedAfterTime !== undefined && normalizedAfterTime === null) ||
        (requestedBeforeTime !== undefined && normalizedBeforeTime === null)
      ) {
        return {
          content: [{ type: "text" as const, text: "afterTime and beforeTime must be valid ISO-8601 timestamps." }],
        };
      }
      if (allChatsPageToken) {
        const outcome = await handleAllChatsRead(
          {
            platform: allChatsPageToken.platform ?? undefined,
            afterTime: allChatsPageToken.afterTime ?? undefined,
            beforeTime: allChatsPageToken.beforeTime ?? undefined,
            cursor: { effectiveAt: allChatsPageToken.lastEffectiveAt, messageId: allChatsPageToken.lastMessageId },
            snapshotBeforeMessageId: allChatsPageToken.snapshotBeforeMessageId ?? undefined,
            order: allChatsPageToken.order,
            limit,
            includeBotMessages: allChatsPageToken.includeBotMessages,
          },
          deps,
          access,
        );
        if (!outcome.ok) return { content: [{ type: "text" as const, text: outcome.message }] };
        const nextPageToken =
          outcome.body.hasMore && outcome.body.nextCursor
            ? encodeAllChatsPageToken({
                version: 2,
                scope: "all_chats",
                lastEffectiveAt: outcome.body.nextCursor.effectiveAt,
                lastMessageId: outcome.body.nextCursor.messageId,
                snapshotBeforeMessageId: allChatsPageToken.snapshotBeforeMessageId,
                afterTime: allChatsPageToken.afterTime,
                beforeTime: allChatsPageToken.beforeTime,
                platform: allChatsPageToken.platform,
                includeBotMessages: allChatsPageToken.includeBotMessages,
                order: allChatsPageToken.order,
              })
            : undefined;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  messages: outcome.body.messages,
                  hasMore: outcome.body.hasMore,
                  ...(nextPageToken ? { nextPageToken } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (requestedPlatform && scope !== "all_chats") {
        return { content: [{ type: "text" as const, text: "platform can only be used with all_chats scope." }] };
      }
      if (scope === "all_chats") {
        if (conversationRef || anchorMessageId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "all_chats scope cannot be combined with a conversationRef or anchorMessageId.",
              },
            ],
          };
        }
        const snapshotBeforeMessageId = deps.conversationContext?.currentMessageId;
        const outcome = await handleAllChatsRead(
          {
            platform: requestedPlatform,
            afterTime: normalizedAfterTime ?? undefined,
            beforeTime: normalizedBeforeTime ?? undefined,
            snapshotBeforeMessageId,
            order,
            limit,
            includeBotMessages,
          },
          deps,
          access,
        );
        if (!outcome.ok) return { content: [{ type: "text" as const, text: outcome.message }] };
        const nextPageToken =
          outcome.body.hasMore && outcome.body.nextCursor
            ? encodeAllChatsPageToken({
                version: 2,
                scope: "all_chats",
                lastEffectiveAt: outcome.body.nextCursor.effectiveAt,
                lastMessageId: outcome.body.nextCursor.messageId,
                snapshotBeforeMessageId: snapshotBeforeMessageId ?? null,
                afterTime: normalizedAfterTime ?? null,
                beforeTime: normalizedBeforeTime ?? null,
                platform: requestedPlatform ?? null,
                includeBotMessages: includeBotMessages === true,
                order: order ?? "asc",
              })
            : undefined;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  messages: outcome.body.messages,
                  hasMore: outcome.body.hasMore,
                  ...(nextPageToken ? { nextPageToken } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (conversationRef && scope === "current_thread") {
        return {
          content: [{ type: "text" as const, text: "Current-thread scope cannot be used with conversationRef." }],
        };
      }
      if (conversationRef && !anchorMessageId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "conversationRef must be combined with anchorMessageId.",
            },
          ],
        };
      }
      if (anchorMessageId && (normalizedAfterTime || normalizedBeforeTime || order)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "anchorMessageId cannot be combined with time bounds or order.",
            },
          ],
        };
      }
      if (anchorMessageId !== undefined && !isStorableRowId(anchorMessageId)) {
        return unavailableCrossConversationResult();
      }

      const parsedPageToken = crossReadPageToken;
      const referencedConversationId =
        parsedPageToken?.conversationId ?? (conversationRef ? parseConversationRef(conversationRef) : null);
      if (conversationRef && !referencedConversationId) return unavailableCrossConversationResult();
      const conversationId = referencedConversationId ?? deps.conversationContext?.conversationId;
      const repo = deps.conversationRepo ?? (deps.db ? createConversationRepository(deps.db) : undefined);
      if (!conversationId || !repo) {
        return { content: [{ type: "text" as const, text: "Chat history is not available in this run." }] };
      }
      const isReferencedConversation = Boolean(conversationRef || parsedPageToken);
      if (
        isReferencedConversation &&
        !(await isChatHistoryConversationAuthorized(deps, conversationId, access, true))
      ) {
        return unavailableCrossConversationResult();
      }

      const providerThreadId = deps.conversationContext?.providerThreadId;
      const isThreadReply = deps.conversationContext?.isThreadReply;
      const currentMessageId = deps.conversationContext?.currentMessageId;
      const effectiveScope = scope ?? (providerThreadId ? "current_thread" : "conversation");
      if (effectiveScope === "current_thread" && !providerThreadId) {
        return {
          content: [{ type: "text" as const, text: "Current-thread chat history is not available in this run." }],
        };
      }

      if (anchorMessageId && currentMessageId && anchorMessageId >= currentMessageId) {
        return unavailableCrossConversationResult();
      }
      let stream: CrossReadStream =
        !isReferencedConversation && effectiveScope === "current_thread"
          ? { providerThreadId }
          : !isReferencedConversation && effectiveScope === "conversation" && isThreadReply !== undefined
            ? { isThreadReply }
            : {};
      const referencedAnchorMessageId = parsedPageToken?.anchorMessageId ?? anchorMessageId;
      if (isReferencedConversation && referencedAnchorMessageId) {
        const anchor = await loadCrossConversationAnchorStream(deps, conversationId, referencedAnchorMessageId);
        if (!anchor.ok) return unavailableCrossConversationResult();
        stream = anchor.stream;
      }
      if (parsedPageToken && !(await boundaryBelongsToCrossReadStream(deps, parsedPageToken, stream))) {
        return unavailableCrossConversationResult();
      }
      const result = parsedPageToken
        ? await readCrossConversationPage(repo, parsedPageToken, stream, limit)
        : anchorMessageId
          ? await readAroundMessage(repo, conversationId, anchorMessageId, {
              limit,
              includeBotMessages,
              beforeMessageId: currentMessageId,
              stream,
            })
          : await repo.listMessages(conversationId, {
              beforeMessageId: currentMessageId,
              afterEffectiveAt: normalizedAfterTime ?? undefined,
              beforeEffectiveAt: normalizedBeforeTime ?? undefined,
              limit,
              order,
              includeBotMessages,
              ...stream,
            });
      if ((anchorMessageId || parsedPageToken) && result.messages.length === 0) {
        return unavailableCrossConversationResult();
      }

      const messages = isReferencedConversation
        ? await renderCrossConversationRead(deps, conversationId, result.messages)
        : result.messages.map(renderMessage);
      if (!messages) return unavailableCrossConversationResult();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                messages,
                hasMore: result.hasMore,
                ...(isReferencedConversation && (anchorMessageId || parsedPageToken)
                  ? {
                      ...("olderPageToken" in result && result.olderPageToken
                        ? { olderPageToken: result.olderPageToken }
                        : {}),
                      ...("newerPageToken" in result && result.newerPageToken
                        ? { newerPageToken: result.newerPageToken }
                        : {}),
                    }
                  : "nextCursor" in result
                    ? { nextCursor: result.nextCursor }
                    : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
