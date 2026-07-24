import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { createServer } from "../bootstrap";
import { loadConfig, validateConfig } from "../config";
import type { DB } from "../db/schema";
import { assertFollowupReviewQaPaths, createFollowupReviewQaConfig } from "./followup-review-qa-config";
import { isolateFollowupReviewQaDatabase } from "./inline-followup-review-fixture";

async function main() {
  const loadedConfig = loadConfig();
  assertFollowupReviewQaPaths(loadedConfig);
  const config = createFollowupReviewQaConfig(loadedConfig);
  validateConfig(config);

  const safeEnvironmentKeys = new Set([
    "CI",
    "FORCE_COLOR",
    "HOME",
    "LANG",
    "LOGNAME",
    "NO_COLOR",
    "OLDPWD",
    "PATH",
    "PWD",
    "SHELL",
    "SHLVL",
    "TERM",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USER",
    "_",
  ]);
  for (const key of Object.keys(process.env)) {
    if (
      safeEnvironmentKeys.has(key) ||
      key.startsWith("LC_") ||
      key.startsWith("NODE_") ||
      key.startsWith("npm_") ||
      key.startsWith("PNPM_") ||
      key.startsWith("XDG_")
    ) {
      continue;
    }
    delete process.env[key];
  }
  process.env.CLAUDE_CONFIG_DIR = config.CLAUDE_CONFIG_DIR;

  await Promise.all([
    rm(config.CLAUDE_CONFIG_DIR, { recursive: true, force: true }),
    rm(config.SKETCH_CONFIG_DIR, { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(config.CLAUDE_CONFIG_DIR, { recursive: true }),
    mkdir(config.SKETCH_CONFIG_DIR, { recursive: true }),
  ]);

  const isolationDatabase = new Kysely<DB>({
    dialect: new SqliteDialect({ database: new Database(config.SQLITE_PATH) }),
  });
  try {
    await isolateFollowupReviewQaDatabase(isolationDatabase);
  } finally {
    await isolationDatabase.destroy();
  }

  const handle = await createServer(config, {
    connect: false,
    externalStartup: false,
    backgroundWork: false,
  });

  async function shutdown() {
    await handle.shutdown();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
