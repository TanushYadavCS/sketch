/**
 * Validates and exports typed configuration from environment variables.
 * Uses zod for schema validation and dotenv for .env file loading.
 * Fails fast on startup with all errors printed at once.
 */
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import "dotenv/config";

export const configSchema = z.object({
  // Database
  DB_TYPE: z.enum(["sqlite", "postgres"]).default("sqlite"),
  SQLITE_PATH: z.string().default("./data/sketch.db"),
  DATABASE_URL: z.string().optional(),
  POSTGRES_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),

  // Slack context
  SLACK_CHANNEL_HISTORY_LIMIT: z.coerce.number().default(5),
  SLACK_THREAD_HISTORY_LIMIT: z.coerce.number().default(50),
  MAX_CONCURRENT_INTERACTIVE_AGENT_RUNS: z.coerce.number().int().min(1).default(4),
  MAX_CONCURRENT_SCHEDULED_AGENT_RUNS: z.coerce.number().int().min(1).default(4),
  AGENT_MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).default(600000),
  AGENT_RUN_WATCHDOG_MS: z.coerce.number().int().min(1).default(900000),

  // Files
  MAX_FILE_SIZE_MB: z.coerce.number().default(20),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(50),
  MAX_ATTACHMENT_TOTAL_MB: z.coerce.number().default(30),

  // Feature flags
  SLACK_ENTITY_SYNC: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  SLACK_ENTITY_SYNC_PUBLIC_CHANNELS: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  SLACK_ENTITY_SYNC_USER_INFO_CAP: z.coerce.number().int().min(1).default(1000),
  SLACK_ENTITY_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(7 * 24 * 60 * 60 * 1000),
  SLACK_ENTITY_EVENT_SILENCE_THRESHOLD_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(7 * 24 * 60 * 60 * 1000),
  BIRTH_GATE_DRY_RUN: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  WEEKLY_MINT_MODE: z.enum(["off", "shadow", "live", "manual"]).default("off"),
  WEEKLY_MINT_JUDGE_MODE: z.enum(["single", "agentic"]).default("single"),
  WEEKLY_MINT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(7 * 24 * 60 * 60 * 1000),
  VISION_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /**
   * Mounts the internal pipeline-debugging routes under /api/dev and the
   * /dev-tools page. Off everywhere except our own deployments — a tenant
   * should have no route to find.
   */
  DEV_TOOLS_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  GRAPH_CURATION_TOOLS_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  VISION_MODEL: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  OPENROUTER_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  OPENROUTER_PRICE_TTL_HOURS: z.coerce.number().min(1).default(12),
  TASK_MINTING_MODEL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z
      .string()
      .trim()
      .regex(/^[^\s/]+\/\S+$/, "Expected a complete OpenRouter model ID")
      .optional(),
  ),
  PROJECT_MINTING_MODEL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z
      .string()
      .trim()
      .regex(/^[^\s/]+\/\S+$/, "Expected a complete OpenRouter model ID")
      .optional(),
  ),
  CONTAINER_CLASSIFICATION_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // Entity materialization
  LLM_PROMOTION_THRESHOLD: z.coerce.number().int().min(1).default(2),
  LLM_TASK_CORROBORATION_THRESHOLD: z.coerce.number().int().min(1).default(2),
  CO_MENTION_CONTRIBUTES_TO_THRESHOLD: z.coerce.number().int().min(2).default(3),
  FLOOR_RETRY_MAX_FILES_PER_DOMAIN: z.coerce.number().int().min(1).default(5000),
  GEMINI_MAX_RPM: z.coerce.number().int().min(1).default(60),
  GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).default(4),
  AGENT_RUNTIME: z.enum(["sdk", "aisdk"]).default("aisdk"),

  // Sync reconciliation
  SYNC_ALLOW_LARGE_RECONCILE: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  SYNC_MAX_RECONCILE_RATIO: z.coerce.number().min(0).max(1).default(0.5),

  // Slack mode
  SLACK_MODE: z.enum(["socket", "http"]).default("socket"),
  SLACK_SIGNING_SECRET: z.string().optional(),

  // WhatsApp providers
  WHATSAPP_DM_PROVIDER: z.preprocess((v) => (v === "" ? undefined : v), z.string().default("baileys")),
  WHATSAPP_GROUP_PROVIDER: z.preprocess((v) => (v === "" ? undefined : v), z.string().default("baileys")),
  WHATSAPP_RUNTIME_MODE: z.enum(["inprocess", "gateway"]).default("inprocess"),
  WHATSAPP_GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(3901),
  WATI_API_ENDPOINT: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  WATI_ACCESS_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  WATI_WEBHOOK_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  WATI_CHANNEL_PHONE_NUMBER: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  MANAGED_WHATSAPP_PLATFORM_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  MANAGED_WHATSAPP_TENANT_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  WHATSAPP_HISTORY_LOOKBACK_DAYS: z.coerce.number().int().min(1).default(30),
  WHATSAPP_CHUNK_WINDOW_MESSAGES: z.coerce.number().int().min(1).default(250),
  WHATSAPP_CHUNK_WINDOW_TOKENS: z.coerce.number().int().min(1).default(7500),
  WHATSAPP_CHUNK_MIN_MESSAGES: z.coerce.number().int().min(1).default(10),
  WHATSAPP_CHUNK_TARGET_MESSAGES: z.coerce.number().int().min(1).default(40),
  WHATSAPP_CHUNK_MAX_MESSAGES: z.coerce.number().int().min(1).default(80),
  WHATSAPP_CHUNK_MAX_TOKENS: z.coerce.number().int().min(1).default(1500),
  WHATSAPP_CHUNK_TICK_MINUTES: z.coerce.number().int().min(1).default(30),
  WHATSAPP_CHUNK_IDLE_CLOSE_HOURS: z.coerce.number().int().min(1).default(96),
  WHATSAPP_CHUNK_PROVISIONAL_REFRESH_MESSAGES: z.coerce.number().int().min(1).default(15),
  WHATSAPP_CHUNK_MODEL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().nullable().default(null),
  ),
  WHATSAPP_CHUNK_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("high"),
  WHATSAPP_CHUNK_BURST_THRESHOLD_MESSAGES: z.preprocess(
    (value) => (value === "" ? null : value),
    z.coerce.number().int().min(1).nullable().default(null),
  ),
  WHATSAPP_CHUNK_TOPIC_REGISTRY_CAP: z.coerce.number().int().min(1).default(30),
  WHATSAPP_CHUNK_GROUP_WORKER_POOL: z.coerce.number().int().min(1).default(4),
  WHATSAPP_SLICE_GAP_MINUTES: z.coerce.number().int().min(1).default(25),
  WHATSAPP_SLICE_MAX_AGE_MINUTES: z.coerce.number().int().min(1).default(120),
  WHATSAPP_SLICE_MAX_MESSAGES: z.coerce.number().int().min(1).default(50),
  WHATSAPP_SALIENCE_BATCH_LIMIT: z.coerce.number().int().min(1).default(50),
  WHATSAPP_EMISSION_REFRESH_DAYS: z.coerce.number().int().min(1).default(7),
  WHATSAPP_BACKFILL_GRAPH_PAGE_MESSAGES: z.coerce.number().int().min(1).default(500),
  WHATSAPP_BACKFILL_GRAPH_PAGE_TOKENS: z.coerce.number().int().min(1).default(20_000),
  WHATSAPP_BACKFILL_GRAPH_CYCLE_MESSAGES: z.coerce.number().int().min(1).default(1500),
  WHATSAPP_BACKFILL_GRAPH_PENDING_SLICES_MAX: z.coerce.number().int().min(0).default(200),
  WHATSAPP_BACKFILL_GRAPH_PENDING_FILES_MAX: z.coerce.number().int().min(0).default(500),
  WHATSAPP_BACKFILL_GRAPH_OPEN_FACTS_MAX: z.coerce.number().int().min(0).default(5000),
  WHATSAPP_WINDOW_KEEPALIVE_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // Security
  ENCRYPTION_KEY: z.string().optional(),
  SYSTEM_SECRET: z.string().optional(),

  // Bootstrap (managed seed)
  BOOTSTRAP_ADMIN_EMAIL: z.preprocess((v) => (v === "" ? undefined : v), z.string().email().optional()),
  BOOTSTRAP_ADMIN_PASSWORD_HASH: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  BOOTSTRAP_SLACK_BOT_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),

  // Managed mode
  MANAGED_URL: z.string().optional(),
  MANAGED_AUTH_SECRET: z.string().optional(),
  CONNECTOR_CREDENTIAL_SOURCE: z.enum(["local", "canvas"]).default("local"),
  CANVAS_CREDENTIAL_PRIVATE_KEY_PEM: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  CANVAS_CREDENTIAL_PRIVATE_KEY_PATH: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  CANVAS_CREDENTIAL_PUBLIC_KEY_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),

  // Zoho CRM OAuth
  ZOHO_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  ZOHO_CLIENT_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),

  // Microsoft OAuth fallback (workspace settings can override these)
  MICROSOFT_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  MICROSOFT_CLIENT_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  MICROSOFT_TENANT: z.preprocess((v) => (v === "" ? undefined : v), z.string().default("common")),
  OUTLOOK_INITIAL_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
  OUTLOOK_MAX_INFLIGHT: z.coerce.number().int().min(1).max(16).default(4),
  TEAMS_INITIAL_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
  TEAMS_MAX_INFLIGHT: z.coerce.number().int().min(1).max(16).default(4),
  TEAMS_PROCESSING_LAG_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60 * 60 * 1000)
    .default(2 * 60 * 60 * 1000),

  // PostHog (optional, enables LLM Analytics via OpenTelemetry)
  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().default("https://us.i.posthog.com"),

  CLAUDE_CONFIG_DIR: z.string().default(join(homedir(), ".claude")),
  SKETCH_CONFIG_DIR: z.string().default(join(homedir(), ".sketch")),

  // Server
  // Public-facing base URL (used for OAuth redirect URIs, email links, etc.)
  // e.g. https://sketch.yourcompany.com — no trailing slash
  BASE_URL: z.string().optional(),
  DATA_DIR: z.string().default("./data"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parses and validates env into a typed Config, failing fast with all errors.
 * Relative path settings (DATA_DIR, SQLITE_PATH, the config dirs) resolve
 * against the project root (the .env file's directory, via DOTENV_CONFIG_PATH)
 * rather than cwd, so they hold regardless of where the process is launched
 * (e.g. when `concurrently` runs it from packages/server/).
 */
export function loadConfig(): Config {
  if (process.env.MAX_CONCURRENT_AGENT_RUNS !== undefined) {
    console.error("Invalid configuration:");
    console.error(
      "  MAX_CONCURRENT_AGENT_RUNS: replaced by MAX_CONCURRENT_INTERACTIVE_AGENT_RUNS and MAX_CONCURRENT_SCHEDULED_AGENT_RUNS",
    );
    process.exit(1);
  }
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid configuration:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  const config = result.data;

  const projectRoot = process.env.DOTENV_CONFIG_PATH ? dirname(process.env.DOTENV_CONFIG_PATH) : process.cwd();
  if (!isAbsolute(config.DATA_DIR)) {
    config.DATA_DIR = resolve(projectRoot, config.DATA_DIR);
  }
  if (!isAbsolute(config.SQLITE_PATH)) {
    config.SQLITE_PATH = resolve(projectRoot, config.SQLITE_PATH);
  }
  if (!isAbsolute(config.CLAUDE_CONFIG_DIR)) {
    config.CLAUDE_CONFIG_DIR = resolve(projectRoot, config.CLAUDE_CONFIG_DIR);
  }
  if (!isAbsolute(config.SKETCH_CONFIG_DIR)) {
    config.SKETCH_CONFIG_DIR = resolve(projectRoot, config.SKETCH_CONFIG_DIR);
  }

  return config;
}

/**
 * Semantic validation that can't be expressed in zod schema alone.
 * Checks cross-field dependencies after loadConfig() succeeds.
 */
export function validateConfig(config: Config): void {
  if (config.DB_TYPE === "postgres" && !config.DATABASE_URL) {
    console.error("DB_TYPE=postgres requires DATABASE_URL");
    process.exit(1);
  }
  if (config.AGENT_RUN_WATCHDOG_MS <= config.AGENT_MODEL_REQUEST_TIMEOUT_MS) {
    console.error(
      "AGENT_RUN_WATCHDOG_MS must exceed AGENT_MODEL_REQUEST_TIMEOUT_MS so a stalled request fails on its own deadline before the watchdog reports the run as slow",
    );
    process.exit(1);
  }
  if (config.SLACK_MODE === "http" && !config.SLACK_SIGNING_SECRET) {
    console.error("SLACK_MODE=http requires SLACK_SIGNING_SECRET");
    process.exit(1);
  }
  if (config.WHATSAPP_DM_PROVIDER === "wati") {
    if (!config.WATI_API_ENDPOINT) {
      console.error("WHATSAPP_DM_PROVIDER=wati requires WATI_API_ENDPOINT");
      process.exit(1);
    }
    if (!config.WATI_ACCESS_TOKEN) {
      console.error("WHATSAPP_DM_PROVIDER=wati requires WATI_ACCESS_TOKEN");
      process.exit(1);
    }
    if (!config.WATI_WEBHOOK_TOKEN) {
      console.error("WHATSAPP_DM_PROVIDER=wati requires WATI_WEBHOOK_TOKEN");
      process.exit(1);
    }
  }
  if (config.WHATSAPP_DM_PROVIDER === "managed") {
    if (!config.MANAGED_WHATSAPP_PLATFORM_URL) {
      console.error("WHATSAPP_DM_PROVIDER=managed requires MANAGED_WHATSAPP_PLATFORM_URL");
      process.exit(1);
    }
    if (!config.MANAGED_WHATSAPP_TENANT_TOKEN) {
      console.error("WHATSAPP_DM_PROVIDER=managed requires MANAGED_WHATSAPP_TENANT_TOKEN");
      process.exit(1);
    }
  }
}
