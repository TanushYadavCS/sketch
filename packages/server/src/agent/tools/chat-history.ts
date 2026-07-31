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
  handleAllChatsSearch,
  isChatHistoryConversationAuthorized,
  renderAllChatsSearchResults,
} from "./chat-search";
import type { SketchMcpDeps, ToolResult } from "./types";

export const READ_CHAT_HISTORY_TOOL_NAME = "ReadChatHistory";
export const SEARCH_CHAT_HISTORY_TOOL_NAME = "SearchChatHistory";

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
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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

function parseCrossReadPageToken(value: string): CrossReadPageToken | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CrossReadPageToken>;
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.conversationId) ||
      Number(parsed.conversationId) <= 0 ||
      !Number.isSafeInteger(parsed.anchorMessageId) ||
      Number(parsed.anchorMessageId) <= 0 ||
      (parsed.direction !== "older" && parsed.direction !== "newer") ||
      !Number.isSafeInteger(parsed.boundaryMessageId) ||
      Number(parsed.boundaryMessageId) <= 0 ||
      (parsed.snapshotBeforeMessageId !== null &&
        (!Number.isSafeInteger(parsed.snapshotBeforeMessageId) || Number(parsed.snapshotBeforeMessageId) <= 0)) ||
      typeof parsed.includeBotMessages !== "boolean"
    ) {
      return null;
    }
    return parsed as CrossReadPageToken;
  } catch {
    return null;
  }
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
    .select([
      "conversations.platform",
      "conversation_messages.provider_thread_id",
      "conversation_messages.is_thread_reply",
    ])
    .where("conversation_messages.conversation_id", "=", conversationId)
    .where("conversation_messages.id", "=", anchorMessageId)
    .executeTakeFirst();
  if (!row) return { ok: false };
  if (row.platform !== "slack") return { ok: true, stream: {} };
  if (row.provider_thread_id === null) return { ok: true, stream: { providerThreadId: null } };
  return row.is_thread_reply === 1
    ? { ok: true, stream: { providerThreadId: row.provider_thread_id } }
    : { ok: true, stream: { isThreadReply: false } };
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
    "Read persisted messages chronologically from the current chat or from an authorized conversation returned by SearchChatHistory. A cross-chat read must start with both conversationRef and anchorMessageId from the search hit. Continue it only with an olderPageToken or newerPageToken returned by that read, passed as pageToken. Do not restart a cross-chat read without its anchor or use this as the first tool for targeted lookup.",
    {
      conversationRef: z
        .string()
        .optional()
        .describe(
          "Opaque conversation ref returned by SearchChatHistory, such as conversation:42. Omit to read the current chat.",
        ),
      anchorMessageId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Center the read around this message row id returned by SearchChatHistory."),
      pageToken: z
        .string()
        .optional()
        .describe("Opaque olderPageToken or newerPageToken returned by a prior cross-chat read."),
      scope: z
        .enum(["conversation", "current_thread"])
        .optional()
        .describe(
          "Read the whole current conversation or only the active Slack thread. Defaults to current_thread when a Slack thread is active, otherwise conversation.",
        ),
      afterMessageId: z.number().int().positive().optional().describe("Return messages with row id greater than this."),
      beforeMessageId: z.number().int().positive().optional().describe("Return messages with row id less than this."),
      limit: z.number().int().positive().max(100).optional().describe("Max messages to return. Default 50, max 100."),
      order: z.enum(["asc", "desc"]).optional().describe("Message row-id order. Default asc."),
      includeBotMessages: z.boolean().optional().describe("Include Sketch's persisted visible replies. Default false."),
    },
    async ({
      conversationRef,
      anchorMessageId,
      pageToken,
      scope,
      afterMessageId,
      beforeMessageId,
      limit,
      order,
      includeBotMessages,
    }) => {
      if (
        pageToken &&
        (conversationRef ||
          anchorMessageId ||
          scope ||
          afterMessageId ||
          beforeMessageId ||
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
              text: "conversationRef must be combined with the anchorMessageId returned by SearchChatHistory.",
            },
          ],
        };
      }
      if (anchorMessageId && (afterMessageId || beforeMessageId || order)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "anchorMessageId cannot be combined with row-id bounds or order.",
            },
          ],
        };
      }

      const parsedPageToken = pageToken ? parseCrossReadPageToken(pageToken) : null;
      if (pageToken && !parsedPageToken) return unavailableCrossConversationResult();
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
      const effectiveBeforeMessageId =
        beforeMessageId && currentMessageId
          ? Math.min(beforeMessageId, currentMessageId)
          : (beforeMessageId ?? currentMessageId);
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
              afterMessageId,
              beforeMessageId: effectiveBeforeMessageId,
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

