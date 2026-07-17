import type { ConversationRowProps } from "@/components/sketch/conversation-row";
import type { WebChatConversationSummary } from "@/lib/api";

export const WEB_CHAT_CONVERSATIONS_QUERY_KEY = ["web-chat", "conversations"] as const;

export function buildWebChatRecents(conversations: WebChatConversationSummary[]): ConversationRowProps[] {
  return conversations.slice(0, 5).map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    channel: conversation.channel,
    occurredAt: conversation.updatedAt,
  }));
}
