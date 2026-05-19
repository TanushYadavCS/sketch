/**
 * <ReviewBanner> — top-of-tab summary of pending entity-review queue rows
 * on the Files → Entities tab.
 *
 * Surfaces two buckets that have no entity row to "live under":
 * - Multi-candidate orphans (candidate_entity_id = NULL)
 * - Off-page rows (candidate_entity_id set, but the entity isn't on the
 *   currently visible/paginated entity list)
 *
 * Candidate-keyed rows whose entity *is* visible render their chip + inline
 * <ReviewActions> beside the entity row in the host (entity-explorer); they
 * appear here only when the entity scrolls off-screen via filters/paging.
 */
import { ReviewActions } from "@/components/review-actions";
import type { EntityReviewQueueRow } from "@/lib/api";
import { Button } from "@sketch/ui/components/button";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useState } from "react";

export interface ReviewBannerProps {
  total: number;
  multiCandidateRows: EntityReviewQueueRow[];
  offPageRows: EntityReviewQueueRow[];
}

export function ReviewBanner({ total, multiCandidateRows, offPageRows }: ReviewBannerProps) {
  const [expanded, setExpanded] = useState(true);

  if (total === 0) return null;

  const multiCount = multiCandidateRows.length;
  const offPageCount = offPageRows.length;

  return (
    <div
      className="mt-3 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30"
      data-testid="review-banner"
    >
      <button
        type="button"
        onClick={() => setExpanded((s) => !s)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
        aria-expanded={expanded}
        data-testid="review-banner-toggle"
      >
        <div className="flex items-center gap-2 text-sm">
          {expanded ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
          <span className="font-medium">
            {total} proposal{total === 1 ? "" : "s"} waiting
          </span>
          {multiCount > 0 ? (
            <span className="text-xs text-muted-foreground">
              · {multiCount} multi-candidate
            </span>
          ) : null}
          {offPageCount > 0 ? (
            <span className="text-xs text-muted-foreground">· {offPageCount} off-page</span>
          ) : null}
        </div>
      </button>
      {expanded ? (
        <div className="border-t border-amber-200 dark:border-amber-800/50">
          {multiCount > 0 ? (
            <ProposalSection
              title="Multi-candidate"
              description="No suggested match — pick an existing entity or create a new one."
              rows={multiCandidateRows}
            />
          ) : null}
          {offPageCount > 0 ? (
            <ProposalSection
              title="Off-page"
              description="Pending proposals whose candidate entity isn't in the current list view."
              rows={offPageRows}
            />
          ) : null}
          {multiCount === 0 && offPageCount === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              All pending proposals have visible entities below — review them inline.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ProposalSection({
  title,
  description,
  rows,
}: {
  title: string;
  description: string;
  rows: EntityReviewQueueRow[];
}) {
  return (
    <div className="border-b border-amber-200 px-3 py-2 last:border-b-0 dark:border-amber-800/50">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title} · {rows.length}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      <div className="mt-2 flex flex-col gap-2">
        {rows.map((row) => (
          <BannerProposalRow key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
}

function BannerProposalRow({ row }: { row: EntityReviewQueueRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border bg-card p-3">
      <button
        type="button"
        onClick={() => setExpanded((s) => !s)}
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={expanded}
        data-testid={`banner-row-${row.id}`}
      >
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{row.proposed_name}</span>
          <span className="text-[11px] text-muted-foreground">
            {row.evidenceCount} evidence row{row.evidenceCount === 1 ? "" : "s"}
            {row.sourceBreakdown.length > 0
              ? ` · ${row.sourceBreakdown.length} source${row.sourceBreakdown.length === 1 ? "" : "s"}`
              : ""}
            {row.candidate?.name ? ` · suggests ${row.candidate.name}` : ""}
          </span>
        </div>
        <Button variant="ghost" size="sm" className="h-6 text-[11px]">
          {expanded ? "Hide" : "Review"}
        </Button>
      </button>
      {expanded ? <ReviewActions row={row} /> : null}
    </div>
  );
}
