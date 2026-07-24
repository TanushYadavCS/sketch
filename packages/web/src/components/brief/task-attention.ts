import type { DailyBriefItem } from "@/lib/api";

export type TaskAttentionReason =
  | "new_since_last_brief"
  | "meaningfully_changed"
  | "status_changed"
  | "due_soon"
  | "overdue"
  | "high_priority"
  | "pending_completion_review"
  | "carried_from_previous_brief";

export interface TaskAttentionContext {
  reasons: TaskAttentionReason[];
  changedFields: string[];
}

const knownReasons = new Set<TaskAttentionReason>([
  "new_since_last_brief",
  "meaningfully_changed",
  "status_changed",
  "due_soon",
  "overdue",
  "high_priority",
  "pending_completion_review",
  "carried_from_previous_brief",
]);

const taskAttentionReasonCopy: Record<
  Exclude<TaskAttentionReason, "meaningfully_changed">,
  { title: string; description: string }
> = {
  new_since_last_brief: {
    title: "New since your last brief",
    description: "This task was added after your previous brief.",
  },
  status_changed: {
    title: "Status changed",
    description: "Its status changed since your previous brief.",
  },
  due_soon: {
    title: "Due soon",
    description: "This task is due within the next seven days.",
  },
  overdue: {
    title: "Overdue",
    description: "The due date has passed and this task is still open.",
  },
  high_priority: {
    title: "High priority",
    description: "This task is marked as high priority.",
  },
  pending_completion_review: {
    title: "Needs your review",
    description: "Sketch found signs that this task may be complete.",
  },
  carried_from_previous_brief: {
    title: "Still on your radar",
    description: "This task appeared in your previous brief and is still open.",
  },
};

export function readTaskAttentionContext(item: DailyBriefItem): TaskAttentionContext | null {
  if (item.sectionKey !== "todos" || !item.structuredPayload) return null;
  const payload = item.structuredPayload as unknown as Record<string, unknown>;
  if (!Array.isArray(payload.attentionReasons)) return null;

  const reasons = [
    ...new Set(
      payload.attentionReasons.filter(
        (reason): reason is TaskAttentionReason =>
          typeof reason === "string" && knownReasons.has(reason as TaskAttentionReason),
      ),
    ),
  ];
  const changedFields = Array.isArray(payload.changedFields)
    ? [
        ...new Set(
          payload.changedFields.flatMap((field) => (typeof field === "string" && field.trim() ? [field.trim()] : [])),
        ),
      ]
    : [];
  return { reasons, changedFields };
}

function formatChangedField(field: string): string | null {
  const labels: Record<string, string> = {
    assignee_entity_id: "assignee",
    assignee_name: "assignee",
    due_at: "due date",
    parent_entity_id: "project",
    priority: "priority",
    proposed_assignee_name: "suggested assignee",
    status: "status",
    title: "title",
  };
  return labels[field] ?? null;
}

function formatNaturalList(values: string[]): string {
  if (values.length === 1) return values[0] as string;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function meaningfulChangeCopy(changedFields: string[]): { title: string; description: string } {
  const readableFields = [
    ...new Set(
      changedFields.flatMap((field) => {
        const label = formatChangedField(field);
        return label ? [label] : [];
      }),
    ),
  ];
  if (readableFields.length === 0) {
    return {
      title: "Recently updated",
      description: "Something important about this task changed since your previous brief.",
    };
  }
  const fields = formatNaturalList(readableFields);
  return {
    title: "Recently updated",
    description: `The ${fields} changed since your previous brief.`,
  };
}

export function readableTaskAttentionReasons(context: TaskAttentionContext) {
  return context.reasons
    .filter((reason) => {
      if (reason === "meaningfully_changed" && context.reasons.includes("new_since_last_brief")) return false;
      if (
        reason === "status_changed" &&
        context.reasons.includes("meaningfully_changed") &&
        context.changedFields.includes("status")
      ) {
        return false;
      }
      return true;
    })
    .map((reason) =>
      reason === "meaningfully_changed" ? meaningfulChangeCopy(context.changedFields) : taskAttentionReasonCopy[reason],
    );
}

export function primaryTaskAttentionMeta(
  context: TaskAttentionContext | null,
): { label: string; dot: string; text: string } | null {
  if (!context) return null;
  const reasons = context.reasons;
  if (reasons.includes("overdue")) {
    return { label: "Overdue", dot: "bg-amber-400", text: "text-amber-600 dark:text-amber-400" };
  }
  if (reasons.includes("pending_completion_review")) {
    return { label: "Needs review", dot: "bg-amber-400", text: "text-amber-600 dark:text-amber-400" };
  }
  if (reasons.includes("new_since_last_brief")) {
    return { label: "New", dot: "bg-lime-600 dark:bg-lime-500", text: "text-lime-700 dark:text-lime-500" };
  }
  if (reasons.includes("meaningfully_changed") || reasons.includes("status_changed")) {
    return { label: "Updated", dot: "bg-muted-foreground/45", text: "text-muted-foreground" };
  }
  if (reasons.includes("due_soon")) {
    return { label: "Due soon", dot: "bg-amber-400/80", text: "text-amber-600 dark:text-amber-400" };
  }
  if (reasons.includes("high_priority")) {
    return { label: "High priority", dot: "bg-orange-400", text: "text-orange-600 dark:text-orange-400" };
  }
  if (reasons.includes("carried_from_previous_brief")) {
    return { label: "Carried", dot: "bg-muted-foreground/45", text: "text-muted-foreground" };
  }
  return null;
}
