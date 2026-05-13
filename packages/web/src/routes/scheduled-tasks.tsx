import { type AutomationRunItem, type AutomationStepContentItem, type ScheduledTaskListItem, api } from "@/lib/api";
import { useDashboardAuth } from "@/routes/dashboard";
import {
  CaretRightIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  CopySimpleIcon,
  DotsThreeIcon,
  LightningIcon,
  PauseIcon,
  PlayIcon,
  SlackLogoIcon,
  SpinnerGapIcon,
  TrashIcon,
  WarningCircleIcon,
  WhatsappLogoIcon,
  XCircleIcon,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sketch/ui/components/dropdown-menu";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sketch/ui/components/tooltip";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { type MouseEvent, useState } from "react";
import { toast } from "sonner";
import { dashboardRoute } from "./dashboard";

export const scheduledTasksRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/scheduled-tasks",
  component: ScheduledTasksPage,
});

const TASKS_QUERY_KEY = ["scheduled-tasks"];

function formatDateTime(value: string | null) {
  if (!value) return "Never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatRelativeTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getSubtitle(role: "admin" | "member") {
  return role === "admin"
    ? "View and manage automations across the workspace"
    : "View and manage the automations you created through chat";
}

function getFallbackTaskError(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Failed to update automation";
}

function replaceTaskInCache(
  tasks: ScheduledTaskListItem[] | undefined,
  updatedTask: ScheduledTaskListItem,
): ScheduledTaskListItem[] {
  if (!tasks) return [updatedTask];
  return tasks.map((task) => (task.id === updatedTask.id ? updatedTask : task));
}

function removeTaskFromCache(tasks: ScheduledTaskListItem[] | undefined, taskId: string): ScheduledTaskListItem[] {
  return (tasks ?? []).filter((task) => task.id !== taskId);
}

function isMultiStep(task: ScheduledTaskListItem): boolean {
  return task.stepCount > 2;
}

function isCanvasManaged(task: ScheduledTaskListItem): boolean {
  return task.triggerConfig?.type === "canvas" || (task.scheduleType === "external" && task.scheduleValue === "canvas");
}

function getTriggerDetail(task: ScheduledTaskListItem): string {
  if (isCanvasManaged(task)) {
    const config = task.triggerConfig;
    const parts = ["Canvas"];
    if (config?.app) parts.push(config.app);
    if (config?.eventDescription) parts.push(config.eventDescription);
    return parts.join(" · ");
  }

  return `${task.scheduleType} · ${task.scheduleValue}`;
}

function getTaskScheduleLabel(task: ScheduledTaskListItem): string {
  if (!isCanvasManaged(task)) return task.scheduleLabel;

  const config = task.triggerConfig;
  const parts = ["Trigger", "Canvas"];
  if (config?.app) parts.push(config.app);
  if (config?.eventDescription) parts.push(config.eventDescription);
  return parts.join(" · ");
}

function getStepSummary(task: ScheduledTaskListItem): string | null {
  if (!task.steps) return null;
  try {
    const steps = JSON.parse(task.steps) as Array<{ label: string; type: string }>;
    return steps
      .filter((s) => s.type !== "trigger")
      .map((s) => s.label)
      .join(" \u2192 ");
  } catch {
    return null;
  }
}

