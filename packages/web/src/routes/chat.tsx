import {
  isNativeCanvasAppConnection,
  isOwnedOrPersonalAppConnection,
} from "@/components/connections/connection-status";
import { ConnectorNudgeDialog, type ConnectorNudgeSuggestion } from "@/components/connections/connector-nudge-dialog";
import { ChatInput } from "@/components/sketch/chat-input";
import { ChatIntegrationConnectionFrame } from "@/components/sketch/chat-integration-connection-dialog";
import {
  ChatConversationLoadError,
  ChatConversationSkeleton,
  ChatRecoveryStatus,
} from "@/components/sketch/chat-route-state";
import {
  ChatThread,
  type ChatThreadFile,
  type ChatThreadIntegrationConnection,
  type ChatThreadIntegrationConnectionStatus,
  type ChatThreadMessage,
  type ChatThreadProgressIcon,
  type ChatThreadProgressIconType,
  type ChatThreadProgressItem,
  type ChatThreadTimelineEntry,
  questionBatchSignature,
} from "@/components/sketch/chat-thread";
import { DEFAULT_TILES, type TileDef } from "@/components/sketch/tile-grid";
import { useWebChatReconciliation } from "@/hooks/use-web-chat-reconciliation";
import {
  type AutomationArtifact,
  type AutomationDraftHandoff,
  type WebChatMessagesResponse,
  type WebChatQuestion,
  type WebChatQuestionAnswer,
  type WebChatQuestionBatch,
  type WebChatQuestionBatchAnswer,
  type WebChatQuestionOption,
  type WebChatToolProgress,
  type WebChatUploadedAttachment,
  type WorkspaceSummary,
  api,
} from "@/lib/api";
import { invalidateAutomationQueries } from "@/lib/automation-refresh";
import {
  createWebChatConversationId,
  hasPendingWebChatSubmission,
  shouldUseChatViewTransition,
  takePendingWebChatSubmission,
} from "@/lib/chat-target";
import { WEB_CHAT_CONVERSATIONS_QUERY_KEY, buildWebChatRecents } from "@/lib/web-chat-conversations";
import { useChat } from "@ai-sdk/react";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import type { IntegrationApp, IntegrationConnection } from "@sketch/shared";
import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { type QueryClient, isCancelledError, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { dashboardRoute } from "./dashboard";

export { buildWebChatRecents };

type WebChatDataParts = {
  progress: {
    lines?: string[];
    items?: ChatThreadProgressItem[];
  };
  interruption: {
    label?: string;
    detail?: string;
  };
  file: {
    name: string;
    url: string;
    mediaType: string;
    sizeBytes?: number;
  };
  automation: AutomationArtifact;
  "automation-handoff": AutomationDraftHandoff;
  question: WebChatQuestion;
  "question-batch": WebChatQuestionBatch;
  "question-answer": {
    questionId: string;
    optionId: string;
  };
  "question-batch-answer": WebChatQuestionBatchAnswer;
  "integration-connection": {
    requestId: string;
    appId: string;
    appName: string;
    state?: "connect" | "connected";
    icon?: string;
    reason?: string;
    accountName?: string;
    connectionId?: string | null;
  };
};

type WebChatMetadata = {
  createdAt?: string;
};

type WebChatMessage = UIMessage<WebChatMetadata, WebChatDataParts> & { createdAt?: string | Date };
type WebChatPart = WebChatMessage["parts"][number];
type WebChatLoadedMessagesResponse = Omit<WebChatMessagesResponse, "messages"> & { messages: WebChatMessage[] };
type ActiveIntegrationConnection = {
  connection: ChatThreadIntegrationConnection;
  popupWindow: Window | null;
};

export interface ChatSearch {
  message?: string;
  prefill?: string;
  new?: boolean;
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

const WEB_CHAT_MESSAGES_STALE_TIME_MS = 15_000;

export const webChatMessagesQueryKey = (conversationId: string) => ["web-chat", "messages", conversationId] as const;

function freshCachedWebChatMessages(
  queryClient: QueryClient,
  conversationId: string,
): WebChatLoadedMessagesResponse | null {
  const queryKey = webChatMessagesQueryKey(conversationId);
  const response = queryClient.getQueryData<WebChatMessagesResponse>(queryKey);
  const queryState = queryClient.getQueryState(queryKey);
  if (
    !response ||
    !queryState?.dataUpdatedAt ||
    queryState.dataUpdatedAt + WEB_CHAT_MESSAGES_STALE_TIME_MS <= Date.now()
  ) {
    return null;
  }
  return { ...response, messages: response.messages as WebChatMessage[] };
}

function isHistoryLoadAbort(error: unknown): boolean {
  return isCancelledError(error) || (error instanceof Error && error.name === "AbortError");
}

export function useKnownNewWebChatConversation(conversationId: string, hasNewConversationIntent: boolean): boolean {
  const [knownNewConversationId, setKnownNewConversationId] = useState<string | null>(() =>
    hasNewConversationIntent ? conversationId : null,
  );

  useEffect(() => {
    setKnownNewConversationId((currentConversationId) => {
      if (hasNewConversationIntent) return conversationId;
      return currentConversationId === conversationId ? currentConversationId : null;
    });
  }, [conversationId, hasNewConversationIntent]);

  return hasNewConversationIntent || knownNewConversationId === conversationId;
}

export function validateChatSearch(search: Record<string, unknown>): ChatSearch {
  const message = typeof search.message === "string" ? search.message.trim() : "";
  const prefill = typeof search.prefill === "string" ? search.prefill.trim() : "";
  const isNew = search.new === true || search.new === "true";
  return {
    ...(message ? { message } : {}),
    ...(prefill ? { prefill } : {}),
    ...(isNew ? { new: true } : {}),
  };
}

function findLastPartIndex(parts: WebChatPart[], predicate: (part: WebChatPart) => boolean): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (predicate(parts[index])) return index;
  }
  return -1;
}

function visibleMessageParts(message: WebChatMessage): WebChatPart[] {
  const latestStepStart = findLastPartIndex(message.parts, (part) => part.type === "step-start");
  return latestStepStart === -1 ? message.parts : message.parts.slice(latestStepStart + 1);
}

function latestTextIndex(parts: WebChatPart[]): number {
  return findLastPartIndex(parts, (part) => part.type === "text" && part.text.trim().length > 0);
}

function latestFileIndex(parts: WebChatPart[]): number {
  return findLastPartIndex(
    parts,
    (part) => part.type === "data-file" && part.data.name.trim().length > 0 && part.data.url.trim().length > 0,
  );
}

function latestAutomationIndex(parts: WebChatPart[]): number {
  return findLastPartIndex(
    parts,
    (part) =>
      (part.type === "data-automation" || part.type === "data-automation-handoff") &&
      part.data.taskId.trim().length > 0,
  );
}

function latestInterruptionIndex(parts: WebChatPart[]): number {
  return findLastPartIndex(
    parts,
    (part) =>
      part.type === "data-interruption" && typeof part.data.label === "string" && part.data.label.trim().length > 0,
  );
}

