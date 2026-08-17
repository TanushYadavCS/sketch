import { AutomationLockBanner } from "@/components/automations/lock-banner";
import {
  AUTOMATION_EDIT_LOCK_HEARTBEAT_INTERVAL_MS,
  AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS,
} from "@/components/automations/lock-banner";
import { AutomationLockHolderResponseDialog } from "@/components/automations/lock-holder-response-dialog";
import { AutomationLockStealDialog } from "@/components/automations/lock-steal-dialog";
import { AutomationShareDialog } from "@/components/automations/share-dialog";
import { ChatInput } from "@/components/sketch/chat-input";
import { SketchMessage, UserMessage } from "@/components/sketch/chat-message";
import {
  ChatThread,
  type ChatThreadInterruption,
  type ChatThreadMessage,
  type ChatThreadProgressItem,
  questionBatchSignature,
} from "@/components/sketch/chat-thread";
import { useWebChatReconciliation } from "@/hooks/use-web-chat-reconciliation";
import {
  ApiRequestError,
  type AutomationArtifact,
  type AutomationBuilderSaveRequest,
  type AutomationDefinition,
  type AutomationEditLockView,
  type AutomationRunRecord,
  type AutomationStepContent,
  type CanvasWebhookEndpoint,
  type ScheduledTaskConversationKind,
  type ScheduledTaskConversationLock,
  type ScheduledTaskConversationSummary,
  type ScheduledTaskConversationsResponse,
  type ScheduledTaskOriginChatMessage,
  type StepOutput,
  type WebChatConversationSummary,
  type WebChatQuestion,
  type WebChatQuestionAnswer,
  type WebChatQuestionBatch,
  type WebChatQuestionBatchAnswer,
  type WebChatQuestionOption,
  type WebChatStoredMessage,
  type WebChatUploadedAttachment,
  type WorkflowEdge,
  type WorkflowStep,
  type WorkflowTriggerConfig,
  api,
} from "@/lib/api";
import { getAutomationAuthoringSessionId } from "@/lib/automation-authoring-session";
import {
  AUTOMATION_ACTIVE_RUN_REFRESH_INTERVAL_MS,
  AUTOMATION_REFRESH_INTERVAL_MS,
  automationDefinitionQueryKey,
  invalidateAutomationQueries,
} from "@/lib/automation-refresh";
import { WEB_CHAT_CONVERSATIONS_QUERY_KEY } from "@/lib/web-chat-conversations";
import { useChat } from "@ai-sdk/react";
import {
  ArchiveIcon,
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  BracketsCurlyIcon,
  CalendarDotsIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CircleIcon,
  CodeIcon,
  CopySimpleIcon,
  EnvelopeSimpleIcon,
  EyeIcon,
  GitBranchIcon,
  GlobeHemisphereWestIcon,
  GoogleLogoIcon,
  type IconProps,
  LightningIcon,
  PlayIcon,
  PlusIcon,
  RobotIcon,
  ShareNetworkIcon,
  SlackLogoIcon,
  SpinnerGapIcon,
  TableIcon,
  TrashIcon,
  WebhooksLogoIcon,
  WhatsappLogoIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sketch/ui/components/alert-dialog";
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
import { createRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
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
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  type AutomationExecutionMode,
  automationExecutionModeMetadata,
  recommendAutomationExecutionMode,
} from "@sketch/shared";
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
import { dashboardRoute, useDashboardAuth } from "./dashboard";

interface BuilderSearch {
  conversationId?: string;
  runId?: string;
}

const SAFE_AUTOMATION_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const BUILDER_MODE_SELECTION_MARKER = "[automation-setup-mode-selection]";

export function validateAutomationBuilderSearch(search: Record<string, unknown>): BuilderSearch {
  const conversationId = typeof search.conversationId === "string" ? search.conversationId.trim() : "";
  const runId = typeof search.runId === "string" ? search.runId.trim() : "";
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(runId && SAFE_AUTOMATION_RUN_ID.test(runId) ? { runId } : {}),
  };
}

function isPlaceholderDraft(automation: AutomationDefinition): boolean {
  return automation.isPlaceholderDraft === true;
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
  executionMode: AutomationDefinition["executionMode"];
  executionModeRecommendation: AutomationDefinition["executionModeRecommendation"];
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  stepContent: Record<string, AutomationStepContent>;
  revision: number;
}

interface ExecutionModeSelection {
  id: number;
  mode: AutomationExecutionMode;
}

type BuilderSourceContextMessage = Pick<ScheduledTaskOriginChatMessage, "id" | "text" | "createdAt">;

function sourceContextMessagesFromWebChat(messages: WebChatStoredMessage[]): BuilderSourceContextMessage[] {
  return messages
    .filter((message) => message.role === "user")
    .flatMap((message) => {
      const text = message.parts
        .filter(
          (part): part is Extract<WebChatStoredMessage["parts"][number], { type: "text" }> => part.type === "text",
        )
        .map((part) => part.text)
        .join("\n")
        .trim();
      return text ? [{ id: message.id, text, createdAt: message.createdAt ?? "" }] : [];
    })
    .slice(-4);
}

function sourceContextMessagesFromProvider(messages: ScheduledTaskOriginChatMessage[]): BuilderSourceContextMessage[] {
  return messages.filter((message) => message.role === "user" && message.text.trim()).slice(-4);
}

type UiStatus = "idle" | "running" | "success" | "failed" | "skipped";
export type AutomationRunLifecycleState = "pending" | "running" | "success" | "failure" | "aborted";

type RunLifecycleInput = {
  status?: string;
  type?: string;
  runType?: string;
  errorMessage?: string | null;
};

export function automationRunLifecycleState(
  run: RunLifecycleInput | null | undefined,
): AutomationRunLifecycleState | null {
  if (!run) return null;
  const status = run.status?.trim().toLowerCase();
  if (status === "pending" || status === "queued" || status === "starting") return "pending";
  if (status === "running" || status === "in_progress") return "running";
  if (status === "completed" || status === "success" || status === "succeeded") return "success";
  if (status === "aborted" || status === "cancelled" || status === "canceled") return "aborted";

  const persistedType = `${run.type ?? ""} ${run.runType ?? ""}`.toLowerCase();
  if (/\b(?:abort(?:ed|ion)?|cancel(?:led|ed)?|interrupt(?:ed|ion)?)\b/.test(persistedType)) return "aborted";
  if (status === "failed" || status === "failure" || status === "error") {
    const persistedError = run.errorMessage?.toLowerCase() ?? "";
    if (/\b(?:abort(?:ed|ion)?|cancel(?:led|ed)?|interrupt(?:ed|ion)?)\b/.test(persistedError)) return "aborted";
    return "failure";
  }
  return null;
}

function isTerminalRunLifecycleState(state: AutomationRunLifecycleState | null): boolean {
  return state === "success" || state === "failure" || state === "aborted";
}

function runStatusLabel(state: AutomationRunLifecycleState): string {
  switch (state) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "success":
      return "Success";
    case "failure":
      return "Failure";
    case "aborted":
      return "Aborted";
  }
}

type BuilderWebChatDataParts = {
  progress: {
    lines: string[];
    items?: ChatThreadProgressItem[];
  };
  file: {
    name: string;
    url: string;
    mediaType: string;
    sizeBytes?: number;
  };
  automation: AutomationArtifact;
  question: WebChatQuestion;
  "question-batch": WebChatQuestionBatch;
  "question-answer": WebChatQuestionAnswer;
  "question-batch-answer": WebChatQuestionBatchAnswer;
  interruption: ChatThreadInterruption;
};

type BuilderWebChatMetadata = {
  createdAt?: string;
};

type BuilderWebChatMessage = UIMessage<BuilderWebChatMetadata, BuilderWebChatDataParts> & {
  createdAt?: string | Date;
};

const canvasToolbarButtonClass =
  "h-8 rounded-[7px] border-border/70 bg-card/90 text-foreground/80 shadow-none backdrop-blur hover:bg-muted hover:text-foreground";
const builderInputClass =
  "h-10 rounded-[8px] border-input bg-background text-[13px] text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-brand-accent/55 focus-visible:ring-brand-accent/20";
const builderTextareaClass =
  "rounded-[8px] border-input bg-card text-[13px] leading-5 text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-brand-accent/55 focus-visible:ring-brand-accent/20";
const builderReadOnlyInputClass = cn(
  builderInputClass,
  "cursor-default bg-muted/35 focus-visible:border-border focus-visible:ring-0",
);
const builderReadOnlyTextareaClass = cn(
  builderTextareaClass,
  "cursor-default bg-muted/35 focus-visible:border-border focus-visible:ring-0",
);
const flowEdgeStyle = {
  stroke: "var(--automation-builder-edge)",
  strokeWidth: 1.2,
  opacity: 0.84,
} satisfies CSSProperties;
const connectionLineStyle = {
  stroke: "var(--automation-builder-edge-active)",
  strokeWidth: 2,
  strokeDasharray: "5 5",
} satisfies CSSProperties;
export const automationBuilderRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/scheduled-tasks/$taskId/edit",
  validateSearch: validateAutomationBuilderSearch,
  component: AutomationBuilderPage,
});

function draftFromDefinition(automation: AutomationDefinition): DraftAutomation {
  const executionMode = automation.executionMode ?? "hybrid";
  const executionModeRecommendation =
    automation.executionModeRecommendation ??
    recommendAutomationExecutionMode(automation.steps, { legacy: automation.executionMode === undefined });
  return {
    title: automation.title,
    description: automation.description,
    prompt: automation.prompt,
    scheduleType: automation.scheduleType,
    scheduleValue: automation.scheduleValue,
    timezone: automation.timezone,
    status: automation.status,
    delivery: automation.delivery,
    executionMode,
    executionModeRecommendation,
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
    executionMode: draft.executionMode,
    steps: draft.steps,
    edges: draft.edges,
    stepContent: draft.stepContent,
  };
}

type AutomationAuthoringLease = {
  clientSessionId: string;
  generation: number;
  holder: AutomationEditLockView;
};

type AutomationLeaseRequest = Pick<AutomationAuthoringLease, "clientSessionId" | "generation">;

function leaseRequest(lease: AutomationAuthoringLease): AutomationLeaseRequest {
  return { clientSessionId: lease.clientSessionId, generation: lease.generation };
}

function sameLease(left: AutomationLeaseRequest | null | undefined, right: AutomationLeaseRequest | null | undefined) {
  return Boolean(
    left && right && left.clientSessionId === right.clientSessionId && left.generation === right.generation,
  );
}

function isLeaseStaleError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.code === "LEASE_STALE";
}

function builderLoadErrorKind(error: unknown): "access" | "server" {
  if (error instanceof ApiRequestError) {
    if (error.status === 403 || error.status === 404 || error.code === "FORBIDDEN" || error.code === "NOT_FOUND") {
      return "access";
    }
  }
  return "server";
}

function BuilderLoadError({
  error,
  onRetry,
  onClose,
}: {
  error: unknown;
  onRetry: () => void;
  onClose: () => void;
}) {
  const kind = builderLoadErrorKind(error);
  const isAccessError = kind === "access";
  return (
    <main
      data-testid={`automation-builder-${kind}-error`}
      role="alert"
      className="flex min-h-[calc(100vh-3rem)] items-center justify-center bg-background px-6 text-foreground md:min-h-screen"
    >
      <div className="w-full max-w-md rounded-[10px] border border-border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <XCircleIcon size={20} weight="fill" />
          </span>
          <div>
            <h1 className="text-sm font-semibold">
              {isAccessError ? "Automation unavailable" : "Unable to load automation"}
            </h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {isAccessError
                ? "This automation may have been deleted or you may not have access to it."
                : "Sketch could not load this automation. Try again or return to the automations list."}
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="outline" className={canvasToolbarButtonClass} onClick={onRetry}>
            Try again
          </Button>
          <Button variant="ghost" className="h-8 rounded-[7px] text-muted-foreground" onClick={onClose}>
            Back to automations
          </Button>
        </div>
      </div>
    </main>
  );
}

