/**
 * /review-entities — ECR-03 review surface.
 *
 * Lists pending entity-review queue rows for the signed-in user. Each row
 * collapses to a one-line summary; expanding fetches detail (which also
 * marks `review_started_at` server-side). Actions: Confirm, Reject
 * (= create new), Pick a different existing.
 *
 * Optimistic mutation pattern: snapshot list state in onMutate, restore in
 * onError, invalidate list + count on success. Refresh-able 409s
 * (CANDIDATE_DRIFT / CANDIDATE_MISSING / TARGET_DELETED) invalidate the
 * detail query so the next render shows the new candidate. 422 conditions
 * (EVIDENCE_TOO_LARGE / TYPE_MISMATCH) surface sticky admin messages.
 */
import { EntityPicker } from "@/components/entity-picker";
import {
  ApiRequestError,
  type EntityReviewListResponse,
  type EntityReviewQueueRow,
  api,
  isEntityReviewErrorCode,
} from "@/lib/api";
import { Button } from "@sketch/ui/components/button";
import { TabContentContainer } from "@sketch/ui/components/tab-content-container";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { useState } from "react";
import { dashboardRoute } from "../dashboard";

export const reviewEntitiesRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "/review-entities",
  component: ReviewEntitiesPage,
});

const LIST_KEY = ["entity-review", "list"] as const;
const COUNT_KEY = ["entity-review", "count"] as const;
const detailKey = (id: string) => ["entity-review", "detail", id] as const;

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

interface ResolveCopy {
  variant: "refresh" | "admin" | "sticky-admin" | "generic";
  message: string;
}

function copyForError(err: unknown): ResolveCopy {
  if (err instanceof ApiRequestError && isEntityReviewErrorCode(err.code)) {
    switch (err.code) {
      case "CANDIDATE_DRIFT":
      case "CANDIDATE_MISSING":
      case "TARGET_DELETED":
        return {
          variant: "refresh",
          message: "The suggestion changed since you opened this row. Refresh to see the current candidate.",
        };
      case "MULTIPLE_STALE_CANDIDATES":
      case "MULTIPLE_RE_RESOLVE_MATCHES":
        return {
          variant: "admin",
          message:
            "Duplicate entities found in the workspace. An admin needs to clean these up before this row can resolve.",
        };
      case "ALREADY_CONFIRMING":
        return {
          variant: "refresh",
          message: "This row is already being processed. Refresh in a moment.",
        };
      case "EVIDENCE_TOO_LARGE":
        return {
          variant: "sticky-admin",
          message:
            "This row has more than 1000 evidence files and needs admin attention. Please contact an admin to resolve it via SQL.",
        };
      case "TYPE_MISMATCH":
        return {
          variant: "sticky-admin",
          message: "You picked an entity of a different type. Pick the same entity type instead.",
        };
      case "ROW_NOT_FOUND":
        return { variant: "refresh", message: "This row no longer exists. Refresh the list." };
      case "OWNER_SCOPE_DENIED":
        return { variant: "sticky-admin", message: "You don't have access to this row." };
    }
  }
  return { variant: "generic", message: "Something went wrong. Try again." };
}

function ReviewActions({ row }: { row: EntityReviewQueueRow }) {
  const [showPicker, setShowPicker] = useState(false);
  const queryClient = useQueryClient();
  const [errorCopy, setErrorCopy] = useState<ResolveCopy | null>(null);

  const candidateGeneratedAt = row.candidate_generated_at ?? "";

  const onSuccess = () => {
    setErrorCopy(null);
    queryClient.invalidateQueries({ queryKey: LIST_KEY });
    queryClient.invalidateQueries({ queryKey: COUNT_KEY });
  };

  const buildOnMutate = () => async () => {
    await queryClient.cancelQueries({ queryKey: LIST_KEY });
    const prev = queryClient.getQueryData<EntityReviewListResponse>(LIST_KEY);
    queryClient.setQueryData<EntityReviewListResponse>(LIST_KEY, (old) =>
      old ? { ...old, rows: old.rows.filter((r) => r.id !== row.id), total: Math.max(0, old.total - 1) } : old,
    );
    return { prev };
  };

  const onError = (err: unknown, _vars: unknown, ctx: { prev?: EntityReviewListResponse } | undefined) => {
    if (ctx?.prev) queryClient.setQueryData(LIST_KEY, ctx.prev);
    queryClient.invalidateQueries({ queryKey: detailKey(row.id) });
    setErrorCopy(copyForError(err));
  };

  const confirmMutation = useMutation({
    mutationFn: (input: { mergeIntoEntityId?: string }) =>
      api.entityReview.confirm(row.id, {
        candidateGeneratedAt,
        ...(input.mergeIntoEntityId ? { mergeIntoEntityId: input.mergeIntoEntityId } : {}),
      }),
    onMutate: buildOnMutate(),
    onError,
    onSuccess,
  });

  const rejectMutation = useMutation({
    mutationFn: (_: void) => api.entityReview.reject(row.id, { candidateGeneratedAt }),
    onMutate: buildOnMutate(),
    onError,
    onSuccess,
  });

  const pending = confirmMutation.isPending || rejectMutation.isPending;
  const hasCandidate = row.candidate_entity_id !== null;

  return (
    <div className="mt-3 flex flex-col gap-3 border-t pt-3">
      {hasCandidate ? (
        <div className="text-sm">
          <span className="text-muted-foreground">Suggested match:</span>{" "}
          <span className="font-medium">{row.candidate?.name ?? row.candidate_entity_id}</span>
          {row.candidate?.email ? (
            <span className="text-muted-foreground"> · {row.candidate.email}</span>
          ) : null}
          {row.candidate_reason ? (
            <span className="text-muted-foreground"> · {row.candidate_reason}</span>
          ) : null}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">
          No suggestion — pick an existing {row.entity_type} or create a new entity.
        </div>
      )}
      {row.sourceBreakdown.length > 0 ? (
        <div className="text-xs text-muted-foreground">
          Evidence:{" "}
          {row.sourceBreakdown.map((s, idx) => (
            <span key={s.source}>
              {idx > 0 ? ", " : ""}
              {s.count}× {s.source}
            </span>
          ))}
        </div>
      ) : null}
      {errorCopy ? <div className="text-sm text-destructive">{errorCopy.message}</div> : null}
      <div className="flex flex-wrap items-center gap-2">
        {hasCandidate ? (
          <Button size="sm" onClick={() => confirmMutation.mutate({})} disabled={pending}>
            Confirm
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => rejectMutation.mutate()}
          disabled={pending}
          data-testid="reject-button"
        >
          {hasCandidate ? "Reject — create new" : "Create new"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowPicker((s) => !s)} disabled={pending}>
          {hasCandidate ? "Pick a different existing" : "Pick existing"}
        </Button>
      </div>
      {showPicker ? (
        <EntityPicker
          entityType={row.entity_type}
          excludeEntityId={row.candidate_entity_id ?? undefined}
          onPick={(entityId) => {
            setShowPicker(false);
            confirmMutation.mutate({ mergeIntoEntityId: entityId });
          }}
        />
      ) : null}
    </div>
  );
}
