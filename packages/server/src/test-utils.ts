import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import pino from "pino";
import { inject } from "vitest";
import type { Config } from "./config";
import type { DB } from "./db/schema";
import { PG_TEMPLATE_PATH } from "./test-global-setup-pg";

/**
 * `runMigrations`, the PGlite dialect, and PGlite itself are imported lazily
 * (only inside the functions that need them). `migrate.ts` statically pulls in
 * all 70 migration modules, and PGlite drags in a WASM bundle. With
 * `isolate: true` the module graph is re-instantiated per test file, so a static
 * import here would force every server test file (~150) to evaluate that whole
 * graph even though the common path (createTestDb via the globalSetup template)
 * never touches migrations or Postgres.
 */

/**
 * Lazily-initialized template: migrations run once for the whole run, then every
 * createTestDb() call clones the result via serialize/deserialize (~0.1ms vs
 * ~25ms per migration set).
 *
 * The migrated bytes are built a single time in the Vitest globalSetup
 * (`test-global-setup.ts`) and shared with every worker via inject(). The
 * fallback (build it here) only fires for invocations without globalSetup
 * configured.
 */
let templateBuffer: Buffer | null = null;

async function getTemplateBuffer(): Promise<Buffer> {
  if (templateBuffer) return templateBuffer;
  const injected = inject("sqliteTemplate");
  if (injected) {
    templateBuffer = Buffer.from(injected);
    return templateBuffer;
  }
  const { runMigrations } = await import("./db/migrate");
  const raw = new Database(":memory:");
  const tmpDb = new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
  await runMigrations(tmpDb, { quiet: true });
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
 *
 * PGlite's ~1.3 s cold boot (initdb) plus the migration replay dominates pg test
 * cost. The first call in a run pays that once, then caches a gzipped
 * `dumpDataDir` tarball to disk (PG_TEMPLATE_PATH); subsequent calls restore from
 * it via `loadDataDir`, skipping initdb + migrations (~1.5 s -> ~0.25 s). The
 * integration-only globalSetup (test-global-setup-pg.ts) deletes the template at
 * run start, so it always reflects the current migration set. Either path returns
 * a fully-migrated DB — the dump captures `kysely_migration` too — so callers
 * (including migrate-pg's re-run/idempotency tests) see the same state as a fresh
 * migrate. The pgvector extension binary is supplied to both paths via the
 * `vector` bundle; the dump only carries the catalog registration.
 */
export async function createTestPgDb(): Promise<Kysely<DB>> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { PGliteDialect } = await import("./test-pglite-dialect");

  const template = await readPgTemplate();
  if (template) {
    const pglite = new PGlite({ extensions: { vector }, loadDataDir: new Blob([new Uint8Array(template)]) });
    return new Kysely<DB>({ dialect: new PGliteDialect({ pglite }) });
  }

  const { runMigrations } = await import("./db/migrate");
  const pglite = new PGlite({ extensions: { vector } });
  const db = new Kysely<DB>({ dialect: new PGliteDialect({ pglite }) });
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);
  await runMigrations(db, { quiet: true });
  await writePgTemplate(pglite);
  return db;
}

async function readPgTemplate(): Promise<Buffer | null> {
  try {
    return await readFile(PG_TEMPLATE_PATH);
  } catch {
    return null;
  }
}

/**
 * Persist the migrated PGlite data dir as a gzipped tarball, written to a
 * pid-scoped temp file and atomically renamed so a concurrent reader never
 * observes a partial file (and two racing builders only waste a redundant build).
 */
async function writePgTemplate(pglite: PGlite): Promise<void> {
  const dump = await pglite.dumpDataDir("gzip");
  const bytes = Buffer.from(await dump.arrayBuffer());
  const tmpPath = `${PG_TEMPLATE_PATH}.${process.pid}.tmp`;
  await writeFile(tmpPath, bytes);
  await rename(tmpPath, PG_TEMPLATE_PATH);
}

let sharedPgDb: Kysely<DB> | null = null;

/**
 * Process-wide PGlite database shared across all Postgres tests in a worker.
 * PGlite's ~1s WASM cold-boot dominates pg test cost, so it is booted once per
 * worker instead of once per test. Pair with per-test BEGIN/ROLLBACK isolation
 * (the pg test files wrap each test in a transaction) so tests still see a
 * clean, migrated schema.
 *
 * Only safe for data-only tests that do not open their own Kysely
 * `.transaction()` (which would collide with the outer rollback scope) and do
 * not mutate schema. Schema/DDL tests must use a fresh createTestPgDb() instead.
 */
export async function getSharedPgDb(): Promise<Kysely<DB>> {
  if (!sharedPgDb) sharedPgDb = await createTestPgDb();
  return sharedPgDb;
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
    WHATSAPP_DM_PROVIDER: "baileys",
    WHATSAPP_GROUP_PROVIDER: "baileys",
    WHATSAPP_HISTORY_LOOKBACK_DAYS: 30,
    WHATSAPP_WINDOW_KEEPALIVE_ENABLED: false,
    MAX_CONCURRENT_AGENT_RUNS: 4,
    MAX_FILE_SIZE_MB: 20,
    MAX_UPLOAD_SIZE_MB: 50,
    BIRTH_GATE_DRY_RUN: true,
    LLM_PROMOTION_THRESHOLD: 2,
    LLM_TASK_CORROBORATION_THRESHOLD: 2,
    FEATURE_AUTO_MINT_THRESHOLD: 1,
    CO_MENTION_CONTRIBUTES_TO_THRESHOLD: 3,
    FLOOR_RETRY_MAX_FILES_PER_DOMAIN: 5000,
    FEATURE_ARCHIVE_MIN_MENTIONS: 2,
    FEATURE_ARCHIVE_AGE_DAYS: 30,
    FEATURE_ARCHIVE_MAX_PER_RUN: 1000,
    GEMINI_MAX_RPM: 60,
    GEMINI_MAX_RETRIES: 4,
    SYNC_ALLOW_LARGE_RECONCILE: false,
    SYNC_MAX_RECONCILE_RATIO: 0.5,
    MICROSOFT_TENANT: "common",
    OUTLOOK_INITIAL_LOOKBACK_DAYS: 365,
    OUTLOOK_MAX_INFLIGHT: 4,
    TEAMS_INITIAL_LOOKBACK_DAYS: 365,
    TEAMS_MAX_INFLIGHT: 4,
    TEAMS_PROCESSING_LAG_MS: 2 * 60 * 60 * 1000,
    DATA_DIR: "./data",
    CLAUDE_CONFIG_DIR: join(tmpdir(), "test-claude"),
    SKETCH_CONFIG_DIR: join(tmpdir(), "test-sketch"),
    PORT: 3000,
    LOG_LEVEL: "info",
    ...overrides,
  } as Config;
}
