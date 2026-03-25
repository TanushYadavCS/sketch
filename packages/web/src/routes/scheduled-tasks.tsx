import { type ScheduledTaskListItem, api } from "@/lib/api";
import { useDashboardAuth } from "@/routes/dashboard";
import {
  CaretRightIcon,
  ClockIcon,
  DotsThreeIcon,
  PauseIcon,
  PlayIcon,
  SlackLogoIcon,
  SpinnerGapIcon,
  TrashIcon,
  WhatsappLogoIcon,
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
import { useState } from "react";
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

function getScheduledTasksSubtitle(role: "admin" | "member") {
  return role === "admin"
    ? "View and manage recurring and one-time tasks across the workspace"
    : "View and manage the tasks you created through chat";
}

function getFallbackTaskError(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Failed to update scheduled task";
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
      toast.success("Task paused");
    },
    onError: (error) => {
      toast.error(getFallbackTaskError(error));
    },
  });

  const resumeMutation = useMutation({
    mutationFn: (taskId: string) => api.scheduledTasks.resume(taskId),
    onSuccess: (task) => {
      queryClient.setQueryData<ScheduledTaskListItem[]>(TASKS_QUERY_KEY, (tasks) => replaceTaskInCache(tasks, task));
      toast.success("Task resumed");
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
      toast.success("Task deleted");
    },
    onError: (error) => {
      toast.error(getFallbackTaskError(error));
    },
  });

  const tasks = tasksQuery.data ?? [];
  const isAdmin = auth.role === "admin";

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div>
        <h1 className="text-xl font-bold">Scheduled Tasks</h1>
        <p className="mt-1 text-sm text-muted-foreground">{getScheduledTasksSubtitle(auth.role)}</p>
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
              {isAdmin ? "All scheduled tasks" : "Your scheduled tasks"}
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
                    (deleteMutation.isPending && deleteMutation.variables === task.id)
                  }
                  onToggleExpanded={() => setExpandedTaskId((current) => (current === task.id ? null : task.id))}
                  onPause={() => pauseMutation.mutate(task.id)}
                  onResume={() => resumeMutation.mutate(task.id)}
                  onDelete={() => setDeletingTask(task)}
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

function PlatformIcon({ platform }: { platform: "slack" | "whatsapp" }) {
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
      {platform === "slack" ? (
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
}) {
  const targetLabel = task.targetLabel || task.deliveryTarget;
  const hasActions = task.canPause || task.canResume || task.canDelete;

  return (
    <div className={cn(!isLast && "border-b border-border")}>
      <div className="flex items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/50">
        <PlatformIcon platform={task.platform} />

        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={onToggleExpanded}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? `Hide details for ${task.prompt}` : `Show details for ${task.prompt}`}
        >
          <div className="min-w-0 flex-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <p className="truncate text-sm font-medium text-foreground">{task.prompt}</p>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  {task.prompt}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {task.scheduleLabel}
              <span className="mx-1.5">·</span>
              {targetLabel}
              {isAdmin && task.creatorName ? (
                <>
                  <span className="mx-1.5">·</span>
                  {task.creatorName}
                </>
              ) : null}
            </p>
          </div>
        </button>

        <TaskStatusBadge status={task.status} />

        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
          onClick={onToggleExpanded}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? `Collapse ${task.prompt}` : `Expand ${task.prompt}`}
        >
          <CaretRightIcon size={14} className={cn("transition-transform", isExpanded && "rotate-90")} />
        </button>

        {hasActions ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label={`Task actions for ${task.prompt}`}
              >
                <DotsThreeIcon size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
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
              {task.canDelete && (task.canPause || task.canResume) ? <DropdownMenuSeparator /> : null}
              {task.canDelete ? (
                <DropdownMenuItem variant="destructive" disabled={isMutating} onClick={onDelete}>
                  <TrashIcon size={16} />
                  Delete
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className="size-7 shrink-0" />
        )}
      </div>

      {isExpanded ? (
        <div className="border-t border-border bg-muted/20 px-4 py-4">
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <DetailItem label="Target" value={`${task.targetKindLabel} · ${targetLabel}`} />
            <DetailItem label="Schedule" value={`${task.scheduleType} · ${task.scheduleValue}`} />
            <DetailItem label="Timezone" value={task.timezone} />
            <DetailItem label="Session mode" value={formatSessionMode(task.sessionMode)} />
            <DetailItem label="Next run" value={formatDateTime(task.nextRunAt)} />
            <DetailItem label="Last run" value={formatDateTime(task.lastRunAt)} />
            <DetailItem label="Created" value={formatDateTime(task.createdAt)} />
            {isAdmin ? <DetailItem label="Created by" value={task.creatorName ?? task.createdBy ?? "Unknown"} /> : null}
            <DetailItem label="Delivery target" value={task.deliveryTarget} />
            {task.threadTs ? <DetailItem label="Thread" value={task.threadTs} /> : null}
          </dl>
        </div>
      ) : null}
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
          <AlertDialogTitle>Delete scheduled task?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the task permanently. Future runs will not be triggered.
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
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <ClockIcon size={24} className="text-muted-foreground" />
      </div>
      <p className="mt-4 text-sm font-medium">No scheduled tasks yet</p>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">
        Create a scheduled task by asking the assistant to remind you or run something on a schedule.
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
      <p className="mt-4 text-sm font-medium text-destructive">Failed to load scheduled tasks.</p>
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
