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
 * Error mapping (from resolve.ts ResolveError codes):
 *   CANDIDATE_DRIFT, CANDIDATE_MISSING, TARGET_DELETED,
 *   MULTIPLE_STALE_CANDIDATES, MULTIPLE_RE_RESOLVE_MATCHES,
 *   ALREADY_CONFIRMING                           → 409
 *   EVIDENCE_TOO_LARGE, TYPE_MISMATCH            → 422
 *   ROW_NOT_FOUND                                → 404
 */
import { type Context, Hono } from "hono";
import type { Kysely } from "kysely";
import { isAdmin } from "../api/auth-helpers";
import { createEntityReviewRepo, readReviewFreezeMs } from "../db/repositories/entity-review";
import type { DB } from "../db/schema";
import { ResolveError, confirmReview, rejectReview } from "./resolve";

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
    const limitRaw = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : DEFAULT_LIMIT;
    const offsetRaw = Number(c.req.query("offset"));
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const status = c.req.query("status") ?? "pending";
    if (status !== "pending") {
      return c.json({ error: { code: "BAD_REQUEST", message: "only status=pending supported in v1" } }, 400);
    }

    const repo = createEntityReviewRepo(db);
    const callerIsAdmin = isAdmin(c);
    const callerId = c.get("sub");
    // Repo's listPending already filters by triggered_by_user_id when
    // non-admin; we still post-filter for multi-user-evidence rows since
    // those need to escalate even when triggered_by_user_id matches.
    const rows = await repo.listPending({
      ownerUserId: callerId,
      isAdmin: callerIsAdmin,
      limit,
      offset,
    });

    if (callerIsAdmin) {
      return c.json({ rows });
    }
    const visible = [] as typeof rows;
    for (const r of rows) {
      const otherOwners = await repo.countOtherOwnersInEvidence(r.id, r.triggered_by_user_id);
      if (otherOwners === 0) visible.push(r);
    }
    return c.json({ rows: visible });
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const repo = createEntityReviewRepo(db);
    const row = await repo.getById(id);
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "review row not found" } }, 404);

    const denied = await denyIfNotOwnerOrAdmin(c, repo, row);
    if (denied) return denied;

    // Side-effecting freeze step runs ONLY after the access check passes.
    if (row.status === "pending") {
      const now = new Date().toISOString();
      const boundary = new Date(Date.now() - readReviewFreezeMs()).toISOString();
      const refreshed = await repo.markReviewStarted(id, c.get("sub"), now, boundary);
      const evidence = await repo.listEvidenceForResolve(id);
      return c.json({ row: refreshed ?? row, evidence });
    }
    const evidence = await repo.listEvidenceForResolve(id);
    return c.json({ row, evidence });
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

    // Idempotent replay: confirmed row returns 200 with current state.
    if (row.status === "confirmed") {
      return c.json({ row, idempotent: true });
    }

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

    if (row.status === "rejected") {
      return c.json({ row, idempotent: true });
    }

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
      });
    } catch (err) {
      return handleResolveError(c, err);
    }
  });

  return app;
}
