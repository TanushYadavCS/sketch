/**
 * HTTP routes for the entity-review queue.
 *
 * Endpoints (gated by config.EXPERIMENTAL_FLAG at mount time in http.ts):
 *   GET    /                  list pending rows (owner-scoped)
 *   GET    /:id               row detail; sets review_started_at atomically
 *                             AFTER the owner-scope check passes
 *   POST   /:id/confirm       resolve via confirmReview()
 *   POST   /:id/reject        resolve via rejectReview()
 *
 * Owner-scope: matches row.triggered_by_user_id OR is admin. Rows whose
 * evidence files were created by other users are admin-only — detected
 * via `countOtherOwnersInEvidence` (JOIN through indexed_files →
 * connector_configs.created_by).
 *
 * Error mapping (from resolve.ts ResolveError codes; the closed set lives
 * in review-errors.ts):
 *   CANDIDATE_DRIFT, CANDIDATE_MISSING, TARGET_DELETED,
 *   MULTIPLE_STALE_CANDIDATES, MULTIPLE_RE_RESOLVE_MATCHES,
 *   ALREADY_CONFIRMING                           → 409
 *   EVIDENCE_TOO_LARGE, TYPE_MISMATCH            → 422
 *   ROW_NOT_FOUND                                → 404
 *   OWNER_SCOPE_DENIED                           → 403
 *   missing `candidateGeneratedAt` in body       → 400
 *
 * Refresh-able 409s (CANDIDATE_DRIFT, CANDIDATE_MISSING, TARGET_DELETED)
 * include `currentRow` in the response body so the UI can re-render
 * without an additional GET.
 */
import { type Context, Hono } from "hono";
import type { Kysely } from "kysely";
import { isAdmin } from "../api/auth-helpers";
import { createEntityRepository } from "../db/repositories/entities";
import { createEntityReviewRepo, readReviewFreezeMs } from "../db/repositories/entity-review";
import type { DB } from "../db/schema";
import { ResolveError, confirmReview, rejectReview } from "./resolve";

function readEmail(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { email?: unknown };
    return typeof parsed.email === "string" && parsed.email.length > 0 ? parsed.email : null;
  } catch {
    return null;
  }
}

type CandidateSummary = { id: string; name: string; email: string | null };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function statusForError(code: ResolveError["code"]): 404 | 409 | 422 {
  switch (code) {
    case "ROW_NOT_FOUND":
      return 404;
    case "EVIDENCE_TOO_LARGE":
    case "TYPE_MISMATCH":
      return 422;
    default:
      return 409;
  }
}

function handleResolveError(c: Context, err: unknown): Response {
  if (err instanceof ResolveError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ?? {}),
        },
      },
      statusForError(err.code),
    );
  }
  throw err;
}

/**
 * Owner-scope check. Returns null when the caller is allowed; otherwise
 * a 403 response. Runs BEFORE any side-effecting writes (the GET :id
 * handler is the load-bearing case — see test "403 GET does not flip
 * review_started_at").
 */
async function denyIfNotOwnerOrAdmin(
  c: Context,
  repo: ReturnType<typeof createEntityReviewRepo>,
  row: { id: string; triggered_by_user_id: string },
): Promise<Response | null> {
  const callerId = c.get("sub");
  if (isAdmin(c)) return null;
  if (callerId !== row.triggered_by_user_id) {
    return c.json({ error: { code: "OWNER_SCOPE_DENIED", message: "not the row owner" } }, 403);
  }
  // Multi-user-evidence escalation: even an owner is blocked if the row's
  // evidence files were created by other users.
  const otherOwners = await repo.countOtherOwnersInEvidence(row.id, row.triggered_by_user_id);
  if (otherOwners > 0) {
    return c.json(
      { error: { code: "OWNER_SCOPE_DENIED", message: "row spans multiple users; admin review required" } },
      403,
    );
  }
  return null;
}