export function createSearchChatHistoryTool(deps: SketchMcpDeps, access = new ChatHistoryAccessResolver(deps)) {
  return tool(
    SEARCH_CHAT_HISTORY_TOOL_NAME,
    "Search persisted messages in the current chat conversation by keyword, topic, name, decision, project, phrase, or older chat reference. Use this as the first tool for targeted chat-history discovery, even when only some missed messages were inlined. Use scope 'all_chats' to search across every Slack channel and WhatsApp group the requesting user is a member of. Use ReadChatHistory only for chronological paging or reading around a known message id.",
    {
      query: z.string().min(1).describe("Keyword, topic, name, project, decision, or phrase to find in chat history."),
      scope: z
        .enum(["conversation", "current_thread", "all_chats"])
        .optional()
        .describe(
          "Search the whole current conversation, only the active Slack thread, or (all_chats) every Slack channel and WhatsApp group the requesting user is a member of plus this conversation. Defaults to current_thread when a Slack thread is active, otherwise conversation.",
        ),
      platform: z
        .enum(["slack", "whatsapp"])
        .optional()
        .describe("With scope all_chats only: restrict results to one platform."),
      afterMessageId: z.number().int().positive().optional().describe("Search messages with row id greater than this."),
      beforeMessageId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Search messages with row id less than this. Defaults to the current trigger message id."),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe(
          "Max matches to return. Default 20, max 100. Results are relevance-ordered; hasMore signals truncation — narrow the query or raise limit rather than paging with row-id bounds.",
        ),
      includeBotMessages: z.boolean().optional().describe("Include Sketch's persisted visible replies. Default false."),
    },
    async ({ query, scope, platform, afterMessageId, beforeMessageId, limit, includeBotMessages }) => {
      if (platform && scope !== "all_chats") {
        return {
          content: [{ type: "text" as const, text: "The platform filter is only valid with scope 'all_chats'." }],
        };
      }
      if (scope === "all_chats") {
        const outcome = await handleAllChatsSearch(
          { query, platform, afterMessageId, beforeMessageId, limit, includeBotMessages },
          deps,
          access,
        );
        if (!outcome.ok) {
          return { content: [{ type: "text" as const, text: outcome.message }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(outcome.body, null, 2) }] };
      }
      const conversationId = deps.conversationContext?.conversationId;
      if (!conversationId || !deps.conversationRepo) {
        return { content: [{ type: "text" as const, text: "Chat history search is not available in this run." }] };
      }
      const providerThreadId = deps.conversationContext?.providerThreadId;
      const currentMessageId = deps.conversationContext?.currentMessageId;
      const effectiveBeforeMessageId =
        beforeMessageId && currentMessageId
          ? Math.min(beforeMessageId, currentMessageId)
          : (beforeMessageId ?? currentMessageId);
      const effectiveScope = scope ?? (providerThreadId ? "current_thread" : "conversation");
      if (effectiveScope === "current_thread" && !providerThreadId) {
        return {
          content: [
            { type: "text" as const, text: "Current-thread chat history search is not available in this run." },
          ],
        };
      }

      const result = await deps.conversationRepo.searchMessages(conversationId, {
        query,
        afterMessageId,
        beforeMessageId: effectiveBeforeMessageId,
        limit,
        includeBotMessages,
        providerThreadId: effectiveScope === "current_thread" ? providerThreadId : undefined,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                messages: result.messages.map(renderMessage),
                hasMore: result.hasMore,
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
