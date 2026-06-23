import { ChatInput } from "@/components/sketch/chat-input";
import { ChatThread, type ChatThreadInterruption, type ChatThreadMessage } from "@/components/sketch/chat-thread";
import {
  type AutomationArtifact,
  type AutomationBuilderSaveRequest,
  type AutomationDefinition,
  type AutomationStepContent,
  type StepOutput,
  type WebChatUploadedAttachment,
  type WorkflowEdge,
  type WorkflowStep,
  api,
} from "@/lib/api";
import { useChat } from "@ai-sdk/react";
import {
  BracketsCurlyIcon,
  CalendarDotsIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CircleIcon,
  CodeIcon,
  EnvelopeSimpleIcon,
  EyeIcon,
  GitBranchIcon,
  GlobeHemisphereWestIcon,
  GoogleLogoIcon,
  type IconProps,
  LightningIcon,
  PlayIcon,
  RobotIcon,
  SlackLogoIcon,
  SpinnerGapIcon,
  TableIcon,
  WebhooksLogoIcon,
  WhatsappLogoIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Button } from "@sketch/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { Input } from "@sketch/ui/components/input";
import { Textarea } from "@sketch/ui/components/textarea";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  type CSSProperties,
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { dashboardRoute } from "./dashboard";

interface BuilderSearch {
  conversationId?: string;
}

interface DraftAutomation {
  title: string | null;
  description: string | null;
  prompt: string;
  scheduleType: AutomationDefinition["scheduleType"];
  scheduleValue: string;
  timezone: string;
  status: AutomationDefinition["status"];
  delivery: AutomationDefinition["delivery"];
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  stepContent: Record<string, AutomationStepContent>;
  revision: number;
}

type UiStatus = "idle" | "running" | "success" | "failed" | "skipped";

type BuilderWebChatDataParts = {
  progress: {
    lines: string[];
  };
  file: {
    name: string;
    url: string;
    mediaType: string;
    sizeBytes?: number;
  };
  automation: AutomationArtifact;
  interruption: ChatThreadInterruption;
};

type BuilderWebChatMetadata = {
  createdAt?: string;
};

type BuilderWebChatMessage = UIMessage<BuilderWebChatMetadata, BuilderWebChatDataParts> & {
  createdAt?: string | Date;
};

const canvasToolbarButtonClass =
  "h-8 rounded-[7px] border-white/10 bg-[#101010]/90 text-white/82 shadow-none backdrop-blur hover:bg-[#1b1b1b] hover:text-white";
const builderInputClass =
  "h-10 rounded-[8px] border-white/10 bg-[#101010] text-[13px] text-white shadow-none placeholder:text-white/35 focus-visible:border-brand-accent/55 focus-visible:ring-brand-accent/20";
const builderTextareaClass =
  "rounded-[8px] border-white/10 bg-[#1d1d1b] text-[13px] leading-5 text-white shadow-none placeholder:text-white/35 focus-visible:border-brand-accent/55 focus-visible:ring-brand-accent/20";
const builderReadOnlyInputClass = cn(
  builderInputClass,
  "cursor-default focus-visible:border-white/10 focus-visible:ring-0",
);
const builderReadOnlyTextareaClass = cn(
  builderTextareaClass,
  "cursor-default focus-visible:border-white/10 focus-visible:ring-0",
);
const flowEdgeStyle = {
  stroke: "#5A6587",
  strokeWidth: 1.2,
  opacity: 0.84,
} satisfies CSSProperties;
const connectionLineStyle = {
  stroke: "#6B7DFA",
  strokeWidth: 2,
  strokeDasharray: "5 5",
} satisfies CSSProperties;
const builderChatSuggestions: Array<{ label: string; prompt: string; icon: ComponentType<IconProps> }> = [
  {
    label: "Change schedule",
    prompt: "Change the schedule for this automation.",
    icon: CalendarDotsIcon,
  },
  {
    label: "Add a step",
    prompt: "Add one useful step to this automation.",
    icon: GitBranchIcon,
  },
  {
    label: "Tighten criteria",
    prompt: "Tighten the criteria this automation uses before it acts.",
    icon: CheckCircleIcon,
  },
];

export const automationBuilderRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/scheduled-tasks/$taskId/edit",
  validateSearch: (search: Record<string, unknown>): BuilderSearch => {
    const conversationId = typeof search.conversationId === "string" ? search.conversationId.trim() : "";
    return conversationId ? { conversationId } : {};
  },
  component: AutomationBuilderPage,
});

function draftFromDefinition(automation: AutomationDefinition): DraftAutomation {
  return {
    title: automation.title,
    description: automation.description,
    prompt: automation.prompt,
    scheduleType: automation.scheduleType,
    scheduleValue: automation.scheduleValue,
    timezone: automation.timezone,
    status: automation.status,
    delivery: automation.delivery,
    steps: automation.steps,
    edges: automation.edges,
    stepContent: automation.stepContent,
    revision: automation.revision,
  };
}

function saveRequestFromDraft(draft: DraftAutomation): AutomationBuilderSaveRequest {
  return {
    expectedRevision: draft.revision,
    title: draft.title,
    description: draft.description,
    prompt: draft.prompt,
    scheduleType: draft.scheduleType,
    scheduleValue: draft.scheduleValue,
    timezone: draft.timezone,
    status: draft.status,
    delivery: draft.delivery,
    steps: draft.steps,
    edges: draft.edges,
    stepContent: draft.stepContent,
  };
}