function latestQuestionIndex(parts: WebChatPart[]): number {
  return findLastPartIndex(parts, (part) => part.type === "data-question" || part.type === "data-question-batch");
}

const progressIconTypes = new Set<ChatThreadProgressIconType>(["tool", "skill", "canvas", "generic"]);

function progressString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function progressIconFromUnknown(value: unknown): ChatThreadProgressIcon | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const type = progressString(candidate.type);
  if (!type || !progressIconTypes.has(type as ChatThreadProgressIconType)) return undefined;

  return {
    type: type as ChatThreadProgressIconType,
    name: progressString(candidate.name),
  };
}

function progressItemFromUnknown(value: unknown): ChatThreadProgressItem | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const label = progressString(candidate.label);
  if (!label) return null;

  return {
    id: progressString(candidate.id),
    kind: progressString(candidate.kind) ?? "generic",
    label,
    detail: progressString(candidate.detail),
    toolName: progressString(candidate.toolName),
    icon: progressIconFromUnknown(candidate.icon),
  };
}

function progressItemsFromData(data: WebChatDataParts["progress"]): ChatThreadProgressItem[] {
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map(progressItemFromUnknown).filter((item): item is ChatThreadProgressItem => Boolean(item));
}

function progressLinesFromData(data: WebChatDataParts["progress"]): string[] {
  const lines = Array.isArray(data.lines) ? data.lines : [];
  return lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0);
}

function progressSnapshotFromData(data: WebChatDataParts["progress"]): {
  items: ChatThreadProgressItem[];
  lines: string[];
} {
  const items = progressItemsFromData(data);
  const lines = items.length > 0 ? [] : progressLinesFromData(data);
  return { items, lines };
}

function latestProgressPart(
  parts: WebChatPart[],
): { index: number; items: ChatThreadProgressItem[]; lines: string[] } | null {
  const index = findLastPartIndex(parts, (part) => {
    if (part.type !== "data-progress") return false;
    const progress = progressSnapshotFromData(part.data);
    return progress.items.length > 0 || progress.lines.length > 0;
  });
  if (index === -1) return null;
  const part = parts[index];
  if (part.type !== "data-progress") return null;
  const progress = progressSnapshotFromData(part.data);
  return { index, items: progress.items, lines: progress.lines };
}

function latestProgressWins(message: WebChatMessage): boolean {
  const parts = visibleMessageParts(message);
  const progress = latestProgressPart(parts);
  if (!progress) return false;
  return (
    progress.index >
    Math.max(
      latestTextIndex(parts),
      latestFileIndex(parts),
      latestAutomationIndex(parts),
      latestQuestionIndex(parts),
      latestInterruptionIndex(parts),
    )
  );
}

