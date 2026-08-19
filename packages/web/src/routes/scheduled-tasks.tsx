import { AutomationShareDialog } from "@/components/automations/share-dialog";
import { type AutomationRunItem, type AutomationStepContentItem, type ScheduledTaskListItem, api } from "@/lib/api";
import {
  AUTOMATION_QUERY_KEY,
  AUTOMATION_REFRESH_INTERVAL_MS,
  automationRunsQueryKey,
  automationStepContentQueryKey,
  invalidateAutomationQueries,
} from "@/lib/automation-refresh";
import { useDashboardAuth } from "@/routes/dashboard";
import {
  BellIcon,
  BellSlashIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  CodeIcon,
  CopySimpleIcon,
  DotsThreeIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  PlayIcon,
  RobotIcon,
  ShareNetworkIcon,
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
import { Input } from "@sketch/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@sketch/ui/components/select";
import { Skeleton } from "@sketch/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@sketch/ui/components/tooltip";
import { cn } from "@sketch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { type MouseEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { dashboardRoute } from "./dashboard";

export const scheduledTasksRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/scheduled-tasks",
  component: ScheduledTasksPage,
});

const TASKS_QUERY_KEY = AUTOMATION_QUERY_KEY;

type OwnershipTab = "all" | "mine" | "shared";
type StatusFilter = "all" | "active" | "attention" | "paused";
type TaskSort = "recent" | "next" | "name" | "attention";

const SORT_LABELS: Record<TaskSort, string> = {
  recent: "Recent activity",
  next: "Next run",
  name: "Name",
  attention: "Needs attention",
};
const toolbarSelectTriggerClass =
  "h-8 w-full rounded-full border-border/45 bg-muted/45 px-3 text-xs font-medium text-muted-foreground shadow-none transition-colors hover:border-border/70 hover:bg-muted/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/35 lg:w-auto [&>svg]:ml-1.5 [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:opacity-60";

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

type CompactWorkflowStep = {
  id: string;
  type: string;
  label: string;
  icon?: string;
};

function parseWorkflowSteps(task: ScheduledTaskListItem): CompactWorkflowStep[] {
  if (!task.steps) return [];
  try {
    const value = JSON.parse(task.steps) as unknown;
    if (!Array.isArray(value)) return [];
    const steps: CompactWorkflowStep[] = [];
    for (const step of value) {
      if (typeof step !== "object" || step === null) continue;
      const record = step as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const type = typeof record.type === "string" ? record.type : "";
      const label = typeof record.label === "string" ? record.label : "";
      const icon = typeof record.icon === "string" ? record.icon : undefined;
      if (id && type && label) steps.push(icon ? { id, type, label, icon } : { id, type, label });
    }
    return steps;
  } catch {
    return [];
  }
}

function hasWorkflowSteps(task: ScheduledTaskListItem): boolean {
  return Boolean(task.steps);
}

function isWorkflowTask(task: ScheduledTaskListItem): boolean {
  return parseWorkflowSteps(task).some((step) => step.type !== "trigger");
}

function workflowStepCount(task: ScheduledTaskListItem): number {
  const steps = parseWorkflowSteps(task);
  return steps.length > 0 ? steps.length : task.stepCount;
}

function isNativeWebhook(task: ScheduledTaskListItem): boolean {
  return (
    task.triggerConfig?.type === "webhook" || (task.scheduleType === "external" && task.scheduleValue === "webhook")
  );
}

function isCanvasManaged(task: ScheduledTaskListItem): boolean {
  return (
    !isNativeWebhook(task) &&
    (task.triggerConfig?.type === "canvas" || (task.scheduleType === "external" && task.scheduleValue === "canvas"))
  );
}

function isTriggerBased(task: ScheduledTaskListItem): boolean {
  return isNativeWebhook(task) || isCanvasManaged(task) || task.triggerConfig?.type === "slack_channel_message";
}