export function AutomationBuilderPage() {
  const { taskId } = useParams({ from: automationBuilderRoute.id });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["scheduled-tasks", taskId, "builder"] as const, [taskId]);
  const builderConversationId = useMemo(() => freshBuilderConversationId(taskId), [taskId]);
  const [draft, setDraft] = useState<DraftAutomation | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [savingPromptStepId, setSavingPromptStepId] = useState<string | null>(null);
  const latestDraftRef = useRef<DraftAutomation | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const automationQuery = useQuery({
    queryKey,
    queryFn: () => api.scheduledTasks.get(taskId),
    refetchInterval: (query) => (query.state.data?.recentRuns.some((run) => run.status === "running") ? 1500 : false),
  });

  useEffect(() => {
    if (!automationQuery.data) return;
    const nextDraft = draftFromDefinition(automationQuery.data);
    latestDraftRef.current = nextDraft;
    setDraft(nextDraft);
  }, [automationQuery.data]);

  const runMutation = useMutation({
    mutationFn: () => api.scheduledTasks.run(taskId),
    onSuccess: async () => {
      toast.success("Automation run started");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to run automation"),
  });

  const testMutation = useMutation({
    mutationFn: (stepId: string) => api.scheduledTasks.testStep(taskId, stepId, { useLatestUpstreamOutput: true }),
    onSuccess: async () => {
      toast.success("Node test finished");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Node test failed"),
  });

  const saveDraftPatch = useCallback(
    (
      patch: (current: DraftAutomation) => DraftAutomation,
      options: { message?: string; promptStepId?: string } = {},
    ) => {
      if (options.promptStepId) setSavingPromptStepId(options.promptStepId);
      const save = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const currentDraft = latestDraftRef.current;
          if (!currentDraft) return;

          const nextDraft = patch(currentDraft);
          latestDraftRef.current = nextDraft;
          setDraft(nextDraft);
          if (options.promptStepId) setSavingPromptStepId(options.promptStepId);

          try {
            const updatedAutomation = await api.scheduledTasks.save(taskId, saveRequestFromDraft(nextDraft));
            const updatedDraft = draftFromDefinition(updatedAutomation);
            latestDraftRef.current = updatedDraft;
            queryClient.setQueryData(queryKey, updatedAutomation);
            setDraft(updatedDraft);
            if (options.message) toast.success(options.message);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Failed to save automation");
            try {
              const refreshed = await api.scheduledTasks.get(taskId);
              const refreshedDraft = draftFromDefinition(refreshed);
              latestDraftRef.current = refreshedDraft;
              queryClient.setQueryData(queryKey, refreshed);
              setDraft(refreshedDraft);
            } catch {
              await queryClient.invalidateQueries({ queryKey });
            }
            throw error;
          } finally {
            if (options.promptStepId) {
              setSavingPromptStepId((current) => (current === options.promptStepId ? null : current));
            }
          }
        });
      saveQueueRef.current = save.catch(() => undefined);
    },
    [queryClient, queryKey, taskId],
  );

  const updateAgentPrompt = useCallback(
    (stepId: string, content: string) => {
      saveDraftPatch(
        (current) => {
          const existing = current.stepContent[stepId];
          return {
            ...current,
            stepContent: {
              ...current.stepContent,
              [stepId]: {
                taskId,
                stepId,
                contentType: "prompt",
                content,
                apps: existing?.apps ?? null,
                updatedAt: existing?.updatedAt ?? null,
              },
            },
          };
        },
        { message: "Prompt saved", promptStepId: stepId },
      );
    },
    [saveDraftPatch, taskId],
  );

  const updateStepPositions = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      saveDraftPatch((current) => ({
        ...current,
        steps: current.steps.map((step) => (positions[step.id] ? { ...step, position: positions[step.id] } : step)),
      }));
    },
    [saveDraftPatch],
  );

  if (automationQuery.isLoading || !draft || !automationQuery.data) {
    return (
      <div className="flex min-h-[calc(100vh-52px)] items-center justify-center text-sm text-muted-foreground">
        Loading builder...
      </div>
    );
  }

  if (automationQuery.isError) {
    return <div className="p-10 text-sm text-destructive">Failed to load automation.</div>;
  }

  const automation = automationQuery.data;
  const selectedRun = selectedRunId
    ? automation.recentRuns.find((run) => run.id === selectedRunId)
    : automation.latestRun;
  const selectedStep = draft.steps.find((step) => step.id === selectedStepId) ?? null;
  const selectedOutput = selectedStep ? selectedRun?.stepOutputs[selectedStep.id] : undefined;
  const builderTitle = draft.title?.trim() || draft.prompt;
  return (
    <div className="relative flex h-[calc(100vh-52px)] min-h-0 overflow-hidden bg-background">
      <BuilderChatSidecar
        conversationId={builderConversationId}
        taskId={taskId}
        title={builderTitle}
        queryKey={queryKey}
        className="hidden lg:flex"
      />

      <div className="relative min-h-0 min-w-0 flex-1 bg-[#050505] text-white">
        <div className="pointer-events-none absolute top-4 left-4 right-4 z-10 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-2 rounded-[8px] border border-white/10 bg-[#0b0b0b]/88 p-1.5 shadow-[0_10px_34px_rgba(0,0,0,0.34)] backdrop-blur">
            <RunsMenu
              runs={automation.recentRuns}
              activeRunId={selectedRun?.id ?? null}
              onSelectRun={(runId) => setSelectedRunId(runId)}
            />
            {selectedRunId ? (
              <Button
                size="sm"
                variant="outline"
                className={canvasToolbarButtonClass}
                onClick={() => setSelectedRunId(null)}
              >
                Latest
              </Button>
            ) : null}
          </div>

          <div className="pointer-events-auto ml-auto flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              className={canvasToolbarButtonClass}
              onClick={() => navigate({ to: "/scheduled-tasks" })}
            >
              Close
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 rounded-[7px] bg-brand-accent text-[#161300] shadow-none hover:bg-brand-accent/90"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
            >
              {runMutation.isPending ? (
                <SpinnerGapIcon size={14} className="animate-spin" />
              ) : (
                <PlayIcon size={14} weight="fill" />
              )}
              Run
            </Button>
          </div>
        </div>

        <AutomationCanvas
          draft={draft}
          selectedStepId={selectedStepId}
          stepOutputs={selectedRun?.stepOutputs ?? {}}
          runStatus={selectedRun?.status}
          onSelectStep={setSelectedStepId}
          onUpdateStepPositions={updateStepPositions}
        />
      </div>

      <NodeDrawer
        key={selectedStep?.id ?? "closed"}
        draft={draft}
        step={selectedStep}
        output={selectedOutput}
        onClose={() => setSelectedStepId(null)}
        onTest={(stepId) => testMutation.mutate(stepId)}
        testingStepId={testMutation.variables ?? null}
        onUpdateAgentPrompt={updateAgentPrompt}
        savingPromptStepId={savingPromptStepId}
      />
    </div>
  );
}