export function entityReviewRoutes(db: Kysely<DB>) {
  const app = new Hono();

  app.get("/", async (c) => {
    const limitRaw = c.req.query("limit");
    // ?limit=0 → count-only short-circuit (badge); other invalid values fall to default.
    const limitParsed = limitRaw === undefined ? Number.NaN : Number(limitRaw);
    const countOnly = limitRaw === "0";
    const limit = countOnly
      ? 0
      : Number.isFinite(limitParsed) && limitParsed > 0
        ? Math.min(limitParsed, MAX_LIMIT)
        : DEFAULT_LIMIT;
    const offsetRaw = Number(c.req.query("offset"));
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const status = c.req.query("status") ?? "pending";
    if (status !== "pending") {
      return c.json({ error: { code: "BAD_REQUEST", message: "only status=pending supported in v1" } }, 400);
    }

    const repo = createEntityReviewRepo(db);
    const callerIsAdmin = isAdmin(c);
    const callerId = c.get("sub");

    const total = await repo.countPending({ ownerUserId: callerId, isAdmin: callerIsAdmin });

    if (countOnly) {
      return c.json({ rows: [], total });
    }

    const visibleRows = await repo.listPending({
      ownerUserId: callerId,
      isAdmin: callerIsAdmin,
      limit,
      offset,
    });

    // Evidence summary per visible row.
    const summaryByReview = await repo.evidenceSummaryByReview(visibleRows.map((r) => r.id));

    // Candidate-entity summary (name + email) — UI renders this in place of the raw id.
    const entityRepo = createEntityRepository(db);
    const candidateIds = Array.from(
      new Set(visibleRows.map((r) => r.candidate_entity_id).filter((v): v is string => !!v)),
    );
    const candidatesById = new Map<string, CandidateSummary>();
    if (candidateIds.length > 0) {
      const entities = await entityRepo.getEntities(candidateIds);
      for (const e of entities) {
        candidatesById.set(e.id, { id: e.id, name: e.name, email: readEmail(e.metadata) });
      }
    }

    const rowsWithSummary = visibleRows.map((r) => {
      const breakdown = summaryByReview.get(r.id) ?? [];
      const evidenceCount = breakdown.reduce((acc, b) => acc + b.count, 0);
      const candidate = r.candidate_entity_id ? (candidatesById.get(r.candidate_entity_id) ?? null) : null;
      return { ...r, evidenceCount, sourceBreakdown: breakdown, candidate };
    });

    return c.json({ rows: rowsWithSummary, total });
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const repo = createEntityReviewRepo(db);
    const row = await repo.getById(id);
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "review row not found" } }, 404);

    const denied = await denyIfNotOwnerOrAdmin(c, repo, row);
    if (denied) return denied;

    // Side-effecting freeze step runs ONLY after the access check passes.
    let baseRow = row;
    if (row.status === "pending") {
      const now = new Date().toISOString();
      const boundary = new Date(Date.now() - readReviewFreezeMs()).toISOString();
      const refreshed = await repo.markReviewStarted(id, c.get("sub"), now, boundary);
      if (refreshed) baseRow = refreshed;
    }
    const evidence = await repo.listEvidenceForResolve(id);
    const breakdown = new Map<string, number>();
    for (const e of evidence) breakdown.set(e.source, (breakdown.get(e.source) ?? 0) + 1);
    const sourceBreakdown = Array.from(breakdown, ([source, count]) => ({ source, count }));

    let candidate: CandidateSummary | null = null;
    if (baseRow.candidate_entity_id) {
      const entityRepo = createEntityRepository(db);
      const candidateEntity = await entityRepo.getEntity(baseRow.candidate_entity_id);
      if (candidateEntity) {
        candidate = { id: candidateEntity.id, name: candidateEntity.name, email: readEmail(candidateEntity.metadata) };
      }
    }

    const enrichedRow = { ...baseRow, evidenceCount: evidence.length, sourceBreakdown, candidate };
    return c.json({ row: enrichedRow, evidence });
  });

  app.post("/:id/confirm", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      mergeIntoEntityId?: string;
      candidateGeneratedAt?: string;
    };
    if (!body.candidateGeneratedAt) {
      return c.json({ error: { code: "BAD_REQUEST", message: "candidateGeneratedAt is required" } }, 400);
    }

    const repo = createEntityReviewRepo(db);
    const row = await repo.getById(id);
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "review row not found" } }, 404);
    const denied = await denyIfNotOwnerOrAdmin(c, repo, row);
    if (denied) return denied;

    try {
      const result = await confirmReview({ db, userId: c.get("sub") }, id, {
        mergeIntoEntityId: body.mergeIntoEntityId,
        candidateGeneratedAt: body.candidateGeneratedAt,
      });
      return c.json({
        row: result.row,
        targetEntityId: result.targetEntityId,
        shortCircuited: result.shortCircuited,
        mergedStaleEntityId: result.mergedStaleEntityId,
        idempotent: result.idempotent,
      });
    } catch (err) {
      return handleResolveError(c, err);
    }
  });

  app.post("/:id/reject", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      rejectAgainstEntityId?: string;
      candidateGeneratedAt?: string;
    };
    if (!body.candidateGeneratedAt) {
      return c.json({ error: { code: "BAD_REQUEST", message: "candidateGeneratedAt is required" } }, 400);
    }

    const repo = createEntityReviewRepo(db);
    const row = await repo.getById(id);
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "review row not found" } }, 404);
    const denied = await denyIfNotOwnerOrAdmin(c, repo, row);
    if (denied) return denied;

    try {
      const result = await rejectReview({ db, userId: c.get("sub") }, id, {
        rejectAgainstEntityId: body.rejectAgainstEntityId,
        candidateGeneratedAt: body.candidateGeneratedAt,
      });
      return c.json({
        row: result.row,
        targetEntityId: result.targetEntityId,
        reResolvedToExisting: result.reResolvedToExisting,
        createdEntityId: result.createdEntityId,
        idempotent: result.idempotent,
      });
    } catch (err) {
      return handleResolveError(c, err);
    }
  });

  return app;
}
