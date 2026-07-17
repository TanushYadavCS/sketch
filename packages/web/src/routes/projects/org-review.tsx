/**
 * Shared review UI for the Your Org surface. One row component + one sheet
 * controller are reused by both the full Review tab and every entity tab's
 * capped "Needs your review" band, so the two surfaces can never drift.
 *
 * The row uses the existing {@link ReviewActions} bar verbatim for inline
 * confirm / pick / dismiss, and row-body clicks open the existing reconcile
 * sheet ({@link ReviewDetailSheet}) for rows with a suggested match or the
 * birth inspect sheet ({@link BirthInspectSheet}) for rows without one.
 */
import { humanSourceType } from "@/components/entity-review/entity-format";
import { BirthInspectSheet, ReviewDetailSheet } from "@/components/entity-review/review-band";
import { ReviewActions } from "@/components/review-actions";
import type { EntityReviewQueueRow } from "@/lib/api";
import { api } from "@/lib/api";
import { EntityAvatar } from "@/lib/entity-ui";
import { formatRelativeTime } from "@/routes/files/file-list";
import { CaretRightIcon } from "@phosphor-icons/react";
import { Badge } from "@sketch/ui/components/badge";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

/**
 * Manages the two review sheets (reconcile vs birth inspect) for a list of
 * rows and exposes an `openRow` that routes each row to the right one. Also
 * hands back a `refresh` that clears the whole `entity-review` query prefix
 * (bands + tabs live outside `LIST_KEY`, so the mutation hook's own
 * invalidation would miss them).
 */
export function useReviewRowSheets() {
  const queryClient = useQueryClient();
  const [reconcileId, setReconcileId] = useState<string | null>(null);
  const [birthId, setBirthId] = useState<string | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["entity-review"] });
    queryClient.invalidateQueries({ queryKey: ["entities"] });
  };

  const openRow = (row: EntityReviewQueueRow) => {
    if (row.candidate) setReconcileId(row.id);
    else setBirthId(row.id);
  };

  const sheets = (
    <>
      <ReviewDetailSheet reviewId={reconcileId} onClose={() => setReconcileId(null)} />
      <BirthInspectSheet reviewId={birthId} onResolved={refresh} onClose={() => setBirthId(null)} />
    </>
  );

  return { openRow, sheets, refresh };
}

export function ReviewRowCard({
  row,
  onOpen,
  onResolved,
}: {
  row: EntityReviewQueueRow;
  onOpen: (row: EntityReviewQueueRow) => void;
  onResolved: () => void;
}) {
  return (
    <div className="border-b border-border last:border-b-0" data-testid={`org-review-row-${row.id}`}>
      <button
        type="button"
        onClick={() => onOpen(row)}
        className="group flex w-full items-center gap-2.5 px-3 pt-2.5 text-left"
      >
        <EntityAvatar entity={{ id: row.id, name: row.proposed_name, sourceType: row.entity_type }} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{row.proposed_name}</span>
            <Badge variant="outline" className="text-[9px] uppercase tracking-wider">
              {humanSourceType(row.entity_type)}
            </Badge>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{formatRelativeTime(row.last_seen_at)}</p>
        </div>
        <CaretRightIcon
          size={13}
          aria-hidden
          className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground"
        />
      </button>
      <div className="px-3 pb-2 pl-[42px]">
        <ReviewActions row={row} onResolved={onResolved} />
      </div>
    </div>
  );
}

/**
 * Type-scoped capped review band. Renders the top 3 pending rows for a tab
 * (same query + row component as the Review tab, just capped) with a
 * "See all → Review" affordance. Renders nothing when the scoped queue is
 * empty. `null` when the tab has no reviews keeps the entity list flush to the
 * top.
 */
export function ReviewBandCapped({ types, onSeeAll }: { types: string[]; onSeeAll: () => void }) {
  const { data } = useQuery({
    queryKey: ["entity-review", "band-capped", types.join(",")],
    queryFn: () => api.entityReview.list({ limit: 200, types }),
    refetchInterval: 30000,
  });
  const rows = data?.rows ?? [];
  const total = data?.total ?? rows.length;
  const { openRow, sheets, refresh } = useReviewRowSheets();

  if (rows.length === 0) return null;

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-amber-300/60 bg-amber-50/40 dark:border-amber-700/50 dark:bg-amber-950/20">
      <div className="flex items-baseline justify-between border-b border-amber-300/50 px-3 py-2 dark:border-amber-700/40">
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-amber-700 dark:text-amber-400">
          Needs your review · {total}
        </span>
        <button
          type="button"
          onClick={onSeeAll}
          className="font-mono text-[10px] uppercase tracking-[0.08em] text-amber-700/80 hover:text-amber-800 dark:text-amber-400/80 dark:hover:text-amber-300"
        >
          See all → Review
        </button>
      </div>
      {rows.slice(0, 3).map((row) => (
        <ReviewRowCard key={row.id} row={row} onOpen={openRow} onResolved={refresh} />
      ))}
      {rows.length > 3 ? (
        <button
          type="button"
          onClick={onSeeAll}
          className="w-full border-t border-amber-300/40 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.08em] text-amber-700/70 hover:text-amber-800 dark:border-amber-700/30 dark:text-amber-400/70"
        >
          {total - 3} more in Review →
        </button>
      ) : null}
      {sheets}
    </section>
  );
}

/** Shared empty/teach frame for a review surface. */
export function ReviewEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border py-10 text-center text-[12.5px] text-muted-foreground">
      {children}
    </p>
  );
}