export function ScheduledTasksPage() {
  const auth = useDashboardAuth();
  const queryClient = useQueryClient();
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [deletingTask, setDeletingTask] = useState<ScheduledTaskListItem | null>(null);

  const tasksQuery = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: () => api.scheduledTasks.list(),
  });

  const pauseMutation = useMutation({
    mutationFn: (taskId: string) => api.scheduledTasks.pause(taskId),
    onSuccess: (task) => {
      queryClient.setQueryData<ScheduledTaskListItem[]>(TASKS_QUERY_KEY, (tasks) => replaceTaskInCache(tasks, task));
      toast.success("Automation paused");
    },
    onError: (error) => {
      toast.error(getFallbackTaskError(error));
    },
  });

  const resumeMutation = useMutation({
    mutationFn: (taskId: string) => api.scheduledTasks.resume(taskId),
    onSuccess: (task) => {
      queryClient.setQueryData<ScheduledTaskListItem[]>(TASKS_QUERY_KEY, (tasks) => replaceTaskInCache(tasks, task));
      toast.success("Automation resumed");
    },
    onError: (error) => {
      toast.error(getFallbackTaskError(error));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (taskId: string) => api.scheduledTasks.remove(taskId),
    onSuccess: (_result, taskId) => {
      queryClient.setQueryData<ScheduledTaskListItem[]>(TASKS_QUERY_KEY, (tasks) => removeTaskFromCache(tasks, taskId));
      setDeletingTask(null);
      setExpandedTaskId((current) => (current === taskId ? null : current));
      toast.success("Automation deleted");
    },
    onError: (error) => {
      toast.error(getFallbackTaskError(error));
    },
  });

  const triggerMutation = useMutation({
    mutationFn: (taskId: string) => api.scheduledTasks.trigger(taskId),
    onSuccess: () => {
      toast.success("Automation triggered");
    },
    onError: (error) => {
      toast.error(getFallbackTaskError(error));
    },
  });

  const tasks = tasksQuery.data ?? [];
  const isAdmin = auth.role === "admin";

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Automations</h1>
        <p className="mt-2 text-sm text-muted-foreground">{getSubtitle(auth.role ?? "member")}</p>
      </div>

      <div className="mt-6">
        {tasksQuery.isLoading ? (
          <LoadingSkeleton />
        ) : tasksQuery.isError ? (
          <ErrorState />
        ) : tasks.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <p className="mb-3 text-sm font-medium text-muted-foreground">
              {isAdmin ? "All automations" : "Your automations"}
            </p>
            <div className="rounded-lg border border-border bg-card">
              {tasks.map((task, index) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  isAdmin={isAdmin}
                  isExpanded={expandedTaskId === task.id}
                  isLast={index === tasks.length - 1}
                  isMutating={
                    (pauseMutation.isPending && pauseMutation.variables === task.id) ||
                    (resumeMutation.isPending && resumeMutation.variables === task.id) ||
                    (deleteMutation.isPending && deleteMutation.variables === task.id) ||
                    (triggerMutation.isPending && triggerMutation.variables === task.id)
                  }
                  onToggleExpanded={() => setExpandedTaskId((current) => (current === task.id ? null : task.id))}
                  onPause={() => pauseMutation.mutate(task.id)}
                  onResume={() => resumeMutation.mutate(task.id)}
                  onDelete={() => setDeletingTask(task)}
                  onTrigger={() => triggerMutation.mutate(task.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <DeleteTaskDialog
        task={deletingTask}
        isDeleting={deleteMutation.isPending}
        onOpenChange={(open) => {
          if (!open) setDeletingTask(null);
        }}
        onConfirm={() => {
          if (deletingTask) {
            deleteMutation.mutate(deletingTask.id);
          }
        }}
      />
    </div>
  );
}

function PlatformIcon({ platform, multiStep }: { platform: "slack" | "whatsapp"; multiStep: boolean }) {
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
      {multiStep ? (
        <LightningIcon size={18} className="text-muted-foreground" weight="fill" />
      ) : platform === "slack" ? (
        <SlackLogoIcon size={18} className="text-muted-foreground" />
      ) : (
        <WhatsappLogoIcon size={18} className="text-muted-foreground" />
      )}
    </div>
  );
}

function TaskRow({
  task,
  isAdmin,
  isExpanded,
  isLast,
  isMutating,
  onToggleExpanded,
  onPause,
  onResume,
  onDelete,
  onTrigger,
}: {
  task: ScheduledTaskListItem;
  isAdmin: boolean;
  isExpanded: boolean;
  isLast: boolean;
  isMutating: boolean;
  onToggleExpanded: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
  onTrigger: () => void;
}) {
  const multi = isMultiStep(task);
  const canvasManaged = isCanvasManaged(task);
  const displayName = task.title ?? task.prompt;
  const stepSummary = multi ? getStepSummary(task) : null;
  const lastRunLabel = formatRelativeTime(task.lastRunAt);
  const hasActions = task.canPause || task.canResume || task.canDelete || task.status === "active";

  return (
    <div className={cn(!isLast && "border-b border-border")}>
      <div className="flex items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/50">
        <PlatformIcon platform={task.platform} multiStep={multi} />

        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={onToggleExpanded}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? `Hide details for ${displayName}` : `Show details for ${displayName}`}
        >
          <div className="min-w-0 flex-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  {displayName}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {stepSummary ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{stepSummary}</p> : null}

            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {getTaskScheduleLabel(task)}
              {lastRunLabel ? (
                <>
                  <span className="mx-1.5">&middot;</span>
                  Last run: {lastRunLabel}
                  {task.lastRunStatus === "completed" ? (
                    <CheckCircleIcon size={12} className="ml-0.5 inline text-emerald-500" />
                  ) : task.lastRunStatus === "failed" ? (
                    <XCircleIcon size={12} className="ml-0.5 inline text-destructive" />
                  ) : null}
                </>
              ) : null}
              {task.runCount > 0 ? (
                <>
                  <span className="mx-1.5">&middot;</span>
                  Runs: {task.runCount}
                </>
              ) : null}
            </p>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          {canvasManaged ? <CanvasManagedBadge triggerConfig={task.triggerConfig} /> : null}
          <TaskStatusBadge status={task.status} />
        </div>

        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
          onClick={onToggleExpanded}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? `Collapse ${displayName}` : `Expand ${displayName}`}
        >
          <CaretRightIcon size={14} className={cn("transition-transform", isExpanded && "rotate-90")} />
        </button>

        {hasActions ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`Actions for ${displayName}`}>
                <DotsThreeIcon size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {task.status === "active" ? (
                <DropdownMenuItem disabled={isMutating} onClick={onTrigger}>
                  <PlayIcon size={16} />
                  Run now
                </DropdownMenuItem>
              ) : null}
              {task.canPause ? (
                <DropdownMenuItem disabled={isMutating} onClick={onPause}>
                  <PauseIcon size={16} />
                  Pause
                </DropdownMenuItem>
              ) : null}
              {task.canResume ? (
                <DropdownMenuItem disabled={isMutating} onClick={onResume}>
                  <PlayIcon size={16} />
                  Resume
                </DropdownMenuItem>
              ) : null}
              {task.canDelete ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" disabled={isMutating} onClick={onDelete}>
                    <TrashIcon size={16} />
                    Delete
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className="size-7 shrink-0" />
        )}
      </div>

      {isExpanded ? <TaskExpandedDetail task={task} isAdmin={isAdmin} /> : null}
    </div>
  );
}