function textFromBuilderMessage(message: BuilderWebChatMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function progressLinesFromBuilderMessage(message: BuilderWebChatMessage): string[] {
  const progressPart = message.parts.find((part) => part.type === "data-progress");
  return progressPart?.data.lines.filter((line) => line.trim().length > 0) ?? [];
}

function filesFromBuilderMessage(message: BuilderWebChatMessage) {
  return message.parts
    .filter((part) => part.type === "data-file")
    .map((part) => part.data)
    .filter((file) => file.name.trim().length > 0 && file.url.trim().length > 0);
}

function automationsFromBuilderMessage(message: BuilderWebChatMessage): AutomationArtifact[] {
  return message.parts.filter((part) => part.type === "data-automation").map((part) => part.data);
}

function interruptionFromBuilderMessage(message: BuilderWebChatMessage): ChatThreadInterruption | undefined {
  const part = message.parts.find((candidate) => candidate.type === "data-interruption");
  return part?.data;
}

function createdAtFromBuilderMessage(message: BuilderWebChatMessage): string | undefined {
  const value = message.createdAt;
  if (typeof value === "string" && value.trim()) return value;
  if (value instanceof Date) return value.toISOString();
  return message.metadata?.createdAt?.trim() || undefined;
}

function builderChatThreadMessages(messages: BuilderWebChatMessage[]): ChatThreadMessage[] {
  return messages.flatMap<ChatThreadMessage>((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textFromBuilderMessage(message);
    const files = filesFromBuilderMessage(message);
    const automations = automationsFromBuilderMessage(message);
    const interruption = interruptionFromBuilderMessage(message);
    const createdAt = createdAtFromBuilderMessage(message);
    if (text || files.length > 0 || automations.length > 0 || interruption) {
      return [
        {
          id: message.id,
          role: message.role,
          text: text || undefined,
          createdAt,
          files: files.length > 0 ? files : undefined,
          automations: automations.length > 0 ? automations : undefined,
          interruption,
        },
      ];
    }
    if (message.role === "assistant") {
      const progressLines = progressLinesFromBuilderMessage(message);
      if (progressLines.length > 0) return [{ id: message.id, role: message.role, createdAt, progressLines }];
    }
    return [];
  });
}

function hasPendingBuilderAssistantProgress(messages: BuilderWebChatMessage[]): boolean {
  const latestMessage = messages.at(-1);
  if (!latestMessage || latestMessage.role !== "assistant") return false;
  return (
    progressLinesFromBuilderMessage(latestMessage).length > 0 &&
    !textFromBuilderMessage(latestMessage) &&
    !interruptionFromBuilderMessage(latestMessage) &&
    filesFromBuilderMessage(latestMessage).length === 0 &&
    automationsFromBuilderMessage(latestMessage).length === 0
  );
}

function outgoingBuilderTextMessage(text: string, attachments: WebChatUploadedAttachment[] = []) {
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

function outgoingBuilderRequestOptions(taskId: string, attachments: WebChatUploadedAttachment[]) {
  return {
    body: {
      automationTaskId: taskId,
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  };
}

function freshBuilderConversationId(taskId: string): string {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "task";
  const rawSuffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const suffix = rawSuffix.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || String(Date.now());
  return `builder-${safeTaskId}-${suffix}`;
}

function BuilderChatSidecar({
  conversationId,
  taskId,
  title,
  queryKey,
  className,
}: {
  conversationId: string;
  taskId: string;
  title: string;
  queryKey: readonly unknown[];
  className?: string;
}) {
  const queryClient = useQueryClient();
  const [loadedConversationId, setLoadedConversationId] = useState<string | null>(null);
  const [stoppingRun, setStoppingRun] = useState(false);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const wasBusyRef = useRef(false);
  const transport = useMemo(
    () =>
      new DefaultChatTransport<BuilderWebChatMessage>({
        api: `/api/web-chat?conversationId=${encodeURIComponent(conversationId)}`,
      }),
    [conversationId],
  );
  const chat = useChat<BuilderWebChatMessage>({
    id: conversationId,
    transport,
  });
  const historyReady = loadedConversationId === conversationId;
  const latestMessage = chat.messages.at(-1);
  const threadScrollKey = latestMessage
    ? [
        latestMessage.id,
        latestMessage.role,
        textFromBuilderMessage(latestMessage).length,
        progressLinesFromBuilderMessage(latestMessage).join("\n").length,
        filesFromBuilderMessage(latestMessage).length,
        automationsFromBuilderMessage(latestMessage).length,
        chat.status,
      ].join(":")
    : "";
  const hasBackgroundRun = hasPendingBuilderAssistantProgress(chat.messages);
  const chatBusy = chat.status === "submitted" || chat.status === "streaming" || hasBackgroundRun || stoppingRun;
  const threadMessages = builderChatThreadMessages(chat.messages);
  const showEmptyState = historyReady && threadMessages.length === 0 && !chatBusy && !chat.error;
  const sendBuilderMessage = useCallback(
    (value: string, attachments: WebChatUploadedAttachment[] = []) => {
      void chat.sendMessage(
        outgoingBuilderTextMessage(value, attachments),
        outgoingBuilderRequestOptions(taskId, attachments),
      );
    },
    [chat.sendMessage, taskId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoadedConversationId(null);
    chat.setMessages([]);
    void api.webChat
      .messages(conversationId)
      .then(({ messages }) => {
        if (!cancelled) {
          chat.setMessages(messages as BuilderWebChatMessage[]);
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
          chat.setMessages(messages as BuilderWebChatMessage[]);
        }
      });
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [chat.setMessages, chat.status, conversationId, hasBackgroundRun, historyReady]);

  useEffect(() => {
    const busy = chat.status === "submitted" || chat.status === "streaming";
    if (busy) {
      wasBusyRef.current = true;
      return;
    }
    if (!historyReady || !wasBusyRef.current) return;
    wasBusyRef.current = false;
    void queryClient.invalidateQueries({ queryKey });
  }, [chat.status, historyReady, queryClient, queryKey]);

  const handleStop = useCallback(() => {
    if (stoppingRun) return;
    setStoppingRun(true);
    void api.webChat
      .interrupt(conversationId)
      .catch(() => undefined)
      .finally(() => setStoppingRun(false));
  }, [conversationId, stoppingRun]);

  return (
    <aside
      className={cn(
        "w-[400px] min-w-[320px] max-w-[600px] shrink-0 resize-x flex-col overflow-hidden border-r border-white/10 bg-[#050505] text-white",
        className,
      )}
    >
      <div className="border-b border-white/10 bg-[#080808] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-brand-accent text-[#141100]">
            <RobotIcon size={17} weight="fill" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-[13px] font-semibold">Builder chat</p>
              <Badge className="rounded-[5px] border border-white/10 bg-white/[0.06] px-1.5 py-0 font-mono text-[10px] text-white/58">
                Fresh
              </Badge>
            </div>
            <p className="truncate text-[12px] text-white/46">{title}</p>
          </div>
        </div>
      </div>
      <div ref={threadScrollRef} className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5">
        {!historyReady ? (
          <BuilderChatLoadingState />
        ) : showEmptyState ? (
          <BuilderChatEmptyState title={title} onPrompt={sendBuilderMessage} />
        ) : (
          <ChatThread
            className="gap-4"
            messages={threadMessages}
            busy={chatBusy}
            error={chat.error?.message ?? null}
            conversationId={conversationId}
          />
        )}
      </div>
      <div className="shrink-0 border-t border-white/10 bg-[#050505] px-3 py-3">
        <ChatInput
          key={conversationId}
          disabled={!historyReady || chatBusy}
          disabledPlaceholder={historyReady ? "Sketch is thinking..." : "Loading conversation..."}
          running={chatBusy}
          runningPlaceholder="Sketch is thinking..."
          stopping={stoppingRun}
          onStop={handleStop}
          placeholder="Reply to Sketch..."
          onSubmit={sendBuilderMessage}
        />
      </div>
    </aside>
  );
}

function BuilderChatLoadingState() {
  return (
    <div className="flex min-h-full items-center justify-center px-3 text-[13px] text-white/46">
      <div className="flex items-center gap-2">
        <SpinnerGapIcon size={15} className="animate-spin" />
        Loading builder chat
      </div>
    </div>
  );
}

function BuilderChatEmptyState({ title, onPrompt }: { title: string; onPrompt: (prompt: string) => void }) {
  return (
    <div className="flex min-h-full items-center justify-center px-1">
      <div className="w-full max-w-[340px] rounded-[8px] border border-white/10 bg-white/[0.035] p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[8px] border border-brand-accent/30 bg-brand-accent/12 text-brand-accent">
            <RobotIcon size={18} weight="fill" />
          </span>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-white">What should change?</p>
            <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-white/50">{title}</p>
          </div>
        </div>
        <div className="mt-4 grid gap-2">
          {builderChatSuggestions.map((suggestion) => {
            const Icon = suggestion.icon;
            return (
              <button
                key={suggestion.label}
                type="button"
                className="flex min-h-9 items-center gap-2 rounded-[7px] border border-white/10 bg-[#101010] px-3 text-left text-[12px] font-medium text-white/76 transition hover:border-brand-accent/35 hover:bg-brand-accent/10 hover:text-white"
                onClick={() => onPrompt(suggestion.prompt)}
              >
                <Icon size={14} className="shrink-0 text-brand-accent" />
                <span className="min-w-0 truncate">{suggestion.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function usesDefaultPosition(step: WorkflowStep): boolean {
  return Math.abs(step.position.x) <= 10 && Math.abs(step.position.y) <= 10;
}

function usesGeneratedColumnPosition(step: WorkflowStep, index: number): boolean {
  return Math.abs(step.position.x) <= 10 && Math.abs(step.position.y - index * 100) <= 10;
}

function shouldAutoLayoutWorkflow(steps: WorkflowStep[]): boolean {
  if (steps.length === 0) return false;
  return steps.every(usesDefaultPosition) || steps.every((step, index) => usesGeneratedColumnPosition(step, index));
}

function layoutWorkflowPositions(
  steps: WorkflowStep[],
  edges: WorkflowEdge[],
): Record<string, { x: number; y: number }> {
  const stepIds = new Set(steps.map((step) => step.id));
  const indexById = new Map(steps.map((step, index) => [step.id, index]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();

  for (const step of steps) incoming.set(step.id, 0);
  for (const edge of edges) {
    if (!stepIds.has(edge.from) || !stepIds.has(edge.to)) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  const roots = steps
    .filter((step) => (incoming.get(step.id) ?? 0) === 0)
    .sort((left, right) => {
      if (left.type === "trigger" && right.type !== "trigger") return -1;
      if (right.type === "trigger" && left.type !== "trigger") return 1;
      return (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0);
    });
  const queue = roots.map((step) => step.id);
  const levels = new Map<string, number>(queue.map((id) => [id, 0]));
  const remainingIncoming = new Map(incoming);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    const currentLevel = levels.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      levels.set(next, Math.max(levels.get(next) ?? 0, currentLevel + 1));
      remainingIncoming.set(next, Math.max(0, (remainingIncoming.get(next) ?? 0) - 1));
      if (remainingIncoming.get(next) === 0) queue.push(next);
    }
  }

  for (const step of steps) {
    if (!levels.has(step.id)) levels.set(step.id, Math.max(0, indexById.get(step.id) ?? 0));
  }

  const groups = new Map<number, WorkflowStep[]>();
  for (const step of steps) {
    const level = levels.get(step.id) ?? 0;
    groups.set(level, [...(groups.get(level) ?? []), step]);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [level, group] of groups) {
    const sorted = [...group].sort((left, right) => (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0));
    for (const [index, step] of sorted.entries()) {
      positions[step.id] = {
        x: level * 245,
        y: (index - (sorted.length - 1) / 2) * 110,
      };
    }
  }

  return positions;
}

function flowPosition(
  step: WorkflowStep,
  layoutPositions: Record<string, { x: number; y: number }>,
  shouldUseLayout: boolean,
) {
  return shouldUseLayout ? (layoutPositions[step.id] ?? step.position) : step.position;
}

function outputStatus(
  output: StepOutput | undefined,
  runStatus: "running" | "completed" | "failed" | undefined,
): UiStatus {
  if (!output) return runStatus === "running" ? "running" : "idle";
  if (output.status === "completed") return "success";
  if (output.status === "failed") return "failed";
  return "skipped";
}

type BuilderNodeData = {
  step: WorkflowStep;
  selected: boolean;
  status: UiStatus;
  visual: StepVisual;
};
type BuilderNode = Node<BuilderNodeData>;

type StepVisualKind =
  | "schedule-trigger"
  | "webhook-trigger"
  | "canvas-trigger"
  | "agent"
  | "gmail-action"
  | "sheets-action"
  | "slack-action"
  | "whatsapp-action"
  | "google-action"
  | "web-action"
  | "code-action";

interface StepVisual {
  kind: StepVisualKind;
  icon: ComponentType<IconProps>;
  shape: "notched" | "rounded" | "circle";
  toneClass: string;
  glyphClass: string;
}

const stepVisuals: Record<StepVisualKind, StepVisual> = {
  "schedule-trigger": {
    kind: "schedule-trigger",
    icon: CalendarDotsIcon,
    shape: "notched",
    toneClass: "border-white/[0.15] bg-[#171717]",
    glyphClass: "text-white/70",
  },
  "webhook-trigger": {
    kind: "webhook-trigger",
    icon: WebhooksLogoIcon,
    shape: "notched",
    toneClass: "border-cyan-200/20 bg-[#161818]",
    glyphClass: "text-cyan-100/75",
  },
  "canvas-trigger": {
    kind: "canvas-trigger",
    icon: GitBranchIcon,
    shape: "notched",
    toneClass: "border-violet-200/20 bg-[#18161a]",
    glyphClass: "text-violet-100/75",
  },
  agent: {
    kind: "agent",
    icon: RobotIcon,
    shape: "rounded",
    toneClass: "border-white/[0.15] bg-[#171717]",
    glyphClass: "text-white/72",
  },
  "gmail-action": {
    kind: "gmail-action",
    icon: EnvelopeSimpleIcon,
    shape: "circle",
    toneClass: "border-red-200/20 bg-[#181515]",
    glyphClass: "text-red-100/75",
  },
  "sheets-action": {
    kind: "sheets-action",
    icon: TableIcon,
    shape: "circle",
    toneClass: "border-emerald-200/20 bg-[#141815]",
    glyphClass: "text-emerald-100/75",
  },
  "slack-action": {
    kind: "slack-action",
    icon: SlackLogoIcon,
    shape: "circle",
    toneClass: "border-fuchsia-200/20 bg-[#181618]",
    glyphClass: "text-fuchsia-100/75",
  },
  "whatsapp-action": {
    kind: "whatsapp-action",
    icon: WhatsappLogoIcon,
    shape: "circle",
    toneClass: "border-green-200/20 bg-[#141815]",
    glyphClass: "text-green-100/75",
  },
  "google-action": {
    kind: "google-action",
    icon: GoogleLogoIcon,
    shape: "circle",
    toneClass: "border-blue-200/20 bg-[#15171a]",
    glyphClass: "text-blue-100/75",
  },
  "web-action": {
    kind: "web-action",
    icon: GlobeHemisphereWestIcon,
    shape: "circle",
    toneClass: "border-sky-200/20 bg-[#141719]",
    glyphClass: "text-sky-100/75",
  },
  "code-action": {
    kind: "code-action",
    icon: CodeIcon,
    shape: "circle",
    toneClass: "border-white/[0.14] bg-[#151515]",
    glyphClass: "text-white/72",
  },
};

function stepSignalText(step: WorkflowStep, content: AutomationStepContent | undefined): string {
  return [
    step.type,
    step.id,
    step.label,
    step.icon,
    step.triggerConfig?.type,
    step.triggerConfig?.componentKey,
    step.triggerConfig?.app,
    ...(content?.apps ?? []),
    content?.content.slice(0, 1400),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function resolveStepVisual(step: WorkflowStep, content: AutomationStepContent | undefined): StepVisual {
  if (step.type === "trigger") {
    if (step.triggerConfig?.type === "webhook") return stepVisuals["webhook-trigger"];
    if (step.triggerConfig?.type === "canvas") return stepVisuals["canvas-trigger"];
    return stepVisuals["schedule-trigger"];
  }

  if (step.type === "agent") return stepVisuals.agent;

  const signal = stepSignalText(step, content);
  if (/\b(google-sheets|sheets|spreadsheet|sheet)\b/.test(signal)) return stepVisuals["sheets-action"];
  if (/\b(gmail|email|mail)\b/.test(signal)) return stepVisuals["gmail-action"];
  if (/\b(slack)\b/.test(signal)) return stepVisuals["slack-action"];
  if (/\b(whatsapp|wa-)\b/.test(signal)) return stepVisuals["whatsapp-action"];
  if (/\b(google|drive|docs|calendar)\b/.test(signal)) return stepVisuals["google-action"];
  if (/\b(http|web|url|api)\b/.test(signal)) return stepVisuals["web-action"];
  return stepVisuals["code-action"];
}

function AutomationCanvas({
  draft,
  selectedStepId,
  stepOutputs,
  runStatus,
  onSelectStep,
  onUpdateStepPositions,
}: {
  draft: DraftAutomation;
  selectedStepId: string | null;
  stepOutputs: Record<string, StepOutput>;
  runStatus?: "running" | "completed" | "failed";
  onSelectStep: (stepId: string | null) => void;
  onUpdateStepPositions: (positions: Record<string, { x: number; y: number }>) => void;
}) {
  return (
    <ReactFlowProvider>
      <AutomationCanvasFlow
        draft={draft}
        selectedStepId={selectedStepId}
        stepOutputs={stepOutputs}
        runStatus={runStatus}
        onSelectStep={onSelectStep}
        onUpdateStepPositions={onUpdateStepPositions}
      />
    </ReactFlowProvider>
  );
}

function AutomationCanvasFlow({
  draft,
  selectedStepId,
  stepOutputs,
  runStatus,
  onSelectStep,
  onUpdateStepPositions,
}: {
  draft: DraftAutomation;
  selectedStepId: string | null;
  stepOutputs: Record<string, StepOutput>;
  runStatus?: "running" | "completed" | "failed";
  onSelectStep: (stepId: string | null) => void;
  onUpdateStepPositions: (positions: Record<string, { x: number; y: number }>) => void;
}) {
  const { fitView } = useReactFlow<BuilderNode>();
  const layoutPositions = useMemo(() => layoutWorkflowPositions(draft.steps, draft.edges), [draft.edges, draft.steps]);
  const shouldUseLayout = useMemo(() => shouldAutoLayoutWorkflow(draft.steps), [draft.steps]);
  const initialNodes = useMemo<BuilderNode[]>(
    () =>
      draft.steps.map((step) => ({
        id: step.id,
        type: step.type,
        position: flowPosition(step, layoutPositions, shouldUseLayout),
        data: {
          step,
          selected: step.id === selectedStepId,
          status: outputStatus(stepOutputs[step.id], runStatus),
          visual: resolveStepVisual(step, draft.stepContent[step.id]),
        },
      })),
    [draft.stepContent, draft.steps, layoutPositions, runStatus, selectedStepId, shouldUseLayout, stepOutputs],
  );
  const initialEdges = useMemo<Edge[]>(
    () =>
      draft.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        animated: runStatus === "running",
        className: "automation-builder-edge",
        interactionWidth: 22,
        style: flowEdgeStyle,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: flowEdgeStyle.stroke,
          width: 16,
          height: 16,
        },
      })),
    [draft.edges, runStatus],
  );
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<BuilderNode>(initialNodes);
  const [edges, setEdges] = useEdgesState(initialEdges);
  const onNodesChange = useCallback(
    (changes: NodeChange<BuilderNode>[]) => {
      onNodesChangeBase(changes.filter((change) => change.type !== "remove" && change.type !== "add"));
    },
    [onNodesChangeBase],
  );

  useEffect(() => setNodes(initialNodes), [initialNodes, setNodes]);
  useEffect(() => setEdges(initialEdges), [initialEdges, setEdges]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void fitView({ padding: selectedStepId ? 0.46 : 0.35, maxZoom: 1.05, duration: 180 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitView, selectedStepId]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => onSelectStep(node.id)}
      onNodeDragStop={(_, node) => {
        onUpdateStepPositions(
          Object.fromEntries(
            nodes.map((currentNode) => [
              currentNode.id,
              currentNode.id === node.id ? node.position : currentNode.position,
            ]),
          ),
        );
      }}
      onPaneClick={() => onSelectStep(null)}
      nodesDraggable
      nodesConnectable={false}
      edgesReconnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
      multiSelectionKeyCode={null}
      selectionKeyCode={null}
      fitView
      fitViewOptions={{ padding: 0.35, maxZoom: 1.05 }}
      minZoom={0.35}
      maxZoom={1.6}
      snapToGrid
      snapGrid={[18, 18]}
      connectionLineStyle={connectionLineStyle}
      connectionRadius={28}
      proOptions={{ hideAttribution: true }}
      className="automation-builder-flow"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.1} color="rgba(255,255,255,0.12)" />
      <Controls showInteractive={false} position="bottom-left" className="automation-builder-controls" />
    </ReactFlow>
  );
}

const statusClasses: Record<UiStatus, string> = {
  idle: "bg-white/42",
  running: "animate-pulse bg-brand-accent shadow-[0_0_14px_rgba(254,237,1,0.55)]",
  success: "bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.42)]",
  failed: "bg-red-400 shadow-[0_0_14px_rgba(248,113,113,0.42)]",
  skipped: "bg-white/24",
};

const nodeAccentClasses: Record<UiStatus, string> = {
  idle: "from-white/[0.08] to-transparent",
  running: "from-brand-accent/[0.18] to-transparent",
  success: "from-emerald-400/[0.16] to-transparent",
  failed: "from-red-400/[0.16] to-transparent",
  skipped: "from-white/[0.05] to-transparent",
};

function StepShape({ visual, selected, status }: { visual: StepVisual; selected: boolean; status: UiStatus }) {
  const Icon = visual.icon;
  const triggerShape =
    visual.shape === "notched"
      ? ({ clipPath: "polygon(0 0, calc(100% - 9px) 0, 100% 50%, calc(100% - 9px) 100%, 0 100%)" } as CSSProperties)
      : undefined;
  return (
    <div className="relative size-[46px]">
      <div
        className={cn(
          "automation-node-shell relative flex size-full items-center justify-center overflow-hidden border text-white/70 shadow-[0_10px_22px_rgba(0,0,0,0.34)] transition-[border-color,background-color,box-shadow,transform]",
          "before:absolute before:inset-0 before:bg-linear-to-br before:from-white/[0.045] before:to-transparent before:content-['']",
          visual.toneClass,
          nodeAccentClasses[status],
          visual.shape === "notched" ? "rounded-[9px]" : visual.shape === "circle" ? "rounded-full" : "rounded-[11px]",
          selected
            ? "border-white/46 bg-[#1c1c1c] text-white shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_14px_30px_rgba(0,0,0,0.46)]"
            : "hover:border-white/24 hover:bg-[#1b1b1b] hover:text-white/86",
        )}
        style={triggerShape}
      >
        <Icon
          size={visual.kind === "agent" ? 18 : 17}
          weight={visual.shape === "notched" || visual.kind === "agent" ? "fill" : "regular"}
          className={cn("relative z-10", visual.glyphClass)}
        />
      </div>
      <span
        className={cn(
          "absolute -top-[4px] left-1/2 z-20 size-[6px] -translate-x-1/2 rounded-full ring-[2px] ring-[#050505]",
          statusClasses[status],
        )}
      />
    </div>
  );
}

function BuilderStepNode({ data, isConnectable }: NodeProps<BuilderNode>) {
  return (
    <div className="group/node flex w-[150px] select-none flex-col items-center gap-2">
      <div className="relative">
        {data.step.type !== "trigger" ? (
          <Handle
            type="target"
            position={Position.Left}
            isConnectable={isConnectable}
            className="automation-builder-handle !left-[-4px]"
          />
        ) : null}
        <StepShape visual={data.visual} selected={data.selected} status={data.status} />
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={isConnectable}
          className="automation-builder-handle !right-[-4px]"
        />
      </div>
      <span className="line-clamp-1 max-w-[150px] text-center text-[11px] font-semibold leading-4 text-white/74 transition-colors group-hover/node:text-white/88">
        {data.step.label}
      </span>
    </div>
  );
}

const nodeTypes = {
  trigger: BuilderStepNode,
  agent: BuilderStepNode,
  action: BuilderStepNode,
};

function RunsMenu({
  runs,
  activeRunId,
  onSelectRun,
}: {
  runs: AutomationDefinition["recentRuns"];
  activeRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  const active = activeRunId ? runs.find((run) => run.id === activeRunId) : runs[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className={cn(canvasToolbarButtonClass, "gap-1.5 text-white/68")}>
          {activeRunId ? <EyeIcon size={14} weight="fill" /> : <CaretDownIcon size={13} />}
          {activeRunId && active ? `Viewing · ${formatRunDate(active.startedAt)}` : `Runs · ${runs.length}`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[310px]">
        <DropdownMenuLabel className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          Run history
        </DropdownMenuLabel>
        {runs.length === 0 ? (
          <DropdownMenuItem disabled>No runs yet</DropdownMenuItem>
        ) : (
          runs.map((run, index) => (
            <DropdownMenuItem key={run.id} onSelect={() => onSelectRun(run.id)} className="gap-3">
              <RunIcon status={run.status} />
              <span className="min-w-0 flex-1 truncate text-xs">
                {formatRunDate(run.startedAt)}
                {index === 0 ? " · latest" : ""}
              </span>
              <span className="text-xs capitalize text-muted-foreground">{run.status}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RunIcon({ status }: { status: string }) {
  if (status === "running") return <SpinnerGapIcon size={15} className="animate-spin text-muted-foreground" />;
  if (status === "failed") return <XCircleIcon size={15} weight="fill" className="text-destructive" />;
  return <CheckCircleIcon size={15} weight="fill" className="text-emerald-500" />;
}

function formatRunDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function NodeDrawer({
  draft,
  step,
  output,
  onClose,
  onTest,
  testingStepId,
  onUpdateAgentPrompt,
  savingPromptStepId,
}: {
  draft: DraftAutomation;
  step: WorkflowStep | null;
  output?: StepOutput;
  onClose: () => void;
  onTest: (stepId: string) => void;
  testingStepId: string | null;
  onUpdateAgentPrompt: (stepId: string, content: string) => void;
  savingPromptStepId: string | null;
}) {
  const [tab, setTab] = useState<"input" | "output">("input");
  useEffect(() => setTab(output?.status === "failed" ? "output" : "input"), [output?.status]);

  if (!step) return null;
  const content = draft.stepContent[step.id];

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex h-full max-h-full w-full max-w-[392px] min-w-0 flex-col overflow-hidden border-l border-white/10 bg-[#050505] text-white shadow-xl xl:relative xl:inset-auto xl:z-auto xl:w-[392px] xl:min-w-[350px] xl:max-w-[540px] xl:resize-x xl:shadow-none">
      <div className="shrink-0 border-b border-white/10 px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-semibold leading-6 text-white">{step.label}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge className="rounded-[5px] border border-white/10 bg-white/[0.06] font-mono text-[10px] uppercase tracking-[0.08em] text-white/62">
                {step.type}
              </Badge>
              <StatusBadge output={output} />
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-[6px] text-white/55 hover:bg-white/[0.08] hover:text-white"
            onClick={onClose}
            aria-label="Close drawer"
          >
            <XIcon size={14} />
          </Button>
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3">
          <div className="flex gap-5">
            <TabButton active={tab === "input"} onClick={() => setTab("input")}>
              Input
            </TabButton>
            <TabButton active={tab === "output"} onClick={() => setTab("output")}>
              Output
            </TabButton>
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 gap-1.5 rounded-[6px] bg-white/[0.08] font-mono text-[11px] uppercase tracking-[0.08em] text-white/72 shadow-none hover:bg-white/[0.12] hover:text-white"
            disabled={testingStepId === step.id}
            onClick={() => onTest(step.id)}
          >
            {testingStepId === step.id ? (
              <SpinnerGapIcon size={13} className="animate-spin" />
            ) : (
              <PlayIcon size={13} weight="fill" />
            )}
            Test
          </Button>
        </div>
      </div>

      <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {tab === "input" ? (
          <NodeInputPanel
            draft={draft}
            step={step}
            content={content}
            onUpdateAgentPrompt={onUpdateAgentPrompt}
            savingPrompt={savingPromptStepId === step.id}
          />
        ) : (
          <OutputPanel output={output} />
        )}
      </div>
    </aside>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "font-mono text-[12px] font-semibold uppercase tracking-[0.1em] transition-colors",
        active ? "text-white" : "text-white/42 hover:text-white/70",
      )}
    >
      {children}
    </button>
  );
}

function StatusBadge({ output }: { output?: StepOutput }) {
  if (!output) {
    return <Badge className="rounded-[5px] border border-white/10 bg-white/[0.04] text-white/52">Idle</Badge>;
  }
  if (output.status === "completed")
    return (
      <Badge className="rounded-[5px] border border-emerald-400/15 bg-emerald-400/12 text-emerald-300">
        Succeeded · {formatDuration(output.duration_ms)}
      </Badge>
    );
  if (output.status === "failed")
    return (
      <Badge className="rounded-[5px] border border-red-400/15 bg-red-400/12 text-red-300">
        Failed · {formatDuration(output.duration_ms)}
      </Badge>
    );
  return <Badge className="rounded-[5px] border border-white/10 bg-white/[0.04] text-white/52">Skipped</Badge>;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function NodeInputPanel({
  draft,
  step,
  content,
  onUpdateAgentPrompt,
  savingPrompt,
}: {
  draft: DraftAutomation;
  step: WorkflowStep;
  content?: AutomationStepContent;
  onUpdateAgentPrompt: (stepId: string, content: string) => void;
  savingPrompt: boolean;
}) {
  const [agentPrompt, setAgentPrompt] = useState(content?.content ?? "");
  useEffect(() => {
    setAgentPrompt(content?.content ?? "");
  }, [content?.content]);
  const agentPromptDirty = step.type === "agent" && agentPrompt !== (content?.content ?? "");

  return (
    <div className="flex min-h-full flex-col gap-5">
      <Field label="Label">
        <Input value={step.label} className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
      </Field>

      {step.type === "trigger" ? <TriggerFields draft={draft} /> : null}

      {step.type === "agent" ? (
        <>
          <Field label="Uses">
            <Input
              value={(content?.apps ?? []).join(", ")}
              className={builderReadOnlyInputClass}
              readOnly
              aria-readonly="true"
            />
          </Field>
          <Field label="Prompt" grow>
            <Textarea
              value={agentPrompt}
              className={cn(builderTextareaClass, "min-h-[320px] flex-1 resize-none font-mono")}
              onChange={(event) => setAgentPrompt(event.target.value)}
            />
          </Field>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5 rounded-[7px] bg-brand-accent px-3 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[#161300] shadow-none hover:bg-brand-accent/90"
              disabled={!agentPromptDirty || !agentPrompt.trim() || savingPrompt}
              onClick={() => onUpdateAgentPrompt(step.id, agentPrompt)}
            >
              {savingPrompt ? (
                <SpinnerGapIcon size={13} className="animate-spin" />
              ) : (
                <CheckCircleIcon size={13} weight="fill" />
              )}
              Save prompt
            </Button>
          </div>
        </>
      ) : null}

      {step.type === "action" ? (
        <>
          <Field label="Uses">
            <Input
              value={(content?.apps ?? []).join(", ")}
              className={builderReadOnlyInputClass}
              readOnly
              aria-readonly="true"
            />
          </Field>
          <Field label="Script" grow>
            <Textarea
              value={content?.content ?? ""}
              className={cn(builderReadOnlyTextareaClass, "min-h-[340px] flex-1 resize-none font-mono")}
              readOnly
              aria-readonly="true"
            />
          </Field>
        </>
      ) : null}
    </div>
  );
}

function TriggerFields({ draft }: { draft: DraftAutomation }) {
  const triggerStep = draft.steps.find((step) => step.type === "trigger");
  const config = triggerStep?.triggerConfig ?? { type: "schedule" as const };
  return (
    <>
      <Field label="Trigger type">
        <Input value={config.type} className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
      </Field>
      {config.type === "schedule" ? (
        <>
          <Field label="Schedule type">
            <Input
              value={draft.scheduleType === "external" ? "cron" : draft.scheduleType}
              className={builderReadOnlyInputClass}
              readOnly
              aria-readonly="true"
            />
          </Field>
          <Field label="Schedule value">
            <Input value={draft.scheduleValue} className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
          </Field>
          <Field label="Timezone">
            <Input value={draft.timezone} className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
          </Field>
        </>
      ) : null}
    </>
  );
}

function Field({ label, children, grow = false }: { label: string; children: ReactNode; grow?: boolean }) {
  return (
    <div className={cn("space-y-2", grow && "flex min-h-0 flex-1 flex-col")}>
      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-white/42">{label}</span>
      {children}
    </div>
  );
}

function OutputPanel({ output }: { output?: StepOutput }) {
  if (!output) {
    return (
      <div className="rounded-[8px] border border-dashed border-white/14 bg-white/[0.03] p-4 text-sm text-white/52">
        No output yet. Run the automation or test this node.
      </div>
    );
  }
  if (output.error) {
    return (
      <pre className="max-w-full overflow-x-hidden whitespace-pre-wrap break-words rounded-[8px] border border-red-400/25 bg-red-400/8 p-3 font-mono text-xs text-red-200 [overflow-wrap:anywhere]">
        {output.error.message}
      </pre>
    );
  }
  if (output.output == null || output.output === "") {
    return (
      <div className="rounded-[8px] border border-white/10 bg-white/[0.04] p-4 text-sm text-white/52">
        No output returned.
      </div>
    );
  }
  return <JsonOutput value={output.output} />;
}

function JsonOutput({ value }: { value: unknown }) {
  const [raw, setRaw] = useState(false);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  let parsed: unknown = value;
  if (typeof value === "string" && (value.trim().startsWith("{") || value.trim().startsWith("["))) {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
  }
  const canTree = parsed !== null && typeof parsed === "object";
  return (
    <div className="flex min-h-[320px] flex-col overflow-hidden rounded-[8px] border border-white/10 bg-[#101010]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-white/42">Output</span>
        <div className="flex items-center gap-1">
          {canTree ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-[6px] text-white/55 hover:bg-white/[0.08] hover:text-white"
              onClick={() => setRaw((current) => !current)}
              aria-label="Toggle output view"
            >
              {raw ? <BracketsCurlyIcon size={14} /> : <CodeIcon size={14} />}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-[6px] text-white/55 hover:bg-white/[0.08] hover:text-white"
            onClick={() => void navigator.clipboard.writeText(text)}
            aria-label="Copy output"
          >
            <CircleIcon size={14} />
          </Button>
        </div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-white/78 [overflow-wrap:anywhere]">
        {canTree && !raw ? JSON.stringify(parsed, null, 2) : text}
      </pre>
    </div>
  );
}
