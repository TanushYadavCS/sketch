import type { DailyBriefReviewDecision, DailyBriefReviewState } from "@/lib/api";
import { BriefActionButton } from "./brief-action-button";
import { BriefFollowupReviewActions, briefFollowupTerminalLabel } from "./brief-followup-review-actions";

function hasVisibleReview(
  review: DailyBriefReviewState | null | undefined,
  onReview?: (kind: DailyBriefReviewState["kind"], id: string, decision: DailyBriefReviewDecision) => void,
): boolean {
  if (!review) return false;
  return briefFollowupTerminalLabel(review) !== null || Boolean(review.canReview && onReview);
}

export function BriefFollowupActionRail({
  review,
  updating,
  onReview,
  chatLabel,
  onOpenChat,
}: {
  review: DailyBriefReviewState | null | undefined;
  updating: boolean;
  onReview?: (kind: DailyBriefReviewState["kind"], id: string, decision: DailyBriefReviewDecision) => void;
  chatLabel: string;
  onOpenChat?: () => void;
}) {
  const showReview = hasVisibleReview(review, onReview);

  if (!showReview && !onOpenChat) return null;

  return (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-1">
      {showReview ? <BriefFollowupReviewActions review={review} updating={updating} onReview={onReview} /> : null}
      {showReview && onOpenChat ? <span className="mx-0.5 h-4 w-px bg-border/80" aria-hidden /> : null}
      {onOpenChat ? <BriefActionButton label={chatLabel} onClick={onOpenChat} borderless /> : null}
    </div>
  );
}
