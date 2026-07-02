import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../config";
import { runEnrichment } from "../connectors/enrichment";
import {
  createEnrichmentEmbeddingProvider,
  createEnrichmentGenerator,
  resolveOpenRouterEnrichmentConfig,
} from "../connectors/enrichment-providers";
import { type createSettingsRepository, parseOrgContext, serializeOrgContext } from "../db/repositories/settings";
import type { DB } from "../db/schema";

const searchConfigSchema = z.object({
  geminiApiKey: z.string().trim().nullable().optional(),
  embeddingProvider: z.enum(["openrouter", "gemini"]).nullable().optional(),
  enrichmentEnabled: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(5).max(1440).optional(),
});

const identityUpdateSchema = z.object({
  orgName: z.string().trim().min(1).max(200).optional(),
  orgContext: z
    .object({
      description: z.string().trim().max(2000).optional(),
      industry: z.string().trim().max(80).optional(),
      disambiguationGuidance: z.string().trim().max(2000).optional(),
    })
    .optional(),
});

const accessUpdateSchema = z.object({
  adminCanReadAllFiles: z.boolean(),
});

type SettingsRepo = ReturnType<typeof createSettingsRepository>;

function generateSketchApiKey(): string {
  return `sk_live_${randomBytes(32).toString("base64url")}`;
}

function requireAdmin(c: Context) {
  if (c.get("role") !== "admin") {
    return { error: { code: "FORBIDDEN", message: "Admin access required" } };
  }
  return null;
}

export function settingsRoutes(
  settings: SettingsRepo,
  db?: Kysely<DB>,
  logger?: Logger,
  config?: Pick<Config, "GEMINI_MAX_RPM" | "GEMINI_MAX_RETRIES" | "OPENROUTER_API_KEY" | "EXPERIMENTAL_FLAG">,
) {
  const routes = new Hono();

  routes.get("/identity", async (c) => {
    const row = await settings.get();

    return c.json({
      orgName: row?.org_name ?? null,
      botName: row?.bot_name ?? "Sketch",
      orgContext: parseOrgContext(row?.org_context),
    });
  });

  routes.put("/identity", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const body = await c.req.json().catch(() => ({}));
    const parsed = identityUpdateSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const updates: Parameters<typeof settings.update>[0] = {};
    if (parsed.data.orgName !== undefined) updates.orgName = parsed.data.orgName;
    if (parsed.data.orgContext !== undefined) {
      updates.orgContext = serializeOrgContext(parsed.data.orgContext);
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "No updates provided" } }, 400);
    }

    await settings.update(updates);
    const row = await settings.get();
    return c.json({
      orgName: row?.org_name ?? null,
      botName: row?.bot_name ?? "Sketch",
      orgContext: parseOrgContext(row?.org_context),
    });
  });

  routes.get("/search", async (c) => {
    const row = await settings.get();
    return c.json({
      geminiApiKeyConfigured: !!row?.gemini_api_key,
      embeddingProvider: row?.embedding_provider ?? null,
      enrichmentEnabled: row?.enrichment_enabled ?? 1,
      syncIntervalMinutes: row?.sync_interval_minutes ?? 30,
    });
  });

  routes.put("/search", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = searchConfigSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    const current = await settings.get();
    const updates: Parameters<typeof settings.update>[0] = {};
    if (parsed.data.geminiApiKey !== undefined) updates.geminiApiKey = parsed.data.geminiApiKey;
    if (parsed.data.embeddingProvider !== undefined) updates.embeddingProvider = parsed.data.embeddingProvider;
    if (
      parsed.data.embeddingProvider === undefined &&
      parsed.data.geminiApiKey != null &&
      parsed.data.geminiApiKey.length > 0 &&
      current?.embedding_provider == null
    ) {
      updates.embeddingProvider = "gemini";
    }
    if (parsed.data.enrichmentEnabled !== undefined) updates.enrichmentEnabled = parsed.data.enrichmentEnabled ? 1 : 0;
    if (parsed.data.syncIntervalMinutes !== undefined) updates.syncIntervalMinutes = parsed.data.syncIntervalMinutes;

    await settings.update(updates);
    const row = await settings.get();
    return c.json({
      geminiApiKeyConfigured: !!row?.gemini_api_key,
      embeddingProvider: row?.embedding_provider ?? null,
      enrichmentEnabled: row?.enrichment_enabled ?? 1,
      syncIntervalMinutes: row?.sync_interval_minutes ?? 30,
    });
  });

  routes.post("/search/enrichments", async (c) => {
    if (!db || !logger) {
      return c.json({ error: { code: "NOT_AVAILABLE", message: "Enrichment not available" } }, 500);
    }

    const row = await settings.get();
    if (row?.enrichment_enabled === 0) {
      return c.json({ error: { code: "DISABLED", message: "Enrichment is disabled" } }, 400);
    }

    const openRouterConfig = resolveOpenRouterEnrichmentConfig(row, config?.OPENROUTER_API_KEY);
    const providerConfig = {
      geminiApiKey: row?.gemini_api_key,
      embeddingProvider: row?.embedding_provider,
      geminiMaxRpm: config?.GEMINI_MAX_RPM,
      geminiMaxRetries: config?.GEMINI_MAX_RETRIES,
      logger,
      ...openRouterConfig,
    };
    const embeddingProvider = createEnrichmentEmbeddingProvider(providerConfig);
    const generator = createEnrichmentGenerator(providerConfig);

    // Run in background
    runEnrichment({
      db,
      logger: logger.child({ component: "enrichment" }),
      embeddingProvider,
      generator,
      geminiApiKey: row?.gemini_api_key,
      geminiMaxRpm: config?.GEMINI_MAX_RPM,
      geminiMaxRetries: config?.GEMINI_MAX_RETRIES,
      experimentalFlag: config?.EXPERIMENTAL_FLAG,
    }).catch((err) => {
      logger.error({ err }, "Manual enrichment run failed");
    });

    return c.json({ success: true, message: "Enrichment started" });
  });

  routes.get("/access", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const row = await settings.get();
    return c.json({
      adminCanReadAllFiles: row?.admin_can_read_all_files === 1,
    });
  });

  routes.put("/access", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const body = await c.req.json().catch(() => ({}));
    const parsed = accessUpdateSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
    }

    await settings.update({ adminCanReadAllFiles: parsed.data.adminCanReadAllFiles });
    return c.json({ adminCanReadAllFiles: parsed.data.adminCanReadAllFiles });
  });

  routes.get("/api-key", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    const row = await settings.get();
    return c.json({
      configured: !!row?.sketch_api_key,
      apiKey: row?.sketch_api_key ?? null,
    });
  });

  routes.post("/api-key", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    if (!(await settings.get())) {
      await settings.create();
    }
    const apiKey = generateSketchApiKey();
    await settings.update({ sketchApiKey: apiKey });
    return c.json({ configured: true, apiKey });
  });

  routes.delete("/api-key", async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return c.json(forbidden, 403);

    await settings.update({ sketchApiKey: null });
    return c.json({ success: true });
  });

  return routes;
}