function BuilderDeleteDialog({
  automationTitle,
  open,
  isDeleting,
  onOpenChange,
  onConfirm,
}: {
  automationTitle: string;
  open: boolean;
  isDeleting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete automation?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes <span className="font-medium text-foreground">{automationTitle}</span> and its
            workflow history. Future runs will not be triggered.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm} disabled={isDeleting}>
            {isDeleting ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Deleting…
              </>
            ) : (
              "Delete automation"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function BuilderOwnership({ automation }: { automation: AutomationDefinition }) {
  const owner = automation.createdByName?.trim() || automation.createdBy || "Unknown";
  const editor = automation.lastEditedByName?.trim() || automation.lastEditedBy || "Unknown";
  return (
    <div
      data-testid="automation-builder-ownership"
      className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-[8px] border border-border/70 bg-card/90 px-3 py-1.5 text-[11px] shadow-md backdrop-blur"
    >
      <span className="truncate text-muted-foreground">
        Owner <span className="font-medium text-foreground">{owner}</span>
      </span>
      {automation.lastEditedBy ? (
        <span className="truncate text-muted-foreground">
          Last edited by <span className="font-medium text-foreground">{editor}</span>
        </span>
      ) : null}
    </div>
  );
}

function AutomationSetupCard({
  mode,
  recommendation,
  onSelect,
}: {
  mode: AutomationExecutionMode | null;
  recommendation?: AutomationDefinition["executionModeRecommendation"];
  onSelect: (mode: AutomationExecutionMode) => void;
}) {
  const modes: AutomationExecutionMode[] = ["deterministic", "hybrid", "agent-led"];
  const initialRecommendationDiffers = Boolean(mode && recommendation && recommendation.mode !== mode);
  return (
    <section data-testid="automation-setup-card" className="w-full pb-1">
      <fieldset className="border-0 p-0">
        <legend className="text-[15px] font-semibold leading-5 text-foreground">
          How should Sketch run this automation?
        </legend>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          Choose how much of the workflow should be fixed and how much should use AI.
        </p>
        <div className="mt-3 grid gap-2">
          {modes.map((option) => {
            const metadata = automationExecutionModeMetadata[option];
            const selected = mode === option;
            const recommended = recommendation?.mode === option;
            return (
              <label
                key={option}
                data-testid={`automation-mode-${option}`}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-[10px] border px-3 py-2.5 transition-[border-color,background-color,box-shadow]",
                  "border-border/70 bg-background/35 hover:border-border hover:bg-muted/45 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-accent/55",
                  selected && "border-brand-accent/60 bg-brand-accent/[0.09] shadow-sm",
                )}
              >
                <input
                  type="radio"
                  name="automation-execution-mode"
                  value={option}
                  checked={selected}
                  aria-label={metadata.label}
                  className="sr-only"
                  onChange={() => onSelect(option)}
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-1 size-3 shrink-0 rounded-full border border-muted-foreground/50",
                    selected && "border-brand-accent bg-brand-accent ring-[3px] ring-brand-accent/20",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="text-[13px] font-semibold leading-5 text-foreground">{metadata.label}</span>
                    {recommended ? (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                        Recommended
                      </span>
                    ) : null}
                    {selected ? (
                      <span className="ml-auto text-[11px] font-medium text-brand-accent">Selected</span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                    {metadata.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {initialRecommendationDiffers && recommendation && mode ? (
        <p aria-live="polite" className="mt-2 text-[11px] leading-4 text-muted-foreground">
          You selected{" "}
          <span className="font-medium text-foreground">{automationExecutionModeMetadata[mode].label}</span>. Sketch
          recommended {automationExecutionModeMetadata[recommendation.mode].label} because{" "}
          {recommendation.reason.charAt(0).toLowerCase()}
          {recommendation.reason.slice(1)}
        </p>
      ) : recommendation && mode ? (
        <p aria-live="polite" className="mt-2 text-[11px] leading-4 text-muted-foreground">
          This matches Sketch’s recommendation for the setup.
        </p>
      ) : null}
    </section>
  );
}

export function AutomationBuilderPage() {
  const { taskId } = useParams({ from: automationBuilderRoute.id });
  const auth = useDashboardAuth();
  const clientSessionId = useMemo(() => getAutomationAuthoringSessionId(), []);
  const builderSearch = useSearch({ from: automationBuilderRoute.id }) as BuilderSearch;
  const requestedConversationId = builderSearch.conversationId;
  const requestedRunId =
    builderSearch.runId && SAFE_AUTOMATION_RUN_ID.test(builderSearch.runId) ? builderSearch.runId : undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => automationDefinitionQueryKey(taskId), [taskId]);
  const [draft, setDraft] = useState<DraftAutomation | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [triggeredRunId, setTriggeredRunId] = useState<string | null>(null);
  const [runRequestError, setRunRequestError] = useState<unknown | null>(null);
  const [savingPromptStepId, setSavingPromptStepId] = useState<string | null>(null);
  const [executionModeSelection, setExecutionModeSelection] = useState<ExecutionModeSelection | null>(null);
  const [setupExecutionMode, setSetupExecutionMode] = useState<AutomationExecutionMode | null>(null);
  const [discardingSetup, setDiscardingSetup] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [builderChatBusy, setBuilderChatBusy] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [stealDialogOpen, setStealDialogOpen] = useState(false);
  const [holderResponseDialogOpen, setHolderResponseDialogOpen] = useState(false);
  const [authoringLease, setAuthoringLease] = useState<AutomationAuthoringLease | null>(null);
  const executionModeSelectionIdRef = useRef(0);
  const executionModeRequestIdRef = useRef(0);
  const latestDraftRef = useRef<DraftAutomation | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSaveCountRef = useRef(0);
  const runLeaseRef = useRef<AutomationLeaseRequest | null>(null);
  const testLeaseRef = useRef<AutomationLeaseRequest | null>(null);

  const navigateToAutomations = useCallback(() => {
    void navigate({ to: "/scheduled-tasks" });
  }, [navigate]);

  const navigateRun = useCallback(
    (runId: string | null) => {
      void navigate({
        to: "/scheduled-tasks/$taskId/edit",
        params: { taskId },
        search: {
          ...(requestedConversationId ? { conversationId: requestedConversationId } : {}),
          ...(runId ? { runId } : {}),
        },
        replace: true,
      });
    },
    [navigate, requestedConversationId, taskId],
  );

  const automationQuery = useQuery({
    queryKey,
    queryFn: () => api.scheduledTasks.get(taskId, { clientSessionId }),
    refetchInterval: (query) =>
      query.state.data?.recentRuns.some((run) => {
        const state = automationRunLifecycleState(run);
        return state === "pending" || state === "running";
      })
        ? AUTOMATION_ACTIVE_RUN_REFRESH_INTERVAL_MS
        : AUTOMATION_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const editLockQueryKey = useMemo(
    () => ["automation-edit-lock", taskId, clientSessionId] as const,
    [clientSessionId, taskId],
  );
  const editLockQuery = useQuery({
    queryKey: editLockQueryKey,
    queryFn: async () => {
      const definition = await api.scheduledTasks.get(taskId, { clientSessionId });
      return definition.lock ?? null;
    },
    initialData: automationQuery.data?.lock ?? null,
    initialDataUpdatedAt: Date.now(),
    staleTime: AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS,
    refetchInterval: AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    enabled: Boolean(automationQuery.data),
  });
  const definitionLock = automationQuery.data?.lock ?? null;
  const lockView = editLockQuery.data ?? definitionLock;
  const canEditAutomation = automationQuery.data?.canEdit !== false;
  const lockHeldByOther = Boolean(lockView?.heldByUserId && !lockView.isHeldByMe);
  const exactLeaseHeld = Boolean(
    authoringLease?.holder.isHeldByMe && authoringLease.holder.generation === authoringLease.generation,
  );
  const builderReadOnly = !canEditAutomation || !exactLeaseHeld || lockHeldByOther;
  const isLockHolder = exactLeaseHeld;
  const lockHolderRef = useRef<AutomationAuthoringLease | null>(authoringLease);
  useEffect(() => {
    lockHolderRef.current = authoringLease;
  }, [authoringLease]);

  const leaseIsCurrent = useCallback((lease: AutomationLeaseRequest) => {
    const current = lockHolderRef.current;
    return current?.clientSessionId === lease.clientSessionId && current.generation === lease.generation;
  }, []);

  useEffect(() => {
    return () => {
      const lease = lockHolderRef.current;
      if (!lease) return;
      void api.scheduledTasks.releaseLock(taskId, leaseRequest(lease)).catch(() => undefined);
    };
  }, [taskId]);

  useEffect(() => {
    const release = () => {
      const lease = lockHolderRef.current;
      if (!lease) return;
      void api.scheduledTasks.releaseLock(taskId, leaseRequest(lease), { keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [taskId]);

  const hasAttributedRuns = Boolean(
    automationQuery.data?.recentRuns.some((run) => Boolean(run.triggeredByUserId)) ||
      automationQuery.data?.latestRun?.triggeredByUserId,
  );
  const attributionUsersQuery = useQuery({
    queryKey: ["automation-run-attribution-users"],
    queryFn: () => api.users.list(),
    enabled: hasAttributedRuns,
    staleTime: 60_000,
  });
  const memberNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const user of attributionUsersQuery.data?.users ?? []) {
      names.set(user.id, user.name);
    }
    return names;
  }, [attributionUsersQuery.data]);

  useEffect(() => {
    if (!automationQuery.data || pendingSaveCountRef.current > 0) return;
    const nextDraft = draftFromDefinition(automationQuery.data);
    latestDraftRef.current = nextDraft;
    setDraft(nextDraft);
  }, [automationQuery.data]);

  const displayDraft = useMemo(() => {
    if (!draft || !automationQuery.data || !isPlaceholderDraft(automationQuery.data)) return draft;
    return { ...draft, steps: [], edges: [], stepContent: {} };
  }, [automationQuery.data, draft]);

  useEffect(() => {
    if (selectedStepId && displayDraft && !displayDraft.steps.some((step) => step.id === selectedStepId)) {
      setSelectedStepId(null);
    }
  }, [displayDraft, selectedStepId]);

  const runMutation = useMutation({
    mutationFn: () => {
      const lease = authoringLease;
      if (!lease) throw new Error("Acquire the automation editing session before running");
      runLeaseRef.current = leaseRequest(lease);
      return api.scheduledTasks.run(taskId, runLeaseRef.current);
    },
    onMutate: () => {
      setRunRequestError(null);
    },
    onSuccess: async ({ runId }) => {
      if (!runLeaseRef.current || !leaseIsCurrent(runLeaseRef.current)) return;
      if (!runId || !SAFE_AUTOMATION_RUN_ID.test(runId)) {
        setRunRequestError(new Error("The run response did not include a valid run ID."));
        return;
      }
      setTriggeredRunId(runId);
      navigateRun(runId);
      await invalidateAutomationQueries(queryClient, [taskId]);
    },
    onError: (error) => {
      setRunRequestError(error);
      if (isLeaseStaleError(error)) setAuthoringLease(null);
      toast.error("Could not start the automation run");
    },
  });

  const selectedRunId = triggeredRunId ?? requestedRunId ?? null;
  const recentRunForSelection = automationQuery.data?.recentRuns.find((run) => run.id === selectedRunId) ?? null;
  const exactRunQuery = useQuery({
    queryKey: ["automation-run", taskId, selectedRunId],
    queryFn: () => api.scheduledTasks.getRun(taskId, selectedRunId as string),
    enabled: Boolean(selectedRunId && automationQuery.data),
    retry: false,
    refetchInterval: (query) => {
      const state = automationRunLifecycleState(query.state.data?.run);
      if (isTerminalRunLifecycleState(state)) return false;
      return triggeredRunId !== null || state === "pending" || state === "running" ? 1_000 : false;
    },
  });

  useEffect(() => {
    if (triggeredRunId && requestedRunId && requestedRunId !== triggeredRunId) setTriggeredRunId(null);
  }, [requestedRunId, triggeredRunId]);

  const testMutation = useMutation({
    mutationFn: (stepId: string) => {
      const lease = authoringLease;
      if (!lease) throw new Error("Acquire the automation editing session before testing a step");
      testLeaseRef.current = leaseRequest(lease);
      return api.scheduledTasks.testStep(taskId, stepId, { useLatestUpstreamOutput: true }, testLeaseRef.current);
    },
    onSuccess: async () => {
      if (!testLeaseRef.current || !leaseIsCurrent(testLeaseRef.current)) return;
      toast.success("Test complete");
      await invalidateAutomationQueries(queryClient, [taskId]);
    },
    onError: (error) => {
      if (isLeaseStaleError(error)) setAuthoringLease(null);
      toast.error(error instanceof Error ? error.message : "Test failed");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!authoringLease) throw new Error("Acquire the automation editing session before deleting");
      return api.scheduledTasks.remove(taskId, leaseRequest(authoringLease));
    },
    onSuccess: async () => {
      await invalidateAutomationQueries(queryClient, [taskId]);
      setDeleteDialogOpen(false);
      toast.success("Automation deleted");
      navigateToAutomations();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete automation"),
  });

  const saveDraftPatch = useCallback(
    (
      patch: (current: DraftAutomation) => DraftAutomation,
      options: { message?: string; promptStepId?: string; onSaved?: () => void } = {},
    ) => {
      if (builderReadOnly) return;
      if (options.promptStepId) setSavingPromptStepId(options.promptStepId);
      pendingSaveCountRef.current += 1;
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
            const lease = authoringLease;
            if (!lease) throw new Error("Acquire the automation editing session before saving");
            const requestLease = leaseRequest(lease);
            const updatedAutomation = await api.scheduledTasks.save(
              taskId,
              saveRequestFromDraft(nextDraft),
              requestLease,
            );
            if (!leaseIsCurrent(requestLease)) return;
            const updatedDraft = draftFromDefinition(updatedAutomation);
            latestDraftRef.current = updatedDraft;
            queryClient.setQueryData(queryKey, updatedAutomation);
            setDraft(updatedDraft);
            await invalidateAutomationQueries(queryClient, [taskId]);
            if (options.message) toast.success(options.message);
            options.onSaved?.();
          } catch (error) {
            if (isLeaseStaleError(error)) setAuthoringLease(null);
            toast.error(error instanceof Error ? error.message : "Failed to save automation");
            try {
              const refreshed = await api.scheduledTasks.get(taskId);
              const refreshedDraft = draftFromDefinition(refreshed);
              latestDraftRef.current = refreshedDraft;
              queryClient.setQueryData(queryKey, refreshed);
              setDraft(refreshedDraft);
            } catch {
              await invalidateAutomationQueries(queryClient, [taskId]);
            }
            throw error;
          } finally {
            if (options.promptStepId) {
              setSavingPromptStepId((current) => (current === options.promptStepId ? null : current));
            }
          }
        })
        .finally(() => {
          pendingSaveCountRef.current -= 1;
        });
      saveQueueRef.current = save.catch(() => undefined);
    },
    [authoringLease, builderReadOnly, leaseIsCurrent, queryClient, queryKey, taskId],
  );

  const acquireLockMutation = useMutation({
    mutationFn: () =>
      api.scheduledTasks.acquireLock(
        taskId,
        clientSessionId,
        authoringLease?.generation ?? (lockView?.isHeldByMe ? lockView.generation : undefined),
      ),
    onSuccess: ({ lock }) => {
      queryClient.setQueryData(editLockQueryKey, lock);
      setAuthoringLease({ clientSessionId, generation: lock.generation, holder: lock });
    },
    onError: (error) => {
      if (!(error instanceof ApiRequestError)) return;
      if (error.code === "LEASE_STALE") setAuthoringLease(null);
      if (error.code !== "LOCKED" && error.code !== "LEASE_STALE") return;
      const lock = (error.details.lock ?? error.details.builderLock) as AutomationEditLockView | undefined;
      if (lock) queryClient.setQueryData(editLockQueryKey, lock);
    },
  });
  const acquireLock = acquireLockMutation.mutate;

  const autoAcquireEnabled = automationQuery.data != null && automationQuery.data.canEdit !== false;
  useEffect(() => {
    if (!autoAcquireEnabled || authoringLease) return;
    const expiresAt = lockView?.expiresAt ? new Date(lockView.expiresAt).getTime() : null;
    const heldByActiveOtherSession =
      Boolean(lockView?.heldByUserId && !lockView.isHeldByMe) && expiresAt !== null && expiresAt > Date.now();
    if (heldByActiveOtherSession) {
      const expiryTimer = window.setTimeout(() => void acquireLock(), expiresAt - Date.now() + 50);
      return () => window.clearTimeout(expiryTimer);
    }
    void acquireLock();
    return;
  }, [acquireLock, authoringLease, autoAcquireEnabled, lockView]);

  useEffect(() => {
    if (authoringLease || !lockView?.isHeldByMe || !lockView.generation) return;
    setAuthoringLease({ clientSessionId, generation: lockView.generation, holder: lockView });
  }, [authoringLease, clientSessionId, lockView]);

  useEffect(() => {
    if (!isLockHolder) return;
    const renew = () => void acquireLock();
    const interval = window.setInterval(() => {
      renew();
    }, AUTOMATION_EDIT_LOCK_HEARTBEAT_INTERVAL_MS);
    window.addEventListener("focus", renew);
    document.addEventListener("visibilitychange", renew);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", renew);
      document.removeEventListener("visibilitychange", renew);
    };
  }, [acquireLock, isLockHolder]);

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

  const updateExecutionMode = useCallback(
    (executionMode: AutomationExecutionMode) => {
      if (builderReadOnly) return;
      executionModeRequestIdRef.current += 1;
      const requestId = executionModeRequestIdRef.current;
      const selected = () => {
        if (executionModeRequestIdRef.current !== requestId) return;
        executionModeSelectionIdRef.current += 1;
        setExecutionModeSelection({ id: executionModeSelectionIdRef.current, mode: executionMode });
      };
      if (automationQuery.data && isPlaceholderDraft(automationQuery.data)) {
        const lease = authoringLease;
        if (!lease) {
          toast.error("Acquire the automation editing session before saving setup");
          return;
        }
        void api.scheduledTasks
          .selectSetupExecutionMode(taskId, executionMode, leaseRequest(lease))
          .then(async (updatedAutomation) => {
            if (executionModeRequestIdRef.current !== requestId) return;
            setSetupExecutionMode(executionMode);
            const updatedDraft = draftFromDefinition(updatedAutomation);
            latestDraftRef.current = updatedDraft;
            queryClient.setQueryData(queryKey, updatedAutomation);
            setDraft(updatedDraft);
            await invalidateAutomationQueries(queryClient, [taskId]);
            selected();
          })
          .catch((error) => {
            if (isLeaseStaleError(error)) setAuthoringLease(null);
            toast.error(error instanceof Error ? error.message : "Failed to save automation setup");
          });
        return;
      }
      saveDraftPatch((current) => ({ ...current, executionMode }), {
        onSaved: selected,
      });
    },
    [automationQuery.data, authoringLease, builderReadOnly, queryClient, queryKey, saveDraftPatch, taskId],
  );
  const handleExecutionModeSelectionHandled = useCallback((selectionId: number) => {
    setExecutionModeSelection((current) => (current?.id === selectionId ? null : current));
  }, []);

  if (automationQuery.isError) {
    return (
      <BuilderLoadError
        error={automationQuery.error}
        onRetry={() => void automationQuery.refetch()}
        onClose={() => navigate({ to: "/scheduled-tasks" })}
      />
    );
  }

  if (automationQuery.isLoading || !draft || !automationQuery.data) {
    return (
      <div className="automation-builder-loading flex min-h-[calc(100vh-3rem)] items-center justify-center bg-background px-6 md:min-h-screen">
        <output className="flex items-center gap-3 text-sm text-muted-foreground">
          <SpinnerGapIcon size={18} className="animate-spin text-brand-accent" />
          <span>Loading automation…</span>
        </output>
      </div>
    );
  }

  const automation = automationQuery.data;
  const canShareAutomation =
    automation?.canShare === true ||
    (automation != null && automation.canShare == null && Boolean(auth.userId) && automation.createdBy === auth.userId);
  const placeholderSetup = isPlaceholderDraft(automation);
  const builderDraft = displayDraft ?? draft;
  const exactRunCandidate = exactRunQuery.data?.run;
  const exactRun = selectedRunId && exactRunCandidate?.id === selectedRunId ? exactRunCandidate : null;
  const selectedRun: AutomationRunRecord | null = selectedRunId
    ? (exactRun ?? (exactRunQuery.isPending ? recentRunForSelection : null))
    : (automation.latestRun as AutomationRunRecord | null);
  const selectedStep = builderDraft.steps.find((step) => step.id === selectedStepId) ?? null;
  const selectedOutput = selectedStep ? selectedRun?.stepOutputs[selectedStep.id] : undefined;
  const testingStepId = testMutation.isPending ? (testMutation.variables ?? null) : null;
  const inferredRunStepId = inferredRunningStepId(
    builderDraft.steps,
    builderDraft.edges,
    selectedRun?.stepOutputs ?? {},
    selectedRun?.status,
  );
  const executingStepId = testingStepId ?? inferredRunStepId;
  const executionActivity: ExecutionActivity = testingStepId ? "test" : inferredRunStepId ? "run" : null;
  const selectedStepStatus = selectedStep ? outputStatus(selectedOutput, selectedStep.id === executingStepId) : "idle";
  const automationTitle = placeholderSetup ? "Automation setup" : draft.title?.trim() || draft.prompt;
  const selectedRunLifecycle = runMutation.isPending
    ? "pending"
    : triggeredRunId && !selectedRun
      ? "pending"
      : automationRunLifecycleState(selectedRun);
  const exactRunUnavailable = Boolean(
    selectedRunId && (exactRunQuery.isError || (exactRunQuery.isSuccess && !exactRun)),
  );
  const exactRunLoading = Boolean(selectedRunId && !exactRunUnavailable && exactRunQuery.isPending);
  const canRunAutomation = automation.status === "active";
  const hasActiveAutomationRun = [automation.latestRun, ...automation.recentRuns].some((run) => {
    const lifecycle = automationRunLifecycleState(run);
    return lifecycle === "pending" || lifecycle === "running";
  });
  const runIsBusy =
    runMutation.isPending ||
    hasActiveAutomationRun ||
    selectedRunLifecycle === "pending" ||
    selectedRunLifecycle === "running";
  const closeBuilder = () => {
    if (!placeholderSetup) {
      navigateToAutomations();
      return;
    }
    setDiscardingSetup(true);
    void api.scheduledTasks
      .remove(taskId)
      .then(async () => {
        if (requestedConversationId?.startsWith("builder-")) {
          await api.webChat.removeConversation(requestedConversationId).catch((error: unknown) => {
            if (error instanceof ApiRequestError && error.code === "CONVERSATION_NOT_FOUND") return;
            toast.error("The setup was removed, but its chat history could not be cleaned up");
          });
        }
        await invalidateAutomationQueries(queryClient, [taskId]);
        navigateToAutomations();
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : "Could not discard this setup"))
      .finally(() => setDiscardingSetup(false));
  };
  const runStateMessage = runMutation.isPending
    ? "Pending"
    : selectedRunLifecycle
      ? runStatusLabel(selectedRunLifecycle)
      : null;
  return (
    <div className="automation-builder-enter relative flex h-[calc(100vh-3rem)] min-h-0 overflow-hidden bg-background md:h-screen">
      <BuilderChatSidecar
        requestedConversationId={requestedConversationId ?? null}
        taskId={taskId}
        title={automationTitle}
        queryKey={queryKey}
        executionMode={isPlaceholderDraft(automation) ? setupExecutionMode : draft.executionMode}
        executionModeRecommendation={draft.executionModeRecommendation}
        isSetupPlaceholder={isPlaceholderDraft(automation)}
        executionModeSelection={executionModeSelection}
        originChat={automation.originChat}
        onExecutionModeSelect={updateExecutionMode}
        onExecutionModeSelectionHandled={handleExecutionModeSelectionHandled}
        onBusyChange={setBuilderChatBusy}
        onBackToAutomations={navigateToAutomations}
        clientSessionId={clientSessionId}
        authoringLease={authoringLease ? leaseRequest(authoringLease) : null}
        onLeaseStale={() => setAuthoringLease(null)}
        className="automation-builder-sidecar-enter hidden lg:flex"
      />

      <div
        data-testid="automation-builder-canvas"
        className="automation-builder-canvas-enter relative min-h-0 min-w-0 flex-1 bg-background text-foreground"
        aria-busy={runMutation.isPending || selectedRun?.status === "running"}
      >
        <div className="pointer-events-none absolute top-4 left-4 right-4 z-10 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="pointer-events-auto flex min-w-0 flex-col items-start gap-2">
            <div
              data-testid="automation-builder-toolbar"
              className="automation-builder-toolbar-enter pointer-events-auto flex min-w-0 flex-wrap items-center gap-2 rounded-[8px] border border-border/70 bg-card/90 p-1.5 shadow-md backdrop-blur"
            >
              <RunsMenu
                runs={automation.recentRuns}
                activeRunId={selectedRun?.id ?? null}
                memberNameById={memberNameById}
                onSelectRun={(runId) => {
                  setTriggeredRunId(null);
                  setRunRequestError(null);
                  navigateRun(runId);
                }}
              />
              {selectedRunId ? (
                <Button
                  size="sm"
                  variant="outline"
                  className={canvasToolbarButtonClass}
                  onClick={() => {
                    setTriggeredRunId(null);
                    setRunRequestError(null);
                    navigateRun(null);
                  }}
                >
                  Latest
                </Button>
              ) : null}
            </div>
            <AutomationLockBanner
              lock={lockView}
              canEdit={canEditAutomation}
              onRequestTakeover={() => setStealDialogOpen(true)}
              onReviewStealRequest={() => setHolderResponseDialogOpen(true)}
            />
          </div>

          <div className="pointer-events-auto ml-auto flex flex-wrap justify-end gap-2">
            <BuilderOwnership automation={automation} />
            {canShareAutomation ? (
              <Button
                size="sm"
                variant="outline"
                className={cn(canvasToolbarButtonClass, "gap-1.5")}
                onClick={() => setShareDialogOpen(true)}
                disabled={builderReadOnly}
              >
                <ShareNetworkIcon size={14} />
                Share{automation.shares && automation.shares.length > 0 ? ` · ${automation.shares.length}` : ""}
              </Button>
            ) : null}
            {automation.isOwner === false ? (
              <span
                data-testid="automation-shared-hint"
                className="inline-flex min-h-8 items-center rounded-[7px] border border-border/70 bg-card/90 px-2.5 text-[11px] font-medium text-muted-foreground backdrop-blur"
              >
                Shared with you · runs execute with the owner's integrations
              </span>
            ) : null}
            {runStateMessage || exactRunUnavailable || exactRunLoading || runRequestError ? (
              <AutomationRunStatusNotice
                state={runRequestError ? "failure" : selectedRunLifecycle}
                run={selectedRun}
                loading={exactRunLoading}
                unavailable={exactRunUnavailable}
                requestFailed={Boolean(runRequestError)}
              />
            ) : null}
            {!placeholderSetup ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 rounded-[7px] border-destructive/35 px-2.5 text-[12px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label="Delete automation"
                onClick={() => setDeleteDialogOpen(true)}
                disabled={deleteMutation.isPending || builderReadOnly}
              >
                <TrashIcon size={14} />
                <span>Delete</span>
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className={canvasToolbarButtonClass}
              onClick={closeBuilder}
              disabled={discardingSetup}
            >
              {discardingSetup ? "Discarding…" : placeholderSetup ? "Discard setup" : "Close"}
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 rounded-[7px] bg-brand-accent text-[#161300] shadow-none hover:bg-brand-accent/90"
              onClick={() => runMutation.mutate()}
              disabled={runIsBusy || !canRunAutomation || builderReadOnly}
              title={
                placeholderSetup
                  ? "Finish setup before running this automation"
                  : canRunAutomation
                    ? undefined
                    : "Only active automations can be triggered"
              }
            >
              {runMutation.isPending ? (
                <SpinnerGapIcon size={14} className="animate-spin" />
              ) : (
                <PlayIcon size={14} weight="fill" />
              )}
              {runMutation.isPending
                ? "Starting…"
                : runIsBusy
                  ? "Running"
                  : placeholderSetup
                    ? "Setting up"
                    : canRunAutomation
                      ? "Run"
                      : "Paused"}
            </Button>
          </div>
        </div>

        <AutomationCanvas
          draft={builderDraft}
          selectedStepId={selectedStepId}
          stepOutputs={selectedRun?.stepOutputs ?? {}}
          runStatus={selectedRun?.status}
          testingStepId={testingStepId}
          isSetupPlaceholder={placeholderSetup}
          isBuilderChatBusy={builderChatBusy}
          readOnly={builderReadOnly}
          onSelectStep={setSelectedStepId}
          onUpdateStepPositions={updateStepPositions}
        />
      </div>

      <BuilderDeleteDialog
        automationTitle={automationTitle}
        open={deleteDialogOpen}
        isDeleting={deleteMutation.isPending}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={() => deleteMutation.mutate()}
      />

      <NodeDrawer
        key={selectedStep?.id ?? "closed"}
        taskId={taskId}
        draft={builderDraft}
        step={selectedStep}
        output={selectedOutput}
        run={selectedRun ?? null}
        status={selectedStepStatus}
        executionActivity={selectedStep?.id === executingStepId ? executionActivity : null}
        readOnly={builderReadOnly}
        onClose={() => setSelectedStepId(null)}
        onTest={(stepId) => testMutation.mutate(stepId)}
        testingStepId={testingStepId}
        onUpdateAgentPrompt={updateAgentPrompt}
        savingPromptStepId={savingPromptStepId}
      />

      <AutomationShareDialog
        taskId={taskId}
        taskName={automationTitle}
        ownerUserId={automation.createdBy}
        canShare={canShareAutomation && !builderReadOnly}
        lease={authoringLease ? leaseRequest(authoringLease) : null}
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
      />

      <AutomationLockStealDialog
        taskId={taskId}
        open={stealDialogOpen}
        onOpenChange={setStealDialogOpen}
        lock={lockView}
        clientSessionId={clientSessionId}
        generation={authoringLease?.generation}
        onRequested={(nextLock) => {
          queryClient.setQueryData(editLockQueryKey, nextLock);
        }}
      />

      <AutomationLockHolderResponseDialog
        taskId={taskId}
        open={holderResponseDialogOpen}
        onOpenChange={setHolderResponseDialogOpen}
        lock={lockView}
        lease={authoringLease ? leaseRequest(authoringLease) : null}
        onResponded={(nextLock) => {
          queryClient.setQueryData(editLockQueryKey, nextLock);
          if (nextLock.isHeldByMe) {
            setAuthoringLease({ clientSessionId, generation: nextLock.generation, holder: nextLock });
          } else {
            setAuthoringLease(null);
          }
          void queryClient.invalidateQueries({ queryKey: builderConversationQueryKey(taskId, clientSessionId) });
        }}
      />
    </div>
  );
}

function AutomationRunStatusNotice({
  state,
  run,
  loading,
  unavailable,
  requestFailed,
}: {
  state: AutomationRunLifecycleState | null;
  run: AutomationRunRecord | null;
  loading: boolean;
  unavailable: boolean;
  requestFailed: boolean;
}) {
  if (unavailable) {
    return (
      <output
        data-testid="automation-run-unavailable"
        role="alert"
        aria-live="assertive"
        className="inline-flex min-h-8 items-center rounded-[7px] border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive backdrop-blur"
      >
        Run unavailable
      </output>
    );
  }
  if (loading) {
    return (
      <output
        data-testid="automation-run-loading"
        aria-live="polite"
        className="inline-flex min-h-8 items-center rounded-[7px] border border-border/70 bg-card/90 px-2.5 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur"
      >
        <SpinnerGapIcon size={13} className="mr-1.5 animate-spin" />
        Loading run
      </output>
    );
  }
  if (!state) return null;

  const label = runStatusLabel(state);
  const copy = requestFailed
    ? "Run could not be started."
    : state === "pending"
      ? "Run is queued."
      : state === "running"
        ? "Run is in progress."
        : state === "success"
          ? "Run completed successfully."
          : state === "aborted"
            ? "Run was aborted."
            : "Run failed.";
  const details = state === "failure" ? run?.errorMessage?.trim() : null;
  return (
    <output
      data-testid="automation-run-state"
      aria-live="polite"
      className={cn(
        "inline-flex min-h-8 max-w-[320px] items-center gap-1.5 rounded-[7px] border bg-card/90 px-2.5 py-1 text-[11px] font-medium backdrop-blur",
        state === "success" && "border-success/35 text-success",
        state === "failure" && "border-destructive/40 text-destructive",
        state === "aborted" && "border-amber-500/40 text-amber-700 dark:text-amber-300",
        (state === "pending" || state === "running") && "border-border/70 text-muted-foreground",
      )}
    >
      {state === "pending" || state === "running" ? (
        <SpinnerGapIcon size={13} className="shrink-0 animate-spin" />
      ) : state === "success" ? (
        <CheckCircleIcon size={13} weight="fill" className="shrink-0" />
      ) : (
        <XCircleIcon size={13} weight="fill" className="shrink-0" />
      )}
      <span>
        {label}: {copy}
      </span>
      {details ? (
        <details className="ml-1 max-w-full">
          <summary className="cursor-pointer font-normal underline underline-offset-2">Inspect details</summary>
          <pre className="absolute right-2 top-full z-40 mt-1 max-w-[320px] whitespace-pre-wrap break-words rounded-[7px] border border-border bg-card p-2 font-mono text-[10px] font-normal text-foreground shadow-lg">
            {details}
          </pre>
        </details>
      ) : null}
    </output>
  );
}

function textFromBuilderMessage(message: BuilderWebChatMessage): string {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return (
    normalizeBuilderDisplayText(text) || (questionBatchAnswerFromBuilderMessage(message) ? "Submitted answers" : "")
  );
}

function normalizeBuilderDisplayText(text: string): string {
  if (!text.startsWith(BUILDER_MODE_SELECTION_MARKER)) return text;
  const modeMatch = text.match(/I chose the "(deterministic|hybrid|agent-led)" execution mode/);
  const mode = modeMatch?.[1];
  if (mode === "deterministic" || mode === "hybrid" || mode === "agent-led") {
    return `${automationExecutionModeMetadata[mode].label} selected.`;
  }
  const metadata = Object.values(automationExecutionModeMetadata).find((candidate) =>
    text.includes(`(${candidate.label})`),
  );
  return metadata ? `${metadata.label} selected.` : "Execution mode selected.";
}

function isBuilderNavigationProgressText(value: string): boolean {
  return /opening (?:the )?automation builder/i.test(value);
}

function progressLinesFromBuilderMessage(message: BuilderWebChatMessage): string[] {
  const progressPart = message.parts.find((part) => part.type === "data-progress");
  return (
    progressPart?.data.lines.filter((line) => line.trim().length > 0 && !isBuilderNavigationProgressText(line)) ?? []
  );
}

function progressItemsFromBuilderMessage(message: BuilderWebChatMessage): ChatThreadProgressItem[] {
  const progressPart = message.parts.find((part) => part.type === "data-progress");
  return progressPart?.data.items?.filter((item) => !isBuilderNavigationProgressText(item.label)) ?? [];
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

function questionFromBuilderMessage(message: BuilderWebChatMessage): WebChatQuestion | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part.type === "data-question") return part.data;
  }
  return undefined;
}

function questionBatchFromBuilderMessage(message: BuilderWebChatMessage): WebChatQuestionBatch | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part.type === "data-question-batch") return part.data;
  }
  return undefined;
}

function questionBatchAnswerFromBuilderMessage(message: BuilderWebChatMessage): WebChatQuestionBatchAnswer | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part.type === "data-question-batch-answer") return part.data;
  }
  return undefined;
}