function textFromParts(parts: WebChatPart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function textFromMessage(message: WebChatMessage): string {
  return textFromParts(visibleMessageParts(message));
}

function filesFromParts(parts: WebChatPart[]): ChatThreadFile[] {
  return parts
    .filter((part) => part.type === "data-file")
    .map((part) => part.data)
    .filter((file) => file.name.trim().length > 0 && file.url.trim().length > 0);
}

function filesFromMessage(message: WebChatMessage): ChatThreadFile[] {
  return filesFromParts(visibleMessageParts(message));
}

function automationsFromParts(parts: WebChatPart[]): AutomationArtifact[] {
  return parts.flatMap((part) => {
    if (part.type === "data-automation") {
      return part.data.taskId.trim().length > 0 && part.data.title.trim().length > 0 ? [part.data] : [];
    }
    if (part.type !== "data-automation-handoff") return [];
    return [automationArtifactFromDraftHandoff(part.data)];
  });
}

export function automationArtifactFromDraftHandoff(handoff: AutomationDraftHandoff): AutomationArtifact {
  const builderConversationId = handoff.builderConversationId ?? handoff.sourceConversationId;
  const builderUrl = automationBuilderUrlWithConversationId(handoff.builderUrl, builderConversationId);
  return {
    taskId: handoff.taskId,
    requiresBuilder: true,
    kind: "Automation setup",
    title: "Set up automation",
    description: "Continue configuring this automation in the automation builder.",
    tags: ["Setup"],
    scheduleLabel: "Not configured",
    deliveryLabel: "Not configured",
    builderUrl,
    status: handoff.status,
  };
}

function automationBuilderUrlWithConversationId(builderUrl: string, conversationId: string): string {
  try {
    const url = new URL(builderUrl, "http://sketch.local");
    url.searchParams.set("conversationId", conversationId);
    return builderUrl.startsWith("/") ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch {
    return `${builderUrl}${builderUrl.includes("?") ? "&" : "?"}conversationId=${encodeURIComponent(conversationId)}`;
  }
}

function automationsFromMessage(message: WebChatMessage): AutomationArtifact[] {
  return automationsFromParts(visibleMessageParts(message));
}

export const AUTOMATION_BUILDER_NAVIGATION_DELAY_MS = 3_000;

type AutomationBuilderNavigation = {
  key: string;
  taskId: string;
  conversationId?: string;
  createConversation: boolean;
};

function automationBuilderNavigationFromMessage(
  message: WebChatMessage | undefined,
): AutomationBuilderNavigation | null {
  if (!message || message.role !== "assistant") return null;
  const parts = visibleMessageParts(message);
  const handoffIndex = findLastPartIndex(parts, (part) => part.type === "data-automation-handoff");
  const handoffPart = handoffIndex === -1 ? undefined : parts[handoffIndex];
  if (handoffPart?.type === "data-automation-handoff") {
    const conversationId = handoffPart.data.builderConversationId ?? handoffPart.data.sourceConversationId;
    return {
      key: `${message.id}:${handoffPart.data.taskId}:${conversationId}`,
      taskId: handoffPart.data.taskId,
      conversationId,
      createConversation: false,
    };
  }

  const automationIndex = findLastPartIndex(parts, (part) => part.type === "data-automation");
  const automationPart = automationIndex === -1 ? undefined : parts[automationIndex];
  if (automationPart?.type !== "data-automation" || automationPart.data.requiresBuilder === false) return null;
  return {
    key: `${message.id}:${automationPart.data.taskId}`,
    taskId: automationPart.data.taskId,
    createConversation: true,
  };
}

function integrationConnectionsFromParts(parts: WebChatPart[]): ChatThreadIntegrationConnection[] {
  return parts
    .filter((part) => part.type === "data-integration-connection")
    .map((part) => part.data)
    .filter(
      (connection) =>
        connection.requestId.trim().length > 0 &&
        connection.appId.trim().length > 0 &&
        connection.appName.trim().length > 0,
    );
}

function integrationConnectionsFromMessage(message: WebChatMessage): ChatThreadIntegrationConnection[] {
  return integrationConnectionsFromParts(visibleMessageParts(message));
}

function interruptionFromParts(parts: WebChatPart[]): ChatThreadMessage["interruption"] | undefined {
  const index = findLastPartIndex(
    parts,
    (part) => part.type === "data-interruption" && typeof part.data.label === "string",
  );
  const part = index === -1 ? undefined : parts[index];
  if (part?.type !== "data-interruption") return undefined;
  const label = part.data.label?.trim();
  const detail = part.data.detail?.trim();
  if (!label) return undefined;
  return { label, ...(detail ? { detail } : {}) };
}

function interruptionFromMessage(message: WebChatMessage): ChatThreadMessage["interruption"] | undefined {
  return interruptionFromParts(visibleMessageParts(message));
}

function questionFromParts(parts: WebChatPart[]): WebChatQuestion | undefined {
  const index = findLastPartIndex(parts, (part) => part.type === "data-question");
  const part = index === -1 ? undefined : parts[index];
  return part?.type === "data-question" ? part.data : undefined;
}

function questionBatchFromParts(parts: WebChatPart[]): WebChatQuestionBatch | undefined {
  const index = findLastPartIndex(parts, (part) => part.type === "data-question-batch");
  const part = index === -1 ? undefined : parts[index];
  return part?.type === "data-question-batch" ? part.data : undefined;
}

function questionBatchAnswerFromParts(parts: WebChatPart[]): WebChatQuestionBatchAnswer | undefined {
  const index = findLastPartIndex(parts, (part) => part.type === "data-question-batch-answer");
  const part = index === -1 ? undefined : parts[index];
  return part?.type === "data-question-batch-answer" ? part.data : undefined;
}

function questionFromMessage(message: WebChatMessage): WebChatQuestion | undefined {
  return questionFromParts(visibleMessageParts(message));
}

function questionBatchFromMessage(message: WebChatMessage): WebChatQuestionBatch | undefined {
  return questionBatchFromParts(visibleMessageParts(message));
}

function questionBatchAnswerFromMessage(message: WebChatMessage): WebChatQuestionBatchAnswer | undefined {
  return questionBatchAnswerFromParts(visibleMessageParts(message));
}

function appendTimelineText(entries: ChatThreadTimelineEntry[], id: string | undefined, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const previous = entries.at(-1);
  if (previous?.type === "text") {
    previous.text = [previous.text, trimmed].filter(Boolean).join("\n");
    return;
  }
  entries.push({ type: "text", ...(id ? { id } : {}), text: trimmed });
}

function webChatPartId(part: WebChatPart): string | undefined {
  const id = (part as unknown as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function progressTimelineEntry(part: Extract<WebChatPart, { type: "data-progress" }>): ChatThreadTimelineEntry | null {
  const progress = progressSnapshotFromData(part.data);
  if (progress.items.length === 0 && progress.lines.length === 0) return null;
  return {
    type: "progress",
    id: part.id,
    ...(progress.items.length > 0 ? { progressItems: progress.items } : {}),
    ...(progress.items.length === 0 && progress.lines.length > 0 ? { progressLines: progress.lines } : {}),
  };
}

function assistantTimelineFromMessage(message: WebChatMessage): ChatThreadTimelineEntry[] {
  const entries: ChatThreadTimelineEntry[] = [];
  for (const [index, part] of visibleMessageParts(message).entries()) {
    if (part.type === "text") {
      const id = webChatPartId(part) ?? `text-${index}`;
      appendTimelineText(entries, id, part.text);
      continue;
    }
    if (part.type !== "data-progress") continue;
    const entry = progressTimelineEntry(part);
    if (entry) entries.push(entry);
  }
  return entries;
}

function hasTimelineProgress(entries: ChatThreadTimelineEntry[]): boolean {
  return entries.some((entry) => entry.type === "progress");
}

export const SMOOTH_TEXT_STREAM_DELAY_MS = 180;
const SMOOTH_TEXT_MIN_CHARS_PER_SECOND = 42;
const SMOOTH_TEXT_MAX_CHARS_PER_SECOND = 520;
const SMOOTH_TEXT_BACKLOG_ACCELERATION = 2;
const WEB_CHAT_PROGRESS_MODES: Array<{ value: WebChatToolProgress; label: string }> = [
  { value: "off", label: "Off" },
  { value: "friendly", label: "Friendly" },
  { value: "technical", label: "Technical" },
];

interface SmoothAssistantTextState {
  messageId: string | null;
  targetText: string;
  availableText: string;
  pendingSegments: SmoothAssistantTextSegment[];
  text: string;
}

interface SmoothAssistantRenderState {
  messageId: string | null;
  text: string;
}

interface SmoothAssistantTextSegment {
  text: string;
  readyAt: number;
}

const emptySmoothAssistantTextState: SmoothAssistantTextState = {
  messageId: null,
  targetText: "",
  availableText: "",
  pendingSegments: [],
  text: "",
};

const emptySmoothAssistantRenderState: SmoothAssistantRenderState = {
  messageId: null,
  text: "",
};

interface GraphemeSegment {
  segment: string;
}

interface GraphemeSegmenter {
  segment(text: string): Iterable<GraphemeSegment>;
}

type GraphemeSegmenterConstructor = new (locale?: string, options?: { granularity: "grapheme" }) => GraphemeSegmenter;

function textCharacters(text: string): string[] {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: GraphemeSegmenterConstructor }).Segmenter;
  if (!Segmenter) return Array.from(text);
  return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text), ({ segment }) => segment);
}

function takeTextCharacters(text: string, count: number): string {
  return textCharacters(text).slice(0, count).join("");
}

export function nextSmoothedAssistantText(current: string, target: string, elapsedMs: number): string {
  if (!target || current === target) return target;
  if (!target.startsWith(current)) return target;

  const remaining = target.slice(current.length);
  const remainingCharacters = textCharacters(remaining).length;
  if (remainingCharacters <= 0) return target;

  const charsPerSecond = Math.min(
    SMOOTH_TEXT_MAX_CHARS_PER_SECOND,
    SMOOTH_TEXT_MIN_CHARS_PER_SECOND + remainingCharacters * SMOOTH_TEXT_BACKLOG_ACCELERATION,
  );
  const revealCount = Math.max(1, Math.floor((Math.max(elapsedMs, 16) / 1000) * charsPerSecond));
  return current + takeTextCharacters(remaining, revealCount);
}

export function releaseReadySmoothedAssistantText(
  availableText: string,
  pendingSegments: SmoothAssistantTextSegment[],
  now: number,
): { availableText: string; pendingSegments: SmoothAssistantTextSegment[] } {
  let nextAvailableText = availableText;
  const nextPendingSegments: SmoothAssistantTextSegment[] = [];

  for (const segment of pendingSegments) {
    if (segment.readyAt <= now) {
      nextAvailableText += segment.text;
    } else {
      nextPendingSegments.push(segment);
    }
  }

  return { availableText: nextAvailableText, pendingSegments: nextPendingSegments };
}

