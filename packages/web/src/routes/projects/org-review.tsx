/**
 * Shared review UI for the Your Org surface. Both surfaces share the same
 * query, sheets, and mutation pipeline; only the row density differs. The
 * Review tab is the sit-down triage surface and keeps the full
 * {@link ReviewRowCard}; the capped per-tab band renders
 * {@link ReviewRowCompact} — a single line with quiet text actions, because
 * the band sits above a directory and must not read as a second queue.
 *
 * Row-body clicks open the existing reconcile sheet
 * ({@link ReviewDetailSheet}) for rows with a suggested match or the birth
 * inspect sheet ({@link BirthInspectSheet}) for rows without one — evidence,
 * match reason, and pick-a-different-existing all live there.
 */
import { BirthInspectSheet, ReviewDetailSheet } from "@/components/entity-review/review-band";
import { useReviewMutations } from "@/components/review-actions";
import type { EntityReviewQueueRow } from "@/lib/api";
import { api } from "@/lib/api";
import { EntityAvatar } from "@/lib/entity-ui";
import { CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@sketch/ui/lib/utils";
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

function CompactAction({
  label,
  emphasis,
  disabled,
  onClick,
}: {
  label: string;
  emphasis?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "px-1.5 py-0.5 text-[11px] disabled:opacity-40",
        emphasis
          ? "font-medium text-foreground hover:underline"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * One-line review row: name, muted suggested-match, quiet Confirm/Dismiss
 * text actions. Everything else (evidence detail, match reason, pick
 * existing) is one click away in the sheet. `detail` adds the candidate email
 * and a per-source evidence summary — the Review tab turns it on; the capped
 * bands stay tightest.
 */
export function ReviewRowCompact({
  row,
  onOpen,
  onResolved,
  detail,
}: {
  row: EntityReviewQueueRow;
  onOpen: (row: EntityReviewQueueRow) => void;
  onResolved: () => void;
  detail?: boolean;
}) {
  const mutations = useReviewMutations(row, onResolved);
  const hasCandidate = Boolean(row.candidate);
  const suggestion = hasCandidate
    ? `→ ${row.candidate?.name}${detail && row.candidate?.email ? ` · ${row.candidate.email}` : ""}`
    : "new — no suggested match";
  const evidence =
    detail && row.sourceBreakdown.length > 0
      ? row.sourceBreakdown.map((b) => `${b.count}× ${b.source}`).join(", ")
      : null;
  return (
    <div className="border-b border-border/60 last:border-b-0" data-testid={`org-review-row-${row.id}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(row)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onOpen(row);
        }}
        className="group flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left"
      >
        <EntityAvatar entity={{ id: row.id, name: row.proposed_name, sourceType: row.entity_type }} size="xs" />
        <span className="shrink-0 truncate text-[12.5px] font-medium">{row.proposed_name}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{suggestion}</span>
        {evidence ? (
          <span className="hidden shrink-0 text-[10.5px] text-muted-foreground/70 sm:inline">{evidence}</span>
        ) : null}
        <span className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <CompactAction
            label={hasCandidate ? "Confirm" : "Add"}
            emphasis
            disabled={mutations.isPending}
            onClick={() => mutations.confirm()}
          />
          <span className="text-muted-foreground/40">·</span>
          <CompactAction label="Dismiss" disabled={mutations.isPending} onClick={() => mutations.dismiss()} />
        </span>
        <CaretRightIcon
          size={12}
          aria-hidden
          className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground"
        />
      </div>
      {mutations.errorCopy ? (
        <p className="px-3 pb-1.5 text-[11px] text-destructive">{mutations.errorCopy.message}</p>
      ) : null}
    </div>
  );
}

/**
 * Type-scoped capped review band. Renders the top 3 pending rows for a tab
 * (same query, sheets, and mutations as the Review tab; compact rows) with a
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
        <ReviewRowCompact key={row.id} row={row} onOpen={openRow} onResolved={refresh} />
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
