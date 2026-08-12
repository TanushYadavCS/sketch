/**
 * Dev-only enrichment trace routes.
 *
 * Mounted only when `DEV_TOOLS_ENABLED` is set, and admin-gated on top of that,
 * so a tenant deployment has no route to find. Everything it returns is
 * captured in memory for the life of the process — see `dev/enrichment-trace.ts`.
 *
 * Running a trace runs the real pipeline: it writes facts and can mint entities,
 * exactly as the Enrich File button does. It is an observation window on a real
 * run, not a simulation of one.
 */
import { type Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import { runEnrichment } from "../connectors/enrichment";
import {
  buildEnrichmentProviderConfig,
  createEnrichmentEmbeddingProvider,
  createEnrichmentGenerator,
  resolveOpenRouterEnrichmentConfig,
} from "../connectors/enrichment-providers";
import type { GeminiGenerator } from "../connectors/gemini-generate";
import { createOpenRouterGenerator } from "../connectors/openrouter-generate";
import { mintTasksFromFile } from "../connectors/task-minting";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import type { DevTraceRun } from "../dev/enrichment-trace";
import {
  appendTraceStageReport,
  createTracedLogger,
  finishTraceRun,
  getTraceRun,
  listTraceRuns,
  startTraceRun,
} from "../dev/enrichment-trace";
import { listLlmDumpHeaders, readLlmDumpBody } from "../dev/llm-dump-reader";
import { getFileViewer } from "./auth-helpers";
import { resolveTaskAccessContext } from "./task-access";

const startRunSchema = z.object({
  fileId: z.string().min(1),
  kind: z.enum(["enrichment", "mint"]).default("enrichment"),
});

function requireAdmin(c: Context) {
  if (c.get("role") !== "admin") {
    return { error: { code: "FORBIDDEN", message: "Admin access required" } };
  }
  return null;
}

export function devEnrichmentRoutes(
  db: Kysely<DB>,
  logger: Logger,
  appConfig?: {
    ENCRYPTION_KEY?: string;
    GEMINI_MAX_RPM?: number;
    GEMINI_MAX_RETRIES?: number;
    OPENROUTER_API_KEY?: string;
    DATA_DIR?: string;
    LLM_TASK_CORROBORATION_THRESHOLD?: number;
    TASK_MINTING_MODEL?: string;
  },
  deps: { enrichmentGenerator?: GeminiGenerator } = {},
) {
  const routes = new Hono();

  /** Starts one traced run of a single file through either pipeline, and returns immediately. */
  routes.post("/runs", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const parsed = startRunSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", message: "fileId is required" } }, 400);
    }

    const file = await db
      .selectFrom("indexed_files")
      .select([
        "id",
        "file_name",
        "connector_config_id",
        "source",
        "content",
        "content_hash",
        "source_created_at",
        "source_updated_at",
      ])
      .where("id", "=", parsed.data.fileId)
      .executeTakeFirst();
    if (!file) {
      return c.json({ error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    }

    const settings = await createSettingsRepository(db, appConfig?.ENCRYPTION_KEY).get();
    const providerConfig = buildEnrichmentProviderConfig(settings, appConfig, logger);
    const generator = deps.enrichmentGenerator ?? createEnrichmentGenerator(providerConfig);
    if (!generator) {
      return c.json(
        { error: { code: "LLM_NOT_CONFIGURED", message: "Configure an enrichment model before tracing a run" } },
        503,
      );
    }
    const embeddingProvider = createEnrichmentEmbeddingProvider(providerConfig);

    const dumpStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dumpDir = `${appConfig?.DATA_DIR ?? "data"}/llm-dumps/${file.id}__${dumpStamp}`;
    const run = startTraceRun({ kind: parsed.data.kind, fileId: file.id, fileName: file.file_name, dumpDir });

    if (parsed.data.kind === "mint") {
      const openRouter = resolveOpenRouterEnrichmentConfig(settings, appConfig?.OPENROUTER_API_KEY);
      const mintModel = appConfig?.TASK_MINTING_MODEL;
      const mintGenerator =
        deps.enrichmentGenerator ??
        (mintModel
          ? openRouter.openRouterApiKey
            ? createOpenRouterGenerator(openRouter.openRouterApiKey, { model: mintModel })
            : null
          : generator);
      if (!mintGenerator) {
        return c.json(
          { error: { code: "LLM_NOT_CONFIGURED", message: "Configure a task-minting model before tracing a mint" } },
          503,
        );
      }
      const model =
        mintModel ??
        (settings?.gemini_api_key ? "gemini-2.5-flash" : openRouter.openRouterModel || "google/gemini-2.5-flash");
      void runMintTrace({
        c,
        db,
        logger,
        run,
        file,
        generator: mintGenerator,
        model,
        dumpDir,
        threshold: appConfig?.LLM_TASK_CORROBORATION_THRESHOLD,
      });
      return c.json({ runId: run.id, fileId: file.id, fileName: file.file_name }, 201);
    }

    void (async () => {
      try {
        const result = await runEnrichment({
          db,
          logger: createTracedLogger(logger.child({ component: "enrichment", fileId: file.id }), run),
          embeddingProvider,
          generator,
          geminiApiKey: settings?.gemini_api_key,
          geminiMaxRpm: appConfig?.GEMINI_MAX_RPM,
          geminiMaxRetries: appConfig?.GEMINI_MAX_RETRIES,
          fileIds: [file.id],
          debugDumpDir: dumpDir,
          forceSmartEnrichment: true,
          stageReport: (report) => appendTraceStageReport(run, report),
        });
        const failure = result.errors[0];
        const failedStage = run.stageReports.find((report) => report.status === "failed");
        if (run.status === "running") {
          if (failure) finishTraceRun(run, "failed", failure.error);
          else if (failedStage) finishTraceRun(run, "failed", failedStage.error ?? `${failedStage.label} failed`);
          else finishTraceRun(run, "done");
        }
      } catch (err) {
        if (run.status === "running") finishTraceRun(run, "failed", err);
        logger.error({ err, fileId: file.id }, "Traced enrichment run failed");
      } finally {
        if (run.status === "running") finishTraceRun(run, "failed", "Trace promise settled without a terminal result");
      }
    })();

    return c.json({ runId: run.id, fileId: file.id, fileName: file.file_name }, 201);
  });

  routes.get("/runs", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);
    return c.json({ runs: listTraceRuns() });
  });

  /** `since` returns only steps after that sequence number, so the client can poll cheaply. */
  routes.get("/runs/:id", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const run = getTraceRun(c.req.param("id"));
    if (!run) {
      return c.json({ error: { code: "NOT_FOUND", message: "Run not found or evicted" } }, 404);
    }

    const since = Number(c.req.query("since") ?? 0) || 0;
    const { steps, stageReports, ...header } = run;
    return c.json({
      run: { ...header, stepCount: steps.length },
      steps: since > 0 ? steps.filter((step) => step.seq > since) : steps,
      stageReports,
    });
  });

  routes.get("/runs/:id/calls", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const run = getTraceRun(c.req.param("id"));
    if (!run) {
      return c.json({ error: { code: "NOT_FOUND", message: "Run not found or evicted" } }, 404);
    }

    return c.json({ calls: await listLlmDumpHeaders(run.dumpDir) });
  });

  routes.get("/runs/:id/calls/:seq", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const run = getTraceRun(c.req.param("id"));
    if (!run) {
      return c.json({ error: { code: "NOT_FOUND", message: "Run not found or evicted" } }, 404);
    }

    const seq = Number(c.req.param("seq"));
    if (!Number.isInteger(seq) || seq < 1) {
      return c.json({ error: { code: "INVALID_SEQ", message: "Call sequence must be a positive integer" } }, 400);
    }
    const call = await readLlmDumpBody(run.dumpDir, seq);
    if (!call) {
      return c.json({ error: { code: "NOT_FOUND", message: "Call not found" } }, 404);
    }
    return c.json({ call });
  });

  return routes;
}