function latestSmoothableAssistantMessage(messages: ChatThreadMessage[]): ChatThreadMessage | null {
  const latest = messages.at(-1);
  if (
    !latest ||
    latest.role !== "assistant" ||
    !latest.text ||
    latest.progressItems?.length ||
    latest.progressLines?.length
  ) {
    return null;
  }
  return latest;
}

function useSmoothedChatThreadMessages(
  messages: ChatThreadMessage[],
  animateIncoming: boolean,
  resetKey: string,
): ChatThreadMessage[] {
  const [smoothText, setSmoothText] = useState<SmoothAssistantRenderState>(emptySmoothAssistantRenderState);
  const smoothRuntime = useRef<SmoothAssistantTextState>(emptySmoothAssistantTextState);
  const shouldAnimateCurrentTurn = useRef(false);
  const lastSmoothFrameAt = useRef(0);
  const latestAssistantMessage = latestSmoothableAssistantMessage(messages);
  const latestAssistantMessageId = latestAssistantMessage?.id ?? null;
  const latestAssistantText = latestAssistantMessage?.text ?? "";

  useEffect(() => {
    if (!resetKey) return;
    shouldAnimateCurrentTurn.current = false;
    lastSmoothFrameAt.current = 0;
    smoothRuntime.current = emptySmoothAssistantTextState;
    setSmoothText((current) => (current.messageId || current.text ? emptySmoothAssistantRenderState : current));
  }, [resetKey]);

  useEffect(() => {
    if (animateIncoming) shouldAnimateCurrentTurn.current = true;
  }, [animateIncoming]);

  useEffect(() => {
    let frameId: number | null = null;
    let cancelled = false;

    const publish = (next: SmoothAssistantTextState) => {
      smoothRuntime.current = next;
      setSmoothText((current) => {
        if (current.messageId === next.messageId && current.text === next.text) return current;
        return { messageId: next.messageId, text: next.text };
      });
    };

    const reset = () => {
      smoothRuntime.current = emptySmoothAssistantTextState;
      setSmoothText((current) => (current.messageId || current.text ? emptySmoothAssistantRenderState : current));
    };

    if (!latestAssistantMessageId || !latestAssistantText) {
      reset();
      return;
    }

    const now = window.performance.now();
    const current = smoothRuntime.current;
    const shouldContinue = current.messageId === latestAssistantMessageId && current.text !== current.targetText;
    const shouldAnimate = animateIncoming || shouldAnimateCurrentTurn.current || shouldContinue;
    let nextRuntime: SmoothAssistantTextState;

    if (!shouldAnimate) {
      nextRuntime = {
        messageId: latestAssistantMessageId,
        targetText: latestAssistantText,
        availableText: latestAssistantText,
        pendingSegments: [],
        text: latestAssistantText,
      };
    } else if (current.messageId === latestAssistantMessageId) {
      if (current.targetText === latestAssistantText) {
        nextRuntime = current;
      } else if (latestAssistantText.startsWith(current.targetText)) {
        const suffix = latestAssistantText.slice(current.targetText.length);
        nextRuntime = {
          ...current,
          targetText: latestAssistantText,
          pendingSegments: suffix
            ? [...current.pendingSegments, { text: suffix, readyAt: now + SMOOTH_TEXT_STREAM_DELAY_MS }]
            : current.pendingSegments,
        };
      } else {
        const text = latestAssistantText.startsWith(current.text) ? current.text : "";
        const remainingText = latestAssistantText.slice(text.length);
        nextRuntime = {
          messageId: latestAssistantMessageId,
          targetText: latestAssistantText,
          availableText: text,
          pendingSegments: remainingText ? [{ text: remainingText, readyAt: now + SMOOTH_TEXT_STREAM_DELAY_MS }] : [],
          text,
        };
      }
    } else {
      lastSmoothFrameAt.current = 0;
      nextRuntime = {
        messageId: latestAssistantMessageId,
        targetText: latestAssistantText,
        availableText: "",
        pendingSegments: [{ text: latestAssistantText, readyAt: now + SMOOTH_TEXT_STREAM_DELAY_MS }],
        text: "",
      };
    }

    publish(nextRuntime);
    if (!shouldAnimate) return;

    const tick = (frameNow: number) => {
      if (cancelled) return;
      const runtime = smoothRuntime.current;
      if (!runtime.messageId) return;

      const elapsedMs = lastSmoothFrameAt.current > 0 ? frameNow - lastSmoothFrameAt.current : 16;
      lastSmoothFrameAt.current = frameNow;
      const released = releaseReadySmoothedAssistantText(runtime.availableText, runtime.pendingSegments, frameNow);
      const nextText = nextSmoothedAssistantText(runtime.text, released.availableText, elapsedMs);
      const next = {
        ...runtime,
        availableText: released.availableText,
        pendingSegments: released.pendingSegments,
        text: nextText,
      };

      publish(next);
      if (next.text !== next.targetText || next.pendingSegments.length > 0) {
        frameId = window.requestAnimationFrame(tick);
      } else if (!animateIncoming) {
        shouldAnimateCurrentTurn.current = false;
      }
    };

    if (nextRuntime.text !== nextRuntime.targetText || nextRuntime.pendingSegments.length > 0) {
      frameId = window.requestAnimationFrame(tick);
    } else if (!animateIncoming) {
      shouldAnimateCurrentTurn.current = false;
    }

    return () => {
      cancelled = true;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [animateIncoming, latestAssistantMessageId, latestAssistantText]);

  return useMemo(() => {
    if (!smoothText.messageId) return messages;
    return messages.map((message) =>
      message.id === smoothText.messageId && message.role === "assistant" && message.text
        ? { ...message, text: smoothText.text || undefined }
        : message,
    );
  }, [messages, smoothText.messageId, smoothText.text]);
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

export function outgoingQuestionAnswerMessage(
  question: WebChatQuestion,
  answer: WebChatQuestionAnswer | WebChatQuestionOption,
) {
  const structuredAnswer: WebChatQuestionAnswer =
    "label" in answer ? { questionId: question.id, optionId: answer.id } : answer;
  const text =
    "customResponse" in structuredAnswer
      ? structuredAnswer.customResponse
      : (question.options.find((option) => option.id === structuredAnswer.optionId)?.label ??
        structuredAnswer.optionId);
  return {
    metadata: { createdAt: new Date().toISOString() },
    parts: [
      { type: "text" as const, text },
      {
        type: "data-question-answer" as const,
        id: `question-answer-${question.id}`,
        data: structuredAnswer,
      },
    ],
  };
}

export function outgoingQuestionBatchAnswerMessage(
  batch: WebChatQuestionBatch,
  answer: WebChatQuestionBatchAnswer | WebChatQuestionBatchAnswer["answers"],
) {
  const payload: WebChatQuestionBatchAnswer = Array.isArray(answer)
    ? { batchId: batch.batchId, answers: answer }
    : answer;
  const orderedAnswers = batch.questions.flatMap((question) => {
    const item = payload.answers.find((candidate) => candidate.questionId === question.id);
    return item ? [item] : [];
  });
  const orderedPayload =
    orderedAnswers.length === batch.questions.length ? { ...payload, answers: orderedAnswers } : payload;
  const labels = orderedPayload.answers.map((item) => {
    const question = batch.questions.find((candidate) => candidate.id === item.questionId);
    return "customResponse" in item
      ? item.customResponse
      : (question?.options.find((option) => option.id === item.optionId)?.label ?? item.optionId);
  });
  return {
    metadata: { createdAt: new Date().toISOString() },
    parts: [
      { type: "text" as const, text: labels.join(" · ") },
      {
        type: "data-question-batch-answer" as const,
        id: `question-batch-answer-${orderedPayload.batchId}`,
        data: orderedPayload,
      },
    ],
  };
}

export function buildChatThreadMessages(messages: WebChatMessage[]): ChatThreadMessage[] {
  return messages.flatMap<ChatThreadMessage>((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const createdAt = createdAtFromMessage(message);
    if (message.role === "assistant") {
      const timeline = assistantTimelineFromMessage(message);
      const interruption = interruptionFromMessage(message);
      const question = questionFromMessage(message);
      const questionBatch = questionBatchFromMessage(message);
      if (hasTimelineProgress(timeline)) {
        const files = filesFromMessage(message);
        const automations = automationsFromMessage(message);
        const integrationConnections = integrationConnectionsFromMessage(message);
        return [
          {
            id: message.id,
            role: message.role,
            createdAt,
            timeline,
            files: files.length > 0 ? files : undefined,
            automations: automations.length > 0 ? automations : undefined,
            integrationConnections: integrationConnections.length > 0 ? integrationConnections : undefined,
            ...(question ? { question } : {}),
            ...(questionBatch ? { questionBatch } : {}),
            ...(interruption ? { interruption } : {}),
          },
        ];
      }
    }
    const batchAnswer = message.role === "user" ? questionBatchAnswerFromMessage(message) : undefined;
    const text = textFromMessage(message) || (batchAnswer ? "Submitted answers" : "");
    const files = filesFromMessage(message);
    const automations = message.role === "assistant" ? automationsFromMessage(message) : [];
    const integrationConnections = message.role === "assistant" ? integrationConnectionsFromMessage(message) : [];
    const interruption = message.role === "assistant" ? interruptionFromMessage(message) : undefined;
    const question = message.role === "assistant" ? questionFromMessage(message) : undefined;
    const questionBatch = message.role === "assistant" ? questionBatchFromMessage(message) : undefined;
    if (
      text ||
      files.length > 0 ||
      automations.length > 0 ||
      integrationConnections.length > 0 ||
      interruption ||
      question ||
      questionBatch
    ) {
      return [
        {
          id: message.id,
          role: message.role,
          text: text || undefined,
          createdAt,
          files: files.length > 0 ? files : undefined,
          automations: automations.length > 0 ? automations : undefined,
          integrationConnections: integrationConnections.length > 0 ? integrationConnections : undefined,
          ...(question ? { question } : {}),
          ...(questionBatch ? { questionBatch } : {}),
          ...(interruption ? { interruption } : {}),
        },
      ];
    }
    return [];
  });
}

export function hasPendingAssistantProgress(messages: WebChatMessage[]): boolean {
  const latestMessage = messages.at(-1);
  if (!latestMessage || latestMessage.role !== "assistant") return false;
  return latestProgressWins(latestMessage);
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
  component: ChatIndexPage,
});

export const chatRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/chat/$conversationId",
  validateSearch: validateChatSearch,
  component: ChatPage,
});

function ChatIndexPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: chatIndexRoute.id }) as ChatSearch;

  useEffect(() => {
    void navigate({
      to: "/chat/$conversationId",
      params: { conversationId: createWebChatConversationId() },
      search: search.message || search.prefill ? search : { new: true },
      replace: true,
      viewTransition: shouldUseChatViewTransition(),
    });
  }, [navigate, search]);

  return null;
}

export function ChatPage() {
  const navigate = useNavigate();
  const { conversationId } = useParams({ from: chatRoute.id });
  const search = useSearch({ from: chatRoute.id }) as ChatSearch;
  const sentInitialMessage = useRef<string | null>(null);
  const recoveryResponsesRef = useRef(new WeakMap<WebChatMessage[], WebChatLoadedMessagesResponse>());
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const toolProgressMutationId = useRef(0);
  const handoffBaselineConversationId = useRef<string | null>(null);
  const seenAutomationHandoffs = useRef<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const hasNewConversationIntent = Boolean(
    search.new || search.message || search.prefill || hasPendingWebChatSubmission(conversationId),
  );
  const knownNewConversation = useKnownNewWebChatConversation(conversationId, hasNewConversationIntent);
  const freshCachedHistory = knownNewConversation ? null : freshCachedWebChatMessages(queryClient, conversationId);
  const [loadedConversationId, setLoadedConversationId] = useState<string | null>(() =>
    freshCachedHistory ? conversationId : null,
  );
  const [historyLoadError, setHistoryLoadError] = useState<{ conversationId: string; attempt: number } | null>(null);
  const [historyLoadAttempt, setHistoryLoadAttempt] = useState(0);
  const [toolProgress, setToolProgress] = useState<WebChatToolProgress>("friendly");
  const [pendingToolProgress, setPendingToolProgress] = useState<WebChatToolProgress | null>(null);
  const [stoppingRun, setStoppingRun] = useState(false);
  const [activeIntegrationConnection, setActiveIntegrationConnection] = useState<ActiveIntegrationConnection | null>(
    null,
  );
  const [localIntegrationConnectionStatuses, setLocalIntegrationConnectionStatuses] = useState<
    Record<string, ChatThreadIntegrationConnectionStatus>
  >({});
  const [connectorNudge, setConnectorNudge] = useState<ConnectorNudgeSuggestion | null>(null);
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
    ...(freshCachedHistory ? { messages: freshCachedHistory.messages } : knownNewConversation ? { messages: [] } : {}),
  });
  const historyReady = knownNewConversation || loadedConversationId === conversationId || freshCachedHistory !== null;
  const historyLoadFailed =
    historyLoadError?.conversationId === conversationId && historyLoadError.attempt === historyLoadAttempt;
  const loadMessagesForReconciliation = useCallback(async (targetConversationId: string, signal: AbortSignal) => {
    const response = await api.webChat.messages(targetConversationId, { signal });
    const messages = response.messages as WebChatMessage[];
    const typedResponse = { ...response, messages };
    recoveryResponsesRef.current.set(messages, typedResponse);
    return typedResponse;
  }, []);
  const setReconciledMessages = useCallback(
    (messages: WebChatMessage[]) => {
      chat.setMessages(messages);
      queryClient.setQueryData(
        webChatMessagesQueryKey(conversationId),
        recoveryResponsesRef.current.get(messages) ?? { messages, updatedAt: null },
      );
    },
    [chat.setMessages, conversationId, queryClient],
  );
  const recovery = useWebChatReconciliation({
    conversationId,
    historyReady,
    status: chat.status,
    error: chat.error,
    messages: chat.messages,
    hasPendingProgress: hasPendingAssistantProgress,
    loadMessages: loadMessagesForReconciliation,
    setMessages: setReconciledMessages,
    clearError: chat.clearError,
  });
  const chatTitle = titleFromChatMessages(chat.messages);
  const hasBackgroundRun = hasPendingAssistantProgress(chat.messages);
  const chatBusy = chat.status === "submitted" || chat.status === "streaming" || hasBackgroundRun || stoppingRun;
  const latestAutomationRefresh = useMemo(() => {
    const latestMessage = chat.messages.at(-1);
    if (!latestMessage || latestMessage.role !== "assistant") return { key: "", taskIds: [] as string[] };
    const taskIds = [...new Set(automationsFromMessage(latestMessage).map((automation) => automation.taskId))];
    return { key: `${latestMessage.id}:${taskIds.join(",")}`, taskIds };
  }, [chat.messages]);
  const lastAutomationRefreshKey = useRef<string | null>(null);
  useEffect(() => {
    if (!historyReady || !latestAutomationRefresh.key) return;
    if (lastAutomationRefreshKey.current === latestAutomationRefresh.key) return;
    lastAutomationRefreshKey.current = latestAutomationRefresh.key;
    void invalidateAutomationQueries(queryClient, latestAutomationRefresh.taskIds);
  }, [historyReady, latestAutomationRefresh, queryClient]);
  const latestAutomationNavigation = useMemo(
    () => automationBuilderNavigationFromMessage(chat.messages.at(-1)),
    [chat.messages],
  );
  const automationNavigationBaselineConversationId = useRef<string | null>(null);
  const lastAutomationNavigationKey = useRef<string | null>(null);
  useEffect(() => {
    if (!historyReady || automationNavigationBaselineConversationId.current === conversationId) return;
    automationNavigationBaselineConversationId.current = conversationId;
    lastAutomationNavigationKey.current = latestAutomationNavigation?.key ?? "";
  }, [conversationId, historyReady, latestAutomationNavigation]);
  useEffect(() => {
    if (!historyReady || !latestAutomationNavigation) return;
    if (lastAutomationNavigationKey.current === latestAutomationNavigation.key) return;
    lastAutomationNavigationKey.current = latestAutomationNavigation.key;
    let cancelled = false;
    const openBuilder = (builderConversationId: string) => {
      if (cancelled) return;
      void navigate({
        to: "/scheduled-tasks/$taskId/edit",
        params: { taskId: latestAutomationNavigation.taskId },
        search: { conversationId: builderConversationId },
        viewTransition: shouldUseChatViewTransition(),
      });
    };
    const timeoutId = window.setTimeout(() => {
      if (!latestAutomationNavigation.createConversation && latestAutomationNavigation.conversationId) {
        openBuilder(latestAutomationNavigation.conversationId);
        return;
      }
      void api.scheduledTasks
        .createConversation(latestAutomationNavigation.taskId, { createNew: true })
        .then(({ conversation }) => openBuilder(conversation.conversationId))
        .catch(() => toast.error("Could not open automation setup"));
    }, AUTOMATION_BUILDER_NAVIGATION_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [historyReady, latestAutomationNavigation, navigate]);
  const rawThreadMessages = useMemo(() => buildChatThreadMessages(chat.messages), [chat.messages]);
  const threadMessages = useSmoothedChatThreadMessages(rawThreadMessages, chatBusy, conversationId);
  const integrationConnectionCards = useMemo(
    () => threadMessages.flatMap((message) => message.integrationConnections ?? []),
    [threadMessages],
  );
  const hasIntegrationConnectionCards = integrationConnectionCards.length > 0;
  const serversQuery = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.mcpServers.list(),
    enabled: hasIntegrationConnectionCards,
  });
  const provider = useMemo(
    () => (serversQuery.data ?? []).find((server) => server.type != null) ?? null,
    [serversQuery.data],
  );
  const providerLoading = hasIntegrationConnectionCards && serversQuery.isLoading;
  const connectionsQuery = useQuery({
    queryKey: ["connections", provider?.id],
    queryFn: () => api.mcpServers.listConnections(provider?.id ?? ""),
    enabled: hasIntegrationConnectionCards && !!provider,
  });
  const connectedAppIds = useMemo(
    () =>
      new Set(
        (connectionsQuery.data ?? [])
          .filter((connection) => isOwnedOrPersonalAppConnection(connection))
          .map((connection) => connection.appId),
      ),
    [connectionsQuery.data],
  );
  const integrationConnectionStatuses = useMemo(() => {
    const statuses: Record<string, ChatThreadIntegrationConnectionStatus> = {};
    const providerUnavailable =
      hasIntegrationConnectionCards &&
      (serversQuery.isError || (!serversQuery.isLoading && serversQuery.isFetched && !provider));
    for (const connection of integrationConnectionCards) {
      statuses[connection.requestId] =
        connection.state === "connected" || connectedAppIds.has(connection.appId)
          ? "connected"
          : providerLoading
            ? "loading"
            : providerUnavailable
              ? "unavailable"
              : (localIntegrationConnectionStatuses[connection.requestId] ?? "idle");
    }
    return statuses;
  }, [
    connectedAppIds,
    hasIntegrationConnectionCards,
    integrationConnectionCards,
    localIntegrationConnectionStatuses,
    provider,
    providerLoading,
    serversQuery.isError,
    serversQuery.isFetched,
    serversQuery.isLoading,
  ]);
  const latestThreadMessage = threadMessages.at(-1);
  const threadScrollKey = latestThreadMessage
    ? [
        latestThreadMessage.id,
        latestThreadMessage.role,
        latestThreadMessage.text?.length ?? 0,
        latestThreadMessage.timeline
          ?.map((entry) =>
            entry.type === "text"
              ? `text:${entry.text}`
              : `progress:${(entry.progressItems ?? [])
                  .map(
                    (item) => `${item.id ?? ""}:${item.kind}:${item.label}:${item.detail ?? ""}:${item.toolName ?? ""}`,
                  )
                  .join("\n")}:${entry.progressLines?.join("\n") ?? ""}`,
          )
          .join("\n").length ?? 0,
        latestThreadMessage.progressItems
          ?.map((item) => `${item.id ?? ""}:${item.kind}:${item.label}:${item.detail ?? ""}:${item.toolName ?? ""}`)
          .join("\n").length ?? 0,
        latestThreadMessage.progressLines?.join("\n").length ?? 0,
        latestThreadMessage.files?.length ?? 0,
        latestThreadMessage.integrationConnections?.length ?? 0,
        latestThreadMessage.question
          ? `${latestThreadMessage.question.id}:${latestThreadMessage.question.options.map((option) => option.id).join(",")}`
          : "",
        latestThreadMessage.questionBatch ? questionBatchSignature(latestThreadMessage.questionBatch) : "",
        chat.status,
      ].join(":")
    : "";

  useEffect(() => {
    let cancelled = false;
    void api.webChat
      .progressSettings()
      .then(({ toolProgress }) => {
        if (!cancelled) setToolProgress(toolProgress);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToolProgressChange = (nextToolProgress: WebChatToolProgress) => {
    if (nextToolProgress === (pendingToolProgress ?? toolProgress)) return;
    const previousToolProgress = toolProgress;
    const mutationId = toolProgressMutationId.current + 1;
    toolProgressMutationId.current = mutationId;
    setToolProgress(nextToolProgress);
    setPendingToolProgress(nextToolProgress);
    void api.webChat
      .updateProgressSettings(nextToolProgress)
      .then(({ toolProgress }) => {
        if (toolProgressMutationId.current === mutationId) setToolProgress(toolProgress);
      })
      .catch(() => {
        if (toolProgressMutationId.current === mutationId) setToolProgress(previousToolProgress);
      })
      .finally(() => {
        if (toolProgressMutationId.current === mutationId) setPendingToolProgress(null);
      });
  };

  const handleStop = useCallback(() => {
    if (stoppingRun) return;
    setStoppingRun(true);
    void api.webChat
      .interrupt(conversationId)
      .catch(() => undefined)
      .finally(() => setStoppingRun(false));
  }, [conversationId, stoppingRun]);

  const handleAnswerQuestion = useCallback(
    (question: WebChatQuestion, answer: WebChatQuestionAnswer) => {
      queryClient.removeQueries({ queryKey: webChatMessagesQueryKey(conversationId), exact: true });
      void Promise.resolve(chat.sendMessage(outgoingQuestionAnswerMessage(question, answer))).then(() =>
        queryClient.invalidateQueries({ queryKey: WEB_CHAT_CONVERSATIONS_QUERY_KEY }),
      );
    },
    [chat.sendMessage, conversationId, queryClient],
  );

  const handleSelectQuestion = useCallback(
    (question: WebChatQuestion, option: WebChatQuestionOption) => {
      queryClient.removeQueries({ queryKey: webChatMessagesQueryKey(conversationId), exact: true });
      void Promise.resolve(chat.sendMessage(outgoingQuestionAnswerMessage(question, option))).then(() =>
        queryClient.invalidateQueries({ queryKey: WEB_CHAT_CONVERSATIONS_QUERY_KEY }),
      );
    },
    [chat.sendMessage, conversationId, queryClient],
  );

  const handleSubmitQuestionBatch = useCallback(
    (batch: WebChatQuestionBatch, answer: WebChatQuestionBatchAnswer) => {
      queryClient.removeQueries({ queryKey: webChatMessagesQueryKey(conversationId), exact: true });
      void Promise.resolve(chat.sendMessage(outgoingQuestionBatchAnswerMessage(batch, answer))).then(() =>
        queryClient.invalidateQueries({ queryKey: WEB_CHAT_CONVERSATIONS_QUERY_KEY }),
      );
    },
    [chat.sendMessage, conversationId, queryClient],
  );

  const handleIntegrationConnectionStatusChange = useCallback(
    (requestId: string, status: ChatThreadIntegrationConnectionStatus) => {
      setLocalIntegrationConnectionStatuses((current) => ({ ...current, [requestId]: status }));
    },
    [],
  );

  const maybeShowConnectorNudge = useCallback(async (connection: IntegrationConnection) => {
    if (!isNativeCanvasAppConnection(connection)) return;
    try {
      const result = await api.integrations.canvasSuggestion(connection.appId, connection.id, connection.source);
      if (result.suggestion) {
        setConnectorNudge({
          ...result.suggestion,
          appName: connection.appName,
          icon: connection.icon ?? connection.app?.imgSrc,
        });
      }
    } catch {
      return;
    }
  }, []);

  const handleConnectIntegration = useCallback(
    (connection: ChatThreadIntegrationConnection) => {
      if (providerLoading) return;
      if (!provider) {
        setLocalIntegrationConnectionStatuses((current) => ({ ...current, [connection.requestId]: "unavailable" }));
        toast.error("No integration provider is configured");
        return;
      }
      const popupWindow = window.open("about:blank", "_blank", "width=600,height=700");
      if (!popupWindow || popupWindow.closed) {
        setLocalIntegrationConnectionStatuses((current) => ({ ...current, [connection.requestId]: "error" }));
        toast.error("Sketch could not open the connection window. Allow popups and try again.");
        return;
      }
      setLocalIntegrationConnectionStatuses((current) => ({ ...current, [connection.requestId]: "connecting" }));
      setActiveIntegrationConnection({ connection, popupWindow });
    },
    [provider, providerLoading],
  );

  const handleIntegrationConnected = useCallback(
    (_app?: IntegrationApp, connection?: IntegrationConnection) => {
      queryClient.invalidateQueries({ queryKey: ["connections"] });
      queryClient.invalidateQueries({ queryKey: ["workspace", "summary"] });
      if (connection) void maybeShowConnectorNudge(connection);
    },
    [maybeShowConnectorNudge, queryClient],
  );

  const handleIntegrationConnectionOpenChange = useCallback((open: boolean) => {
    if (!open) setActiveIntegrationConnection(null);
  }, []);

  const retryHistoryLoad = useCallback(() => {
    setHistoryLoadError((error) => (error?.conversationId === conversationId ? null : error));
    setHistoryLoadAttempt((attempt) => attempt + 1);
  }, [conversationId]);

  useEffect(() => {
    let active = true;
    const queryKey = webChatMessagesQueryKey(conversationId);
    setHistoryLoadError((error) => (error?.conversationId === conversationId ? null : error));
    if (knownNewConversation) {
      handoffBaselineConversationId.current = conversationId;
      seenAutomationHandoffs.current = new Set();
      setLoadedConversationId(conversationId);
      return;
    }
    const cachedHistory = freshCachedWebChatMessages(queryClient, conversationId);
    if (cachedHistory) {
      handoffBaselineConversationId.current = conversationId;
      seenAutomationHandoffs.current = new Set(
        automationHandoffsFromMessages(cachedHistory.messages).map(automationHandoffKey),
      );
      chat.setMessages(cachedHistory.messages);
      setLoadedConversationId(conversationId);
    } else {
      handoffBaselineConversationId.current = null;
      seenAutomationHandoffs.current = new Set();
      chat.setMessages([]);
      setLoadedConversationId(null);
    }
    void queryClient
      .fetchQuery({
        queryKey,
        queryFn: ({ signal }) => api.webChat.messages(conversationId, { signal }),
        staleTime: WEB_CHAT_MESSAGES_STALE_TIME_MS,
      })
      .then(({ messages }) => {
        if (!active) return;
        handoffBaselineConversationId.current = conversationId;
        seenAutomationHandoffs.current = new Set(automationHandoffsFromMessages(messages).map(automationHandoffKey));
        chat.setMessages(messages as WebChatMessage[]);
        setLoadedConversationId(conversationId);
      })
      .catch((error: unknown) => {
        if (!active || isHistoryLoadAbort(error)) return;
        setHistoryLoadError({ conversationId, attempt: historyLoadAttempt });
        setLoadedConversationId((currentConversationId) =>
          currentConversationId === conversationId ? null : currentConversationId,
        );
      });
    return () => {
      active = false;
      void queryClient.cancelQueries({ queryKey, exact: true });
    };
  }, [chat.setMessages, conversationId, historyLoadAttempt, knownNewConversation, queryClient]);

  useEffect(() => {
    if (!historyReady || handoffBaselineConversationId.current !== conversationId) return;
    const handoffs = automationHandoffsFromMessages(chat.messages);
    const freshHandoff = handoffs.find((handoff) => !seenAutomationHandoffs.current.has(automationHandoffKey(handoff)));
    for (const handoff of handoffs) seenAutomationHandoffs.current.add(automationHandoffKey(handoff));
    if (!freshHandoff) return;

    void navigate({
      to: "/scheduled-tasks/$taskId/edit",
      params: { taskId: freshHandoff.taskId },
      search: { conversationId: freshHandoff.sourceConversationId },
      viewTransition: shouldUseChatViewTransition(),
    });
  }, [chat.messages, conversationId, historyReady, navigate]);

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
    if (!historyReady) return;

    const pendingSubmission = takePendingWebChatSubmission(conversationId);
    const initialText = pendingSubmission?.text || search.message;
    const initialAttachments = pendingSubmission?.attachments ?? [];
    const initialMessageKey = initialText ? `${conversationId}:${initialText}` : null;
    if (!initialText || sentInitialMessage.current === initialMessageKey) return;
    sentInitialMessage.current = initialMessageKey;
    queryClient.removeQueries({ queryKey: webChatMessagesQueryKey(conversationId), exact: true });
    const requestOptions = outgoingRequestOptions(initialAttachments);
    const send = requestOptions
      ? chat.sendMessage(outgoingTextMessage(initialText, initialAttachments), requestOptions)
      : chat.sendMessage(outgoingTextMessage(initialText));
    void Promise.resolve(send).then(() =>
      queryClient.invalidateQueries({ queryKey: WEB_CHAT_CONVERSATIONS_QUERY_KEY }),
    );
    void navigate({
      to: "/chat/$conversationId",
      params: { conversationId },
      search: {},
      replace: true,
      viewTransition: shouldUseChatViewTransition(),
    });
  }, [chat.sendMessage, conversationId, historyReady, navigate, queryClient, search.message]);

  useEffect(() => {
    if (!search.prefill) return;
    void navigate({ to: "/chat/$conversationId", params: { conversationId }, search: {}, replace: true });
  }, [conversationId, navigate, search.prefill]);

  return (
    <TabContentContainer className="mx-auto box-content flex min-h-[calc(100vh-3rem)] max-w-4xl flex-col w-[calc(100%-32px)] px-4 sm:w-[calc(100%-80px)] sm:px-10 md:min-h-screen">
      <ChatHeader title={chatTitle} onBack={() => navigate({ to: "/home" })} />

      <div className="sketch-chat-route-enter relative min-h-0 flex-1">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[28px] bg-gradient-to-b from-background to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[28px] bg-gradient-to-t from-background to-transparent" />
        <div
          ref={threadScrollRef}
          className="chat-scrollbar absolute inset-y-0 left-0 right-[-18px] overflow-y-auto pr-[18px]"
        >
          {historyReady ? (
            <ChatThread
              className="pt-8 pb-12"
              messages={threadMessages}
              busy={chatBusy}
              error={recovery.suppressError ? null : (chat.error?.message ?? null)}
              integrationConnectionStatuses={integrationConnectionStatuses}
              onConnectIntegration={handleConnectIntegration}
              onAnswerQuestion={handleAnswerQuestion}
              onSelectQuestion={handleSelectQuestion}
              onSubmitQuestionBatch={handleSubmitQuestionBatch}
              conversationId={conversationId}
            />
          ) : historyLoadFailed ? (
            <div className="pt-8 pb-12">
              <ChatConversationLoadError onRetry={retryHistoryLoad} />
            </div>
          ) : (
            <div className="pt-8 pb-12">
              <ChatConversationSkeleton />
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 bg-background">
        <div className="pt-3 pb-[18px]">
          <ChatRecoveryStatus stage={recovery.stage} onRetry={recovery.retryNow} />
          <ChatInput
            key={conversationId}
            initialValue={search.prefill ?? ""}
            disabled={!historyReady || chatBusy}
            disabledPlaceholder={
              historyLoadFailed
                ? "Conversation unavailable"
                : historyReady
                  ? "Sketch is thinking..."
                  : "Loading conversation..."
            }
            running={chatBusy}
            runningPlaceholder="Sketch is thinking..."
            stopping={stoppingRun}
            rendererValue={pendingToolProgress ?? toolProgress}
            rendererSaving={pendingToolProgress !== null}
            rendererOptions={WEB_CHAT_PROGRESS_MODES}
            onRendererChange={handleToolProgressChange}
            onStop={handleStop}
            placeholder="Reply to Sketch..."
            onSubmit={(value, attachments) => {
              queryClient.removeQueries({ queryKey: webChatMessagesQueryKey(conversationId), exact: true });
              const send = chat.sendMessage(
                outgoingTextMessage(value, attachments),
                outgoingRequestOptions(attachments),
              );
              void Promise.resolve(send).then(() =>
                queryClient.invalidateQueries({ queryKey: WEB_CHAT_CONVERSATIONS_QUERY_KEY }),
              );
              if (search.new) {
                void navigate({
                  to: "/chat/$conversationId",
                  params: { conversationId },
                  search: {},
                  replace: true,
                });
              }
            }}
          />
        </div>
      </div>

      <ChatIntegrationConnectionFrame
        open={activeIntegrationConnection !== null}
        providerId={provider?.id ?? null}
        connection={activeIntegrationConnection?.connection ?? null}
        popupWindow={activeIntegrationConnection?.popupWindow ?? null}
        onOpenChange={handleIntegrationConnectionOpenChange}
        onStatusChange={handleIntegrationConnectionStatusChange}
        onConnected={handleIntegrationConnected}
      />

      <ConnectorNudgeDialog
        suggestion={connectorNudge}
        onOpenChange={(open) => {
          if (!open) setConnectorNudge(null);
        }}
        onConnected={() => {
          queryClient.invalidateQueries({ queryKey: ["integrations"] });
          queryClient.invalidateQueries({ queryKey: ["workspace", "summary"] });
        }}
      />
    </TabContentContainer>
  );
}

function ChatHeader({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}) {
  return (
    <div className="flex w-full shrink-0 items-center gap-[12px] py-[18px]">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to Chat"
        className="shrink-0 cursor-pointer text-muted-foreground/70 transition-colors duration-100 ease-out hover:text-foreground"
      >
        <ArrowLeftIcon size={16} aria-hidden />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground/85">{title}</h1>
    </div>
  );
}
