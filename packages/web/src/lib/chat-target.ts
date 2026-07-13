import type { WebChatUploadedAttachment } from "@/lib/api";

export function createWebChatConversationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `chat-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

interface PendingWebChatSubmission {
  text: string;
  attachments: WebChatUploadedAttachment[];
}

const pendingWebChatSubmissions = new Map<string, PendingWebChatSubmission>();

export function setPendingWebChatSubmission(conversationId: string, submission: PendingWebChatSubmission): void {
  pendingWebChatSubmissions.set(conversationId, submission);
}

export function hasPendingWebChatSubmission(conversationId: string): boolean {
  return pendingWebChatSubmissions.has(conversationId);
}

export function takePendingWebChatSubmission(conversationId: string): PendingWebChatSubmission | null {
  const submission = pendingWebChatSubmissions.get(conversationId) ?? null;
  pendingWebChatSubmissions.delete(conversationId);
  return submission;
}

export function chatTargetFromPrompt(value: string, createId = createWebChatConversationId) {
  return {
    to: "/chat/$conversationId" as const,
    params: { conversationId: createId() },
    search: { message: value.trim() },
  };
}

export function chatPrefillTargetFromPrompt(value: string, createId = createWebChatConversationId) {
  return {
    to: "/chat/$conversationId" as const,
    params: { conversationId: createId() },
    search: { prefill: value.trim() },
  };
}
