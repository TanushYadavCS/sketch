import { randomUUID } from "node:crypto";
import { generateText } from "ai";
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
import { createAgentRuntimeProvider, resolveAgentRuntimeProviderConfigFromSettings } from "../agent/runtime/provider";
import { handleSearch } from "../agent/tools/search";
import type { SketchMcpDeps } from "../agent/tools/types";
import { runEnrichment } from "../connectors/enrichment";
import {
  buildEnrichmentProviderConfig,
  createEnrichmentEmbeddingProvider,
  createEnrichmentGenerator,
  resolveOpenRouterEnrichmentConfig,
} from "../connectors/enrichment-providers";
import type { GeminiGenerator } from "../connectors/gemini-generate";
import { createOpenRouterGenerator } from "../connectors/openrouter-generate";
import { SEARCHABLE_SOURCES } from "../connectors/search";
import { mintTasksFromFile } from "../connectors/task-minting";
import { createDevSearchTraceRepository } from "../db/repositories/dev-search-traces";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
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

const searchRunSchema = z.object({
  query: z.string().optional(),
  entityIds: z.array(z.string()).optional(),
  entityIdsMode: z.enum(["and", "or"]).optional(),
  kind: z.enum(["meeting", "doc", "task", "message"]).optional(),
  source: z.enum(SEARCHABLE_SOURCES).optional(),
  sortBy: z.enum(["relevance", "recency"]).optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().optional(),
});

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
    SLACK_ENTITY_SYNC?: boolean;
  },
  deps: { enrichmentGenerator?: GeminiGenerator; taskMintingGenerator?: GeminiGenerator } = {},
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

    const dumpStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dumpDir = `${appConfig?.DATA_DIR ?? "data"}/llm-dumps/${file.id}__${dumpStamp}`;

    if (parsed.data.kind === "mint") {
      const openRouter = resolveOpenRouterEnrichmentConfig(settings, appConfig?.OPENROUTER_API_KEY);
      const mintModel = appConfig?.TASK_MINTING_MODEL;
      const mintGenerator =
        deps.taskMintingGenerator ??
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
      const run = startTraceRun({ kind: "mint", fileId: file.id, fileName: file.file_name, dumpDir });
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

    if (!generator) {
      return c.json(
        { error: { code: "LLM_NOT_CONFIGURED", message: "Configure an enrichment model before tracing a run" } },
        503,
      );
    }
    const embeddingProvider = createEnrichmentEmbeddingProvider(providerConfig);
    const run = startTraceRun({ kind: "enrichment", fileId: file.id, fileName: file.file_name, dumpDir });

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

  /**
   * Runs one `Search` from the dev-tools tab, through the very same traced core the agent
   * uses, and returns the finished trace.
   *
   * This is not a simulation: `Search` is a pure read, so running it here executes the real
   * pipeline against the real index and records a real trace. The only difference from an
   * agent's own search is the `dev_tools` origin, which is what lets the feed tell a test
   * run apart from live traffic.
   *
   * Principals are the calling admin's own, so the trace answers "what would I see". To
   * ask what another user would see, open that user's own search from the feed.
   */
  routes.post("/search-runs", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const parsed = searchRunSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_BODY", message: parsed.error.issues[0]?.message ?? "Invalid" } }, 400);
    }

    const traceId = randomUUID();
    const deps = {
      db,
      logger,
      currentUserId: c.get("sub") as string,
      userRepo: createUserRepository(db, { slackEntitySyncEnabled: appConfig?.SLACK_ENTITY_SYNC }),
      slackEntitySyncEnabled: appConfig?.SLACK_ENTITY_SYNC,
      devToolsEnabled: true,
      devSearchTraceId: traceId,
      geminiConfig: { maxRpm: appConfig?.GEMINI_MAX_RPM, maxRetries: appConfig?.GEMINI_MAX_RETRIES },
      openRouterApiKey: appConfig?.OPENROUTER_API_KEY,
      settingsEncryptionKey: appConfig?.ENCRYPTION_KEY,
    } as unknown as SketchMcpDeps;

    await handleSearch(parsed.data, deps, "dev_tools");

    /**
     * The trace write is fire-and-forget everywhere else, so the id is pre-assigned above
     * and read back here rather than guessing at the newest row.
     */
    const repo = createDevSearchTraceRepository(db);
    for (let attempt = 0; attempt < 40; attempt++) {
      const trace = await repo.get(traceId);
      if (trace) return c.json({ trace }, 201);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return c.json(
      { error: { code: "TRACE_NOT_WRITTEN", message: "The search ran but its trace was not stored" } },
      500,
    );
  });

  /**
   * Captured traces of real `Search` calls. There is no POST: nothing is started here,
   * only observed. Traces exist only for searches made while `DEV_TOOLS_ENABLED` was on,
   * which the client states plainly rather than rendering an empty list.
   */
  routes.get("/search-traces", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);
    return c.json({ traces: await createDevSearchTraceRepository(db).list() });
  });

  routes.get("/search-traces/:id/syntheses", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);
    return c.json({ syntheses: await createDevSearchTraceRepository(db).listSyntheses(c.req.param("id")) });
  });

  routes.get("/syntheses/:id", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);
    const synthesis = await createDevSearchTraceRepository(db).getSynthesis(c.req.param("id"));
    if (!synthesis) return c.json({ error: { code: "NOT_FOUND", message: "Synthesis not found" } }, 404);
    return c.json({ synthesis });
  });

  /**
   * Runs one synthesis over a stored trace. POST only, and nothing else on this router
   * calls the model — opening or listing a trace must never spend an LLM call.
   */
  routes.post("/search-traces/:id/syntheses", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const repo = createDevSearchTraceRepository(db);
    const trace = await repo.get(c.req.param("id"));
    if (!trace) return c.json({ error: { code: "NOT_FOUND", message: "Trace not found" } }, 404);
    if (trace.results.length === 0) {
      return c.json({ error: { code: "NO_RESULTS", message: "This trace returned nothing to synthesise from" } }, 400);
    }
    if (!trace.query.trim()) {
      return c.json({ error: { code: "NO_QUERY", message: "Filter-only trace has no question to answer" } }, 400);
    }

    /**
     * The encryption key is required, not optional: provider keys set through the settings
     * UI are stored `enc:`-prefixed, and reading them without it throws before the
     * `generateText` try/catch below — losing the run instead of recording it as failed.
     */
    const settings = await createSettingsRepository(db, appConfig?.ENCRYPTION_KEY).get();
    const providerConfig = resolveAgentRuntimeProviderConfigFromSettings(settings);
    if (!providerConfig) {
      return c.json({ error: { code: "NO_PROVIDER", message: "No LLM provider is configured" } }, 400);
    }
    const provider = createAgentRuntimeProvider(providerConfig);

    /**
     * `agentText`, not the raw rows: the tool cuts each result to 200 characters before
     * the agent sees it, so synthesising from the untruncated text would answer from
     * material the agent never had and flatter the retrieval.
     */
    const prompt = [
      `Question: ${trace.query}`,
      "",
      "Search returned these results, exactly as the agent received them:",
      "",
      ...trace.results.map((row) => row.agentText),
      "",
      "Answer the question using only the text above.",
      "If it does not contain the answer, say so plainly and name what is missing.",
    ].join("\n");

    const startedAt = Date.now();
    let answer: string | null = null;
    let error: string | null = null;
    try {
      const result = await generateText({ model: provider.model, prompt });
      answer = result.text;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const id = await repo.recordSynthesis({
      traceId: trace.id,
      provider: provider.provider,
      model: provider.modelId,
      prompt,
      answer,
      status: error ? "failed" : "done",
      error,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ synthesis: await repo.getSynthesis(id) }, error ? 502 : 201);
  });

  routes.get("/search-traces/:id", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);
    const trace = await createDevSearchTraceRepository(db).get(c.req.param("id"));
    if (!trace) {
      return c.json({ error: { code: "NOT_FOUND", message: "Trace not found" } }, 404);
    }
    return c.json({ trace });
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