function TaskExpandedDetail({ task, isAdmin }: { task: ScheduledTaskListItem; isAdmin: boolean }) {
  const multi = isMultiStep(task);
  const targetLabel = task.targetLabel || task.deliveryTarget;
  const canvasManaged = isCanvasManaged(task);

  return (
    <div className="border-t border-border bg-muted/20 px-4 py-4 space-y-4">
      {multi ? <StepsList task={task} /> : null}

      <RunHistory taskId={task.id} />

      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <DetailItem label="Target" value={`${task.targetKindLabel} \u00b7 ${targetLabel}`} />
        <DetailItem label="Type" value={canvasManaged ? "Trigger-based" : "Scheduled"} />
        <DetailItem label={canvasManaged ? "Trigger" : "Schedule"} value={getTriggerDetail(task)} />
        {canvasManaged ? null : <DetailItem label="Timezone" value={task.timezone} />}
        <DetailItem label="Session mode" value={formatSessionMode(task.sessionMode)} />
        {canvasManaged ? null : <DetailItem label="Next run" value={formatDateTime(task.nextRunAt)} />}
        <DetailItem label="Last run" value={formatDateTime(task.lastRunAt)} />
        <DetailItem label="Created" value={formatDateTime(task.createdAt)} />
        {isAdmin ? <DetailItem label="Created by" value={task.creatorName ?? task.createdBy ?? "Unknown"} /> : null}
      </dl>
    </div>
  );
}

