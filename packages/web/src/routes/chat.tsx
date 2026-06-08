import { ChatInput } from "@/components/sketch/chat-input";
import { ChatThread, type ChatThreadFile, type ChatThreadMessage } from "@/components/sketch/chat-thread";
import { type WebChatUploadedAttachment, api } from "@/lib/api";
import { useChat } from "@ai-sdk/react";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { createRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { dashboardRoute } from "./dashboard";
import { createWebChatConversationId, takePendingWebChatSubmission } from "./home";

type WebChatDataParts = {
  progress: {
    lines: string[];
  };
  file: {
    name: string;
    url: string;
    mediaType: string;
    sizeBytes?: number;
  };
};

type WebChatMetadata = {
  createdAt?: string;
};

type WebChatMessage = UIMessage<WebChatMetadata, WebChatDataParts> & { createdAt?: string | Date };

export interface ChatSearch {
  message?: string;
}

export function validateChatSearch(search: Record<string, unknown>): ChatSearch {
  const message = typeof search.message === "string" ? search.message.trim() : "";
  return message ? { message } : {};
}

function textFromMessage(message: WebChatMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function progressLinesFromMessage(message: WebChatMessage): string[] {
  const progressPart = message.parts.find((part) => part.type === "data-progress");
  return progressPart?.data.lines.filter((line) => line.trim().length > 0) ?? [];
}

function filesFromMessage(message: WebChatMessage): ChatThreadFile[] {
  return message.parts
    .filter((part) => part.type === "data-file")
    .map((part) => part.data)
    .filter((file) => file.name.trim().length > 0 && file.url.trim().length > 0);
}

function createdAtFromMessage(message: WebChatMessage): string | undefined {
  const value = message.createdAt;
  if (typeof value === "string" && value.trim()) return value;
  if (value instanceof Date) return value.toISOString();
  return message.metadata?.createdAt?.trim() || undefined;
}

export function outgoingTextMessage(text: string, attachments: WebChatUploadedAttachment[] = []) {
  const metadata = { createdAt: new Date().toISOString() };
  if (attachments.length === 0) {
    return { text, metadata };
  }

  return {
    metadata,
    parts: [
      { type: "text" as const, text },
      ...attachments.map((attachment, index) => ({
        type: "data-file" as const,
        id: `attachment-${index}`,
        data: {
          name: attachment.name,
          url: attachment.url,
          mediaType: attachment.mediaType,
          sizeBytes: attachment.sizeBytes,
        },
      })),
    ],
  };
}

export function outgoingRequestOptions(attachments: WebChatUploadedAttachment[]) {
  return attachments.length > 0 ? { body: { attachments } } : undefined;
}

export function buildChatThreadMessages(messages: WebChatMessage[]): ChatThreadMessage[] {
  return messages.flatMap<ChatThreadMessage>((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textFromMessage(message);
    const files = filesFromMessage(message);
    const createdAt = createdAtFromMessage(message);
    if (text || files.length > 0) {
      return [
        {
          id: message.id,
          role: message.role,
          text: text || undefined,
          createdAt,
          files: files.length > 0 ? files : undefined,
        },
      ];
    }
    if (message.role === "assistant") {
      const progressLines = progressLinesFromMessage(message);
      if (progressLines.length > 0) return [{ id: message.id, role: message.role, createdAt, progressLines }];
    }
    return [];
  });
}

export function hasPendingAssistantProgress(messages: WebChatMessage[]): boolean {
  const latestMessage = messages.at(-1);
  if (!latestMessage || latestMessage.role !== "assistant") return false;
  return (
    progressLinesFromMessage(latestMessage).length > 0 &&
    !textFromMessage(latestMessage) &&
    filesFromMessage(latestMessage).length === 0
  );
}

export function titleFromChatMessages(messages: WebChatMessage[]): string {
  const title = messages
    .find((message) => message.role === "user" && textFromMessage(message))
    ?.parts.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return "New web chat";
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

export const chatIndexRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/chat",
  validateSearch: validateChatSearch,
  component: ChatIndexRedirect,
});

export const chatRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/chat/$conversationId",
  validateSearch: validateChatSearch,
  component: ChatPage,
});

function ChatIndexRedirect() {
  const navigate = useNavigate();
  const search = useSearch({ from: chatIndexRoute.id }) as ChatSearch;

  useEffect(() => {
    void navigate({
      to: "/chat/$conversationId",
      params: { conversationId: createWebChatConversationId() },
      search,
      replace: true,
    });
  }, [navigate, search]);

  return null;
}

