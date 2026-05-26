import type { ConversationRowProps } from "@/components/sketch/conversation-row";
import { HomePane } from "@/components/sketch/home-pane";
import { DEFAULT_TILES, type TileDef } from "@/components/sketch/tile-grid";
import { type WebChatConversationSummary, type WorkspaceSummary, api } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { dashboardRoute, useDashboardAuth } from "./dashboard";

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

const NEXT_RUN_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function plural(value: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralLabel}`;
}

function formatNextRun(nextRunAt: string | null): string {
  if (!nextRunAt) return "no upcoming runs";
  return `next ${NEXT_RUN_FORMATTER.format(new Date(nextRunAt))}`;
}

function formatIntegrationApps(summary: WorkspaceSummary["integrations"]): string {
  const visibleApps = summary.appNames.slice(0, 3);
  if (visibleApps.length === 0) return "No connected apps";

  const overflow = Math.max(0, summary.appNames.length - visibleApps.length);
  return `${visibleApps.join(", ")}${overflow > 0 ? ` +${overflow}` : ""}`;
}

export function buildSummaryTiles(summary: WorkspaceSummary): TileDef[] {
  return [
    {
      ...DEFAULT_TILES[0],
      primary: plural(summary.automations.running, "running", "running"),
      secondary: `${plural(summary.automations.total, "total", "total")} · ${formatNextRun(summary.automations.nextRunAt)}`,
    },
    {
      ...DEFAULT_TILES[1],
      primary: `${summary.skills.total} in library`,
      secondary: `${summary.skills.yours} yours · ${summary.skills.shared} shared`,
    },
    {
      ...DEFAULT_TILES[2],
      primary: plural(summary.integrations.connected, "connected", "connected"),
      secondary: formatIntegrationApps(summary.integrations),
    },
    {
      ...DEFAULT_TILES[3],
      primary: plural(summary.team.total, "member"),
      secondary: `${plural(summary.team.humans, "person", "people")} · ${plural(summary.team.agents, "agent")}`,
    },
  ];
}

export function createWebChatConversationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `chat-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

export function chatTargetFromPrompt(value: string, createId = createWebChatConversationId) {
  return {
    to: "/chat/$conversationId" as const,
    params: { conversationId: createId() },
    search: { message: value.trim() },
  };
}

export function buildWebChatRecents(conversations: WebChatConversationSummary[]): ConversationRowProps[] {
  return conversations.slice(0, 5).map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    channel: conversation.channel,
    occurredAt: conversation.updatedAt,
  }));
}

const WEB_CHAT_CONVERSATIONS_QUERY_KEY = ["web-chat", "conversations"];

function removeWebChatConversationFromCache(
  data: { conversations: WebChatConversationSummary[] } | undefined,
  conversationId: string,
) {
  return { conversations: (data?.conversations ?? []).filter((conversation) => conversation.id !== conversationId) };
}

function getDeleteConversationError(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Failed to delete conversation";
}

export const homeRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/home",
  component: HomePage,
});

export function HomePage() {
  const auth = useDashboardAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const summaryQuery = useQuery({
    queryKey: ["workspace", "summary"],
    queryFn: () => api.workspace.summary(),
  });
  const webChatQuery = useQuery({
    queryKey: WEB_CHAT_CONVERSATIONS_QUERY_KEY,
    queryFn: () => api.webChat.conversations(),
  });
  const deleteConversationMutation = useMutation({
    mutationFn: (conversationId: string) => api.webChat.removeConversation(conversationId),
    onSuccess: (_result, conversationId) => {
      queryClient.setQueryData<{ conversations: WebChatConversationSummary[] }>(
        WEB_CHAT_CONVERSATIONS_QUERY_KEY,
        (data) => removeWebChatConversationFromCache(data, conversationId),
      );
      toast.success("Conversation deleted");
    },
    onError: (error) => {
      toast.error(getDeleteConversationError(error));
    },
  });

  return (
    <HomePane
      firstName={firstNameOf(auth.displayName)}
      tiles={summaryQuery.data ? buildSummaryTiles(summaryQuery.data) : undefined}
      recents={webChatQuery.data ? buildWebChatRecents(webChatQuery.data.conversations) : []}
      deletingConversationId={deleteConversationMutation.variables ?? null}
      onDeleteConversation={(conversation) => {
        deleteConversationMutation.mutate(conversation.id);
      }}
      onSubmit={(value) => {
        void navigate(chatTargetFromPrompt(value));
      }}
    />
  );
}