function StepsList({ task }: { task: ScheduledTaskListItem }) {
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(new Set());

  const stepContentQuery = useQuery({
    queryKey: ["automation-step-content", task.id],
    queryFn: () => api.scheduledTasks.getStepContent(task.id),
  });

  if (!task.steps) return null;

  let steps: Array<{ id: string; type: string; label: string; triggerConfig?: ScheduledTaskListItem["triggerConfig"] }>;
  try {
    steps = JSON.parse(task.steps);
  } catch {
    return null;
  }

  const contentByStepId = new Map<string, AutomationStepContentItem>();
  for (const row of stepContentQuery.data ?? []) {
    contentByStepId.set(row.step_id, row);
  }

  const stepTypeIcon = (type: string) => {
    if (type === "trigger") return "\u26a1";
    if (type === "agent") return "\ud83e\udd16";
    return "\u25fb";
  };

  const stepTypeLabel = (type: string) => {
    if (type === "trigger") return "Trigger";
    if (type === "agent") return "Agent";
    return "Code";
  };

  const toggleStep = (stepId: string) => {
    setExpandedStepIds((current) => {
      const next = new Set(current);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Steps</p>
      <div className="space-y-1">
        {steps.map((step, i) => {
          const content = contentByStepId.get(step.id);
          const hasContent = !!content;
          const isExpanded = expandedStepIds.has(step.id);

          return (
            <div key={step.id}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm",
                  hasContent && "hover:bg-muted/50",
                )}
                onClick={hasContent ? () => toggleStep(step.id) : undefined}
                disabled={!hasContent}
                aria-expanded={hasContent ? isExpanded : undefined}
              >
                <span className="w-5 text-right text-xs text-muted-foreground">{i + 1}.</span>
                <span>{stepTypeIcon(step.type)}</span>
                <span className="text-xs text-muted-foreground">{stepTypeLabel(step.type)}:</span>
                <span className="flex-1 text-foreground">{step.label}</span>
                {hasContent ? (
                  <CaretRightIcon
                    size={12}
                    className={cn("text-muted-foreground transition-transform", isExpanded && "rotate-90")}
                  />
                ) : null}
              </button>

              {hasContent && isExpanded ? <StepContentView row={content} /> : null}
            </div>
          );
        })}
      </div>
      {stepContentQuery.isError ? <p className="mt-2 text-xs text-destructive">Failed to load step content.</p> : null}
    </div>
  );
}

function StepContentView({ row }: { row: AutomationStepContentItem }) {
  const headerLabel = row.content_type === "prompt" ? "Agent prompt" : "Script";
  let apps: string[] | null = null;
  if (row.apps) {
    try {
      apps = JSON.parse(row.apps) as string[];
    } catch {
      apps = null;
    }
  }

  return (
    <div className="ml-7 mt-1 mb-2 rounded border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{headerLabel}</span>
        {apps && apps.length > 0 ? (
          <span className="text-[10px] text-muted-foreground">apps: {apps.join(", ")}</span>
        ) : null}
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-foreground">
        {row.content}
      </pre>
    </div>
  );
}

