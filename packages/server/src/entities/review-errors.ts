/**
 * Closed set of error codes emitted by /api/entity-review routes.
 *
 * The route layer maps `ResolveError` codes to HTTP statuses, and the 403
 * owner-scope check emits `OWNER_SCOPE_DENIED` directly. The UI in ECR-03
 * switches on `code` to render locked copy, so the set is closed —
 * adding a new code requires a UI update.
 *
 * Refresh-able 409s (CANDIDATE_DRIFT, CANDIDATE_MISSING, TARGET_DELETED)
 * carry `currentRow` in `details` so the UI can re-render without an
 * additional fetch.
 */
import type { ResolveErrorCode } from "./resolve";

export const REVIEW_ERROR_CODES = [
  // 409 — retry-after-refresh
  "CANDIDATE_DRIFT",
  "CANDIDATE_MISSING",
  "TARGET_DELETED",
  // 409 — admin escalation, no UI retry
  "MULTIPLE_STALE_CANDIDATES",
  "MULTIPLE_RE_RESOLVE_MATCHES",
  "ALREADY_CONFIRMING",
  "TYPE_RECLASSIFY_COLLISION",
  // 422 — invalid input
  "EVIDENCE_TOO_LARGE",
  "TYPE_MISMATCH",
  // 404
  "ROW_NOT_FOUND",
  // 403
  "OWNER_SCOPE_DENIED",
] as const;

export type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[number];

/**
 * Compile-time guard: every ResolveErrorCode is in the closed set.
 * If resolve.ts adds a new code without updating REVIEW_ERROR_CODES, this
 * assignment fails to typecheck.
 */
const _assertResolveCodesCovered: ReviewErrorCode = "" as ResolveErrorCode;
void _assertResolveCodesCovered;
