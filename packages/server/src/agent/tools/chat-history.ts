import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { StoredConversationMessage } from "../../db/repositories/conversations";
import type { Attachment } from "../../files";
import { handleAllChatsSearch } from "./chat-search";
import type { SketchMcpDeps } from "./types";

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

export function createReadChatHistoryTool(deps: SketchMcpDeps) {
  return tool(
    READ_CHAT_HISTORY_TOOL_NAME,
    "Read persisted messages from the current chat conversation in chronological row-id order. Use this for chronological paging or reading around a known message id. Do not use this as the first tool for targeted keyword, topic, decision, person, project, or phrase lookup; use SearchChatHistory first.",
    {
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
    async ({ scope, afterMessageId, beforeMessageId, limit, order, includeBotMessages }) => {
      const conversationId = deps.conversationContext?.conversationId;
      if (!conversationId || !deps.conversationRepo) {
        return { content: [{ type: "text" as const, text: "Chat history is not available in this run." }] };
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
          content: [{ type: "text" as const, text: "Current-thread chat history is not available in this run." }],
        };
      }

      const result = await deps.conversationRepo.listMessages(conversationId, {
        afterMessageId,
        beforeMessageId: effectiveBeforeMessageId,
        limit,
        order,
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
                nextCursor: result.nextCursor,
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

export function createSearchChatHistoryTool(deps: SketchMcpDeps) {
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