/**
 * Runs one file through task minting under the same trace ring as enrichment.
 *
 * Minting is normally a foreground request that returns its report to the
 * caller. Here it is driven in the background so both pipelines share one run
 * shape, one poll loop and one dump reader on the client.
 */
async function runMintTrace(args: {
  c: Context;
  db: Kysely<DB>;
  logger: Logger;
  run: DevTraceRun;
  file: {
    id: string;
    file_name: string;
    connector_config_id: string;
    source: string;
    content: string | null;
    content_hash: string | null;
    source_created_at: string | null;
    source_updated_at: string | null;
  };
  generator: GeminiGenerator;
  model: string;
  dumpDir: string;
  threshold?: number;
}): Promise<void> {
  const { c, db, logger, run, file, generator, dumpDir } = args;
  try {
    const userId = c.get("sub") as string;
    const taskAccess = await resolveTaskAccessContext(db, c, userId);
    await mintTasksFromFile({
      db,
      logger: createTracedLogger(logger.child({ component: "task-minting", fileId: file.id }), run),
      file: {
        id: file.id,
        connectorConfigId: file.connector_config_id,
        fileName: file.file_name,
        source: file.source,
        content: file.content ?? "",
        contentHash: file.content_hash,
        sourceCreatedAt: file.source_created_at,
        sourceUpdatedAt: file.source_updated_at,
      },
      userId,
      viewer: getFileViewer(c),
      taskAccess,
      generator,
      model: args.model,
      dumpDir,
      llmTaskCorroborationThreshold: args.threshold,
      stageReport: (report) => appendTraceStageReport(run, report),
    });
    const failedStage = run.stageReports.find((report) => report.status === "failed");
    if (run.status === "running") {
      if (failedStage) finishTraceRun(run, "failed", failedStage.error ?? `${failedStage.label} failed`);
      else finishTraceRun(run, "done");
    }
  } catch (err) {
    if (run.status === "running") finishTraceRun(run, "failed", err);
    logger.error({ err, fileId: file.id }, "Traced mint run failed");
  } finally {
    if (run.status === "running") finishTraceRun(run, "failed", "Trace promise settled without a terminal result");
  }
}
