import type { DailyBriefReviewDecision, DailyBriefReviewState } from "@/lib/api";
import { CheckIcon, PlusIcon } from "@phosphor-icons/react";
import { Button } from "@sketch/ui/components/button";
import { cn } from "@sketch/ui/lib/utils";

export function briefFollowupTerminalLabel(review: DailyBriefReviewState): string | null {
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
  const terminal = briefFollowupTerminalLabel(review);
  if (terminal) {
    return <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{terminal}</span>;
  }
  if (!review.canReview || !onReview) return null;
  const groupLabel = review.kind === "completion" ? "Completion review decision" : "Follow-up tracking decision";
  const actions: Array<{
    label: string;
    decision: DailyBriefReviewDecision;
    Icon: typeof CheckIcon | null;
    tone: "primary" | "secondary";
  }> =
    review.kind === "completion"
      ? [
          { label: "Mark as done", decision: "confirm_done", Icon: CheckIcon, tone: "primary" },
          { label: "Keep open", decision: "keep_open", Icon: null, tone: "secondary" },
        ]
      : [
          { label: "Track", decision: "track", Icon: PlusIcon, tone: "primary" },
          { label: "Dismiss", decision: "dismiss", Icon: null, tone: "secondary" },
        ];
  return (
    <fieldset aria-label={groupLabel} aria-busy={updating} className="flex w-max max-w-full flex-col items-end gap-1">
      <div className="inline-flex flex-nowrap items-center justify-end gap-1">
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
              "h-7 min-w-0 rounded-md px-2 text-[11px] shadow-none focus-visible:ring-inset",
              action.tone === "primary"
                ? "border border-accent-foreground/25 bg-accent px-2.5 text-accent-foreground hover:bg-accent-foreground/15 hover:text-accent-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {action.Icon ? <action.Icon size={12} weight="bold" aria-hidden /> : null}
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
