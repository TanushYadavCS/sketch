import type { DailyBriefReviewDecision, DailyBriefReviewState } from "@/lib/api";
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
  if (updating) {
    return (
      <output aria-live="polite" className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
        Updating…
      </output>
    );
  }
  const terminal = terminalLabel(review);
  if (terminal) {
    return <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{terminal}</span>;
  }
  if (!review.canReview || !onReview) return null;
  const actions: Array<{ label: string; decision: DailyBriefReviewDecision }> =
    review.kind === "completion"
      ? [
          { label: "Mark done", decision: "confirm_done" },
          { label: "Keep open", decision: "keep_open" },
        ]
      : [
          { label: "Track", decision: "track" },
          { label: "Dismiss", decision: "dismiss" },
        ];
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {actions.map((action) => (
        <button
          key={action.decision}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onReview(review.kind, review.id, action.decision);
          }}
          className={cn(
            "inline-flex shrink-0 items-center rounded-full border-[0.5px] border-border px-2.5 py-1",
            "text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
          )}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
