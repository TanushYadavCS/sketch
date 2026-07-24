/**
 * Pure helpers for the Live Brief Task Links slice.
 *
 * These are extracted from the component tree so the cache-overlay update
 * logic (and the status formatting it shares with the row + drawer) can be
 * unit-tested without rendering Home or wiring a router.
 */
import type {
  DailyBrief,
  DailyBriefItem,
  DailyBriefResponse,
  DailyBriefReviewMutationResponse,
  DailyBriefTaskState,
  TaskStatus,
} from "@/lib/api";

export const BRIEF_TASK_STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "dropped", label: "Dropped" },
];

export function formatBriefTaskStatus(status: string): string {
  return BRIEF_TASK_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status.replace(/_/g, " ");
}

/** Tailwind classes for the live-status pill/dot keyed by status. */
export function briefTaskStatusTone(status: TaskStatus): { dot: string; text: string } {
  switch (status) {
    case "in_progress":
      return { dot: "bg-amber-400", text: "text-amber-600 dark:text-amber-400" };
    case "done":
      return { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" };
    case "dropped":
      return { dot: "bg-muted-foreground/40", text: "text-muted-foreground line-through" };
    default:
      return { dot: "bg-muted-foreground/40", text: "text-muted-foreground" };
  }
}

/** Supplementary source text shown only for externally-authoritative status. */
export function briefTaskExternalStatus(task: DailyBriefTaskState): string | null {
  if (task.statusAuthority === "external" && task.statusRaw) return task.statusRaw;
  return null;
}

/** Concise reason copy for a read-only task overlay. */
export function briefTaskReadonlyReason(task: DailyBriefTaskState): string | null {
  if (task.readonlyReason === "external_authority") return "Managed by the source system and read-only here.";
  if (task.readonlyReason === "not_owner") return "Only the creator, assignee, or an admin can change this status.";
  return null;
}

/** Return a usable live overlay only when both the canonical id and task are present. */
export function getBriefItemTask(item: DailyBriefItem): DailyBriefTaskState | null {
  return item.taskId && item.task ? item.task : null;
}

const BRIEF_SECTION_KEYS = [
  "meetings",
  "todos",
  "untracked_followups",
  "looks_resolved",
  "customer_updates",
  "active_projects",
] as const;

/**
 * Replace the `task` overlay on every brief item whose `taskId` matches the
 * given task's id, preserving all snapshot fields (title/summary/label/etc.).
 *
 * Returns the same response object reference when there is no brief, so callers
 * can short-circuit without allocating.
 */
export function applyTaskOverlayToBriefResponse(
  response: DailyBriefResponse,
  task: DailyBriefTaskState,
): DailyBriefResponse {
  if (!response.brief) return response;
  return { ...response, brief: applyTaskOverlayToBrief(response.brief, task) };
}

export function applyTaskOverlayToBrief(brief: DailyBrief, task: DailyBriefTaskState): DailyBrief {
  let changed = false;
  const sections = { ...brief.sections } as DailyBrief["sections"];
  for (const key of BRIEF_SECTION_KEYS) {
    const items = sections[key];
    if (!items || items.length === 0) continue;
    const nextItems = items.map((item) => {
      if (item.taskId && item.taskId === task.id) {
        changed = true;
        return { ...item, task };
      }
      return item;
    });
    sections[key] = nextItems;
  }
  return changed ? { ...brief, sections } : brief;
}

export function applyReviewOverlayToBriefResponse(
  response: DailyBriefResponse,
  result: DailyBriefReviewMutationResponse,
): DailyBriefResponse {
  if (!response.brief) return response;
  let changed = false;
  const sections = { ...response.brief.sections } as DailyBrief["sections"];
  for (const key of BRIEF_SECTION_KEYS) {
    const items = sections[key];
    if (!items?.length) continue;
    sections[key] = items.map((item) => {
      if (item.review?.id !== result.review.id) return item;
      changed = true;
      return {
        ...item,
        review: result.review,
        taskId: result.task?.id ?? null,
        task: result.task,
      };
    });
  }
  return changed ? { ...response, brief: { ...response.brief, sections } } : response;
}
