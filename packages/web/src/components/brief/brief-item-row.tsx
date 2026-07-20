import type { DailyBriefItem } from "@/lib/api";
import { cn } from "@sketch/ui/lib/utils";
import { BriefActionButton } from "./brief-action-button";
import { actionLabelForItem, labelMeta } from "./item-metadata";
import { briefTaskExternalStatus, briefTaskStatusTone, formatBriefTaskStatus, getBriefItemTask } from "./task-overlay";

export function BriefItemRow({
  item,
  isLast,
  onOpenDetail,
  onOpenChat,
}: {
  item: DailyBriefItem;
  isLast: boolean;
  onOpenDetail: () => void;
  onOpenChat: (prompt: string) => void;
}) {
  const meta = labelMeta(item);
  const actionLabel = actionLabelForItem(item);
  const hasLabelColumn = item.sectionKey !== "active_projects";
  const task = getBriefItemTask(item);
  const liveLabel = task ? formatBriefTaskStatus(task.status) : null;
  const tone = task ? briefTaskStatusTone(task.status) : null;
  const externalStatus = task ? briefTaskExternalStatus(task) : null;

  return (
    <article
      className={cn(
        "grid grid-cols-[minmax(0,1fr)] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_168px]",
        !isLast && "border-b border-border/50",
      )}
    >
      <button
        type="button"
        onClick={onOpenDetail}
        className={cn(
          "group grid min-w-0 cursor-pointer items-center gap-x-3 py-2.5 text-left outline-none transition-colors",
          "hover:bg-muted/25 focus-visible:bg-muted/25",
          item.sectionKey === "todos" && "grid-cols-[88px_minmax(0,1fr)] sm:grid-cols-[88px_minmax(0,1fr)_112px]",
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
          ) : null}
        </span>

        {hasLabelColumn ? (
          <span className="hidden w-[112px] min-w-0 items-center gap-1.5 pl-3 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground/80 sm:flex">
            {liveLabel ? (
              <>
                <span className={cn("size-1.5 shrink-0 rounded-full", tone?.dot)} aria-hidden />
                <span className={cn("truncate", tone?.text)}>
                  {liveLabel}
                  {externalStatus ? <span className="ml-1 normal-case tracking-normal">· {externalStatus}</span> : null}
                </span>
              </>
            ) : item.sectionKey === "todos" ? (
              <span className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} aria-hidden />
            ) : null}
            {!liveLabel ? <span className="truncate">{meta.label}</span> : null}
          </span>
        ) : null}
      </button>

      <div className="flex min-w-0 shrink-0 items-center justify-end py-2.5">
        {item.actionPrompt ? (
          <BriefActionButton label={actionLabel} onClick={() => onOpenChat(item.actionPrompt as string)} />
        ) : null}
      </div>
    </article>
  );
}