function createdAtFromBuilderMessage(message: BuilderWebChatMessage): string | undefined {
  const value = message.createdAt;
  if (typeof value === "string" && value.trim()) return value;
  if (value instanceof Date) return value.toISOString();
  return message.metadata?.createdAt?.trim() || undefined;
}

export function builderChatThreadMessages(messages: BuilderWebChatMessage[]): ChatThreadMessage[] {
  return messages.flatMap<ChatThreadMessage>((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const rawText = textFromBuilderMessage(message);
    const text = message.role === "assistant" && isBuilderNavigationProgressText(rawText) ? "" : rawText;
    const files = filesFromBuilderMessage(message);
    const automations: AutomationArtifact[] = [];
    const interruption = interruptionFromBuilderMessage(message);
    const question = message.role === "assistant" ? questionFromBuilderMessage(message) : undefined;
    const questionBatch = message.role === "assistant" ? questionBatchFromBuilderMessage(message) : undefined;
    const createdAt = createdAtFromBuilderMessage(message);
    if (text || files.length > 0 || automations.length > 0 || interruption || question || questionBatch) {
      return [
        {
          id: message.id,
          role: message.role,
          text: text || undefined,
          createdAt,
          files: files.length > 0 ? files : undefined,
          automations: automations.length > 0 ? automations : undefined,
          ...(question ? { question } : {}),
          ...(questionBatch ? { questionBatch } : {}),
          interruption,
        },
      ];
    }
    if (message.role === "assistant") {
      const progressLines = progressLinesFromBuilderMessage(message);
      const progressItems = progressItemsFromBuilderMessage(message);
      if (progressLines.length > 0 || progressItems.length > 0) {
        return [
          {
            id: message.id,
            role: message.role,
            createdAt,
            ...(progressLines.length > 0 ? { progressLines } : {}),
            ...(progressItems.length > 0 ? { progressItems } : {}),
          },
        ];
      }
    }
    return [];
  });
}