function RunHistory({ taskId }: { taskId: string }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ["automation-runs", taskId],
    queryFn: () => api.scheduledTasks.listRuns(taskId),
  });

  const runs = runsQuery.data ?? [];

  if (runsQuery.isLoading) {
    return (
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent Runs</p>
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (runs.length === 0) return null;

  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent Runs</p>
      <div className="space-y-1">
        {runs.slice(0, 5).map((run) => (
          <div key={run.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-muted/50"
              onClick={() => setSelectedRunId(selectedRunId === run.id ? null : run.id)}
            >
              <RunStatusIcon status={run.status} />
              <span className="text-xs text-muted-foreground">{formatDateTime(run.started_at)}</span>
              {run.completed_at && run.started_at ? (
                <span className="text-xs text-muted-foreground">
                  {((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000).toFixed(1)}s
                </span>
              ) : null}
              {run.status === "running" ? (
                <SpinnerGapIcon size={12} className="animate-spin text-muted-foreground" />
              ) : null}
              <span className="ml-auto text-xs text-muted-foreground">
                {selectedRunId === run.id ? "Hide" : "View"}
              </span>
            </button>

            {selectedRunId === run.id ? <RunDetail taskId={taskId} runId={run.id} run={run} /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function RunStatusIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircleIcon size={14} className="text-emerald-500" />;
  if (status === "failed") return <XCircleIcon size={14} className="text-destructive" />;
  if (status === "running") return <SpinnerGapIcon size={14} className="animate-spin text-blue-500" />;
  return <WarningCircleIcon size={14} className="text-muted-foreground" />;
}

type RunStepResult = {
  status: string;
  duration_ms: number;
  output?: unknown;
  error?: { message: string; stack?: string };
};

function parseStepOutputs(run: AutomationRunItem): Record<string, RunStepResult> | null {
  if (!run.step_outputs) return null;
  try {
    return JSON.parse(run.step_outputs) as Record<string, RunStepResult>;
  } catch {
    return null;
  }
}

/**
 * Build a plain-text log of the run suitable for copy/paste into chat or a bug
 * report. Includes full (untruncated) step outputs and error messages.
 */
function formatRunLog(run: AutomationRunItem): string {
  const lines: string[] = [];
  lines.push(`Run ID: ${run.id}`);
  lines.push(`Task ID: ${run.task_id}`);
  lines.push(`Status: ${run.status}`);
  lines.push(`Started: ${run.started_at}`);
  if (run.completed_at) lines.push(`Completed: ${run.completed_at}`);
  if (run.trigger_data) lines.push(`Trigger: ${run.trigger_data}`);
  lines.push("");

  const stepOutputs = parseStepOutputs(run);
  if (stepOutputs) {
    lines.push("--- Steps ---");
    for (const [stepId, result] of Object.entries(stepOutputs)) {
      lines.push("");
      lines.push(`[${result.status}] ${stepId} (${(result.duration_ms / 1000).toFixed(1)}s)`);
      if (result.error) {
        lines.push(`  error: ${result.error.message}`);
        if (result.error.stack) {
          lines.push("  stack:");
          for (const stackLine of result.error.stack.split("\n")) {
            lines.push(`    ${stackLine}`);
          }
        }
      }
      if (result.output != null) {
        const outputStr = typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2);
        lines.push("  output:");
        for (const outputLine of outputStr.split("\n")) {
          lines.push(`    ${outputLine}`);
        }
      }
    }
  }

  if (run.error_message) {
    lines.push("");
    lines.push("--- Error ---");
    lines.push(run.error_message);
  }

  return lines.join("\n");
}

function CopyLogsButton({ run }: { run: AutomationRunItem }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(formatRunLog(run));
      setCopied(true);
      toast.success("Run logs copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Unable to copy logs");
    }
  };

  return (
    <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={handleCopy}>
      {copied ? (
        <>
          <CheckIcon className="size-3" weight="bold" />
          Copied
        </>
      ) : (
        <>
          <CopySimpleIcon className="size-3" />
          Copy logs
        </>
      )}
    </Button>
  );
}

function RunDetail({ taskId: _taskId, runId: _runId, run }: { taskId: string; runId: string; run: AutomationRunItem }) {
  const stepOutputs = parseStepOutputs(run);

  if (!stepOutputs) {
    return run.error_message ? (
      <div className="ml-7 mb-1 space-y-2">
        <div className="rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">{run.error_message}</div>
        <div className="flex justify-end">
          <CopyLogsButton run={run} />
        </div>
      </div>
    ) : null;
  }

  return (
    <div className="ml-7 mb-1 space-y-1">
      {Object.entries(stepOutputs).map(([stepId, result]) => (
        <div key={stepId} className="flex items-start gap-2 rounded px-3 py-1.5 text-xs">
          <RunStatusIcon status={result.status} />
          <div className="min-w-0 flex-1">
            <span className="font-medium">{stepId}</span>
            <span className="ml-2 text-muted-foreground">({(result.duration_ms / 1000).toFixed(1)}s)</span>
            {result.status === "failed" && result.error ? (
              <p className="mt-0.5 whitespace-pre-wrap text-destructive">{result.error.message}</p>
            ) : null}
            {result.status === "completed" && result.output ? (
              <p className="mt-0.5 truncate text-muted-foreground">
                {typeof result.output === "string"
                  ? result.output.slice(0, 150)
                  : JSON.stringify(result.output).slice(0, 150)}
              </p>
            ) : null}
          </div>
        </div>
      ))}
      {run.error_message ? (
        <div className="rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">{run.error_message}</div>
      ) : null}
      <div className="flex justify-end pt-1">
        <CopyLogsButton run={run} />
      </div>
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="break-all text-sm text-foreground">{value}</dd>
    </div>
  );
}

function TaskStatusBadge({ status }: { status: ScheduledTaskListItem["status"] }) {
  if (status === "active") {
    return <Badge className="shrink-0 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">Active</Badge>;
  }

  if (status === "paused") {
    return (
      <Badge variant="secondary" className="shrink-0">
        Paused
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="shrink-0">
      Completed
    </Badge>
  );
}

function CanvasManagedBadge({ triggerConfig }: { triggerConfig: ScheduledTaskListItem["triggerConfig"] }) {
  const status = triggerConfig?.status;
  if (status === "active") {
    return (
      <Badge variant="outline" className="shrink-0 border-blue-500/30 text-blue-700 dark:text-blue-300">
        Canvas
      </Badge>
    );
  }

  if (status === "error") {
    return (
      <Badge variant="outline" className="shrink-0 border-destructive/30 text-destructive">
        Canvas error
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="shrink-0">
      Canvas
    </Badge>
  );
}

function DeleteTaskDialog({
  task,
  isDeleting,
  onOpenChange,
  onConfirm,
}: {
  task: ScheduledTaskListItem | null;
  isDeleting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={!!task} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete automation?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the automation permanently. Future runs will not be triggered.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm} disabled={isDeleting}>
            {isDeleting ? (
              <>
                <SpinnerGapIcon size={14} className="animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-brand-accent/[0.04] px-6 pt-8 pb-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border border-brand-accent bg-white">
        <ClockIcon size={24} className="text-[#8B7A00]" />
      </div>
      <p className="mt-3 text-sm font-medium">No automations yet</p>
      <p className="mt-1.5 max-w-xs text-sm text-muted-foreground">
        Create an automation by asking the assistant to set up a recurring task or multi-step workflow.
      </p>
    </div>
  );
}

function ErrorState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <ClockIcon size={24} className="text-muted-foreground" />
      </div>
      <p className="mt-4 text-sm font-medium text-destructive">Failed to load automations.</p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-32" />
      <div className="rounded-lg border border-border bg-card">
        {[1, 2, 3].map((i) => (
          <div key={i} className={cn("flex items-center gap-4 px-4 py-4", i < 3 && "border-b border-border")}>
            <Skeleton className="size-9 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-2/5" />
            </div>
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function formatSessionMode(sessionMode: ScheduledTaskListItem["sessionMode"]) {
  if (sessionMode === "chat") return "Chat";
  if (sessionMode === "persistent") return "Persistent";
  return "Fresh";
}