export function ChatPage() {
  const navigate = useNavigate();
  const { conversationId } = useParams({ from: chatRoute.id });
  const search = useSearch({ from: chatRoute.id }) as ChatSearch;
  const sentInitialMessage = useRef<string | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const [loadedConversationId, setLoadedConversationId] = useState<string | null>(null);
  const transport = useMemo(
    () =>
      new DefaultChatTransport<WebChatMessage>({
        api: `/api/web-chat?conversationId=${encodeURIComponent(conversationId)}`,
      }),
    [conversationId],
  );
  const chat = useChat<WebChatMessage>({
    id: conversationId,
    transport,
  });
  const historyReady = loadedConversationId === conversationId;
  const chatTitle = titleFromChatMessages(chat.messages);
  const latestMessage = chat.messages.at(-1);
  const threadScrollKey = latestMessage
    ? [
        latestMessage.id,
        latestMessage.role,
        textFromMessage(latestMessage).length,
        progressLinesFromMessage(latestMessage).join("\n").length,
        filesFromMessage(latestMessage).length,
        chat.status,
      ].join(":")
    : "";
  const hasBackgroundRun = hasPendingAssistantProgress(chat.messages);
  const chatBusy = chat.status === "submitted" || chat.status === "streaming" || hasBackgroundRun;

  useEffect(() => {
    let cancelled = false;
    setLoadedConversationId(null);
    chat.setMessages([]);
    void api.webChat
      .messages(conversationId)
      .then(({ messages }) => {
        if (!cancelled) {
          chat.setMessages(messages as WebChatMessage[]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadedConversationId(conversationId);
      });
    return () => {
      cancelled = true;
    };
  }, [chat.setMessages, conversationId]);

  useEffect(() => {
    if (!historyReady || !threadScrollKey) return;
    const frameId = window.requestAnimationFrame(() => {
      const el = threadScrollRef.current;
      if (!el) return;
      if (typeof el.scrollTo === "function") {
        el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [historyReady, threadScrollKey]);

  useEffect(() => {
    if (!historyReady || !hasBackgroundRun || chat.status !== "ready") return;
    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void api.webChat.messages(conversationId).then(({ messages }) => {
        if (!cancelled) {
          chat.setMessages(messages as WebChatMessage[]);
        }
      });
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [chat.setMessages, chat.status, conversationId, hasBackgroundRun, historyReady]);

  useEffect(() => {
    if (!historyReady) return;

    const pendingSubmission = takePendingWebChatSubmission(conversationId);
    const initialText = pendingSubmission?.text || search.message;
    const initialAttachments = pendingSubmission?.attachments ?? [];
    const initialMessageKey = initialText ? `${conversationId}:${initialText}` : null;
    if (!initialText || sentInitialMessage.current === initialMessageKey) return;
    sentInitialMessage.current = initialMessageKey;
    const requestOptions = outgoingRequestOptions(initialAttachments);
    if (requestOptions) {
      void chat.sendMessage(outgoingTextMessage(initialText, initialAttachments), requestOptions);
    } else {
      void chat.sendMessage(outgoingTextMessage(initialText));
    }
    void navigate({ to: "/chat/$conversationId", params: { conversationId }, search: {}, replace: true });
  }, [chat.sendMessage, conversationId, historyReady, navigate, search.message]);

  return (
    <TabContentContainer className="mx-auto box-content flex min-h-[calc(100vh-52px)] max-w-4xl flex-col px-10">
      <ChatHeader title={chatTitle} onBack={() => navigate({ to: "/home" })} />

      <div className="relative min-h-0 flex-1">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[28px] bg-gradient-to-b from-background to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[28px] bg-gradient-to-t from-background to-transparent" />
        <div ref={threadScrollRef} className="chat-scrollbar absolute inset-0 overflow-y-auto">
          <ChatThread
            className="pt-8 pb-12"
            messages={buildChatThreadMessages(chat.messages)}
            busy={chatBusy}
            error={chat.error?.message ?? null}
          />
        </div>
      </div>

      <div className="shrink-0 bg-background">
        <div className="pt-3 pb-[18px]">
          <ChatInput
            disabled={chatBusy}
            disabledPlaceholder="Sketch is thinking..."
            placeholder="Reply to Sketch..."
            onSubmit={(value, attachments) => {
              void chat.sendMessage(outgoingTextMessage(value, attachments), outgoingRequestOptions(attachments));
            }}
          />
        </div>
      </div>
    </TabContentContainer>
  );
}

function ChatHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex w-full shrink-0 items-center gap-[12px] py-[18px]">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to Home"
        className="shrink-0 cursor-pointer text-muted-foreground/70 transition-colors duration-100 ease-out hover:text-foreground"
      >
        <ArrowLeftIcon size={16} aria-hidden />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground/85">{title}</h1>
    </div>
  );
}
