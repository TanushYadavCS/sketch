import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import pino from "pino";
import type { Config } from "./config";
import { runMigrations } from "./db/migrate";
import type { DB } from "./db/schema";
import { PGliteDialect } from "./test-pglite-dialect";

/**
 * Lazily-initialized template: migrations run once, then every createTestDb()
 * call clones the result via serialize/deserialize (~0.1ms vs ~25ms per migration set).
 */
let templateBuffer: Buffer | null = null;

async function getTemplateBuffer(): Promise<Buffer> {
  if (templateBuffer) return templateBuffer;
  const raw = new Database(":memory:");
  const tmpDb = new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
  await runMigrations(tmpDb);
  templateBuffer = raw.serialize();
  await tmpDb.destroy();
  return templateBuffer;
}

/**
 * Creates an in-memory SQLite database with all migrations applied.
 * Each call returns a fresh, isolated database cloned from a cached template.
 */
export async function createTestDb(): Promise<Kysely<DB>> {
  const buf = await getTemplateBuffer();
  const db = new Kysely<DB>({
    dialect: new SqliteDialect({
      database: new Database(buf),
    }),
  });
  // Force driver initialization so destroy() works correctly
  // (Kysely's RuntimeDriver.destroy() is a no-op if init() was never called).
  await db.selectFrom("users").select("id").limit(0).execute();
  return db;
}

/**
 * Creates an in-memory Postgres database (via PGlite) with all migrations applied.
 * PGlite instances are cheap enough to create fresh for each test — no template clone needed.
 * The pgvector extension is loaded via PGlite's built-in vector bundle before migrations run.
 */
export async function createTestPgDb(): Promise<Kysely<DB>> {
  const pglite = new PGlite({ extensions: { vector } });
  const db = new Kysely<DB>({ dialect: new PGliteDialect({ pglite }) });
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);
  await runMigrations(db);
  return db;
}

/** Silent logger for tests — no output noise. */
export function createTestLogger() {
  return pino({ level: "silent" });
}

/**
 * Wait for all pending microtasks / async queue work to settle.
 * Works for single-depth async (handler → enqueue → async work). If handlers
 * ever gain nested async patterns (async work that itself enqueues more async
 * work), call flush() multiple times or replace with a drain loop.
 */
export function flush() {
  return new Promise<void>((r) => setTimeout(r, 0));
}

/** Minimal config for tests — only fields needed by the component under test. */
export function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    DB_TYPE: "sqlite",
    SQLITE_PATH: ":memory:",
    SLACK_CHANNEL_HISTORY_LIMIT: 5,
    SLACK_THREAD_HISTORY_LIMIT: 50,
    MAX_FILE_SIZE_MB: 20,
    DATA_DIR: "./data",
    PORT: 3000,
    LOG_LEVEL: "info",
    ...overrides,
  } as Config;
}
