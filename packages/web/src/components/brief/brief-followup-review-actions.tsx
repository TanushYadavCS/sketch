import type { DailyBriefReviewDecision, DailyBriefReviewState } from "@/lib/api";
import { CheckIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { cn } from "@sketch/ui/lib/utils";

function terminalLabel(review: DailyBriefReviewState): string | null {
  if (review.kind === "completion") {
    if (review.state === "accepted") return "Marked done";
    if (review.state === "rejected") return "Kept open";
    if (review.state === "expired") return "Review expired";
    return null;
  }
  if (review.state === "accepted") return "Tracked";
  if (review.state === "dismissed") return "Dismissed";
  return null;
}

export function BriefFollowupReviewActions({
  review,
  updating,
  onReview,
}: {
  review: DailyBriefReviewState | null | undefined;
  updating: boolean;
  onReview?: (kind: DailyBriefReviewState["kind"], id: string, decision: DailyBriefReviewDecision) => void;
}) {
  if (!review) return null;
  const terminal = terminalLabel(review);
  if (terminal) {
    return <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{terminal}</span>;
  }
  if (!review.canReview || !onReview) return null;
  const groupLabel = review.kind === "completion" ? "Completion review decision" : "Follow-up tracking decision";
  const actions: Array<{
    label: string;
    decision: DailyBriefReviewDecision;
    Icon: typeof CheckIcon;
    tone: "accept" | "reject";
  }> =
    review.kind === "completion"
      ? [
          { label: "Mark as done", decision: "confirm_done", Icon: CheckIcon, tone: "accept" },
          { label: "Keep open", decision: "keep_open", Icon: XIcon, tone: "reject" },
        ]
      : [
          { label: "Track", decision: "track", Icon: CheckIcon, tone: "accept" },
          { label: "Dismiss", decision: "dismiss", Icon: XIcon, tone: "reject" },
        ];
  return (
    <fieldset aria-label={groupLabel} aria-busy={updating} className="flex w-max max-w-full flex-col items-end gap-1">
      <div className="inline-flex flex-nowrap items-center justify-end gap-1.5">
        {actions.map((action) => (
          <Button
            key={action.decision}
            type="button"
            variant="ghost"
            size="xs"
            disabled={updating}
            onClick={(event) => {
              event.stopPropagation();
              onReview(review.kind, review.id, action.decision);
            }}
            className={cn(
              "h-7 min-w-0 rounded-full border-[0.5px] px-3 text-[11px] shadow-none focus-visible:ring-inset",
              action.tone === "accept"
                ? "border-emerald-500/15 bg-emerald-500/8 text-emerald-700/80 hover:bg-emerald-500/12 hover:text-emerald-800 dark:border-emerald-400/15 dark:bg-emerald-400/8 dark:text-emerald-400/75 dark:hover:bg-emerald-400/12 dark:hover:text-emerald-300"
                : "border-red-500/15 bg-red-500/8 text-red-700/80 hover:bg-red-500/12 hover:text-red-800 dark:border-red-400/15 dark:bg-red-400/8 dark:text-red-400/75 dark:hover:bg-red-400/12 dark:hover:text-red-300",
            )}
          >
            <action.Icon size={12} weight="bold" aria-hidden />
            {action.label}
          </Button>
        ))}
      </div>
      {updating ? (
        <output aria-live="polite" className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
          Updating…
        </output>
      ) : null}
    </fieldset>
  );
}
