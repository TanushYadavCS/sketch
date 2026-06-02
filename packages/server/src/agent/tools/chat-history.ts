import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { StoredConversationMessage } from "../../db/repositories/conversations";
import type { Attachment } from "../../files";
import type { SketchMcpDeps } from "./types";

export const READ_CHAT_HISTORY_TOOL_NAME = "ReadChatHistory";

function renderAttachment(attachment: Attachment): Record<string, unknown> {
  return {
    name: attachment.originalName,
    mimeType: attachment.mimeType,
    localPath: attachment.localPath,
    sizeBytes: attachment.sizeBytes,
    transcription: attachment.transcription,
  };
}

function renderMessage(message: StoredConversationMessage): Record<string, unknown> {
  return {
    id: message.id,
    senderName: message.senderName,
    senderJid: message.senderJid || null,
    senderUserId: message.senderUserId,
    isBot: message.isBot,
    addressedToSketch: message.addressedToSketch,
    text: message.text,
    attachments: message.attachments.map(renderAttachment),
    providerTimestamp: message.providerTimestamp,
    receivedAt: message.receivedAt,
  };
}

export function createReadChatHistoryTool(deps: SketchMcpDeps) {
  return tool(
    READ_CHAT_HISTORY_TOOL_NAME,
    "Read persisted messages from the current WhatsApp conversation only. Use this when the context says there are more missed messages than were inlined, or when you need earlier chat history from this same conversation.",
    {
      afterMessageId: z.number().int().positive().optional().describe("Return messages with row id greater than this."),
      beforeMessageId: z.number().int().positive().optional().describe("Return messages with row id less than this."),
      limit: z.number().int().positive().max(100).optional().describe("Max messages to return. Default 50, max 100."),
      order: z.enum(["asc", "desc"]).optional().describe("Message row-id order. Default asc."),
      includeBotMessages: z.boolean().optional().describe("Include Sketch's persisted visible replies. Default false."),
    },
    async ({ afterMessageId, beforeMessageId, limit, order, includeBotMessages }) => {
      const conversationId = deps.conversationContext?.conversationId;
      if (!conversationId || !deps.conversationRepo) {
        return { content: [{ type: "text" as const, text: "Chat history is not available in this run." }] };
      }

      const result = await deps.conversationRepo.listMessages(conversationId, {
        afterMessageId,
        beforeMessageId,
        limit,
        order,
        includeBotMessages,
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
