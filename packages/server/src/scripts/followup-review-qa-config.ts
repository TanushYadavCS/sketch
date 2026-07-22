import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

export function assertFollowupReviewQaDatabasePath(sqlitePath: string, projectRoot = PROJECT_ROOT): void {
  const manualQaRoot = resolve(projectRoot, "data", "manual-qa");
  if (!isWithin(manualQaRoot, resolve(sqlitePath))) {
    throw new Error(`Follow-up review QA database must be inside ${manualQaRoot}.`);
  }
}

export function assertFollowupReviewQaPaths(config: Config, projectRoot = PROJECT_ROOT): void {
  const manualQaRoot = resolve(projectRoot, "data", "manual-qa");
  const dataDir = resolve(config.DATA_DIR);
  const sqlitePath = resolve(config.SQLITE_PATH);
  if (config.DB_TYPE !== "sqlite") {
    throw new Error("Follow-up review QA requires DB_TYPE=sqlite.");
  }
  if (!isWithin(manualQaRoot, dataDir)) {
    throw new Error(`Follow-up review QA DATA_DIR must be inside ${manualQaRoot}.`);
  }
  if (!isWithin(dataDir, sqlitePath)) {
    throw new Error("Follow-up review QA SQLITE_PATH must be inside its QA DATA_DIR.");
  }
  assertFollowupReviewQaDatabasePath(sqlitePath, projectRoot);
}

export function createFollowupReviewQaConfig(config: Config): Config {
  return {
    ...config,
    OPENROUTER_API_KEY: undefined,
    VISION_ENABLED: false,
    SLACK_MODE: "socket",
    SLACK_SIGNING_SECRET: undefined,
    WHATSAPP_DM_PROVIDER: "baileys",
    WHATSAPP_GROUP_PROVIDER: "baileys",
    WHATSAPP_RUNTIME_MODE: "inprocess",
    WATI_API_ENDPOINT: undefined,
    WATI_ACCESS_TOKEN: undefined,
    WATI_WEBHOOK_TOKEN: undefined,
    WATI_CHANNEL_PHONE_NUMBER: undefined,
    MANAGED_WHATSAPP_PLATFORM_URL: undefined,
    MANAGED_WHATSAPP_TENANT_TOKEN: undefined,
    WHATSAPP_WINDOW_KEEPALIVE_ENABLED: false,
    BOOTSTRAP_ADMIN_EMAIL: undefined,
    BOOTSTRAP_ADMIN_PASSWORD_HASH: undefined,
    BOOTSTRAP_SLACK_BOT_TOKEN: undefined,
    MANAGED_URL: undefined,
    MANAGED_AUTH_SECRET: undefined,
    CONNECTOR_CREDENTIAL_SOURCE: "local",
    CANVAS_CREDENTIAL_PRIVATE_KEY_PEM: undefined,
    CANVAS_CREDENTIAL_PRIVATE_KEY_PATH: undefined,
    CANVAS_CREDENTIAL_PUBLIC_KEY_ID: undefined,
    ZOHO_CLIENT_ID: undefined,
    ZOHO_CLIENT_SECRET: undefined,
    MICROSOFT_CLIENT_ID: undefined,
    MICROSOFT_CLIENT_SECRET: undefined,
    MICROSOFT_TENANT: "common",
    POSTHOG_API_KEY: undefined,
    BASE_URL: `http://localhost:${config.PORT}`,
    CLAUDE_CONFIG_DIR: join(config.DATA_DIR, "claude-config"),
    SKETCH_CONFIG_DIR: join(config.DATA_DIR, "sketch-config"),
  };
}
