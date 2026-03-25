/**
 * Validates and exports typed configuration from environment variables.
 * Uses zod for schema validation and dotenv for .env file loading.
 * Fails fast on startup with all errors printed at once.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import "dotenv/config";

export const configSchema = z.object({
  // Database
  DB_TYPE: z.enum(["sqlite", "postgres"]).default("sqlite"),
  SQLITE_PATH: z.string().default("./data/sketch.db"),
  DATABASE_URL: z.string().optional(),

  // Slack context
  SLACK_CHANNEL_HISTORY_LIMIT: z.coerce.number().default(5),
  SLACK_THREAD_HISTORY_LIMIT: z.coerce.number().default(50),

  // Files
  MAX_FILE_SIZE_MB: z.coerce.number().default(20),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(50),

  // Slack mode
  SLACK_MODE: z.enum(["socket", "http"]).default("socket"),
  SLACK_SIGNING_SECRET: z.string().optional(),

  // Security
  ENCRYPTION_KEY: z.string().optional(),
  SYSTEM_SECRET: z.string().optional(),

  // Bootstrap (managed seed)
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD_HASH: z.string().optional(),
  BOOTSTRAP_SLACK_BOT_TOKEN: z.string().optional(),

  // Managed mode
  MANAGED_URL: z.string().optional(),
  MANAGED_AUTH_SECRET: z.string().optional(),

  // Server
  // Public-facing base URL (used for OAuth redirect URIs, email links, etc.)
  // e.g. https://sketch.yourcompany.com — no trailing slash
  BASE_URL: z.string().optional(),
  DATA_DIR: z.string().default("./data"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid configuration:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  const config = result.data;

  // Resolve relative paths against the project root (dirname of .env file)
  // so they work regardless of cwd (e.g. when concurrently runs from packages/server/).
  const projectRoot = process.env.DOTENV_CONFIG_PATH ? dirname(process.env.DOTENV_CONFIG_PATH) : process.cwd();
  if (!isAbsolute(config.DATA_DIR)) {
    config.DATA_DIR = resolve(projectRoot, config.DATA_DIR);
  }
  if (!isAbsolute(config.SQLITE_PATH)) {
    config.SQLITE_PATH = resolve(projectRoot, config.SQLITE_PATH);
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
  if (config.SLACK_MODE === "http" && !config.SLACK_SIGNING_SECRET) {
    console.error("SLACK_MODE=http requires SLACK_SIGNING_SECRET");
    process.exit(1);
  }
}
