import type {
  DailyBriefItem,
  DailyBriefMeetingAttendee,
  DailyBriefReviewDecision,
  DailyBriefReviewState,
  DailyBriefTaskState,
  TaskStatus,
} from "@/lib/api";
import { EntityChip, useEntityUiOptional } from "@/lib/entity-ui";
import { ArrowSquareOutIcon, ClockIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@sketch/ui/components/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@sketch/ui/components/sheet";
import { cn } from "@sketch/ui/lib/utils";
import { BriefActionButton } from "./brief-action-button";
import { BriefFollowupActionRail } from "./brief-followup-action-rail";
import { labelMeta, refChips, sourceLinkLabel } from "./item-metadata";
import { formatMeetingTime } from "./meeting-row";
import {
  BRIEF_TASK_STATUS_OPTIONS,
  briefTaskExternalStatus,
  briefTaskReadonlyReason,
  briefTaskStatusTone,
  formatBriefTaskStatus,
  getBriefItemTask,
} from "./task-overlay";

type TaskAttentionReason =
  | "new_since_last_brief"
  | "meaningfully_changed"
  | "status_changed"
  | "due_soon"
  | "overdue"
  | "high_priority"
  | "pending_completion_review"
  | "carried_from_previous_brief";

interface TaskAttentionContext {
  reasons: TaskAttentionReason[];
  changedFields: string[];
}

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

function readTaskAttentionContext(item: DailyBriefItem): TaskAttentionContext | null {
  if (item.sectionKey !== "todos" || !item.structuredPayload) return null;
  const payload = item.structuredPayload as unknown as Record<string, unknown>;
  if (!Array.isArray(payload.attentionReasons)) return null;

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

function readableTaskAttentionReasons(context: TaskAttentionContext) {
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

function BriefContextBlock({ item }: { item: DailyBriefItem }) {
  const taskAttention = readTaskAttentionContext(item);
  if (!taskAttention && !item.summary) return null;
  const knownReasons = taskAttention ? readableTaskAttentionReasons(taskAttention) : [];
  const readableReasons = taskAttention
    ? knownReasons.length > 0
      ? knownReasons
      : [{ title: "Recent activity", description: "Sketch noticed recent activity on this task." }]
    : [];
  const label = taskAttention ? "Why it’s in your brief" : "Briefing note";

  return (
    <section aria-label={label} className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span
          className={cn("inline-block size-1 rounded-full", taskAttention ? "bg-amber-400" : "bg-muted-foreground/50")}
          aria-hidden
        />
        <p
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.12em]",
            taskAttention ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
          )}
        >
          {label}
        </p>
      </div>
      {readableReasons.length > 0 ? (
        <ul className="border-l border-amber-400/40 pl-3">
          {readableReasons.map((reason, index) => (
            <li key={reason.title} className={cn("py-2", index > 0 && "border-t border-border/50")}>
              <p className="text-[13px] font-medium leading-snug text-foreground">{reason.title}</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{reason.description}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] leading-relaxed text-foreground/80">{item.summary}</p>
      )}
    </section>
  );
}

function drawerTitle(item: DailyBriefItem): string {
  if (item.sectionKey === "todos" && item.displayRef) return `${item.displayRef} \u00b7 ${item.title}`;
  return item.title;
}

function drawerSubtitle(item: DailyBriefItem): string {
  if (item.sectionKey === "todos") return "Assigned or inferred for you";
  if (item.sectionKey === "untracked_followups") return "Reconstructed follow-up";
  if (item.sectionKey === "looks_resolved") return "Completion review";
  if (item.sectionKey === "customer_updates") return "Customer Updates";
  return "Active Projects";
}

function priorityLabel(priority: DailyBriefItem["priority"]): string {
  if (priority === "high") return "High priority";
  if (priority === "medium") return "Medium priority";
  return "Low priority";
}

export function BriefDetailDrawer({
  item,
  timezone,
  onClose,
  onOpenChat,
  onUpdateTaskStatus,
  updatingTaskId,
  onReviewFollowup,
  updatingReviewId,
}: {
  item: DailyBriefItem | null;
  timezone: string;
  onClose: () => void;
  onOpenChat: (prompt: string) => void;
  onUpdateTaskStatus?: (taskId: string, status: TaskStatus) => void;
  updatingTaskId?: string | null;
  onReviewFollowup?: (kind: DailyBriefReviewState["kind"], id: string, decision: DailyBriefReviewDecision) => void;
  updatingReviewId?: string | null;
}) {
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[480px]">
        <SheetTitle className="sr-only">Brief detail</SheetTitle>
        <SheetDescription className="sr-only">Context and actions for the selected brief item.</SheetDescription>
        {item ? (
          item.sectionKey === "meetings" ? (
            <MeetingDrawerBody item={item} timezone={timezone} onOpenChat={onOpenChat} />
          ) : (
            <DrawerBody
              item={item}
              onOpenChat={onOpenChat}
              onUpdateTaskStatus={onUpdateTaskStatus}
              updatingTaskId={updatingTaskId}
              onReviewFollowup={onReviewFollowup}
              updatingReviewId={updatingReviewId}
            />
          )
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({
  item,
  onOpenChat,
  onUpdateTaskStatus,
  updatingTaskId,
  onReviewFollowup,
  updatingReviewId,
}: {
  item: DailyBriefItem;
  onOpenChat: (prompt: string) => void;
  onUpdateTaskStatus?: (taskId: string, status: TaskStatus) => void;
  updatingTaskId?: string | null;
  onReviewFollowup?: (kind: DailyBriefReviewState["kind"], id: string, decision: DailyBriefReviewDecision) => void;
  updatingReviewId?: string | null;
}) {
  const meta = labelMeta(item);
  const chips = refChips(item);
  const actionLabel = item.actionLabel ?? "Ask Sketch";
  const task = getBriefItemTask(item);
  const isFollowupSection = item.sectionKey === "untracked_followups" || item.sectionKey === "looks_resolved";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-6 pb-8 pt-12">
        <header>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {meta.eyebrow} {"\u00b7"} {meta.label}
          </p>
          <h2 className="mt-2 text-[18px] font-semibold leading-snug text-foreground">{drawerTitle(item)}</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {drawerSubtitle(item)}
            {!task ? (
              <>
                {" "}
                {"\u00b7"} {priorityLabel(item.priority)}
              </>
            ) : null}
          </p>
        </header>

        <div className="mt-5 space-y-5">
          <BriefContextBlock item={item} />

          {task ? (
            <CurrentTaskSection
              task={task}
              snapshotTitle={item.title}
              onUpdateTaskStatus={onUpdateTaskStatus}
              updating={updatingTaskId === task.id}
            />
          ) : null}

          {chips.length > 0 ? (
            <div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Evidence</p>
              <div className="flex flex-wrap gap-1.5">
                {chips.map((chip) => (
                  <span
                    key={chip}
                    className="rounded-full border-[0.5px] border-border bg-muted/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.04em] text-muted-foreground"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {isFollowupSection && (item.review || item.actionPrompt || item.sourceUrl) ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 px-6 py-4">
          {item.sourceUrl ? (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="mr-auto inline-flex items-center gap-1.5 rounded-full border-[0.5px] border-border bg-transparent px-3 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-muted/50 hover:text-foreground"
            >
              <ArrowSquareOutIcon size={13} weight="bold" aria-hidden />
              {sourceLinkLabel(item.sourceUrl)}
            </a>
          ) : null}
          <BriefFollowupActionRail
            review={item.review}
            updating={updatingReviewId === item.review?.id}
            onReview={onReviewFollowup}
            chatLabel={actionLabel}
            onOpenChat={item.actionPrompt ? () => onOpenChat(item.actionPrompt as string) : undefined}
          />
        </div>
      ) : item.review || item.actionPrompt || item.sourceUrl ? (
        <div className="flex flex-col items-start gap-2 border-t border-border/60 px-6 py-4">
          {item.actionPrompt || item.sourceUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              {item.actionPrompt ? (
                <BriefActionButton
                  label={actionLabel}
                  stopPropagation={false}
                  onClick={() => onOpenChat(item.actionPrompt as string)}
                />
              ) : null}
              {item.sourceUrl ? (
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border-[0.5px] border-border bg-transparent px-3 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-muted/50 hover:text-foreground"
                >
                  <ArrowSquareOutIcon size={13} weight="bold" aria-hidden />
                  {sourceLinkLabel(item.sourceUrl)}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MeetingDrawerBody({
  item,
  timezone,
  onOpenChat,
}: {
  item: DailyBriefItem;
  timezone: string;
  onOpenChat: (prompt: string) => void;
}) {
  const payload = item.structuredPayload;
  const attendees = payload?.attendees ?? [];
  const time = payload?.startTime ? formatMeetingTime(payload.startTime, timezone) : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-6 pb-8 pt-12">
        <header>
          <span className="font-mono text-[13px] font-medium tabular-nums text-foreground">{time}</span>
          <h2 className="mt-2 text-[18px] font-semibold leading-snug text-foreground">{item.title}</h2>
          {payload?.via ? <p className="mt-1 text-[12px] text-muted-foreground">{payload.via}</p> : null}
        </header>

        <div className="mt-5 space-y-5">
          {attendees.length > 0 ? (
            <div>
              <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Attendees</p>
              <ul className="flex flex-col gap-3.5">
                {attendees.map((attendee) => (
                  <AttendeeRow key={`${attendee.name}-${attendee.entityId ?? ""}`} attendee={attendee} />
                ))}
              </ul>
            </div>
          ) : null}

          <BriefContextBlock item={item} />

          <MeetingTimelines attendees={attendees} />
        </div>
      </div>

      {item.actionPrompt || item.sourceUrl ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-6 py-4">
          {item.actionPrompt ? (
            <BriefActionButton
              label={item.actionLabel ?? "Prep with Sketch"}
              stopPropagation={false}
              onClick={() => onOpenChat(item.actionPrompt as string)}
            />
          ) : null}
          {item.sourceUrl ? (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border-[0.5px] border-border bg-transparent px-3 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-muted/50 hover:text-foreground"
            >
              <ArrowSquareOutIcon size={13} weight="bold" aria-hidden />
              {sourceLinkLabel(item.sourceUrl)}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatCompactRelative(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diff = Date.now() - then;
  const absDays = Math.floor(Math.abs(diff) / 86_400_000);
  if (absDays <= 0) return "today";
  const label = absDays === 1 ? "1d ago" : `${absDays}d ago`;
  return diff < 0 ? `in ${absDays === 1 ? "1d" : `${absDays}d`}` : label;
}

function formatCompactDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTaskPriority(priority: string | null): string | null {
  if (!priority?.trim()) return null;
  const normalized = priority.trim().toLowerCase();
  if (normalized.endsWith(" priority")) {
    return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
  }
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} priority`;
}

/**
 * Compact "Current task" section for non-meeting brief items that carry a live
 * task overlay. Shows the live status (editable Select when canEditStatus, a
 * passive pill otherwise), the current task title only when it diverges from
 * the snapshot title, priority, and useful updated/completed metadata. Snapshot
 * fields (title/summary) are always preserved above this section.
 */
function CurrentTaskSection({
  task,
  snapshotTitle,
  onUpdateTaskStatus,
  updating,
}: {
  task: DailyBriefTaskState;
  snapshotTitle: string;
  onUpdateTaskStatus?: (taskId: string, status: TaskStatus) => void;
  updating: boolean;
}) {
  const tone = briefTaskStatusTone(task.status);
  const showChangedTitle = task.title && task.title !== snapshotTitle;
  const externalStatus = briefTaskExternalStatus(task);
  const reason = briefTaskReadonlyReason(task);
  const updatedRelative = formatCompactRelative(task.updatedAt);
  const completedDate = task.completedAt ? formatCompactDate(task.completedAt) : null;
  const canEdit = task.canEditStatus && onUpdateTaskStatus;
  const priority = formatTaskPriority(task.priority);
  const metadata = updatedRelative || completedDate ? buildTaskMetadataLine(completedDate, updatedRelative) : null;
  const headingId = `brief-current-task-${task.id}`;

  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-lg border-[0.5px] border-border/70 bg-background/40"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/50 bg-muted/20 px-4 py-3">
        <h3 id={headingId} className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          Current task
        </h3>
        {priority ? (
          <span className="rounded-full border-[0.5px] border-border/70 bg-background/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            {priority}
          </span>
        ) : null}
      </div>

      <div className="px-4 py-3">
        {showChangedTitle ? (
          <p className="mb-3 text-[13px] font-medium leading-snug text-foreground">{task.title}</p>
        ) : null}

        <div className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-3">
          <p className="text-[11px] font-medium text-muted-foreground">Status</p>
          {canEdit ? (
            <Select
              value={task.status}
              onValueChange={(value) => onUpdateTaskStatus?.(task.id, value as TaskStatus)}
              disabled={updating}
            >
              <SelectTrigger aria-label={`${task.title} status`} className="h-9 w-full text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BRIEF_TASK_STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Badge variant="outline" className={cn("max-w-full px-2.5 py-1.5 text-[11px]", tone.text)}>
              <span className={cn("mr-1 inline-block size-1.5 rounded-full", tone.dot)} aria-hidden />
              {formatBriefTaskStatus(task.status)}
            </Badge>
          )}
        </div>

        {externalStatus ? (
          <p className="mt-2 pl-[64px] text-[11px] text-muted-foreground">Source status: {externalStatus}</p>
        ) : null}

        {reason ? <p className="mt-2 pl-[64px] text-[11px] leading-relaxed text-muted-foreground">{reason}</p> : null}
      </div>

      {metadata ? (
        <div className="flex items-center gap-1.5 border-t border-border/50 bg-muted/10 px-4 py-2.5 text-[11px] text-muted-foreground">
          <ClockIcon size={13} weight="regular" aria-hidden />
          <span className="tabular-nums">{metadata}</span>
        </div>
      ) : null}
    </section>
  );
}

function buildTaskMetadataLine(completedDate: string | null, updatedRelative: string | null): string {
  const parts: string[] = [];
  if (completedDate) parts.push(`Completed ${completedDate}`);
  if (updatedRelative) parts.push(updatedDateLabel(updatedRelative, completedDate));
  return parts.join(" \u00b7 ");
}

function updatedDateLabel(updatedRelative: string, completedDate: string | null): string {
  return completedDate ? `updated ${updatedRelative}` : `Updated ${updatedRelative}`;
}

function AttendeeRow({ attendee }: { attendee: DailyBriefMeetingAttendee }) {
  const initials = attendee.name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <li className="flex gap-3">
      <div
        className={`mt-[1px] flex size-[28px] shrink-0 items-center justify-center rounded-full text-[10px] font-medium ${
          attendee.emphasis
            ? "bg-amber-400 text-amber-950"
            : "border-[0.5px] border-border bg-muted text-muted-foreground dark:bg-muted/50"
        }`}
        aria-hidden
      >
        {initials}
      </div>
      <div className="min-w-0">
        <p className="text-[13px] leading-tight text-foreground">
          <span className="font-medium">{attendee.name}</span>
          {attendee.role ? <span className="text-muted-foreground"> — {attendee.role}</span> : null}
        </p>
        {attendee.note ? (
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{attendee.note}</p>
        ) : null}
      </div>
    </li>
  );
}

/** Timeline chips for attendees resolved to a graph entity; opens their drawer. */
function MeetingTimelines({ attendees }: { attendees: DailyBriefMeetingAttendee[] }) {
  const entityUi = useEntityUiOptional();
  const resolved = attendees.filter((attendee) => attendee.entityId);
  if (!entityUi || resolved.length === 0) return null;

  return (
    <div>
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Timelines</p>
      <div className="flex flex-wrap gap-1.5">
        {resolved.map((attendee) => (
          <EntityChip
            key={attendee.entityId as string}
            entity={{ id: attendee.entityId as string, name: attendee.name, sourceType: "person" }}
            compact
            onClick={() => entityUi.openEntity(attendee.entityId as string)}
          />
        ))}
      </div>
    </div>
  );
}