function getTriggerDetail(task: ScheduledTaskListItem): string {
  if (isNativeWebhook(task)) return "Sketch webhook";
  if (task.triggerConfig?.type === "slack_channel_message") {
    return `Slack channel message · ${task.triggerConfig.channelId}`;
  }
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
  if (isNativeWebhook(task)) return "Trigger · Sketch webhook";
  if (task.triggerConfig?.type === "slack_channel_message") {
    return `Trigger · Slack channel message · ${task.triggerConfig.channelId}`;
  }
  if (!isCanvasManaged(task)) return task.scheduleLabel;

  const config = task.triggerConfig;
  const parts = ["Trigger", "Canvas"];
  if (config?.app) parts.push(config.app);
  if (config?.eventDescription) parts.push(config.eventDescription);
  return parts.join(" · ");
}

function formatClockTime(hourValue: string, minuteValue: string): string | null {
  if (!/^\d+$/.test(hourValue) || !/^\d+$/.test(minuteValue)) return null;
  const hour = Number.parseInt(hourValue, 10);
  const minute = Number.parseInt(minuteValue, 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

function weekdayLabel(value: string): string | null {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pluralDayNames = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  const normalized = value.toUpperCase();
  const namedDayMap = new Map(dayNames.map((day, index) => [day.toUpperCase(), index]));
  const normalizeDay = (part: string): number | null => {
    if (/^\d+$/.test(part)) {
      const day = Number.parseInt(part, 10);
      if (day === 7) return 0;
      return day >= 0 && day <= 6 ? day : null;
    }
    return namedDayMap.get(part) ?? null;
  };

  if (normalized === "*") return "Daily";
  if (normalized === "1-5" || normalized === "MON-FRI") return "Weekdays";
  if (normalized === "0,6" || normalized === "6,0" || normalized === "SUN,SAT" || normalized === "SAT,SUN") {
    return "Weekends";
  }

  const singleDay = normalizeDay(normalized);
  if (singleDay !== null) return pluralDayNames[singleDay];

  const parts = normalized.split(",");
  const days = parts.map(normalizeDay);
  if (days.length > 0 && days.every((day): day is number => day !== null)) {
    return days.map((day) => dayNames[day]).join(", ");
  }

  return null;
}

function ordinalDay(value: string): string | null {
  if (!/^\d+$/.test(value)) return null;
  const day = Number.parseInt(value, 10);
  if (day < 1 || day > 31) return null;
  const suffix =
    day % 10 === 1 && day !== 11
      ? "st"
      : day % 10 === 2 && day !== 12
        ? "nd"
        : day % 10 === 3 && day !== 13
          ? "rd"
          : "th";
  return `${day}${suffix}`;
}

function formatCronSchedule(value: string): string | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (/^\*\/\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const minutes = Number.parseInt(minute.slice(2), 10);
    if (Number.isFinite(minutes) && minutes > 0) return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  if (minute === "0" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return "Every hour";
  }

  if (minute === "0" && /^\*\/\d+$/.test(hour) && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const hours = Number.parseInt(hour.slice(2), 10);
    if (Number.isFinite(hours) && hours > 0) return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
  }

  const time = formatClockTime(hour, minute);
  if (!time) return null;

  if (dayOfMonth === "*" && month === "*") {
    const dayLabel = weekdayLabel(dayOfWeek);
    if (dayLabel) return `${dayLabel} at ${time}`;
  }

  if (dayOfWeek === "*" && month === "*") {
    const day = ordinalDay(dayOfMonth);
    if (day) return `Monthly on the ${day} at ${time}`;
  }

  return null;
}

function getReminderScheduleLabel(task: ScheduledTaskListItem): string {
  if (task.scheduleType === "cron") return formatCronSchedule(task.scheduleValue) ?? task.scheduleLabel;
  if (task.scheduleType === "once") return `Once at ${formatDateTime(task.scheduleValue)}`;
  return getTaskScheduleLabel(task);
}

function formatDelivery(task: ScheduledTaskListItem): string {
  if (task.delivery.mode === "silent") return "Silent";
  const platform = task.delivery.platform === "slack" ? "Slack" : "WhatsApp";
  return `${platform} · ${task.delivery.label}`;
}

function taskTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function getCreatorDisplayName(task: ScheduledTaskListItem): string {
  if (!task.createdBy) return "System";
  return task.creatorName ?? task.createdBy;
}

function isOwnedTask(task: ScheduledTaskListItem, userId: string | undefined): boolean {
  if (task.isOwner === true) return true;
  if (task.isOwner != null) return false;
  return Boolean(userId) && task.createdBy === userId;
}

function isSharedTask(task: ScheduledTaskListItem): boolean {
  return task.sharedWithMe === true;
}

function isAttentionTask(task: ScheduledTaskListItem): boolean {
  return task.lastRunStatus === "failed" || task.triggerConfig?.status === "error";
}

function taskSearchText(task: ScheduledTaskListItem): string {
  return [
    task.title,
    task.prompt,
    task.description,
    task.creatorName,
    task.createdBy,
    getCreatorDisplayName(task),
    task.targetLabel,
    task.targetKindLabel,
    task.scheduleLabel,
    task.delivery.label,
    task.deliveryTarget,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

function sortTasks(tasks: ScheduledTaskListItem[], sort: TaskSort): ScheduledTaskListItem[] {
  return [...tasks].sort((left, right) => {
    if (sort === "name") {
      return (left.title ?? left.prompt).localeCompare(right.title ?? right.prompt);
    }
    if (sort === "next") {
      return (
        (taskTimestamp(left.nextRunAt) ?? Number.POSITIVE_INFINITY) -
        (taskTimestamp(right.nextRunAt) ?? Number.POSITIVE_INFINITY)
      );
    }
    if (sort === "attention") {
      return (
        Number(isAttentionTask(right)) - Number(isAttentionTask(left)) ||
        (taskTimestamp(right.lastRunAt) ?? Number.NEGATIVE_INFINITY) -
          (taskTimestamp(left.lastRunAt) ?? Number.NEGATIVE_INFINITY)
      );
    }
    return (
      (taskTimestamp(right.lastRunAt) ?? taskTimestamp(right.createdAt) ?? Number.NEGATIVE_INFINITY) -
      (taskTimestamp(left.lastRunAt) ?? taskTimestamp(left.createdAt) ?? Number.NEGATIVE_INFINITY)
    );
  });
}

export function ScheduledTasksPage() {
  const auth = useDashboardAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [deletingTask, setDeletingTask] = useState<ScheduledTaskListItem | null>(null);
  const [sharingTask, setSharingTask] = useState<ScheduledTaskListItem | null>(null);
  const [query, setQuery] = useState("");
  const [ownershipTab, setOwnershipTab] = useState<OwnershipTab>("mine");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<TaskSort>("recent");

  const tasksQuery = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: () => api.scheduledTasks.list(),
    refetchInterval: AUTOMATION_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const pauseMutation = useMutation({
    mutationFn: (taskId: string) => api.scheduledTasks.pause(taskId),
    onSuccess: (task) => {
      queryClient.setQueryData<ScheduledTaskListItem[]>(TASKS_QUERY_KEY, (tasks) => replaceTaskInCache(tasks, task));
      void invalidateAutomationQueries(queryClient, [task.id]);
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
      void invalidateAutomationQueries(queryClient, [task.id]);
      toast.success("Automation resumed");
    },
    onError: (error) => {
      toast.error(getFallbackTaskError(error));
    },
  });

  const responseMutation = useMutation({
    mutationFn: ({ taskId, muted }: { taskId: string; muted: boolean }) =>
      api.scheduledTasks.setResponseMuted(taskId, muted),
    onSuccess: (task) => {
      queryClient.setQueryData<ScheduledTaskListItem[]>(TASKS_QUERY_KEY, (tasks) => replaceTaskInCache(tasks, task));
      void invalidateAutomationQueries(queryClient, [task.id]);
      toast.success(task.outputMode === "silent" ? "Automation responses muted" : "Automation responses unmuted");
    },
    onError: (error) => {
      toast.error(getFallbackTaskError(error));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (taskId: string) => api.scheduledTasks.remove(taskId),
    onSuccess: (_result, taskId) => {
      queryClient.setQueryData<ScheduledTaskListItem[]>(TASKS_QUERY_KEY, (tasks) => removeTaskFromCache(tasks, taskId));
      void invalidateAutomationQueries(queryClient, [taskId]);
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
    onSuccess: (_result, taskId) => {
      void invalidateAutomationQueries(queryClient, [taskId]);
      toast.success("Automation triggered");
    },
    onError: (error) => {
      toast.error(getFallbackTaskError(error));
    },
  });

  const createMutation = useMutation({
    mutationFn: () => api.scheduledTasks.create(),
    onSuccess: ({ automationId, conversationId }) => {
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
      void navigate({
        to: "/scheduled-tasks/$taskId/edit",
        params: { taskId: automationId },
        search: { conversationId },
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not create automation");
    },
  });

  const tasks = tasksQuery.data ?? [];
  const isAdmin = auth.role === "admin";
  const normalizedQuery = query.trim().toLowerCase();
  const ownershipGroups = useMemo(
    () => ({
      all: tasks,
      mine: tasks.filter((task) => isOwnedTask(task, auth.userId)),
      shared: tasks.filter(isSharedTask),
    }),
    [auth.userId, tasks],
  );
  const tabTasks = ownershipGroups[ownershipTab];
  const searchedTasks = useMemo(
    () => (normalizedQuery ? tabTasks.filter((task) => taskSearchText(task).includes(normalizedQuery)) : tabTasks),
    [normalizedQuery, tabTasks],
  );
  const statusCounts = useMemo(
    () => ({
      all: searchedTasks.length,
      active: searchedTasks.filter((task) => task.status === "active").length,
      attention: searchedTasks.filter(isAttentionTask).length,
      paused: searchedTasks.filter((task) => task.status === "paused").length,
    }),
    [searchedTasks],
  );
  const filteredTasks = useMemo(() => {
    const byStatus =
      statusFilter === "all"
        ? searchedTasks
        : statusFilter === "attention"
          ? searchedTasks.filter(isAttentionTask)
          : searchedTasks.filter((task) => task.status === statusFilter);
    return sortTasks(byStatus, sort);
  }, [searchedTasks, sort, statusFilter]);
  const hasFilters = Boolean(normalizedQuery) || statusFilter !== "all" || ownershipTab !== "mine";
  const handleOwnershipTabChange = (value: OwnershipTab) => {
    setOwnershipTab(value);
  };

  return (
    <div className="mx-auto box-content max-w-4xl px-10 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium text-foreground">Automations</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{getSubtitle(auth.role ?? "member")}</p>
        </div>
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
        >
          {createMutation.isPending ? (
            <SpinnerGapIcon size={14} className="animate-spin" />
          ) : (
            <RobotIcon size={14} weight="fill" aria-hidden />
          )}
          {createMutation.isPending ? "Opening builder…" : "Create with Sketch"}
        </Button>
      </div>
      {createMutation.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {createMutation.error instanceof Error ? createMutation.error.message : "Could not create automation"}
        </p>
      ) : null}

      <div className="mt-6">
        {tasksQuery.isLoading ? (
          <LoadingSkeleton />
        ) : tasksQuery.isError ? (
          <ErrorState />
        ) : tasks.length === 0 ? (
          <EmptyState isCreating={createMutation.isPending} onCreate={() => createMutation.mutate()} />
        ) : (
          <>
            <AutomationToolbar
              query={query}
              onQueryChange={setQuery}
              sort={sort}
              onSortChange={setSort}
              ownershipTab={ownershipTab}
              onOwnershipTabChange={handleOwnershipTabChange}
              isAdmin={isAdmin}
              ownershipCounts={{
                all: ownershipGroups.all.length,
                mine: ownershipGroups.mine.length,
                shared: ownershipGroups.shared.length,
              }}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              statusCounts={statusCounts}
            />
            <div className="overflow-hidden rounded-[10px] border border-border bg-card shadow-sm">
              {filteredTasks.length > 0 ? (
                filteredTasks.map((task, index) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    isAdmin={isAdmin}
                    isExpanded={expandedTaskId === task.id}
                    isLast={index === filteredTasks.length - 1}
                    isMutating={
                      (pauseMutation.isPending && pauseMutation.variables === task.id) ||
                      (resumeMutation.isPending && resumeMutation.variables === task.id) ||
                      (responseMutation.isPending && responseMutation.variables?.taskId === task.id) ||
                      (deleteMutation.isPending && deleteMutation.variables === task.id) ||
                      (triggerMutation.isPending && triggerMutation.variables === task.id)
                    }
                    onToggleExpanded={() => setExpandedTaskId((current) => (current === task.id ? null : task.id))}
                    onPause={() => pauseMutation.mutate(task.id)}
                    onResume={() => resumeMutation.mutate(task.id)}
                    onMuteResponses={() => responseMutation.mutate({ taskId: task.id, muted: true })}
                    onUnmuteResponses={() => responseMutation.mutate({ taskId: task.id, muted: false })}
                    onDelete={() => setDeletingTask(task)}
                    onTrigger={() => triggerMutation.mutate(task.id)}
                    onShare={() => setSharingTask(task)}
                    userId={auth.userId}
                    onOpenBuilder={() =>
                      navigate({ to: "/scheduled-tasks/$taskId/edit", params: { taskId: task.id }, search: {} })
                    }
                  />
                ))
              ) : (
                <FilteredEmptyState hasFilters={hasFilters} />
              )}
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

      <AutomationShareDialog
        taskId={sharingTask?.id ?? ""}
        taskName={sharingTask ? (sharingTask.title ?? sharingTask.prompt) : ""}
        ownerUserId={sharingTask?.createdBy ?? auth.userId}
        canShare={
          sharingTask?.canShare === true ||
          (sharingTask != null && sharingTask.canShare == null && isOwnedTask(sharingTask, auth.userId))
        }
        open={Boolean(sharingTask)}
        onOpenChange={(open) => {
          if (!open) setSharingTask(null);
        }}
      />
    </div>
  );
}

function AutomationToolbar({
  query,
  onQueryChange,
  sort,
  onSortChange,
  ownershipTab,
  onOwnershipTabChange,
  isAdmin,
  ownershipCounts,
  statusFilter,
  onStatusFilterChange,
  statusCounts,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  sort: TaskSort;
  onSortChange: (value: TaskSort) => void;
  ownershipTab: OwnershipTab;
  onOwnershipTabChange: (value: OwnershipTab) => void;
  isAdmin: boolean;
  ownershipCounts: Record<OwnershipTab, number>;
  statusFilter: StatusFilter;
  onStatusFilterChange: (value: StatusFilter) => void;
  statusCounts: Record<StatusFilter, number>;
}) {
  return (
    <div className="mb-3 space-y-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlassIcon
            size={16}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search tasks"
            aria-label="Search tasks"
            className="h-9 rounded-[8px] pl-8 text-sm"
          />
        </div>
        <Select value={sort} onValueChange={(value) => onSortChange(value as TaskSort)}>
          <SelectTrigger
            className={cn(toolbarSelectTriggerClass, "lg:min-w-[136px]")}
            aria-label="Sort scheduled tasks"
          >
            <span className="min-w-0 flex-1 truncate text-left">{SORT_LABELS[sort]}</span>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SORT_LABELS) as TaskSort[]).map((key) => (
              <SelectItem key={key} value={key}>
                {SORT_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-1 border-b border-border">
        {isAdmin ? (
          <OwnershipTabButton
            label="All"
            count={ownershipCounts.all}
            active={ownershipTab === "all"}
            onClick={() => onOwnershipTabChange("all")}
          />
        ) : null}
        <OwnershipTabButton
          label="Mine"
          count={ownershipCounts.mine}
          active={ownershipTab === "mine"}
          onClick={() => onOwnershipTabChange("mine")}
        />
        <OwnershipTabButton
          label="Shared with me"
          count={ownershipCounts.shared}
          active={ownershipTab === "shared"}
          onClick={() => onOwnershipTabChange("shared")}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <StatusFilterChip
          label="All"
          count={statusCounts.all}
          active={statusFilter === "all"}
          onClick={() => onStatusFilterChange("all")}
        />
        <StatusFilterChip
          label="Active"
          count={statusCounts.active}
          active={statusFilter === "active"}
          onClick={() => onStatusFilterChange("active")}
        />
        <StatusFilterChip
          label="Needs attention"
          count={statusCounts.attention}
          active={statusFilter === "attention"}
          tone="attention"
          onClick={() => onStatusFilterChange("attention")}
        />
        <StatusFilterChip
          label="Paused"
          count={statusCounts.paused}
          active={statusFilter === "paused"}
          onClick={() => onStatusFilterChange("paused")}
        />
      </div>
    </div>
  );
}

function OwnershipTabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
        active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      aria-pressed={active}
    >
      {label} <span className="ml-1 text-xs text-muted-foreground">{count}</span>
    </button>
  );
}

function StatusFilterChip({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  tone?: "attention";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 items-center gap-2 rounded-full px-3 text-xs font-medium transition-colors",
        active
          ? "bg-foreground text-background"
          : tone === "attention" && count > 0
            ? "bg-destructive/10 text-destructive hover:bg-destructive/15"
            : "bg-muted text-muted-foreground hover:bg-muted/70",
      )}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
      <span
        className={cn(
          "grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] tabular-nums",
          active ? "bg-background/15 text-background/80" : "bg-background/50 text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function PlatformIcon({
  platform,
  workflow,
  status,
}: {
  platform: "slack" | "whatsapp";
  workflow: boolean;
  status: ScheduledTaskListItem["status"];
}) {
  const activeWorkflow = workflow && status === "active";
  return (
    <div
      aria-label={workflow ? `${status} workflow icon` : `${platform} reminder icon`}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-[8px]",
        activeWorkflow ? "bg-brand-accent/12 text-brand-accent" : "bg-muted text-muted-foreground",
      )}
    >
      {workflow ? (
        <LightningIcon size={14} weight="fill" />
      ) : platform === "slack" ? (
        <SlackLogoIcon size={14} />
      ) : (
        <WhatsappLogoIcon size={14} />
      )}
    </div>
  );
}

function StepChainIcon({ step }: { step: CompactWorkflowStep }) {
  if (step.type === "trigger") return <LightningIcon size={11} weight="fill" />;
  if (step.type === "agent") return <RobotIcon size={11} weight="bold" />;
  if (step.type === "action" || step.icon === "code") return <CodeIcon size={11} weight="bold" />;
  return <CheckCircleIcon size={11} weight="fill" />;
}

function WorkflowChain({ task }: { task: ScheduledTaskListItem }) {
  const steps = parseWorkflowSteps(task);
  const visibleSteps = steps.length > 0 ? steps.slice(0, 3) : [];
  const hiddenStepCount = Math.max(0, steps.length - visibleSteps.length);
  if (visibleSteps.length === 0) return null;

  return (
    <span
      className="grid h-5 w-[92px] grid-flow-col auto-cols-[20px] items-center justify-start gap-1"
      aria-label={`${workflowStepCount(task)} workflow steps`}
    >
      {visibleSteps.map((step) => (
        <span key={step.id} className="inline-flex items-center gap-1">
          <span
            className="grid size-5 place-items-center rounded-[5px] border border-border/80 bg-muted/45 text-muted-foreground"
            title={step.label}
          >
            <StepChainIcon step={step} />
          </span>
        </span>
      ))}
      {hiddenStepCount > 0 ? (
        <span className="grid size-5 place-items-center rounded-[5px] border border-border/80 bg-muted text-[10px] font-medium text-muted-foreground">
          +{hiddenStepCount}
        </span>
      ) : null}
    </span>
  );
}

function RunHealth({ task }: { task: ScheduledTaskListItem }) {
  const hasRuns = task.runCount > 0 || Boolean(task.lastRunStatus);
  const count = hasRuns ? Math.min(5, Math.max(1, task.runCount || 1)) : 0;
  const dots = Array.from({ length: 5 }, (_, index) => {
    const status =
      index === 0 && task.lastRunStatus === "failed"
        ? "failed"
        : index === 0 && task.lastRunStatus === "running"
          ? "running"
          : "completed";
    return { id: `${task.id}-run-health-${index + 1}`, status };
  });

  return (
    <span
      className="grid h-5 w-[46px] grid-cols-5 place-items-center gap-1"
      title={`Last run: ${task.lastRunStatus ?? "unknown"}`}
      aria-label={hasRuns ? `${count} recent run signals` : "No recent run signals"}
    >
      {dots.map((dot, index) => (
        <span
          key={dot.id}
          className={cn(
            "size-1.5 rounded-full",
            index >= count && "invisible",
            dot.status === "failed" ? "bg-destructive" : dot.status === "running" ? "bg-blue-500" : "bg-emerald-500",
          )}
        />
      ))}
    </span>
  );
}

function RowMiddleSignal({ task, workflow }: { task: ScheduledTaskListItem; workflow: boolean }) {
  if (workflow) {
    return (
      <div className="hidden h-5 w-[154px] shrink-0 items-center justify-start gap-4 md:flex">
        <WorkflowChain task={task} />
        <RunHealth task={task} />
      </div>
    );
  }

  return (
    <div className="hidden h-5 w-[154px] shrink-0 items-center justify-start md:flex">
      <span className="truncate text-xs text-muted-foreground" title={getTaskScheduleLabel(task)}>
        {getReminderScheduleLabel(task)}
      </span>
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
  onMuteResponses,
  onUnmuteResponses,
  onDelete,
  onTrigger,
  onShare,
  onOpenBuilder,
  userId,
}: {
  task: ScheduledTaskListItem;
  isAdmin: boolean;
  userId: string | undefined;
  isExpanded: boolean;
  isLast: boolean;
  isMutating: boolean;
  onToggleExpanded: () => void;
  onPause: () => void;
  onResume: () => void;
  onMuteResponses: () => void;
  onUnmuteResponses: () => void;
  onDelete: () => void;
  onTrigger: () => void;
  onShare: () => void;
  onOpenBuilder: () => void;
}) {
  const workflow = isWorkflowTask(task);
  const displayName = task.title ?? task.prompt;
  const canShare = task.canShare === true || (task.canShare == null && isOwnedTask(task, userId));
  const shareCount = task.shareCount ?? 0;

  return (
    <div className={cn(!isLast && "border-b border-border")}>
      <div className="flex min-h-[56px] items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-muted/35">
        <PlatformIcon platform={task.platform} workflow={workflow} status={task.status} />

        <button
          type="button"
          className="min-w-0 flex-[1.4] text-left"
          onClick={onToggleExpanded}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? `Hide details for ${displayName}` : `Show details for ${displayName}`}
        >
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
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
              {isSharedTask(task) ? (
                <Badge
                  aria-label="Shared with you"
                  className="shrink-0 rounded-full bg-brand-accent/12 px-2 py-0 text-[10px] font-medium text-brand-accent"
                >
                  Shared with you
                </Badge>
              ) : null}
            </div>

            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {workflow ? `workflow · ${workflowStepCount(task)} steps` : "reminder"}
              {isAdmin ? ` · by ${getCreatorDisplayName(task)}` : ""}
              {task.lastRunStatus === "failed" ? <span className="text-destructive"> · failed</span> : null}
            </p>
          </div>
        </button>

        <RowMiddleSignal task={task} workflow={workflow} />

        <div className="flex shrink-0 items-center justify-end md:w-[86px]">
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
            <DropdownMenuItem onClick={onOpenBuilder}>
              <LightningIcon size={16} />
              Open Builder
            </DropdownMenuItem>
            {canShare ? (
              <DropdownMenuItem onClick={onShare}>
                <ShareNetworkIcon size={16} />
                Share{shareCount > 0 ? ` · ${shareCount}` : ""}
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
            {task.canMuteResponses ? (
              <DropdownMenuItem disabled={isMutating} onClick={onMuteResponses}>
                <BellSlashIcon size={16} />
                Mute responses
              </DropdownMenuItem>
            ) : null}
            {task.canUnmuteResponses ? (
              <DropdownMenuItem disabled={isMutating} onClick={onUnmuteResponses}>
                <BellIcon size={16} />
                Unmute responses
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
      </div>

      {isExpanded ? <TaskExpandedDetail task={task} isAdmin={isAdmin} /> : null}
    </div>
  );
}

function TaskExpandedDetail({ task, isAdmin }: { task: ScheduledTaskListItem; isAdmin: boolean }) {
  const targetLabel = task.targetLabel || task.deliveryTarget;
  const triggerBased = isTriggerBased(task);

  return (
    <div className="border-t border-border bg-muted/20 px-4 py-4 space-y-4">
      {hasWorkflowSteps(task) ? <StepsList task={task} /> : null}

      <RunHistory taskId={task.id} />

      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <DetailItem label="Source" value={`${task.targetKindLabel} \u00b7 ${targetLabel}`} />
        <DetailItem label="Delivery" value={formatDelivery(task)} />
        <DetailItem label="Type" value={triggerBased ? "Trigger-based" : "Scheduled"} />
        <DetailItem label={triggerBased ? "Trigger" : "Schedule"} value={getTriggerDetail(task)} />
        {triggerBased ? null : <DetailItem label="Timezone" value={task.timezone} />}
        <DetailItem label="Session mode" value={formatSessionMode(task.sessionMode)} />
        {triggerBased ? null : <DetailItem label="Next run" value={formatDateTime(task.nextRunAt)} />}
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
    queryKey: automationStepContentQueryKey(task.id),
    queryFn: () => api.scheduledTasks.getStepContent(task.id),
    refetchInterval: AUTOMATION_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
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

  const StepTypeIcon = ({ type }: { type: string }) => {
    if (type === "trigger") return <LightningIcon size={14} weight="bold" />;
    if (type === "agent") return <RobotIcon size={14} weight="bold" />;
    return <CodeIcon size={14} weight="bold" />;
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
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  <StepTypeIcon type={step.type} />
                </span>
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
    queryKey: automationRunsQueryKey(taskId),
    queryFn: () => api.scheduledTasks.listRuns(taskId),
    refetchInterval: AUTOMATION_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const runs = runsQuery.data ?? [];
  const hasAttributedRuns = runs.some((run) => Boolean(run.triggered_by_user_id));

  const usersQuery = useQuery({
    queryKey: ["automation-run-attribution-users"],
    queryFn: () => api.users.list(),
    enabled: hasAttributedRuns,
    staleTime: 60_000,
  });

  const memberNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const user of usersQuery.data?.users ?? []) {
      names.set(user.id, user.name);
    }
    return names;
  }, [usersQuery.data]);

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
              {run.triggered_by_user_id ? (
                <span className="truncate text-xs text-muted-foreground">
                  · by {memberNameById.get(run.triggered_by_user_id) ?? "a member"}
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
  const label = `Task status: ${status}`;

  if (status === "active") {
    return (
      <Badge aria-label={label} className="shrink-0 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
        Active
      </Badge>
    );
  }

  if (status === "paused") {
    return (
      <Badge aria-label={label} variant="secondary" className="shrink-0">
        Paused
      </Badge>
    );
  }

  return (
    <Badge aria-label={label} variant="outline" className="shrink-0">
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

function EmptyState({
  isCreating,
  onCreate,
}: {
  isCreating: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-brand-accent/[0.04] px-6 pt-8 pb-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border border-brand-accent bg-white">
        <ClockIcon size={24} className="text-[#8B7A00]" />
      </div>
      <p className="mt-3 text-sm font-medium">No automations yet</p>
      <p className="mt-1.5 max-w-xs text-sm text-muted-foreground">
        Create an automation by asking the assistant to set up a recurring task or multi-step workflow.
      </p>
      <Button type="button" size="sm" className="mt-4" onClick={onCreate} disabled={isCreating}>
        {isCreating ? (
          <SpinnerGapIcon size={14} className="animate-spin" />
        ) : (
          <RobotIcon size={14} weight="fill" aria-hidden />
        )}
        {isCreating ? "Opening builder…" : "Create with Sketch"}
      </Button>
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

function FilteredEmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="flex min-h-[164px] flex-col items-center justify-center px-6 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-[8px] bg-muted">
        <MagnifyingGlassIcon size={20} className="text-muted-foreground" />
      </div>
      <p className="mt-3 text-sm font-medium text-foreground">
        {hasFilters ? "No tasks match these filters" : "No tasks here yet"}
      </p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {hasFilters ? "Try a different search, status, or sort." : "Tasks will appear here once they exist."}
      </p>
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
  void sessionMode;
  return "Fresh";
}
