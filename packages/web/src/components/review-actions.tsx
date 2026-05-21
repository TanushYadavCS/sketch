/**
 * <ReviewActions> — shared resolve UI for an entity_review_queue row.
 *
 * Optimistic mutation pattern: snapshot list state in onMutate, restore in
 * onError, invalidate list + count on success. Refresh-able 409s
 * (CANDIDATE_DRIFT / CANDIDATE_MISSING / TARGET_DELETED) invalidate the
 * detail query so the next render shows the new candidate. 422 conditions
 * (EVIDENCE_TOO_LARGE / TYPE_MISMATCH) surface sticky admin messages.
 *
 * Extracted from routes/review-entities/index.tsx in ECR-03B so the same
 * component can be hosted both on the standalone review page and inline
 * inside the entities tab.
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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export const LIST_KEY = ["entity-review", "list"] as const;
export const COUNT_KEY = ["entity-review", "count"] as const;
export const detailKey = (id: string) => ["entity-review", "detail", id] as const;

export interface ResolveResult {
  kind: "confirmed" | "rejected";
  targetEntityId: string;
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

export interface ReviewActionsProps {
  row: EntityReviewQueueRow;
  onResolved?: (result: ResolveResult) => void;
}

export function ReviewActions({ row, onResolved }: ReviewActionsProps) {
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
    onSuccess: (result) => {
      onSuccess();
      onResolved?.({ kind: "confirmed", targetEntityId: result.targetEntityId });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (_: undefined) => api.entityReview.reject(row.id, { candidateGeneratedAt }),
    onMutate: buildOnMutate(),
    onError,
    onSuccess: (result) => {
      onSuccess();
      onResolved?.({ kind: "rejected", targetEntityId: result.targetEntityId });
    },
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
          onClick={() => rejectMutation.mutate(undefined)}
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
