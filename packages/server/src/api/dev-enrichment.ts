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
} from "../connectors/enrichment-providers";
import type { GeminiGenerator } from "../connectors/gemini-generate";
import { createSettingsRepository } from "../db/repositories/settings";
import type { DB } from "../db/schema";
import {
  appendTraceStageReport,
  createTracedLogger,
  finishTraceRun,
  getTraceRun,
  listTraceRuns,
  startTraceRun,
} from "../dev/enrichment-trace";
import { listLlmDumpHeaders, readLlmDumpBody } from "../dev/llm-dump-reader";

const startRunSchema = z.object({ fileId: z.string().min(1) });

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
  },
  deps: { enrichmentGenerator?: GeminiGenerator } = {},
) {
  const routes = new Hono();

  /** Starts one traced enrichment of a single file and returns immediately. */
  routes.post("/enrichment-runs", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const parsed = startRunSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", message: "fileId is required" } }, 400);
    }

    const file = await db
      .selectFrom("indexed_files")
      .select(["id", "file_name"])
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
    const run = startTraceRun({ fileId: file.id, fileName: file.file_name, dumpDir });

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

  routes.get("/enrichment-runs", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);
    return c.json({ runs: listTraceRuns() });
  });

  /** `since` returns only steps after that sequence number, so the client can poll cheaply. */
  routes.get("/enrichment-runs/:id", async (c) => {
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

  routes.get("/enrichment-runs/:id/calls", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const run = getTraceRun(c.req.param("id"));
    if (!run) {
      return c.json({ error: { code: "NOT_FOUND", message: "Run not found or evicted" } }, 404);
    }

    return c.json({ calls: await listLlmDumpHeaders(run.dumpDir) });
  });

  routes.get("/enrichment-runs/:id/calls/:seq", async (c) => {
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
