import type { DailyBriefItem, DailyBriefReviewDecision, DailyBriefReviewState } from "@/lib/api";
import { cn } from "@sketch/ui/lib/utils";
import { BriefActionButton } from "./brief-action-button";
import { BriefFollowupActionRail } from "./brief-followup-action-rail";
import { actionLabelForItem, labelMeta } from "./item-metadata";
import { primaryTaskAttentionMeta, readTaskAttentionContext } from "./task-attention";
import { briefTaskExternalStatus, briefTaskStatusTone, formatBriefTaskStatus, getBriefItemTask } from "./task-overlay";

export function BriefItemRow({
  item,
  isLast,
  onOpenDetail,
  onOpenChat,
  onReviewFollowup,
  updatingReviewId,
}: {
  item: DailyBriefItem;
  isLast: boolean;
  onOpenDetail: () => void;
  onOpenChat: (prompt: string) => void;
  onReviewFollowup?: (kind: DailyBriefReviewState["kind"], id: string, decision: DailyBriefReviewDecision) => void;
  updatingReviewId?: string | null;
}) {
  const meta = labelMeta(item);
  const actionLabel = actionLabelForItem(item);
  const hasLabelColumn = item.sectionKey !== "active_projects";
  const task = getBriefItemTask(item);
  const liveLabel = task ? formatBriefTaskStatus(task.status) : null;
  const tone = task ? briefTaskStatusTone(task.status) : null;
  const externalStatus = task ? briefTaskExternalStatus(task) : null;
  const attention = primaryTaskAttentionMeta(readTaskAttentionContext(item));
  const isFollowupSection = item.sectionKey === "untracked_followups" || item.sectionKey === "looks_resolved";

  return (
    <article
      className={cn(
        "grid grid-cols-[minmax(0,1fr)] items-center gap-x-3",
        isFollowupSection
          ? "sm:grid-cols-[minmax(0,1fr)_auto]"
          : item.actionPrompt
            ? "sm:grid-cols-[minmax(0,1fr)_168px]"
            : null,
        !isLast && "border-b border-border/50",
      )}
    >
      <button
        type="button"
        onClick={onOpenDetail}
        className={cn(
          "group grid min-w-0 cursor-pointer items-center gap-x-3 py-2.5 text-left outline-none transition-colors",
          "hover:bg-muted/25 focus-visible:bg-muted/25",
          item.sectionKey === "todos" && "grid-cols-[88px_minmax(0,1fr)] sm:grid-cols-[88px_minmax(0,1fr)_224px]",
          item.sectionKey === "customer_updates" &&
            "grid-cols-[18px_minmax(0,1fr)] sm:grid-cols-[18px_minmax(0,1fr)_112px]",
          item.sectionKey === "active_projects" && "grid-cols-[minmax(0,1fr)]",
        )}
      >
        {item.sectionKey === "todos" ? (
          <span className="shrink-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">
            {item.displayRef ?? "KG"}
          </span>
        ) : item.sectionKey === "customer_updates" ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} aria-hidden />
        ) : null}

        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium leading-snug text-foreground">{item.title}</span>
          {liveLabel ? (
            attention ? (
              <span
                aria-label="Task status and attention"
                className="mt-0.5 grid min-w-0 grid-cols-[auto_1px_minmax(0,1fr)] items-center gap-x-2 font-mono text-[9.5px] uppercase tracking-[0.06em] sm:hidden"
              >
                <span className={cn("whitespace-nowrap truncate", tone?.text)}>
                  {liveLabel}
                  {externalStatus ? <span className="ml-1 normal-case tracking-normal">· {externalStatus}</span> : null}
                </span>
                <span className="h-3 w-px bg-border" aria-hidden />
                <span className={cn("flex min-w-0 items-center gap-1.5", attention.text)}>
                  <span className={cn("size-1.5 shrink-0 rounded-full", attention.dot)} aria-hidden />
                  <span className="whitespace-nowrap truncate">{attention.label}</span>
                </span>
              </span>
            ) : (
              <span
                className={cn(
                  "mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.06em] sm:hidden",
                  tone?.text,
                )}
              >
                <span className={cn("size-1.5 shrink-0 rounded-full", tone?.dot)} aria-hidden />
                <span className="truncate">
                  {liveLabel}
                  {externalStatus ? <span className="ml-1 normal-case tracking-normal">· {externalStatus}</span> : null}
                </span>
              </span>
            )
          ) : null}
        </span>

        {hasLabelColumn ? (
          <span className="hidden w-[224px] min-w-0 pl-3 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground/80 sm:flex">
            {liveLabel && attention ? (
              <span
                aria-label="Task status and attention"
                className="grid w-full grid-cols-[88px_1px_minmax(0,1fr)] items-center gap-x-2"
              >
                <span className={cn("whitespace-nowrap truncate text-right", tone?.text)}>
                  {liveLabel}
                  {externalStatus ? <span className="ml-1 normal-case tracking-normal">· {externalStatus}</span> : null}
                </span>
                <span className="h-4 w-px bg-border" aria-hidden />
                <span className={cn("flex min-w-0 items-center gap-1.5", attention.text)}>
                  <span className={cn("size-1.5 shrink-0 rounded-full", attention.dot)} aria-hidden />
                  <span className="whitespace-nowrap truncate">{attention.label}</span>
                </span>
              </span>
            ) : liveLabel ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn("size-1.5 shrink-0 rounded-full", tone?.dot)} aria-hidden />
                <span className={cn("truncate", tone?.text)}>
                  {liveLabel}
                  {externalStatus ? <span className="ml-1 normal-case tracking-normal">· {externalStatus}</span> : null}
                </span>
              </span>
            ) : item.sectionKey === "todos" ? (
              <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} aria-hidden />
            ) : null}
            {!liveLabel ? <span className="truncate">{meta.label}</span> : null}
          </span>
        ) : null}
      </button>

      {isFollowupSection ? (
        <div className="flex min-w-0 shrink-0 items-center justify-start pb-2.5 sm:justify-end sm:py-2.5">
          <BriefFollowupActionRail
            review={item.review}
            updating={updatingReviewId === item.review?.id}
            onReview={onReviewFollowup}
            chatLabel={actionLabel}
            onOpenChat={item.actionPrompt ? () => onOpenChat(item.actionPrompt as string) : undefined}
          />
        </div>
      ) : item.actionPrompt ? (
        <div className="flex min-w-0 shrink-0 items-center justify-end py-2.5">
          <BriefActionButton label={actionLabel} onClick={() => onOpenChat(item.actionPrompt as string)} />
        </div>
      ) : null}
    </article>
  );
}
