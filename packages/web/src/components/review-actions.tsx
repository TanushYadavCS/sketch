/**
 * Entity-review mutations + the standalone <ReviewActions> button bar.
 *
 * `useReviewMutations` is the shared mutation pipeline — optimistic remove
 * from LIST_KEY in onMutate, restore in onError, invalidate count + detail
 * keys on success. Refresh-able 409s (CANDIDATE_DRIFT / CANDIDATE_MISSING /
 * TARGET_DELETED) invalidate the detail key so the next render shows the
 * new candidate; 422 conditions (EVIDENCE_TOO_LARGE / TYPE_MISMATCH) surface
 * as sticky-admin messages.
 *
 * `<ReviewActions>` is the standalone-page button bar (Confirm / Reject /
 * Pick existing) that uses the hook internally. Hosts that need a custom
 * layout (e.g. the side-drawer with ✓/✗ icon buttons embedded in the
 * candidate card) should call `useReviewMutations` directly and render
 * their own UI.
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

export interface ResolveCopy {
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
        return { variant: "refresh", message: "This row is already being processed. Refresh in a moment." };
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

/**
 * Shared mutation pipeline for an entity_review_queue row. Returns three
 * action functions + the current pending/error state, all wired up with the
 * optimistic LIST_KEY filter + COUNT_KEY/detail invalidations that every
 * resolve path needs.
 */
export interface UseReviewMutationsResult {
  /** Confirm the row's default suggested candidate. No-op if the row has no candidate. */
  confirm: () => void;
  /** Reject the proposal — server creates a brand-new entity. */
  reject: () => void;
  /** Confirm with a host-picked target entity (overrides the row's suggested candidate). */
  mergeInto: (entityId: string) => void;
  isPending: boolean;
  errorCopy: ResolveCopy | null;
  clearError: () => void;
}

export function useReviewMutations(
  row: EntityReviewQueueRow,
  onResolved?: (result: ResolveResult) => void,
): UseReviewMutationsResult {
  const queryClient = useQueryClient();
  const [errorCopy, setErrorCopy] = useState<ResolveCopy | null>(null);
  const candidateGeneratedAt = row.candidate_generated_at ?? "";

  const onSuccessCommon = () => {
    setErrorCopy(null);
    queryClient.invalidateQueries({ queryKey: LIST_KEY });
    queryClient.invalidateQueries({ queryKey: COUNT_KEY });
  };

  const onMutate = async () => {
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
    onMutate,
    onError,
    onSuccess: (result) => {
      onSuccessCommon();
      onResolved?.({ kind: "confirmed", targetEntityId: result.targetEntityId });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (_: void) => api.entityReview.reject(row.id, { candidateGeneratedAt }),
    onMutate,
    onError,
    onSuccess: (result) => {
      onSuccessCommon();
      onResolved?.({ kind: "rejected", targetEntityId: result.targetEntityId });
    },
  });

  return {
    confirm: () => confirmMutation.mutate({}),
    reject: () => rejectMutation.mutate(),
    mergeInto: (entityId: string) => confirmMutation.mutate({ mergeIntoEntityId: entityId }),
    isPending: confirmMutation.isPending || rejectMutation.isPending,
    errorCopy,
    clearError: () => setErrorCopy(null),
  };
}

export interface ReviewActionsProps {
  row: EntityReviewQueueRow;
  onResolved?: (result: ResolveResult) => void;
}

/**
 * Standalone Confirm / Reject — create new / Pick existing button bar with
 * an inline EntityPicker. Used by the colocated component tests and any
 * host that wants the off-the-shelf review UI.
 *
 * Hosts that need a custom layout (e.g. the side-drawer with ✓/✗ icon
 * buttons inside the candidate card) should call `useReviewMutations`
 * directly and render their own UI.
 */
export function ReviewActions({ row, onResolved }: ReviewActionsProps) {
  const [showPicker, setShowPicker] = useState(false);
  const mutations = useReviewMutations(row, onResolved);
  const hasCandidate = row.candidate_entity_id !== null;

  return (
    <div className="mt-3 flex flex-col gap-3 border-t pt-3">
      {hasCandidate ? (
        <div className="text-sm">
          <span className="text-muted-foreground">Suggested match:</span>{" "}
          <span className="font-medium">{row.candidate?.name ?? row.candidate_entity_id}</span>
          {row.candidate?.email ? <span className="text-muted-foreground"> · {row.candidate.email}</span> : null}
          {row.candidate_reason ? <span className="text-muted-foreground"> · {row.candidate_reason}</span> : null}
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
      {mutations.errorCopy ? <div className="text-sm text-destructive">{mutations.errorCopy.message}</div> : null}
      <div className="flex flex-wrap items-center gap-2">
        {hasCandidate ? (
          <Button size="sm" onClick={() => mutations.confirm()} disabled={mutations.isPending}>
            Confirm
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => mutations.reject()}
          disabled={mutations.isPending}
          data-testid="reject-button"
        >
          {hasCandidate ? "Reject — create new" : "Create new"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowPicker((s) => !s)} disabled={mutations.isPending}>
          {hasCandidate ? "Pick a different existing" : "Pick existing"}
        </Button>
      </div>
      {showPicker ? (
        <EntityPicker
          entityType={row.entity_type}
          excludeEntityId={row.candidate_entity_id ?? undefined}
          onPick={(entityId) => {
            setShowPicker(false);
            mutations.mergeInto(entityId);
          }}
        />
      ) : null}
    </div>
  );
}
