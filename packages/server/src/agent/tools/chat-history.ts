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

async function readAroundMessage(
  repo: ReturnType<typeof createConversationRepository>,
  conversationId: number,
  anchorMessageId: number,
  options: {
    limit?: number;
    includeBotMessages?: boolean;
    beforeMessageId?: number;
    providerThreadId?: string | null;
  },
): Promise<{ messages: StoredConversationMessage[]; hasMore: boolean }> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  const beforeLimit = Math.floor((limit - 1) / 2);
  const afterLimit = limit - beforeLimit;
  const before =
    beforeLimit > 0
      ? await repo.listMessages(conversationId, {
          beforeMessageId: anchorMessageId,
          limit: beforeLimit,
          order: "desc",
          includeBotMessages: options.includeBotMessages,
          providerThreadId: options.providerThreadId,
        })
      : { messages: [], hasMore: false };
  const after = await repo.listMessages(conversationId, {
    afterMessageId: anchorMessageId - 1,
    beforeMessageId: options.beforeMessageId,
    limit: afterLimit,
    order: "asc",
    includeBotMessages: options.includeBotMessages,
    providerThreadId: options.providerThreadId,
  });
  if (!after.messages.some((message) => message.id === anchorMessageId)) {
    return { messages: [], hasMore: false };
  }
  return {
    messages: [...before.messages.reverse(), ...after.messages],
    hasMore: before.hasMore || after.hasMore,
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

async function loadCrossConversationAnchorThread(
  deps: SketchMcpDeps,
  conversationId: number,
  anchorMessageId: number,
): Promise<{ ok: true; providerThreadId?: string | null } | { ok: false }> {
  if (!deps.db) return { ok: false };
  const row = await deps.db
    .selectFrom("conversation_messages")
    .innerJoin("conversations", "conversations.id", "conversation_messages.conversation_id")
    .select(["conversations.platform", "conversation_messages.provider_thread_id"])
    .where("conversation_messages.conversation_id", "=", conversationId)
    .where("conversation_messages.id", "=", anchorMessageId)
    .executeTakeFirst();
  if (!row) return { ok: false };
  if (row.platform !== "slack") return { ok: true };
  return { ok: true, providerThreadId: row.provider_thread_id };
}

export function createReadChatHistoryTool(deps: SketchMcpDeps, access = new ChatHistoryAccessResolver(deps)) {
  return tool(
    READ_CHAT_HISTORY_TOOL_NAME,
    "Read persisted messages chronologically from the current chat or from an authorized conversation returned by SearchChatHistory. Use conversationRef and anchorMessageId to read around a cross-chat search hit. Do not use this as the first tool for targeted keyword, topic, decision, person, project, or phrase lookup; use SearchChatHistory first.",
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
      scope,
      afterMessageId,
      beforeMessageId,
      limit,
      order,
      includeBotMessages,
    }) => {
      if (conversationRef && scope === "current_thread") {
        return {
          content: [{ type: "text" as const, text: "Current-thread scope cannot be used with conversationRef." }],
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

      const referencedConversationId = conversationRef ? parseConversationRef(conversationRef) : null;
      if (conversationRef && !referencedConversationId) return unavailableCrossConversationResult();
      const conversationId = referencedConversationId ?? deps.conversationContext?.conversationId;
      const repo = deps.conversationRepo ?? (deps.db ? createConversationRepository(deps.db) : undefined);
      if (!conversationId || !repo) {
        return { content: [{ type: "text" as const, text: "Chat history is not available in this run." }] };
      }
      const isCrossConversation = conversationId !== deps.conversationContext?.conversationId;
      if (isCrossConversation && !(await isChatHistoryConversationAuthorized(deps, conversationId, access))) {
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
      let threadId = !isCrossConversation && effectiveScope === "current_thread" ? providerThreadId : undefined;
      if (isCrossConversation && anchorMessageId) {
        const anchor = await loadCrossConversationAnchorThread(deps, conversationId, anchorMessageId);
        if (!anchor.ok) return unavailableCrossConversationResult();
        threadId = anchor.providerThreadId;
      }
      const result = anchorMessageId
        ? await readAroundMessage(repo, conversationId, anchorMessageId, {
            limit,
            includeBotMessages,
            beforeMessageId: currentMessageId,
            providerThreadId: threadId,
          })
        : await repo.listMessages(conversationId, {
            afterMessageId,
            beforeMessageId: effectiveBeforeMessageId,
            limit,
            order,
            includeBotMessages,
            providerThreadId: threadId,
            ...(!isCrossConversation && effectiveScope === "conversation" && isThreadReply !== undefined
              ? { isThreadReply }
              : {}),
          });
      if (anchorMessageId && result.messages.length === 0) return unavailableCrossConversationResult();

      const messages = isCrossConversation
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
                ...("nextCursor" in result ? { nextCursor: result.nextCursor } : {}),
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