function hasPendingBuilderAssistantProgress(messages: BuilderWebChatMessage[]): boolean {
  const latestMessage = messages.at(-1);
  if (!latestMessage || latestMessage.role !== "assistant") return false;
  const text = textFromBuilderMessage(latestMessage);
  const visibleText = isBuilderNavigationProgressText(text) ? "" : text;
  return (
    (progressLinesFromBuilderMessage(latestMessage).length > 0 ||
      progressItemsFromBuilderMessage(latestMessage).length > 0) &&
    !visibleText &&
    !interruptionFromBuilderMessage(latestMessage) &&
    filesFromBuilderMessage(latestMessage).length === 0 &&
    automationsFromBuilderMessage(latestMessage).length === 0 &&
    !questionFromBuilderMessage(latestMessage) &&
    !questionBatchFromBuilderMessage(latestMessage)
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

export function outgoingBuilderQuestionAnswerMessage(
  question: WebChatQuestion,
  answer: WebChatQuestionOption | WebChatQuestionAnswer,
) {
  const payload: WebChatQuestionAnswer = "id" in answer ? { questionId: question.id, optionId: answer.id } : answer;
  const text =
    "optionId" in payload
      ? (question.options.find((option) => option.id === payload.optionId)?.label ?? payload.optionId)
      : payload.customResponse;
  return {
    metadata: { createdAt: new Date().toISOString() },
    parts: [
      { type: "text" as const, text },
      {
        type: "data-question-answer" as const,
        id: `question-answer-${question.id}`,
        data: payload,
      },
    ],
  };
}

export function outgoingBuilderQuestionBatchAnswerMessage(
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
    return "optionId" in item
      ? (question?.options.find((option) => option.id === item.optionId)?.label ?? item.optionId)
      : item.customResponse;
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

function outgoingBuilderRequestOptions(
  taskId: string,
  attachments: WebChatUploadedAttachment[],
  authoringLease?: AutomationLeaseRequest | null,
) {
  return {
    body: {
      automationTaskId: taskId,
      ...(authoringLease ?? {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  };
}

const builderConversationQueryKey = (taskId: string, clientSessionId: string) =>
  ["scheduled-tasks", taskId, "conversations", clientSessionId] as const;

function replaceBuilderConversationCache(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  conversation: ScheduledTaskConversationSummary,
) {
  queryClient.setQueryData<ScheduledTaskConversationsResponse>(queryKey, (current) => {
    if (!current) return current;
    return {
      ...current,
      conversations: [
        conversation,
        ...current.conversations.filter((item) => item.conversationId !== conversation.conversationId),
      ],
    };
  });
}

function conversationSourceLabel(conversation: ScheduledTaskConversationSummary): string {
  const hasBuilder = conversation.kinds.includes("builder");
  const hasWebChat = conversation.kinds.includes("web_chat");
  if (hasBuilder && hasWebChat) return "Source + automation";
  if (hasWebChat) return "Source";
  return "Automation";
}

function conversationDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function conversationDisplayTitle(
  conversation: ScheduledTaskConversationSummary,
  summary?: WebChatConversationSummary,
): string {
  const title = summary?.title.trim();
  if (title) return normalizeBuilderDisplayText(title);
  return conversation.kinds.includes("web_chat") ? "Source chat" : "Automation chat";
}

function conversationDisplayUpdatedAt(
  conversation: ScheduledTaskConversationSummary,
  summary?: WebChatConversationSummary,
): string {
  return summary?.updatedAt ?? conversation.lastActiveAt;
}

function builderChatMutationError(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.code === "BUILDER_CHAT_LOCKED") {
    const lock = (error.details.builderLock ?? error.details.lock) as ScheduledTaskConversationLock | undefined;
    return lock?.owner === "self"
      ? "This automation is open in another window. Return to that window to continue the chat."
      : "This automation is being edited by another user. You can view it, but chat is read-only until they release it.";
  }
  if (error instanceof ApiRequestError && (error.status >= 500 || error.code === "LEASE_STALE")) {
    return "Sketch could not verify the editing session. Try again.";
  }
  return error instanceof Error ? error.message : fallback;
}

function BuilderChatSidecar({
  requestedConversationId,
  taskId,
  title,
  queryKey,
  executionMode,
  executionModeRecommendation,
  isSetupPlaceholder,
  executionModeSelection,
  originChat,
  onExecutionModeSelect,
  onExecutionModeSelectionHandled,
  onBusyChange,
  onBackToAutomations,
  clientSessionId,
  authoringLease,
  onLeaseStale,
  className,
}: {
  requestedConversationId: string | null;
  taskId: string;
  title: string;
  queryKey: readonly unknown[];
  executionMode: AutomationExecutionMode | null;
  executionModeRecommendation: AutomationDefinition["executionModeRecommendation"];
  isSetupPlaceholder: boolean;
  executionModeSelection: ExecutionModeSelection | null;
  originChat: AutomationDefinition["originChat"];
  onExecutionModeSelect: (mode: AutomationExecutionMode) => void;
  onExecutionModeSelectionHandled: (selectionId: number) => void;
  onBusyChange: (busy: boolean) => void;
  onBackToAutomations: () => void;
  clientSessionId: string;
  authoringLease: AutomationLeaseRequest | null;
  onLeaseStale: () => void;
  className?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const conversationsQueryKey = useMemo(
    () => builderConversationQueryKey(taskId, clientSessionId),
    [clientSessionId, taskId],
  );
  const conversationsQuery = useQuery({
    queryKey: conversationsQueryKey,
    queryFn: () =>
      api.scheduledTasks.conversations(taskId, {
        includeArchived: true,
        clientSessionId,
      }),
    refetchInterval: AUTOMATION_EDIT_LOCK_POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });
  const webChatConversationsQuery = useQuery({
    queryKey: WEB_CHAT_CONVERSATIONS_QUERY_KEY,
    queryFn: () => api.webChat.conversations(),
    staleTime: 30_000,
  });
  const webChatSummaryById = useMemo(
    () => new Map((webChatConversationsQuery.data?.conversations ?? []).map((summary) => [summary.id, summary])),
    [webChatConversationsQuery.data],
  );
  const pendingSelectionLeaseRef = useRef<AutomationLeaseRequest | null>(null);
  const visibleConversations = useMemo(() => {
    const conversations = conversationsQuery.data?.conversations ?? [];
    const builderConversations = conversations.filter((conversation) => conversation.kinds.includes("builder"));
    return builderConversations.length > 0 ? builderConversations : conversations;
  }, [conversationsQuery.data?.conversations]);
  const selectedConversation = visibleConversations.find(
    (conversation) => conversation.conversationId === requestedConversationId,
  );
  const initialBuilderConversationId = useMemo(() => {
    const builderConversations = visibleConversations.filter((conversation) => conversation.kinds.includes("builder"));
    return builderConversations.reduce<ScheduledTaskConversationSummary | null>((oldest, conversation) => {
      if (!oldest) return conversation;
      return new Date(conversation.createdAt).getTime() < new Date(oldest.createdAt).getTime() ? conversation : oldest;
    }, null)?.conversationId;
  }, [visibleConversations]);
  const originContextQuery = useQuery({
    queryKey: ["automation-origin-context", taskId, originChat?.platform, originChat?.conversationId],
    queryFn: async (): Promise<BuilderSourceContextMessage[]> => {
      if (!originChat?.conversationId) return [];
      if (originChat.platform === "web") {
        const response = await api.webChat.messages(originChat.conversationId);
        return sourceContextMessagesFromWebChat(response.messages);
      }
      const response = await api.scheduledTasks.originChatMessages(taskId);
      return sourceContextMessagesFromProvider(response.messages);
    },
    enabled: Boolean(
      requestedConversationId &&
        selectedConversation?.state === "active" &&
        selectedConversation.kinds.includes("builder"),
    ),
    staleTime: 30_000,
  });

  const openConversation = useCallback(
    (conversationId: string) => {
      void navigate({
        to: "/scheduled-tasks/$taskId/edit",
        params: { taskId },
        search: { conversationId },
        replace: true,
      });
    },
    [navigate, taskId],
  );
  const openChatList = useCallback(() => {
    void navigate({
      to: "/scheduled-tasks/$taskId/edit",
      params: { taskId },
      search: {},
      replace: true,
    });
  }, [navigate, taskId]);

  const createMutation = useMutation({
    mutationFn: () => {
      if (!authoringLease) throw new Error("Acquire the automation editing session before starting a chat");
      pendingSelectionLeaseRef.current = authoringLease;
      return api.scheduledTasks.createConversation(taskId, { createNew: true, ...authoringLease });
    },
    onSuccess: ({ conversation }) => {
      if (!sameLease(pendingSelectionLeaseRef.current, authoringLease)) return;
      replaceBuilderConversationCache(queryClient, conversationsQueryKey, conversation);
      openConversation(conversation.conversationId);
    },
    onError: (error) => toast.error(builderChatMutationError(error, "Could not start a chat")),
  });
  const selectMutation = useMutation({
    mutationFn: (conversation: ScheduledTaskConversationSummary) => {
      if (!authoringLease) {
        return Promise.reject(new Error("Acquire the automation editing session before opening a chat"));
      }
      pendingSelectionLeaseRef.current = authoringLease;
      return api.scheduledTasks.selectConversation(
        taskId,
        conversation.conversationId,
        conversation.kinds[0],
        authoringLease,
      );
    },
    onSuccess: ({ conversation }) => {
      if (!sameLease(pendingSelectionLeaseRef.current, authoringLease)) return;
      replaceBuilderConversationCache(queryClient, conversationsQueryKey, conversation);
      openConversation(conversation.conversationId);
    },
    onError: (error) => {
      if (isLeaseStaleError(error)) onLeaseStale();
      toast.error(builderChatMutationError(error, "This chat is unavailable"));
    },
  });
  const archiveMutation = useMutation({
    mutationFn: (conversationId: string) =>
      api.scheduledTasks.archiveConversation(taskId, conversationId, true, authoringLease ?? undefined),
    onSuccess: ({ conversation }) => {
      replaceBuilderConversationCache(queryClient, conversationsQueryKey, conversation);
      openChatList();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not archive this chat"),
  });
  const restoreMutation = useMutation({
    mutationFn: (conversationId: string) =>
      api.scheduledTasks.archiveConversation(taskId, conversationId, false, authoringLease ?? undefined),
    onSuccess: ({ conversation }) => {
      replaceBuilderConversationCache(queryClient, conversationsQueryKey, conversation);
      openConversation(conversation.conversationId);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not restore this chat"),
  });

  const selectedIsArchived = selectedConversation?.state === "archived";
  return (
    <aside
      data-testid="automation-builder-chat-sidecar"
      aria-label="Automation chats"
      className={cn(
        "box-border w-[460px] min-w-[400px] max-w-[560px] shrink-0 resize-x flex-col overflow-hidden border-r border-border/80 bg-background text-foreground",
        className,
      )}
    >
      <BuilderChatHeader
        conversation={selectedConversation}
        summary={selectedConversation ? webChatSummaryById.get(selectedConversation.conversationId) : undefined}
        title={title}
        onBack={selectedConversation ? openChatList : undefined}
        onBackToAutomations={onBackToAutomations}
        onNew={() => createMutation.mutate()}
        newPending={createMutation.isPending}
        newDisabled={!authoringLease}
        onArchive={
          selectedConversation && !selectedIsArchived && authoringLease
            ? () => archiveMutation.mutate(selectedConversation.conversationId)
            : undefined
        }
        archivePending={archiveMutation.isPending}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {conversationsQuery.isError ? (
          <BuilderChatNavigationError onRetry={() => void conversationsQuery.refetch()} />
        ) : conversationsQuery.isLoading || !conversationsQuery.data ? (
          <BuilderChatLoadingState />
        ) : !requestedConversationId ? (
          <BuilderChatListView
            conversations={visibleConversations}
            builderLock={conversationsQuery.data.builderLock}
            summaryById={webChatSummaryById}
            onSelect={(conversation) => {
              if (conversation.state === "archived" || !authoringLease) openConversation(conversation.conversationId);
              else selectMutation.mutate(conversation);
            }}
            selectingConversationId={selectMutation.isPending ? selectMutation.variables?.conversationId : null}
          />
        ) : !selectedConversation ? (
          <BuilderChatUnavailableState onBack={openChatList} />
        ) : selectedIsArchived ? (
          <BuilderChatArchivedState
            onBack={openChatList}
            onRestore={() => restoreMutation.mutate(selectedConversation.conversationId)}
            restoring={restoreMutation.isPending}
            canRestore={Boolean(authoringLease)}
          />
        ) : (
          <BuilderChatTranscript
            key={selectedConversation.conversationId}
            conversationId={selectedConversation.conversationId}
            conversationKind={selectedConversation.kinds[0]}
            taskId={taskId}
            title={title}
            queryKey={queryKey}
            conversationsQueryKey={conversationsQueryKey}
            executionMode={executionMode}
            executionModeRecommendation={executionModeRecommendation}
            isSetupPlaceholder={isSetupPlaceholder}
            isInitialBuilderConversation={selectedConversation.conversationId === initialBuilderConversationId}
            executionModeSelection={executionModeSelection}
            originContextMessages={originContextQuery.data ?? []}
            originContextLoading={originContextQuery.isPending && Boolean(originChat?.conversationId)}
            authoringLease={authoringLease}
            onLeaseStale={onLeaseStale}
            onExecutionModeSelect={onExecutionModeSelect}
            onExecutionModeSelectionHandled={onExecutionModeSelectionHandled}
            onBusyChange={onBusyChange}
            onBack={openChatList}
          />
        )}
      </div>
    </aside>
  );
}

function BuilderChatHeader({
  conversation,
  summary,
  title,
  onBack,
  onBackToAutomations,
  onNew,
  newPending,
  newDisabled,
  onArchive,
  archivePending,
}: {
  conversation?: ScheduledTaskConversationSummary;
  summary?: WebChatConversationSummary;
  title: string;
  onBack?: () => void;
  onBackToAutomations: () => void;
  onNew: () => void;
  newPending: boolean;
  newDisabled?: boolean;
  onArchive?: () => void;
  archivePending: boolean;
}) {
  const conversationTitle = conversation ? conversationDisplayTitle(conversation, summary) : null;
  return (
    <div className="shrink-0 border-b border-border/80 bg-background/95 px-3 py-3 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2.5">
        {conversation && onBack ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 gap-1.5 rounded-[8px] px-2 text-[12px] text-muted-foreground hover:bg-muted/80 hover:text-foreground focus-visible:ring-brand-accent/50"
            aria-label="Back to chats"
            onClick={onBack}
          >
            <ArrowLeftIcon size={15} />
            <span>Chats</span>
          </Button>
        ) : !conversation ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 gap-1.5 rounded-[8px] px-2 text-[12px] text-muted-foreground hover:bg-muted/80 hover:text-foreground focus-visible:ring-brand-accent/50"
            aria-label="Back to automations"
            onClick={onBackToAutomations}
          >
            <ArrowLeftIcon size={15} />
            <span>Automations</span>
          </Button>
        ) : (
          <span className="size-8 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          {conversation ? (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <p
                  title={conversationTitle ?? undefined}
                  className="truncate text-[13px] font-semibold leading-5 text-foreground"
                >
                  {conversationTitle}
                </p>
                <Badge className="shrink-0 rounded-[5px] border border-border/80 bg-muted/60 px-1.5 py-0 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {conversationSourceLabel(conversation)}
                </Badge>
              </div>
              <p title={title} className="truncate text-[11px] leading-4 text-muted-foreground">
                {title} · {conversationDateLabel(conversationDisplayUpdatedAt(conversation, summary))}
              </p>
              {!summary ? (
                <p className="truncate font-mono text-[10px] leading-4 text-muted-foreground/60">
                  Chat {conversation.conversationId}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-[13px] font-semibold leading-5 text-foreground">Chats</p>
              <p title={title} className="truncate text-[11px] leading-4 text-muted-foreground">
                {title}
              </p>
            </>
          )}
        </div>
        {conversation ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0 rounded-[8px] text-muted-foreground hover:bg-muted/80 hover:text-foreground focus-visible:ring-brand-accent/50"
            aria-label="Archive chat"
            disabled={!onArchive || archivePending}
            onClick={onArchive}
          >
            {archivePending ? <SpinnerGapIcon size={15} className="animate-spin" /> : <ArchiveIcon size={16} />}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0 gap-1.5 rounded-[8px] border-border/80 bg-background px-2.5 text-[12px] shadow-none hover:bg-muted/70 focus-visible:ring-brand-accent/50"
            onClick={onNew}
            disabled={newPending || newDisabled}
          >
            {newPending ? <SpinnerGapIcon size={14} className="animate-spin" /> : <PlusIcon size={14} />}
            New chat
          </Button>
        )}
      </div>
    </div>
  );
}

function BuilderChatListView({
  conversations,
  builderLock,
  summaryById,
  onSelect,
  selectingConversationId,
}: {
  conversations: ScheduledTaskConversationSummary[];
  builderLock?: ScheduledTaskConversationLock;
  summaryById: ReadonlyMap<string, WebChatConversationSummary>;
  onSelect: (conversation: ScheduledTaskConversationSummary) => void;
  selectingConversationId: string | null;
}) {
  const active = conversations.filter((conversation) => conversation.state === "active");
  const archived = conversations.filter((conversation) => conversation.state === "archived");
  const renderConversation = (conversation: ScheduledTaskConversationSummary) => {
    const summary = summaryById.get(conversation.conversationId);
    const conversationTitle = conversationDisplayTitle(conversation, summary);
    return (
      <button
        key={conversation.conversationId}
        type="button"
        data-testid={`automation-builder-conversation-${conversation.conversationId}`}
        aria-label={`Open ${conversation.state === "archived" ? "archived " : ""}chat: ${conversationTitle}`}
        className="group flex w-full min-w-0 items-start gap-2.5 rounded-[9px] px-2.5 py-2.5 text-left outline-none transition-[background-color,color] hover:bg-muted/70 focus-visible:bg-muted/80 focus-visible:ring-2 focus-visible:ring-brand-accent/55 disabled:cursor-wait disabled:opacity-60"
        onClick={() => onSelect(conversation)}
        disabled={selectingConversationId !== null}
      >
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-muted/80 text-brand-accent transition-colors group-hover:bg-brand-accent/12">
          <RobotIcon size={15} weight="fill" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span title={conversationTitle} className="truncate text-[12px] font-medium leading-5 text-foreground">
              {conversationTitle}
            </span>
            {selectingConversationId === conversation.conversationId ? (
              <SpinnerGapIcon size={13} className="shrink-0 animate-spin text-muted-foreground" />
            ) : null}
          </span>
          {!summary ? (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/60">
              Chat {conversation.conversationId}
            </span>
          ) : null}
          <span className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{conversationSourceLabel(conversation)}</span>
            <span aria-hidden>·</span>
            {conversation.transcriptUserName ? (
              <>
                <span className="truncate">by {conversation.transcriptUserName}</span>
                <span aria-hidden>·</span>
              </>
            ) : null}
            <span className="shrink-0">
              {conversationDateLabel(conversationDisplayUpdatedAt(conversation, summary))}
            </span>
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="chat-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-3">
      <div className="flex min-h-full flex-col gap-5">
        {builderLock?.state === "held" && builderLock.owner !== "self" ? (
          <BuilderChatLockNotice lock={builderLock} />
        ) : null}
        <div>
          <p className="px-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Recent</p>
          {active.length > 0 ? (
            <div className="mt-1 grid gap-0.5">{active.map(renderConversation)}</div>
          ) : (
            <div className="mx-2.5 mt-3 border-l border-border pl-3 text-[12px] leading-5 text-muted-foreground">
              No chats yet. Start one when you are ready.
            </div>
          )}
        </div>
        {archived.length > 0 ? (
          <div>
            <p className="px-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Archived
            </p>
            <div className="mt-1 grid gap-0.5">{archived.map(renderConversation)}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BuilderChatLockNotice({ lock }: { lock: ScheduledTaskConversationLock }) {
  return (
    <div
      data-testid="automation-builder-chat-lock-notice"
      className="mx-2.5 border-l-2 border-amber-500/70 pl-3 text-[12px] leading-5 text-muted-foreground"
    >
      <p className="font-medium text-foreground">Chat is read-only</p>
      <p>Another editing session is active. Use Take over editing above to continue here.</p>
    </div>
  );
}

function BuilderChatNavigationError({ onRetry }: { onRetry: () => void }) {
  return (
    <div data-testid="automation-builder-chat-error" className="flex min-h-full items-center justify-center px-5 py-6">
      <div className="w-full border-l-2 border-destructive/70 pl-4">
        <p className="text-[13px] font-semibold text-foreground">Chats unavailable</p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          Sketch could not load the task chat history. Your automation is still available.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-3 h-8 rounded-[7px] border-border/70 bg-background text-[12px] shadow-none"
          onClick={onRetry}
        >
          Try again
        </Button>
      </div>
    </div>
  );
}

function BuilderChatUnavailableState({ onBack }: { onBack: () => void }) {
  return (
    <div
      data-testid="automation-builder-chat-unavailable"
      className="flex min-h-full items-center justify-center px-5 py-6"
    >
      <div className="w-full border-l border-border pl-4">
        <p className="text-[13px] font-semibold text-foreground">Chat unavailable</p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          This chat is not associated with this automation for your account, so its transcript was not opened.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-3 h-8 rounded-[7px] border-border/70 bg-background text-[12px] shadow-none"
          onClick={onBack}
        >
          Back to chats
        </Button>
      </div>
    </div>
  );
}

function BuilderChatLockState({
  locked,
  onBack,
  onRetry,
}: {
  locked: boolean;
  onBack: () => void;
  onRetry: () => void;
}) {
  return (
    <div data-testid="automation-builder-chat-locked" className="flex min-h-full items-center justify-center px-5 py-6">
      <div className="w-full border-l-2 border-amber-500/70 pl-4">
        <p className="text-[13px] font-semibold text-foreground">
          {locked ? "Chat is read-only" : "Chat temporarily unavailable"}
        </p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          {locked
            ? "Another editing session is active. Use Take over editing above, then try again."
            : "Sketch could not confirm editing access. Refresh and try again before sending a message."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-[7px] border-border/70 bg-background text-[12px] shadow-none"
            onClick={onRetry}
          >
            Try again
          </Button>
          <Button size="sm" variant="ghost" className="h-8 rounded-[7px] text-[12px] shadow-none" onClick={onBack}>
            Back to chats
          </Button>
        </div>
      </div>
    </div>
  );
}

function BuilderChatArchivedState({
  onBack,
  onRestore,
  restoring,
  canRestore,
}: {
  onBack: () => void;
  onRestore: () => void;
  restoring: boolean;
  canRestore: boolean;
}) {
  return (
    <div
      data-testid="automation-builder-chat-archived"
      className="flex min-h-full items-center justify-center px-5 py-6"
    >
      <div className="w-full border-l border-border pl-4">
        <p className="text-[13px] font-semibold text-foreground">Chat archived</p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          This chat is kept for history but is not active. Restore it explicitly to continue the transcript.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            className="h-8 gap-1.5 rounded-[7px] bg-brand-accent text-[#161300] shadow-none hover:bg-brand-accent/90"
            onClick={onRestore}
            disabled={restoring || !canRestore}
          >
            {restoring ? <SpinnerGapIcon size={14} className="animate-spin" /> : <ArrowClockwiseIcon size={14} />}
            Restore chat
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-[7px] border-border/70 bg-background text-[12px] shadow-none"
            onClick={onBack}
          >
            Back to chats
          </Button>
        </div>
      </div>
    </div>
  );
}

type BuilderChatLockStatus = "loading" | "ready" | "locked" | "error";

const BUILDER_CHAT_LOCK_RENEWAL_INTERVAL_MS = 60_000;

function BuilderChatTranscript({
  conversationId,
  conversationKind,
  taskId,
  title,
  queryKey,
  conversationsQueryKey,
  executionMode,
  executionModeRecommendation,
  isSetupPlaceholder,
  isInitialBuilderConversation,
  executionModeSelection,
  originContextMessages,
  originContextLoading,
  authoringLease,
  onLeaseStale,
  onExecutionModeSelect,
  onExecutionModeSelectionHandled,
  onBusyChange,
  onBack,
}: {
  conversationId: string;
  conversationKind: ScheduledTaskConversationKind;
  taskId: string;
  title: string;
  queryKey: readonly unknown[];
  conversationsQueryKey: readonly unknown[];
  executionMode: AutomationExecutionMode | null;
  executionModeRecommendation: AutomationDefinition["executionModeRecommendation"];
  isSetupPlaceholder: boolean;
  isInitialBuilderConversation: boolean;
  executionModeSelection: ExecutionModeSelection | null;
  originContextMessages: BuilderSourceContextMessage[];
  originContextLoading: boolean;
  authoringLease: AutomationLeaseRequest | null;
  onLeaseStale: () => void;
  onExecutionModeSelect: (mode: AutomationExecutionMode) => void;
  onExecutionModeSelectionHandled: (selectionId: number) => void;
  onBusyChange: (busy: boolean) => void;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [lockStatus, setLockStatus] = useState<BuilderChatLockStatus>("loading");
  const [loadedHistoryKey, setLoadedHistoryKey] = useState<string | null>(null);
  const [historyLoadError, setHistoryLoadError] = useState<string | null>(null);
  const [historyLoadAttempt, setHistoryLoadAttempt] = useState(0);
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
  const selectBuilderConversation = useCallback(
    async (isCancelled?: () => boolean) => {
      setLockStatus("loading");
      if (!authoringLease) {
        setLockStatus("ready");
        return;
      }
      try {
        const { conversation } = await api.scheduledTasks.selectConversation(
          taskId,
          conversationId,
          conversationKind,
          authoringLease,
        );
        if (isCancelled?.()) return;
        replaceBuilderConversationCache(queryClient, conversationsQueryKey, conversation);
        setLockStatus("ready");
      } catch (error: unknown) {
        if (isCancelled?.()) return;
        if (isLeaseStaleError(error)) onLeaseStale();
        setLockStatus(error instanceof ApiRequestError && error.code === "BUILDER_CHAT_LOCKED" ? "locked" : "error");
      }
    },
    [authoringLease, conversationId, conversationKind, conversationsQueryKey, onLeaseStale, queryClient, taskId],
  );
  useEffect(() => {
    let cancelled = false;
    void selectBuilderConversation(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [selectBuilderConversation]);

  const lockReady = lockStatus === "ready";
  const historyKey = `${conversationId}:${historyLoadAttempt}`;
  const historyReady = lockReady && loadedHistoryKey === historyKey;
  const hasBackgroundRun = hasPendingBuilderAssistantProgress(chat.messages);
  const chatBusy = chat.status === "submitted" || chat.status === "streaming" || hasBackgroundRun || stoppingRun;
  const threadMessages = builderChatThreadMessages(chat.messages);
  const transcriptMessages = threadMessages;
  useEffect(() => {
    onBusyChange(chatBusy);
    return () => onBusyChange(false);
  }, [chatBusy, onBusyChange]);
  const latestMessage = chat.messages.at(-1);
  const threadScrollKey = latestMessage
    ? [
        latestMessage.id,
        latestMessage.role,
        textFromBuilderMessage(latestMessage).length,
        progressLinesFromBuilderMessage(latestMessage).join("\n").length,
        filesFromBuilderMessage(latestMessage).length,
        automationsFromBuilderMessage(latestMessage).length,
        questionFromBuilderMessage(latestMessage)?.id ?? "",
        questionBatchFromBuilderMessage(latestMessage)
          ? questionBatchSignature(questionBatchFromBuilderMessage(latestMessage) as WebChatQuestionBatch)
          : "",
        questionBatchAnswerFromBuilderMessage(latestMessage)?.batchId ?? "",
        chat.status,
      ].join(":")
    : "";
  useEffect(() => {
    if (!executionModeSelection || !historyReady || chatBusy) return;
    const { mode } = executionModeSelection;
    const modeMessage = `${BUILDER_MODE_SELECTION_MARKER} I chose the "${mode}" execution mode (${automationExecutionModeMetadata[mode].label}) for this automation. Please continue by asking the next relevant automation questions.`;
    void chat.sendMessage(
      outgoingBuilderTextMessage(modeMessage),
      outgoingBuilderRequestOptions(taskId, [], authoringLease),
    );
    onExecutionModeSelectionHandled(executionModeSelection.id);
  }, [
    authoringLease,
    chat.sendMessage,
    chatBusy,
    executionModeSelection,
    historyReady,
    onExecutionModeSelectionHandled,
    taskId,
  ]);
  const sendBuilderMessage = useCallback(
    (value: string, attachments: WebChatUploadedAttachment[] = []) => {
      void chat.sendMessage(
        outgoingBuilderTextMessage(value, attachments),
        outgoingBuilderRequestOptions(taskId, attachments, authoringLease),
      );
    },
    [authoringLease, chat.sendMessage, taskId],
  );
  const selectBuilderQuestion = useCallback(
    (question: WebChatQuestion, answer: WebChatQuestionOption | WebChatQuestionAnswer) => {
      void chat.sendMessage(
        outgoingBuilderQuestionAnswerMessage(question, answer),
        outgoingBuilderRequestOptions(taskId, [], authoringLease),
      );
    },
    [authoringLease, chat.sendMessage, taskId],
  );

  const submitBuilderQuestionBatch = useCallback(
    (batch: WebChatQuestionBatch, answer: WebChatQuestionBatchAnswer) => {
      void chat.sendMessage(
        outgoingBuilderQuestionBatchAnswerMessage(batch, answer),
        outgoingBuilderRequestOptions(taskId, [], authoringLease),
      );
    },
    [authoringLease, chat.sendMessage, taskId],
  );

  const loadMessagesForReconciliation = useCallback(
    async (targetConversationId: string, signal: AbortSignal) => {
      const response = await api.scheduledTasks.conversationMessages(taskId, targetConversationId, { signal });
      return { ...response, messages: response.messages as BuilderWebChatMessage[] };
    },
    [taskId],
  );
  useWebChatReconciliation({
    conversationId,
    historyReady,
    status: chat.status,
    error: chat.error,
    messages: chat.messages,
    hasPendingProgress: hasPendingBuilderAssistantProgress,
    loadMessages: loadMessagesForReconciliation,
    setMessages: chat.setMessages,
    clearError: chat.clearError,
  });

  useEffect(() => {
    let cancelled = false;
    if (!lockReady) {
      setLoadedHistoryKey(null);
      setHistoryLoadError(null);
      chat.setMessages([]);
      return () => {
        cancelled = true;
      };
    }
    setLoadedHistoryKey(null);
    setHistoryLoadError(null);
    chat.setMessages([]);
    void api.scheduledTasks
      .conversationMessages(taskId, conversationId)
      .then(({ messages }) => {
        if (!cancelled) chat.setMessages(messages as BuilderWebChatMessage[]);
      })
      .catch((error: unknown) => {
        if (!cancelled) setHistoryLoadError(error instanceof Error ? error.message : "Transcript unavailable");
      })
      .finally(() => {
        if (!cancelled) setLoadedHistoryKey(historyKey);
      });
    return () => {
      cancelled = true;
    };
  }, [chat.setMessages, conversationId, historyKey, lockReady, taskId]);

  useEffect(() => {
    if (!lockReady || !authoringLease) return;
    const timer = window.setInterval(() => {
      void api.scheduledTasks
        .selectConversation(taskId, conversationId, conversationKind, authoringLease)
        .then(({ conversation }) => {
          replaceBuilderConversationCache(queryClient, conversationsQueryKey, conversation);
        })
        .catch((error: unknown) => {
          if (isLeaseStaleError(error)) onLeaseStale();
          setLockStatus(error instanceof ApiRequestError && error.code === "BUILDER_CHAT_LOCKED" ? "locked" : "error");
        });
    }, BUILDER_CHAT_LOCK_RENEWAL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [
    authoringLease,
    conversationId,
    conversationKind,
    conversationsQueryKey,
    lockReady,
    onLeaseStale,
    queryClient,
    taskId,
  ]);

  useEffect(() => {
    if (!historyReady || !threadScrollKey) return;
    const frameId = window.requestAnimationFrame(() => {
      const el = threadScrollRef.current;
      if (!el) return;
      if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      else el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [historyReady, threadScrollKey]);

  useEffect(() => {
    const busy = chat.status === "submitted" || chat.status === "streaming";
    if (busy) {
      wasBusyRef.current = true;
      return;
    }
    if (!historyReady || !wasBusyRef.current) return;
    wasBusyRef.current = false;
    void invalidateAutomationQueries(queryClient, [taskId]);
    void queryClient.invalidateQueries({ queryKey: conversationsQueryKey });
  }, [chat.status, conversationsQueryKey, historyReady, queryClient, taskId]);

  const handleStop = useCallback(() => {
    if (stoppingRun) return;
    setStoppingRun(true);
    void api.webChat
      .interrupt(conversationId, taskId, authoringLease)
      .catch(() => undefined)
      .finally(() => setStoppingRun(false));
  }, [authoringLease, conversationId, stoppingRun, taskId]);

  if (lockStatus === "locked" || lockStatus === "error") {
    return (
      <BuilderChatLockState
        locked={lockStatus === "locked"}
        onBack={onBack}
        onRetry={() => void selectBuilderConversation()}
      />
    );
  }

  return (
    <>
      <div ref={threadScrollRef} className="chat-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-4">
        {historyReady && !historyLoadError ? (
          <div className="mb-6 space-y-5">
            {originContextLoading ? <BuilderSourceContextLoading /> : null}
            {originContextMessages.length > 0 ? <BuilderSourceContext messages={originContextMessages} /> : null}
            {chat.messages.length === 0 ? (
              isSetupPlaceholder && isInitialBuilderConversation && originContextMessages.length > 0 ? (
                <SketchMessage>
                  <AutomationSetupCard
                    mode={executionMode}
                    recommendation={executionModeRecommendation}
                    onSelect={onExecutionModeSelect}
                  />
                </SketchMessage>
              ) : (
                <AutomationDescriptionPrompt />
              )
            ) : null}
          </div>
        ) : null}
        {!historyReady ? (
          <BuilderChatLoadingState />
        ) : historyLoadError ? (
          <div
            data-testid="automation-builder-transcript-error"
            className="flex min-h-full items-center justify-center"
          >
            <div className="w-full border-l border-border pl-4">
              <p className="text-[13px] font-semibold text-foreground">Transcript unavailable</p>
              <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                This chat is associated with the task, but its transcript could not be loaded.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 h-8 rounded-[7px] border-border/70 bg-background text-[12px] shadow-none"
                onClick={() => setHistoryLoadAttempt((attempt) => attempt + 1)}
              >
                Try again
              </Button>
            </div>
          </div>
        ) : (
          <ChatThread
            className="mt-4 gap-4"
            messages={transcriptMessages}
            busy={chatBusy}
            error={chat.error?.message ?? null}
            conversationId={conversationId}
            onAnswerQuestion={selectBuilderQuestion}
            onSubmitQuestionBatch={submitBuilderQuestionBatch}
          />
        )}
      </div>
      <div className="shrink-0 border-t border-border/80 bg-background px-3 py-3">
        <ChatInput
          key={conversationId}
          disabled={!authoringLease || !historyReady || Boolean(historyLoadError) || chatBusy}
          disabledPlaceholder={chatBusy ? "" : historyReady ? "Transcript unavailable" : "Loading conversation..."}
          running={chatBusy}
          runningPlaceholder="Sketch is thinking..."
          stopping={stoppingRun}
          onStop={handleStop}
          placeholder="Reply to Sketch..."
          onSubmit={sendBuilderMessage}
        />
      </div>
    </>
  );
}

function BuilderChatLoadingState() {
  return (
    <div className="flex min-h-full items-center justify-center px-3 text-[13px] text-muted-foreground">
      <div className="flex items-center gap-2">
        <SpinnerGapIcon size={15} className="animate-spin" />
        Loading chat…
      </div>
    </div>
  );
}

function BuilderSourceContext({ messages }: { messages: BuilderSourceContextMessage[] }) {
  return (
    <div data-testid="automation-builder-source-context" className="space-y-2">
      <div className="ml-[36px] flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
        <span className="h-px w-5 bg-border/80" aria-hidden />
        <span>From the originating chat</span>
      </div>
      {messages.map((message) => (
        <UserMessage key={message.id}>
          <p className="whitespace-pre-wrap">{message.text}</p>
        </UserMessage>
      ))}
    </div>
  );
}

function BuilderSourceContextLoading() {
  return (
    <output
      data-testid="automation-builder-source-context-loading"
      className="ml-[36px] flex items-center gap-2 text-[12px] text-muted-foreground"
    >
      <span className="automation-builder-source-context-dot" aria-hidden />
      <span>Bringing in your web-chat request…</span>
    </output>
  );
}

function AutomationDescriptionPrompt() {
  return (
    <SketchMessage>
      <div className="max-w-[640px] border-l border-brand-accent pl-4">
        <p className="text-[15px] font-semibold leading-6 text-foreground">What should this automation do?</p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          Describe the workflow in your own words. You can include what starts it and what Sketch should do.
        </p>
      </div>
    </SketchMessage>
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

type ExecutionActivity = "run" | "test" | null;

function outputStatus(output: StepOutput | undefined, isExecuting: boolean): UiStatus {
  if (isExecuting) return "running";
  if (!output) return "idle";
  if (output.status === "completed") return "success";
  if (output.status === "failed") return "failed";
  return "skipped";
}

function executionOrder(steps: WorkflowStep[], edges: WorkflowEdge[]): WorkflowStep[] {
  const executionSteps = steps.filter((step) => step.type !== "trigger");
  if (edges.length === 0) return executionSteps;

  const byId = new Map(steps.map((step) => [step.id, step]));
  const indegree = new Map(steps.map((step) => [step.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0);
  const ordered: WorkflowStep[] = [];
  while (queue.length > 0) {
    const step = queue.shift();
    if (!step) continue;
    ordered.push(step);
    for (const nextId of outgoing.get(step.id) ?? []) {
      const nextCount = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, nextCount);
      if (nextCount === 0) {
        const nextStep = byId.get(nextId);
        if (nextStep) queue.push(nextStep);
      }
    }
  }

  return ordered.length === steps.length ? ordered.filter((step) => step.type !== "trigger") : executionSteps;
}

function inferredRunningStepId(
  steps: WorkflowStep[],
  edges: WorkflowEdge[],
  stepOutputs: Record<string, StepOutput>,
  runStatus: string | undefined,
): string | null {
  if (runStatus !== "running") return null;
  return executionOrder(steps, edges).find((step) => !stepOutputs[step.id])?.id ?? null;
}

type BuilderNodeData = {
  step: WorkflowStep;
  selected: boolean;
  status: UiStatus;
  executionActivity: ExecutionActivity;
  visual: StepVisual;
};
type BuilderNode = Node<BuilderNodeData>;

type StepVisualKind =
  | "schedule-trigger"
  | "webhook-trigger"
  | "canvas-trigger"
  | "slack-channel-message-trigger"
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
    toneClass: "border-border/80 bg-muted/80",
    glyphClass: "text-muted-foreground",
  },
  "webhook-trigger": {
    kind: "webhook-trigger",
    icon: WebhooksLogoIcon,
    shape: "notched",
    toneClass: "border-cyan-300/70 bg-cyan-50 dark:border-cyan-300/30 dark:bg-cyan-950/50",
    glyphClass: "text-cyan-700 dark:text-cyan-200",
  },
  "canvas-trigger": {
    kind: "canvas-trigger",
    icon: GitBranchIcon,
    shape: "notched",
    toneClass: "border-violet-300/70 bg-violet-50 dark:border-violet-300/30 dark:bg-violet-950/50",
    glyphClass: "text-violet-700 dark:text-violet-200",
  },
  "slack-channel-message-trigger": {
    kind: "slack-channel-message-trigger",
    icon: SlackLogoIcon,
    shape: "notched",
    toneClass: "border-fuchsia-300/70 bg-fuchsia-50 dark:border-fuchsia-300/30 dark:bg-fuchsia-950/50",
    glyphClass: "text-fuchsia-700 dark:text-fuchsia-200",
  },
  agent: {
    kind: "agent",
    icon: RobotIcon,
    shape: "rounded",
    toneClass: "border-border/80 bg-card",
    glyphClass: "text-foreground/80",
  },
  "gmail-action": {
    kind: "gmail-action",
    icon: EnvelopeSimpleIcon,
    shape: "circle",
    toneClass: "border-red-300/70 bg-red-50 dark:border-red-300/30 dark:bg-red-950/50",
    glyphClass: "text-red-700 dark:text-red-200",
  },
  "sheets-action": {
    kind: "sheets-action",
    icon: TableIcon,
    shape: "circle",
    toneClass: "border-emerald-300/70 bg-emerald-50 dark:border-emerald-300/30 dark:bg-emerald-950/50",
    glyphClass: "text-emerald-700 dark:text-emerald-200",
  },
  "slack-action": {
    kind: "slack-action",
    icon: SlackLogoIcon,
    shape: "circle",
    toneClass: "border-fuchsia-300/70 bg-fuchsia-50 dark:border-fuchsia-300/30 dark:bg-fuchsia-950/50",
    glyphClass: "text-fuchsia-700 dark:text-fuchsia-200",
  },
  "whatsapp-action": {
    kind: "whatsapp-action",
    icon: WhatsappLogoIcon,
    shape: "circle",
    toneClass: "border-green-300/70 bg-green-50 dark:border-green-300/30 dark:bg-green-950/50",
    glyphClass: "text-green-700 dark:text-green-200",
  },
  "google-action": {
    kind: "google-action",
    icon: GoogleLogoIcon,
    shape: "circle",
    toneClass: "border-blue-300/70 bg-blue-50 dark:border-blue-300/30 dark:bg-blue-950/50",
    glyphClass: "text-blue-700 dark:text-blue-200",
  },
  "web-action": {
    kind: "web-action",
    icon: GlobeHemisphereWestIcon,
    shape: "circle",
    toneClass: "border-sky-300/70 bg-sky-50 dark:border-sky-300/30 dark:bg-sky-950/50",
    glyphClass: "text-sky-700 dark:text-sky-200",
  },
  "code-action": {
    kind: "code-action",
    icon: CodeIcon,
    shape: "circle",
    toneClass: "border-border/70 bg-muted/70",
    glyphClass: "text-foreground/80",
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
    if (step.triggerConfig?.type === "slack_channel_message") return stepVisuals["slack-channel-message-trigger"];
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
  testingStepId,
  isSetupPlaceholder,
  isBuilderChatBusy,
  readOnly,
  onSelectStep,
  onUpdateStepPositions,
}: {
  draft: DraftAutomation;
  selectedStepId: string | null;
  stepOutputs: Record<string, StepOutput>;
  runStatus?: string;
  testingStepId: string | null;
  isSetupPlaceholder: boolean;
  isBuilderChatBusy: boolean;
  readOnly: boolean;
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
        testingStepId={testingStepId}
        isSetupPlaceholder={isSetupPlaceholder}
        isBuilderChatBusy={isBuilderChatBusy}
        readOnly={readOnly}
        onSelectStep={onSelectStep}
        onUpdateStepPositions={onUpdateStepPositions}
      />
    </ReactFlowProvider>
  );
}

function AutomationBuilderPlaceholder({
  isSetupPlaceholder,
  running,
}: {
  isSetupPlaceholder: boolean;
  running: boolean;
}) {
  const authoringInProgress = isSetupPlaceholder && running;

  return (
    <div
      data-testid={isSetupPlaceholder ? "automation-builder-graph-loading" : undefined}
      className="w-full max-w-[520px] text-left"
    >
      <div
        className={cn(
          "automation-builder-empty-diagram mb-5",
          authoringInProgress && "automation-builder-empty-diagram-loading",
        )}
        aria-hidden
      >
        <div className="automation-builder-empty-diagram-meta">
          <span>Workflow preview</span>
          <span className="automation-builder-empty-diagram-meta-status">
            {authoringInProgress ? "Assembling steps" : "Awaiting setup"}
          </span>
        </div>
        <svg className="automation-builder-empty-edges" viewBox="0 0 520 280" fill="none" aria-hidden="true">
          <path
            className="automation-builder-empty-edge automation-builder-empty-edge-track"
            d="M150 140C174 140 165 92 185 92"
          />
          <path
            className="automation-builder-empty-edge automation-builder-empty-edge-track"
            d="M335 92C355 92 346 164 370 164"
          />
          <path
            className="automation-builder-empty-edge automation-builder-empty-edge-progress automation-builder-empty-edge-progress-one"
            d="M150 140C174 140 165 92 185 92"
          />
          <path
            className="automation-builder-empty-edge automation-builder-empty-edge-progress automation-builder-empty-edge-progress-two"
            d="M335 92C355 92 346 164 370 164"
          />
          <circle className="automation-builder-empty-edge-junction" cx="150" cy="140" r="3" />
          <circle className="automation-builder-empty-edge-junction" cx="185" cy="92" r="3" />
          <circle className="automation-builder-empty-edge-junction" cx="335" cy="92" r="3" />
          <circle className="automation-builder-empty-edge-junction" cx="370" cy="164" r="3" />
        </svg>
        <div className="automation-builder-empty-node automation-builder-empty-node-trigger">
          <span className="automation-builder-empty-node-icon">
            <LightningIcon size={15} weight="fill" />
          </span>
          <span>
            <strong>Trigger</strong>
            <small>Start event</small>
          </span>
        </div>
        <div className="automation-builder-empty-node automation-builder-empty-node-action">
          <span className="automation-builder-empty-node-icon">
            <RobotIcon size={15} weight="fill" />
          </span>
          <span>
            <strong>Action</strong>
            <small>Workflow logic</small>
          </span>
        </div>
        <div className="automation-builder-empty-node automation-builder-empty-node-delivery">
          <span className="automation-builder-empty-node-icon">
            <CheckCircleIcon size={15} weight="fill" />
          </span>
          <span>
            <strong>Delivery</strong>
            <small>Final output</small>
          </span>
        </div>
      </div>
      <div className="border-l border-brand-accent pl-5">
        {authoringInProgress ? (
          <div className="flex items-center gap-2 text-[12px] font-medium text-brand-accent">
            <span className="automation-builder-scribble-status-dot" />
            <span>Composing automation</span>
          </div>
        ) : null}
        <p
          className={cn(
            "mt-2 text-sm font-semibold text-foreground",
            authoringInProgress && "automation-builder-typewriter",
          )}
        >
          {authoringInProgress
            ? "Building your workflow"
            : isSetupPlaceholder
              ? "Workflow canvas"
              : "No workflow steps yet"}
        </p>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {authoringInProgress
            ? "Sketch is applying your answers to the workflow canvas."
            : isSetupPlaceholder
              ? "Your workflow will appear here as you configure it in the chat."
              : "Ask Sketch to add the first workflow step in the chat."}
        </p>
      </div>
    </div>
  );
}

function AutomationCanvasFlow({
  draft,
  selectedStepId,
  stepOutputs,
  runStatus,
  testingStepId,
  isSetupPlaceholder,
  isBuilderChatBusy,
  readOnly,
  onSelectStep,
  onUpdateStepPositions,
}: {
  draft: DraftAutomation;
  selectedStepId: string | null;
  stepOutputs: Record<string, StepOutput>;
  runStatus?: string;
  testingStepId: string | null;
  isSetupPlaceholder: boolean;
  isBuilderChatBusy: boolean;
  readOnly: boolean;
  onSelectStep: (stepId: string | null) => void;
  onUpdateStepPositions: (positions: Record<string, { x: number; y: number }>) => void;
}) {
  const { fitView } = useReactFlow<BuilderNode>();
  const nodesInitialized = useNodesInitialized();
  const isDrawerOpen = selectedStepId !== null;
  const lastFitViewRequestKey = useRef<string | null>(null);
  const layoutPositions = useMemo(() => layoutWorkflowPositions(draft.steps, draft.edges), [draft.edges, draft.steps]);
  const shouldUseLayout = useMemo(() => shouldAutoLayoutWorkflow(draft.steps), [draft.steps]);
  const inferredRunStepId = useMemo(
    () => inferredRunningStepId(draft.steps, draft.edges, stepOutputs, runStatus),
    [draft.edges, draft.steps, runStatus, stepOutputs],
  );
  const executingStepId = testingStepId ?? inferredRunStepId;
  const executionActivity: ExecutionActivity = testingStepId ? "test" : inferredRunStepId ? "run" : null;
  const topologyKey = useMemo(
    () =>
      [
        draft.steps.map((step) => step.id).join(","),
        draft.edges.map((edge) => `${edge.from}:${edge.to}`).join(","),
      ].join("|"),
    [draft.edges, draft.steps],
  );
  const fitViewRequestKey = `${topologyKey}:${isDrawerOpen ? "drawer" : "canvas"}`;
  const initialNodes = useMemo<BuilderNode[]>(
    () =>
      draft.steps.map((step) => ({
        id: step.id,
        type: step.type,
        position: flowPosition(step, layoutPositions, shouldUseLayout),
        data: {
          step,
          selected: step.id === selectedStepId,
          status: outputStatus(stepOutputs[step.id], step.id === executingStepId),
          executionActivity: step.id === executingStepId ? executionActivity : null,
          visual: resolveStepVisual(step, draft.stepContent[step.id]),
        },
      })),
    [
      draft.stepContent,
      draft.steps,
      executingStepId,
      executionActivity,
      layoutPositions,
      selectedStepId,
      shouldUseLayout,
      stepOutputs,
    ],
  );
  const initialEdges = useMemo<Edge[]>(
    () =>
      draft.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        animated: edge.to === executingStepId,
        className: cn("automation-builder-edge", edge.to === executingStepId && "automation-builder-edge-active"),
        interactionWidth: 22,
        style:
          edge.to === executingStepId
            ? { ...flowEdgeStyle, stroke: connectionLineStyle.stroke, strokeWidth: 1.8, opacity: 1 }
            : flowEdgeStyle,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: edge.to === executingStepId ? connectionLineStyle.stroke : flowEdgeStyle.stroke,
          width: 16,
          height: 16,
        },
      })),
    [draft.edges, executingStepId],
  );
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<BuilderNode>(initialNodes);
  const onNodesChange = useCallback(
    (changes: NodeChange<BuilderNode>[]) => {
      onNodesChangeBase(changes.filter((change) => change.type !== "remove" && change.type !== "add"));
    },
    [onNodesChangeBase],
  );

  useEffect(() => setNodes(initialNodes), [initialNodes, setNodes]);
  useEffect(() => {
    if (!nodesInitialized || lastFitViewRequestKey.current === fitViewRequestKey) return;
    lastFitViewRequestKey.current = fitViewRequestKey;
    const frame = window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
      void fitView({ padding: 0.12, maxZoom: 1.1, duration: reducedMotion ? 0 : 180 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitView, fitViewRequestKey, nodesInitialized]);

  if (draft.steps.length === 0) {
    return (
      <div className="relative size-full overflow-hidden">
        <div className="automation-builder-empty-grid pointer-events-none absolute inset-0" aria-hidden />
        <div
          data-testid="automation-builder-empty-canvas"
          className="automation-builder-empty-state relative z-[1] flex size-full items-center justify-center bg-transparent px-6 pb-36 text-center"
        >
          <AutomationBuilderPlaceholder isSetupPlaceholder={isSetupPlaceholder} running={isBuilderChatBusy} />
        </div>
      </div>
    );
  }

  return (
    <div className="relative size-full">
      <ReactFlow
        nodes={nodes}
        edges={initialEdges}
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
        nodesDraggable={!readOnly}
        nodesConnectable={false}
        edgesReconnectable={false}
        nodesFocusable
        edgesFocusable={false}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }}
        minZoom={0.3}
        maxZoom={1.8}
        snapToGrid
        snapGrid={[18, 18]}
        connectionLineStyle={connectionLineStyle}
        connectionRadius={28}
        proOptions={{ hideAttribution: true }}
        className="automation-builder-flow automation-builder-flow-ready"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.1} color="var(--automation-builder-grid)" />
        <Controls showInteractive={false} position="bottom-left" className="automation-builder-controls" />
      </ReactFlow>
    </div>
  );
}

const statusMarkerClasses: Record<UiStatus, string> = {
  idle: "border-muted-foreground/70",
  running: "text-amber-700 dark:text-amber-300",
  success: "text-emerald-700 dark:text-emerald-300",
  failed: "text-destructive",
  skipped: "border-muted-foreground/45",
};

const nodeAccentClasses: Record<UiStatus, string> = {
  idle: "from-muted-foreground/[0.1] to-transparent",
  running: "from-brand-accent/[0.18] to-transparent",
  success: "from-emerald-500/[0.16] to-transparent",
  failed: "from-destructive/[0.16] to-transparent",
  skipped: "from-muted-foreground/[0.06] to-transparent",
};

function nodeStatusLabel(status: UiStatus, activity: ExecutionActivity): string {
  if (status === "running") return activity === "test" ? "Testing" : "Running";
  if (status === "success") return "Succeeded";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return "No result";
}

function StepStatusMarker({ status }: { status: UiStatus }) {
  if (status === "failed") {
    return (
      <span
        aria-hidden
        data-testid="automation-node-status-marker"
        className={cn(
          "absolute -top-2 -right-2 z-20 flex size-[18px] items-center justify-center bg-transparent drop-shadow-sm",
          statusMarkerClasses.failed,
        )}
      >
        <XCircleIcon size={18} weight="fill" />
      </span>
    );
  }
  if (status === "success") {
    return (
      <span
        aria-hidden
        data-testid="automation-node-status-marker"
        className={cn(
          "absolute -top-2 -right-2 z-20 flex size-[18px] items-center justify-center bg-transparent drop-shadow-sm",
          statusMarkerClasses.success,
        )}
      >
        <CheckCircleIcon size={18} weight="fill" />
      </span>
    );
  }
  if (status === "running") {
    return (
      <span
        aria-hidden
        data-testid="automation-node-status-marker"
        className={cn(
          "absolute -top-2 -right-2 z-20 flex size-[18px] items-center justify-center bg-transparent drop-shadow-sm",
          statusMarkerClasses.running,
        )}
      >
        <SpinnerGapIcon size={17} className="animate-spin" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      data-testid="automation-node-status-marker"
      className={cn(
        "absolute -top-[5px] left-1/2 z-20 size-[8px] -translate-x-1/2 rounded-full border-2 bg-transparent ring-[2px] ring-background",
        statusMarkerClasses[status],
      )}
    />
  );
}

function StepShape({ visual, selected, status }: { visual: StepVisual; selected: boolean; status: UiStatus }) {
  const Icon = visual.icon;
  const triggerShape =
    visual.shape === "notched"
      ? ({ clipPath: "polygon(0 0, calc(100% - 9px) 0, 100% 50%, calc(100% - 9px) 100%, 0 100%)" } as CSSProperties)
      : undefined;
  return (
    <div className="relative size-[46px]">
      <div
        data-testid="automation-node-shell"
        className={cn(
          "automation-node-shell relative flex size-full items-center justify-center overflow-hidden border text-foreground/75 shadow-lg transition-[border-color,background-color,box-shadow,transform]",
          "before:absolute before:inset-0 before:bg-linear-to-br before:from-foreground/[0.045] before:to-transparent before:content-['']",
          visual.toneClass,
          nodeAccentClasses[status],
          status === "running" && "automation-node-running",
          status === "failed" && "automation-node-failed",
          visual.shape === "notched" ? "rounded-[9px]" : visual.shape === "circle" ? "rounded-full" : "rounded-[11px]",
          selected
            ? "border-brand-accent/70 bg-accent text-foreground shadow-md ring-2 ring-brand-accent/20"
            : "hover:border-foreground/30 hover:bg-muted/80 hover:text-foreground",
        )}
        style={triggerShape}
      >
        <Icon
          size={visual.kind === "agent" ? 18 : 17}
          weight={visual.shape === "notched" || visual.kind === "agent" ? "fill" : "regular"}
          className={cn("relative z-10", visual.glyphClass)}
        />
      </div>
      <StepStatusMarker status={status} />
    </div>
  );
}

function BuilderStepNode({ data, isConnectable }: NodeProps<BuilderNode>) {
  const statusLabel = nodeStatusLabel(data.status, data.executionActivity);
  return (
    <div
      data-testid={`automation-node-${data.step.id}`}
      data-state={data.status}
      data-execution-activity={data.executionActivity ?? undefined}
      aria-label={`${data.step.label}: ${statusLabel}`}
      className="group/node flex w-[164px] select-none flex-col items-center gap-2"
    >
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
      <span
        title={data.step.label}
        className="line-clamp-2 max-w-[164px] text-center text-[11px] font-semibold leading-4 text-foreground/80 transition-colors group-hover/node:text-foreground"
      >
        {data.step.label}
      </span>
      <span className="sr-only">{statusLabel}</span>
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
  memberNameById,
  onSelectRun,
}: {
  runs: AutomationDefinition["recentRuns"];
  activeRunId: string | null;
  memberNameById: ReadonlyMap<string, string>;
  onSelectRun: (runId: string) => void;
}) {
  const active = activeRunId ? runs.find((run) => run.id === activeRunId) : runs[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className={cn(canvasToolbarButtonClass, "min-w-0 max-w-full gap-1.5 text-foreground/75")}
        >
          {activeRunId ? <EyeIcon size={14} weight="fill" /> : <CaretDownIcon size={13} />}
          <span className="min-w-0 max-w-full truncate">
            {activeRunId && active ? `Viewing · ${formatRunDate(active.startedAt)}` : `Runs · ${runs.length}`}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[310px]">
        <DropdownMenuLabel className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          Run history
        </DropdownMenuLabel>
        {runs.length === 0 ? (
          <DropdownMenuItem disabled>No runs yet</DropdownMenuItem>
        ) : (
          runs.map((run) => {
            const lifecycle = automationRunLifecycleState(run);
            return (
              <DropdownMenuItem key={run.id} onSelect={() => onSelectRun(run.id)} className="gap-3">
                <RunIcon status={run.status} />
                <span className="min-w-0 flex-1 truncate text-xs">{formatRunDate(run.startedAt)}</span>
                {run.triggeredByUserId ? (
                  <span className="truncate text-[11px] text-muted-foreground">
                    · by {memberNameById.get(run.triggeredByUserId) ?? "a member"}
                  </span>
                ) : null}
                <span className="text-xs capitalize text-muted-foreground">
                  {lifecycle ? runStatusLabel(lifecycle) : run.status}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RunIcon({ status }: { status: string }) {
  const lifecycle = automationRunLifecycleState({ status });
  if (lifecycle === "pending" || lifecycle === "running") {
    return <SpinnerGapIcon size={15} className="animate-spin text-muted-foreground" />;
  }
  if (lifecycle === "failure") return <XCircleIcon size={15} weight="fill" className="text-destructive" />;
  if (lifecycle === "aborted")
    return <XCircleIcon size={15} weight="fill" className="text-amber-700 dark:text-amber-300" />;
  return <CheckCircleIcon size={15} weight="fill" className="text-emerald-700 dark:text-emerald-300" />;
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
  taskId,
  draft,
  step,
  output,
  run,
  status,
  executionActivity,
  readOnly,
  onClose,
  onTest,
  testingStepId,
  onUpdateAgentPrompt,
  savingPromptStepId,
}: {
  taskId: string;
  draft: DraftAutomation;
  step: WorkflowStep | null;
  output?: StepOutput;
  run: AutomationRunRecord | null;
  status: UiStatus;
  executionActivity: ExecutionActivity;
  readOnly: boolean;
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
  const isTesting = testingStepId === step.id;

  return (
    <aside
      data-testid="automation-builder-drawer"
      aria-label={`${step.label} details`}
      className="automation-builder-drawer-enter absolute inset-y-0 right-0 z-30 flex h-full max-h-full w-full max-w-[392px] min-w-0 flex-col overflow-hidden border-l border-border/80 bg-background text-foreground shadow-xl xl:relative xl:inset-auto xl:z-auto xl:w-[392px] xl:min-w-[350px] xl:max-w-[540px] xl:resize-x xl:shadow-none"
    >
      <div className="shrink-0 border-b border-border/80 px-4 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-semibold leading-6 text-foreground">{step.label}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge className="rounded-[5px] border border-border bg-muted font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                {step.type}
              </Badge>
              <StatusBadge output={output} status={status} executionActivity={executionActivity} />
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label="Close drawer"
          >
            <XIcon size={14} />
          </Button>
        </div>
        <NodeRunSummary run={run} output={output} status={status} executionActivity={executionActivity} />
        <div className="mt-4 flex items-center justify-between border-t border-border/80 pt-3">
          <div role="tablist" aria-label="Node details" className="flex gap-5">
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
            className="h-7 gap-1.5 rounded-[6px] bg-muted font-mono text-[11px] uppercase tracking-[0.08em] text-foreground/75 shadow-none hover:bg-accent hover:text-accent-foreground"
            disabled={readOnly || isTesting}
            aria-busy={isTesting}
            onClick={() => onTest(step.id)}
          >
            {isTesting ? <SpinnerGapIcon size={13} className="animate-spin" /> : <PlayIcon size={13} weight="fill" />}
            {isTesting ? "Testing…" : "Test"}
          </Button>
        </div>
      </div>

      <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {tab === "input" ? (
          <NodeInputPanel
            taskId={taskId}
            draft={draft}
            step={step}
            content={content}
            readOnly={readOnly}
            onUpdateAgentPrompt={onUpdateAgentPrompt}
            savingPrompt={savingPromptStepId === step.id}
          />
        ) : (
          <OutputPanel output={output} status={status} executionActivity={executionActivity} />
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
      role="tab"
      aria-selected={active}
      className={cn(
        "font-mono text-[12px] font-semibold uppercase tracking-[0.1em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/55",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function StatusBadge({
  output,
  status,
  executionActivity,
}: {
  output?: StepOutput;
  status: UiStatus;
  executionActivity: ExecutionActivity;
}) {
  if (status === "running") {
    return (
      <Badge className="gap-1 rounded-[5px] border border-brand-accent/35 bg-brand-accent/10 text-foreground">
        <SpinnerGapIcon size={12} className="animate-spin" />
        {executionActivity === "test" ? "Testing" : "Running"}
      </Badge>
    );
  }
  if (!output) {
    return <Badge className="rounded-[5px] border border-border bg-muted/60 text-muted-foreground">No result</Badge>;
  }
  if (output.status === "completed")
    return (
      <Badge className="rounded-[5px] border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
        Succeeded · {formatDuration(output.duration_ms)}
      </Badge>
    );
  if (output.status === "failed")
    return (
      <Badge className="rounded-[5px] border border-destructive/30 bg-destructive/10 text-destructive">
        Failed · {formatDuration(output.duration_ms)}
      </Badge>
    );
  return <Badge className="rounded-[5px] border border-border bg-muted text-muted-foreground">Skipped</Badge>;
}

function NodeRunSummary({
  run,
  output,
  status,
  executionActivity,
}: {
  run: AutomationRunRecord | null;
  output?: StepOutput;
  status: UiStatus;
  executionActivity: ExecutionActivity;
}) {
  if (status === "running") {
    const copy =
      executionActivity === "test"
        ? "Testing this node. The result will update when the test finishes."
        : run
          ? `Run started ${formatRunDate(run.startedAt)}. Results will appear when this node finishes.`
          : "This node is running. Results will appear when it finishes.";
    return (
      <output
        data-testid="automation-node-execution-summary"
        aria-live="polite"
        className="mt-3 block text-[11px] leading-4 text-muted-foreground"
      >
        {copy}
      </output>
    );
  }
  if (!output || !run) return null;
  const timestamp = run.completedAt ?? run.startedAt;
  return (
    <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
      Latest result · {formatRunDate(timestamp)} · {formatDuration(output.duration_ms)}
    </p>
  );
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function NodeInputPanel({
  taskId,
  draft,
  step,
  content,
  readOnly,
  onUpdateAgentPrompt,
  savingPrompt,
}: {
  taskId: string;
  draft: DraftAutomation;
  step: WorkflowStep;
  content?: AutomationStepContent;
  readOnly: boolean;
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

      {step.type === "trigger" ? <TriggerFields draft={draft} taskId={taskId} /> : null}

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
              readOnly={readOnly}
              aria-readonly={readOnly}
              onChange={(event) => setAgentPrompt(event.target.value)}
            />
          </Field>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5 rounded-[7px] bg-brand-accent px-3 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[#161300] shadow-none hover:bg-brand-accent/90"
              disabled={readOnly || !agentPromptDirty || !agentPrompt.trim() || savingPrompt}
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
              value={[
                ...(content?.apps ?? []),
                ...(step.actionCapabilities?.sketchTools ?? []).map((tool) => `Sketch: ${tool}`),
              ].join(", ")}
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

function TriggerFields({ draft, taskId }: { draft: DraftAutomation; taskId: string }) {
  const triggerStep = draft.steps.find((step) => step.type === "trigger");
  const config = (triggerStep?.triggerConfig as WorkflowTriggerConfig | undefined) ?? { type: "schedule" as const };
  const canvasConfig = config.type === "canvas" ? config : undefined;
  const triggerLabel = canvasConfig
    ? canvasConfig.componentKey === "webhook-trigger"
      ? "Canvas webhook"
      : "Canvas trigger"
    : config.type === "slack_channel_message"
      ? "Slack channel message"
      : config.type;
  return (
    <>
      <Field label="Trigger type">
        <Input value={triggerLabel} className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
      </Field>
      {config.type === "slack_channel_message" ? (
        <Field label="Slack channel">
          <Input value={config.channelId ?? ""} className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
        </Field>
      ) : null}
      {config.type === "webhook" ? <NativeWebhookFields config={config} /> : null}
      {canvasConfig ? (
        <CanvasWebhookFields
          endpoint={canvasConfig.canvasEndpoint}
          status={canvasConfig.status}
          errorMessage={canvasConfig.errorMessage}
        />
      ) : null}
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

function NativeWebhookFields({ config }: { config: WorkflowTriggerConfig }) {
  const metadata = config;
  const hasEndpoint = Boolean(metadata.webhookUrl);
  const statusDetails = hasEndpoint
    ? {
        label: "Active",
        guidance: "Send POST requests with JSON to the canonical URL above; no authentication is required.",
        isError: false,
        toneClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      }
    : {
        label: "Setup pending",
        guidance: "Sketch is still setting up this trigger. Refresh this automation before sending requests.",
        isError: false,
        toneClass: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
  const handleCopy = async () => {
    if (!metadata.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(metadata.webhookUrl);
      toast.success("Sketch webhook URL copied");
    } catch {
      toast.error("Unable to copy Sketch webhook URL");
    }
  };

  return (
    <div
      data-testid="native-webhook-details"
      className="space-y-3 rounded-[8px] border border-brand-accent/25 bg-brand-accent/5 p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[12px] font-medium text-foreground">Webhook trigger</p>
          <p className="text-[11px] leading-4 text-muted-foreground">
            Send JSON events to this endpoint to start the automation.
          </p>
        </div>
        <Badge
          className={cn(
            "shrink-0 rounded-[5px] border px-1.5 py-0.5 text-[10px] font-semibold",
            statusDetails.toneClass,
          )}
        >
          {statusDetails.label}
        </Badge>
      </div>
      <div
        data-testid="native-webhook-guidance"
        role={statusDetails.isError ? "alert" : "status"}
        className={cn(
          "rounded-[6px] border px-2.5 py-2 text-[11px] leading-4",
          statusDetails.isError
            ? "border-destructive/25 bg-destructive/10 text-destructive"
            : "border-border/70 bg-background/55 text-muted-foreground",
        )}
      >
        <p>{statusDetails.guidance}</p>
      </div>
      <Field label="Canonical URL">
        <div className="flex gap-2">
          <Input
            value={metadata.webhookUrl ?? "Webhook endpoint is not available yet"}
            className={cn(builderReadOnlyInputClass, "min-w-0 flex-1")}
            readOnly
            aria-readonly="true"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-10 shrink-0 rounded-[8px]"
            aria-label="Copy canonical Sketch webhook URL"
            disabled={!metadata.webhookUrl}
            onClick={() => void handleCopy()}
          >
            <CopySimpleIcon size={15} />
          </Button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Method">
          <Input
            value={metadata.webhookMethod ?? "POST"}
            className={builderReadOnlyInputClass}
            readOnly
            aria-readonly="true"
          />
        </Field>
        <Field label="Content type">
          <Input
            value={metadata.webhookContentType ?? "application/json"}
            className={builderReadOnlyInputClass}
            readOnly
            aria-readonly="true"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Authentication mode">
          <Input value="None required" className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
        </Field>
        <Field label="Payload shape">
          <Input value="Any JSON value" className={builderReadOnlyInputClass} readOnly aria-readonly="true" />
        </Field>
      </div>
    </div>
  );
}

function CanvasWebhookFields({
  endpoint,
  status,
  errorMessage,
}: {
  endpoint?: CanvasWebhookEndpoint;
  status?: WorkflowTriggerConfig["status"];
  errorMessage?: string;
}) {
  const statusDetails = getCanvasWebhookStatusDetails(status, endpoint);
  const handleCopy = async () => {
    if (!endpoint?.url) return;
    try {
      await navigator.clipboard.writeText(endpoint.url);
      toast.success("Canvas webhook URL copied");
    } catch {
      toast.error("Unable to copy Canvas webhook URL");
    }
  };

  return (
    <div
      data-testid="canvas-trigger-details"
      className="space-y-3 rounded-[8px] border border-brand-accent/25 bg-brand-accent/5 p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[12px] font-medium text-foreground">Canvas-managed trigger</p>
          <p className="text-[11px] leading-4 text-muted-foreground">
            Canvas owns this trigger setup and sends JSON events to Sketch.
          </p>
        </div>
        <Badge
          className={cn(
            "shrink-0 rounded-[5px] border px-1.5 py-0.5 text-[10px] font-semibold",
            statusDetails.toneClass,
          )}
        >
          {statusDetails.label}
        </Badge>
      </div>
      <div
        data-testid="canvas-trigger-setup-guidance"
        role={statusDetails.isError ? "alert" : "status"}
        className={cn(
          "rounded-[6px] border px-2.5 py-2 text-[11px] leading-4",
          statusDetails.isError
            ? "border-destructive/25 bg-destructive/10 text-destructive"
            : "border-border/70 bg-background/55 text-muted-foreground",
        )}
      >
        <p>{statusDetails.guidance}</p>
        {errorMessage ? <p className="mt-1 text-destructive">Canvas error: {errorMessage}</p> : null}
      </div>
      <Field label="Canonical URL">
        <div className="flex gap-2">
          <Input
            value={endpoint?.url ?? "Canvas endpoint is not available yet"}
            className={cn(builderReadOnlyInputClass, "min-w-0 flex-1")}
            readOnly
            aria-readonly="true"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-10 shrink-0 rounded-[8px]"
            aria-label="Copy canonical Canvas webhook URL"
            disabled={!endpoint?.url}
            onClick={() => void handleCopy()}
          >
            <CopySimpleIcon size={15} />
          </Button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Method">
          <Input
            value={endpoint?.method ?? "POST"}
            className={builderReadOnlyInputClass}
            readOnly
            aria-readonly="true"
          />
        </Field>
        <Field label="Content type">
          <Input
            value={endpoint?.contentType ?? "application/json"}
            className={builderReadOnlyInputClass}
            readOnly
            aria-readonly="true"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Authentication mode">
          <Input
            value={endpoint?.authentication === "none" ? "None required" : "Not configured"}
            className={builderReadOnlyInputClass}
            readOnly
            aria-readonly="true"
          />
        </Field>
        <Field label="Payload shape">
          <Input
            value={endpoint?.payload ?? "Any JSON value"}
            className={builderReadOnlyInputClass}
            readOnly
            aria-readonly="true"
          />
        </Field>
      </div>
    </div>
  );
}

function getCanvasWebhookStatusDetails(
  status: WorkflowTriggerConfig["status"],
  endpoint: CanvasWebhookEndpoint | undefined,
): { label: string; guidance: string; isError: boolean; toneClass: string } {
  if (status === "error") {
    return {
      label: "Setup error",
      guidance: "Canvas could not finish setting up this trigger. Fix the trigger in Canvas and retry setup.",
      isError: true,
      toneClass: "border-destructive/30 bg-destructive/10 text-destructive",
    };
  }
  if (status === "pending_canvas_setup" || (!status && !endpoint)) {
    return {
      label: "Setup pending",
      guidance: "Canvas is still setting up this trigger. Complete setup in Canvas before sending requests.",
      isError: false,
      toneClass: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  if (status === "active" && !endpoint) {
    return {
      label: "Active",
      guidance:
        "Canvas reports this trigger as active, but its canonical URL is not available yet. Refresh after setup completes.",
      isError: false,
      toneClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }
  return {
    label: "Active",
    guidance:
      "Canvas setup is complete. Send POST requests with JSON to the canonical URL above; no authentication is required.",
    isError: false,
    toneClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  };
}

function Field({ label, children, grow = false }: { label: string; children: ReactNode; grow?: boolean }) {
  return (
    <div className={cn("space-y-2", grow && "flex min-h-0 flex-1 flex-col")}>
      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function OutputPanel({
  output,
  status,
  executionActivity,
}: {
  output?: StepOutput;
  status: UiStatus;
  executionActivity: ExecutionActivity;
}) {
  const activeNotice =
    status === "running"
      ? executionActivity === "test"
        ? "Testing this node. The latest saved result remains below until the test finishes."
        : "This node is running. Results will appear here when it finishes."
      : null;
  if (!output) {
    return (
      <output
        aria-live={activeNotice ? "polite" : undefined}
        className="block rounded-[8px] border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground"
      >
        {activeNotice ?? "No output yet. Run the automation or test this node."}
      </output>
    );
  }
  return (
    <div className="space-y-3">
      {activeNotice ? (
        <output className="block rounded-[8px] border border-brand-accent/25 bg-brand-accent/8 p-3 text-[12px] leading-5 text-muted-foreground">
          {activeNotice}
        </output>
      ) : null}
      {output.error ? (
        <details
          data-testid="automation-builder-step-failure-details"
          className="rounded-[8px] border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
        >
          <summary className="cursor-pointer font-medium">Inspect persisted failure details</summary>
          <pre className="mt-2 max-w-full overflow-x-hidden whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere]">
            {output.error.message}
          </pre>
        </details>
      ) : output.output == null || output.output === "" ? (
        <div className="rounded-[8px] border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
          No output returned.
        </div>
      ) : (
        <JsonOutput value={output.output} />
      )}
    </div>
  );
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
    <div
      data-testid="automation-builder-output"
      className="flex min-h-[320px] flex-col overflow-hidden rounded-[8px] border border-border bg-card"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Output
        </span>
        <div className="flex items-center gap-1">
          {canTree ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setRaw((current) => !current)}
              aria-label="Toggle output view"
            >
              {raw ? <BracketsCurlyIcon size={14} /> : <CodeIcon size={14} />}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-[6px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void navigator.clipboard.writeText(text)}
            aria-label="Copy output"
          >
            <CircleIcon size={14} />
          </Button>
        </div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-foreground/80 [overflow-wrap:anywhere]">
        {canTree && !raw ? JSON.stringify(parsed, null, 2) : text}
      </pre>
    </div>
  );
}
