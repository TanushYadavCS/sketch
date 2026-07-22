import type {
  DailyBriefItem,
  DailyBriefMeetingAttendee,
  DailyBriefReviewDecision,
  DailyBriefReviewState,
  DailyBriefTaskState,
  TaskStatus,
} from "@/lib/api";
import { EntityChip, useEntityUiOptional } from "@/lib/entity-ui";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
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
            {drawerSubtitle(item)} {"\u00b7"} {priorityLabel(item.priority)}
          </p>
        </header>

        <div className="mt-5 space-y-5">
          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Context</p>
            <p className="text-[13px] leading-relaxed text-muted-foreground">{item.summary}</p>
          </div>

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

          {item.summary ? (
            <div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Context</p>
              <p className="text-[13px] leading-relaxed text-muted-foreground">{item.summary}</p>
            </div>
          ) : null}

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

  return (
    <div className="rounded-md border-[0.5px] border-border/70 bg-muted/20 px-3 py-3">
      <p className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Current task</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {canEdit ? (
          <Select
            value={task.status}
            onValueChange={(value) => onUpdateTaskStatus?.(task.id, value as TaskStatus)}
            disabled={updating}
          >
            <SelectTrigger aria-label={`${task.title} status`} className="h-8 w-full text-xs sm:w-44">
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
          <Badge variant="outline" className={cn("max-w-full text-[10px]", tone.text)}>
            <span className={cn("mr-1 inline-block size-1.5 rounded-full", tone.dot)} aria-hidden />
            {formatBriefTaskStatus(task.status)}
          </Badge>
        )}
        {task.priority ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground/80">
            {task.priority}
          </span>
        ) : null}
      </div>

      {showChangedTitle ? <p className="mt-2 text-[13px] leading-snug text-foreground">{task.title}</p> : null}

      {externalStatus ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground/70">
          Source status: {externalStatus}
        </p>
      ) : null}

      {reason ? <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{reason}</p> : null}

      {updatedRelative || completedDate ? (
        <p className="mt-2 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {buildTaskMetadataLine(completedDate, updatedRelative)}
        </p>
      ) : null}
    </div>
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
