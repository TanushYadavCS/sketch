/**
 * /review-entities — ECR-03 review surface.
 *
 * Lists pending entity-review queue rows for the signed-in user. Each row
 * collapses to a one-line summary; expanding fetches detail (which also
 * marks `review_started_at` server-side). Resolve UI ships as a shared
 * `<ReviewActions>` component (see components/review-actions.tsx) so the
 * same affordances can render inline on the entities tab in ECR-03B.
 */
import { LIST_KEY, ReviewActions, detailKey } from "@/components/review-actions";
import { ApiRequestError, type EntityReviewQueueRow, api } from "@/lib/api";
import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { dashboardRoute } from "../dashboard";

export const reviewEntitiesRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/review-entities",
  component: ReviewEntitiesPage,
});

function ReviewEntitiesPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: LIST_KEY,
    queryFn: () => api.entityReview.list({ limit: 20 }),
  });

  return (
    <TabContentContainer>
      <div className="flex flex-col gap-4 px-6 py-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Review entities</h1>
          <p className="text-sm text-muted-foreground">
            Names proposed by syncs that fuzzy-collide with existing entities. Confirm to merge, reject to create a
            new entity, or pick a different existing entity.
          </p>
        </header>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : isError ? (
          <ListError error={error} />
        ) : !data || data.rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">Nothing pending. New rows appear here as syncs run.</div>
        ) : (
          <div className="flex flex-col gap-3">
            {data.rows.map((row) => (
              <ReviewRow key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>
    </TabContentContainer>
  );
}

function ListError({ error }: { error: unknown }) {
  if (error instanceof ApiRequestError && error.status === 404) {
    return (
      <div className="text-sm text-muted-foreground">
        Review entities is an experimental feature; it is not enabled on this workspace.
      </div>
    );
  }
  return (
    <div className="text-sm text-destructive">
      Could not load the review queue. Try refreshing in a moment.
    </div>
  );
}

function ReviewRow({ row }: { row: EntityReviewQueueRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border bg-card p-4">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={() => setExpanded((s) => !s)}
        aria-expanded={expanded}
        data-testid={`review-row-${row.id}`}
      >
        <div className="flex min-w-0 flex-col">
          <span className="font-medium truncate">{row.proposed_name}</span>
          <span className="text-xs text-muted-foreground">
            {row.evidenceCount} evidence row{row.evidenceCount === 1 ? "" : "s"}
            {row.sourceBreakdown.length > 0
              ? ` · ${row.sourceBreakdown.length} source${row.sourceBreakdown.length === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">{expanded ? "Hide" : "Review"}</span>
      </button>
      {expanded ? <ReviewRowDetail rowId={row.id} /> : null}
    </div>
  );
}

function ReviewRowDetail({ rowId }: { rowId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: detailKey(rowId),
    queryFn: () => api.entityReview.get(rowId),
  });

  if (isLoading) return <div className="mt-3 text-sm text-muted-foreground">Loading…</div>;
  if (isError || !data) return <div className="mt-3 text-sm text-destructive">Could not load detail.</div>;

  return <ReviewActions row={data.row} />;
}
