import { type Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { readClusterVerdict } from "../connectors/project-minting";
import {
  ProjectMintingAcceptanceError,
  acceptProjectMintingVerdict,
  maxProjectConfidence,
  parseJsonArray,
  parseStoredAcceptedResult,
  rejectProjectMintingVerdict,
} from "../connectors/project-minting-acceptance";
import {
  createCompanyRelationshipDeclarationRepository,
  isDeclaredRelationshipState,
} from "../db/repositories/company-relationship-declarations";
import {
  type ProjectMintingVerdictRow,
  createProjectMintingVerdictRepository,
} from "../db/repositories/project-minting-verdicts";
import type { DB } from "../db/schema";

function requireAdmin(c: Context) {
  if (c.get("role") !== "admin") {
    return { error: { code: "FORBIDDEN", message: "Admin access required" } };
  }
  return null;
}

function serializeVerdict(row: ProjectMintingVerdictRow, includeDossier = false) {
  const verdict = readClusterVerdict(JSON.parse(row.verdict));
  return {
    id: row.id,
    companyEntityId: row.company_entity_id,
    companyName: row.company_name,
    fileCount: row.file_count,
    relationshipState: row.relationship_state,
    flags: parseJsonArray(row.flags),
    voteStats: row.vote_stats ? JSON.parse(row.vote_stats) : null,
    verdict,
    dossier: includeDossier ? row.dossier : undefined,
    status: row.status,
    supersededAt: row.superseded_at,
    decidedAt: row.decided_at,
    decidedByUserId: row.decided_by_user_id,
    struckProjects: parseJsonArray(row.struck_projects),
    acceptedResult: parseStoredAcceptedResult(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pendingSortKey(row: ProjectMintingVerdictRow): [number, number, string, string] {
  const flagsEmpty = parseJsonArray(row.flags).length === 0 ? 0 : 1;
  let confidence = 0;
  try {
    confidence = maxProjectConfidence(readClusterVerdict(JSON.parse(row.verdict)));
  } catch {
    confidence = 0;
  }
  return [flagsEmpty, -confidence, row.created_at, row.id];
}

function sortPendingRows(rows: ProjectMintingVerdictRow[]): ProjectMintingVerdictRow[] {
  return [...rows].sort((a, b) => {
    const left = pendingSortKey(a);
    const right = pendingSortKey(b);
    for (let i = 0; i < left.length; i++) {
      if (left[i] < right[i]) return -1;
      if (left[i] > right[i]) return 1;
    }
    return 0;
  });
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  if (!c.req.header("content-type")?.includes("application/json")) return {};
  const body = await c.req.json();
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function errorResponse(c: Context, err: unknown) {
  if (err instanceof ProjectMintingAcceptanceError) {
    const status =
      err.code === "NOT_FOUND"
        ? 404
        : err.code === "STALE_VERDICT" || err.code === "TRIPWIRE_BLOCKED" || err.code === "STRIKE_CASCADE"
          ? 409
          : 400;
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, status);
  }
  throw err;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function readRenameMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(value)) {
    if (typeof to === "string" && from.trim() && to.trim()) out[from.trim()] = to.trim();
  }
  return out;
}

export function projectMintingRoutes(db: Kysely<DB>, logger: Logger) {
  const routes = new Hono();
  const verdicts = createProjectMintingVerdictRepository(db);
  const declarations = createCompanyRelationshipDeclarationRepository(db);

  routes.get("/verdicts", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const rows = sortPendingRows(await verdicts.listPending());
    return c.json({ verdicts: rows.map((row) => serializeVerdict(row)) });
  });

  routes.get("/verdicts/:id", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const row = await verdicts.findById(c.req.param("id"));
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "Project minting verdict not found" } }, 404);
    return c.json({ verdict: serializeVerdict(row, true) });
  });

  routes.post("/verdicts/:id/acceptance", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    try {
      const body = await readJsonObject(c);
      const result = await acceptProjectMintingVerdict(db, {
        verdictId: c.req.param("id"),
        actorUserId: c.get("sub"),
        struckProjectNames: readStringArray(body.struckProjectNames),
        renameMap: readRenameMap(body.renameMap),
        overrideTripwireFlags: body.overrideTripwireFlags === true,
      });
      return c.json({ acceptance: result });
    } catch (err) {
      logger.warn({ err, verdictId: c.req.param("id") }, "Project minting verdict acceptance failed");
      return errorResponse(c, err);
    }
  });

  routes.post("/verdicts/:id/rejection", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    try {
      const row = await rejectProjectMintingVerdict(db, { verdictId: c.req.param("id"), actorUserId: c.get("sub") });
      return c.json({ verdict: serializeVerdict(row) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  routes.get("/declarations", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const rows = await declarations.list();
    return c.json({
      declarations: rows.map((row) => ({
        companyEntityId: row.company_entity_id,
        declaredState: row.declared_state,
        note: row.note,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  });

  routes.put("/declarations/:companyEntityId", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const body = await readJsonObject(c);
    const declaredState = body.declaredState;
    if (typeof declaredState !== "string" || !isDeclaredRelationshipState(declaredState)) {
      return c.json(
        { error: { code: "INVALID_DECLARED_STATE", message: "declaredState must be trial or paying" } },
        400,
      );
    }
    await declarations.declare({
      companyEntityId: c.req.param("companyEntityId"),
      declaredState,
      note: typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined,
    });
    return c.body(null, 204);
  });

  routes.delete("/declarations/:companyEntityId", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    await declarations.remove(c.req.param("companyEntityId"));
    return c.body(null, 204);
  });

  return routes;
}
