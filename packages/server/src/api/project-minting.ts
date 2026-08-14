import { type Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { resolveOpenRouterEnrichmentConfig } from "../connectors/enrichment-providers";
import { createOpenRouterGenerator } from "../connectors/openrouter-generate";
import { clusterClientFiles, readClusterVerdict, runProjectMintingPass } from "../connectors/project-minting";
import {
  ProjectMintingAcceptanceError,
  acceptProjectMintingVerdict,
  maxProjectConfidence,
  parseJsonArray,
  parseStoredAcceptedResult,
  rejectProjectMintingVerdict,
} from "../connectors/project-minting-acceptance";
import {
  type ClientStage,
  assertStageMatchesKind,
  createCompanyRelationshipDeclarationRepository,
  isClientStage,
  isCounterpartyKind,
  kindCarriesStage,
} from "../db/repositories/company-relationship-declarations";
import { createGraphPassRunRepository } from "../db/repositories/graph-pass-runs";
import {
  type ProjectMintingVerdictRow,
  createProjectMintingVerdictRepository,
} from "../db/repositories/project-minting-verdicts";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";

/**
 * What the pass route needs from config. Kept narrow so the routes stay
 * testable without a whole `AppConfig`.
 */
export interface ProjectMintingRouteConfig {
  encryptionKey?: string;
  openRouterApiKey?: string | null;
  projectMintingModel?: string | null;
  /** Running a pass calls a reasoning model per cluster, so it is gated with the dev surface it is driven from. */
  passesEnabled: boolean;
}

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
    counterpartyKind: row.counterparty_kind,
    clientStage: row.client_stage,
    declaredCounterpartyKind: row.declared_counterparty_kind,
    declaredClientStage: row.declared_client_stage,
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

function readConfirmedAxes(body: Record<string, unknown>) {
  const kind = body.confirmedCounterpartyKind;
  if (typeof kind !== "string" || !isCounterpartyKind(kind)) {
    throw new ProjectMintingAcceptanceError(
      "INVALID_ACCEPTANCE",
      "confirmedCounterpartyKind must be client, vendor, investor, partner or other",
    );
  }
  const hasStage = Object.hasOwn(body, "confirmedClientStage");
  const rawStage = body.confirmedClientStage;
  if (!kindCarriesStage(kind) && hasStage) {
    throw new ProjectMintingAcceptanceError(
      "INVALID_ACCEPTANCE",
      "confirmedClientStage must be absent unless confirmedCounterpartyKind is client or partner",
    );
  }
  let stage: ClientStage | null = null;
  if (hasStage) {
    if (typeof rawStage !== "string" || !isClientStage(rawStage)) {
      throw new ProjectMintingAcceptanceError(
        "INVALID_ACCEPTANCE",
        "confirmedClientStage must be prospect, pilot, active, dormant or ended",
      );
    }
    stage = rawStage;
  }
  if (kindCarriesStage(kind) && stage === null) {
    throw new ProjectMintingAcceptanceError(
      "INVALID_ACCEPTANCE",
      "confirmedClientStage must be prospect, pilot, active, dormant or ended",
    );
  }
  try {
    assertStageMatchesKind(kind, stage);
  } catch (err) {
    throw new ProjectMintingAcceptanceError(
      "INVALID_ACCEPTANCE",
      err instanceof Error ? err.message : "confirmed axes are invalid",
    );
  }
  return { confirmedCounterpartyKind: kind, confirmedClientStage: stage };
}

export function projectMintingRoutes(
  db: Kysely<DB>,
  logger: Logger,
  routeConfig: ProjectMintingRouteConfig = { passesEnabled: false },
) {
  const routes = new Hono();
  const verdicts = createProjectMintingVerdictRepository(db);
  const declarations = createCompanyRelationshipDeclarationRepository(db);
  const passRuns = createGraphPassRunRepository(db);

  /**
   * Stages 1–2 only — cluster the corpus and report what would be sent. No
   * model call, so this is safe to poll; it costs about 120ms on a 3,800-file
   * corpus. `pendingVerdictId` is what lets the UI show a cluster as already
   * queued instead of inviting a second paid run.
   */
  routes.get("/clusters", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const clusters = await clusterClientFiles(db, { minFiles: 2 });
    const pending = await verdicts.listPending();
    const pendingByCompany = new Map(pending.map((row) => [row.company_entity_id, row.id]));
    return c.json({
      clusters: clusters
        .map((cluster) => ({
          companyEntityId: cluster.companyEntityId,
          companyName: cluster.companyName,
          fileCount: cluster.files.length,
          triggered: cluster.triggered,
          shardNames: cluster.groupMembers.map((member) => member.name),
          channels: cluster.channels.map((channel) => channel.name),
          signals: [...new Set(cluster.files.flatMap((file) => file.via))].sort(),
          pendingVerdictId: pendingByCompany.get(cluster.companyEntityId) ?? null,
        }))
        .sort((a, b) => b.fileCount - a.fileCount),
      passesEnabled: routeConfig.passesEnabled,
    });
  });

  /**
   * Runs stage 3 for one cluster in the background and returns the run id to
   * poll. Scoped to a single company on purpose: an unscoped pass would call
   * the model once per triggered cluster, which is real money on a click.
   */
  routes.post("/passes", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);
    if (!routeConfig.passesEnabled) {
      return c.json({ error: { code: "NOT_FOUND", message: "Project minting passes are not enabled" } }, 404);
    }

    const body = await readJsonObject(c);
    const companyEntityId = typeof body.companyEntityId === "string" ? body.companyEntityId : null;
    if (!companyEntityId) {
      return c.json({ error: { code: "INVALID_REQUEST", message: "companyEntityId is required" } }, 400);
    }

    const clusters = await clusterClientFiles(db, { minFiles: 2 });
    const cluster = clusters.find((candidate) => candidate.companyEntityId === companyEntityId);
    if (!cluster) {
      return c.json({ error: { code: "NOT_FOUND", message: "No cluster for that company" } }, 404);
    }

    const settings = await createSettingsRepository(db, routeConfig.encryptionKey).get();
    const openRouter = resolveOpenRouterEnrichmentConfig(settings, routeConfig.openRouterApiKey);
    const model = routeConfig.projectMintingModel ?? openRouter.openRouterModel;
    if (!openRouter.openRouterApiKey || !model) {
      return c.json(
        {
          error: {
            code: "LLM_NOT_CONFIGURED",
            message: "Stage 3 needs an OpenRouter key and a reasoning-tier model",
          },
        },
        503,
      );
    }

    const runId = await passRuns.start({
      kind: "project_minting",
      companyEntityId: cluster.companyEntityId,
      companyName: cluster.companyName,
      model,
      clustersConsidered: 1,
      verdictsStored: 0,
    });

    const generator = createOpenRouterGenerator(openRouter.openRouterApiKey, {
      model,
      reasoningEffort: "medium",
      timeoutMs: 300_000,
    });

    void runProjectMintingPass({
      db,
      logger: logger.child({ component: "project-minting-pass", runId }),
      generator,
      model,
      storeVerdicts: true,
      onlyTriggered: false,
      companyFilter: (name) => name === cluster.companyName,
    })
      .then(async (pass) => {
        await passRuns.updateSnapshot(runId, {
          kind: "project_minting",
          companyEntityId: cluster.companyEntityId,
          companyName: cluster.companyName,
          model,
          clustersConsidered: pass.results.length,
          verdictsStored: pass.results.filter((result) => result.verdictId).length,
        });
        await passRuns.complete(runId);
      })
      .catch(async (err) => {
        logger.error({ err, runId }, "Project minting pass failed");
        await passRuns.fail(runId, err instanceof Error ? err.message : String(err));
      });

    return c.json({ run: { id: runId, status: "running", companyName: cluster.companyName, model } }, 201);
  });

  routes.get("/passes/:id", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const run = await passRuns.get(c.req.param("id"));
    if (!run) return c.json({ error: { code: "NOT_FOUND", message: "Run not found" } }, 404);
    return c.json({
      run: {
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        errorMessage: run.errorMessage,
        snapshot: run.inputSnapshot,
      },
    });
  });

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
      const confirmedAxes = readConfirmedAxes(body);
      const result = await acceptProjectMintingVerdict(db, {
        verdictId: c.req.param("id"),
        actorUserId: c.get("sub"),
        ...confirmedAxes,
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
        subjectEntityId: row.subject_entity_id,
        counterpartyKind: row.counterparty_kind,
        clientStage: row.client_stage,
        note: row.note,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  });

  routes.put("/declarations/:subjectEntityId", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const body = await readJsonObject(c);
    const counterpartyKind = body.counterpartyKind;
    if (typeof counterpartyKind !== "string" || !isCounterpartyKind(counterpartyKind)) {
      return c.json(
        {
          error: {
            code: "INVALID_COUNTERPARTY_KIND",
            message: "counterpartyKind must be client, vendor, investor, partner or other",
          },
        },
        400,
      );
    }
    const clientStage = body.clientStage;
    if (
      clientStage !== null &&
      clientStage !== undefined &&
      (typeof clientStage !== "string" || !isClientStage(clientStage))
    ) {
      return c.json(
        {
          error: {
            code: "INVALID_CLIENT_STAGE",
            message: "clientStage must be prospect, pilot, active, dormant, ended or null",
          },
        },
        400,
      );
    }
    try {
      await declarations.declare({
        subjectEntityId: c.req.param("subjectEntityId"),
        counterpartyKind,
        clientStage: clientStage ?? null,
        note: typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined,
      });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof Error && err.message.includes("client_stage")) {
        return c.json({ error: { code: "INVALID_CLIENT_STAGE", message: err.message } }, 400);
      }
      throw err;
    }
  });

  routes.delete("/declarations/:subjectEntityId", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    await declarations.remove(c.req.param("subjectEntityId"));
    return c.body(null, 204);
  });

  return routes;
}
