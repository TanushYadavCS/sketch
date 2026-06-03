import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { runMigrations } from "./db/migrate";
import type { DB } from "./db/schema";

/**
 * Builds the migrated in-memory SQLite template ONCE for the whole test run and
 * hands the serialized bytes to every worker via Vitest's provide/inject. Without
 * this, `isolate: true` resets module state per file, so `createTestDb()` would
 * re-run all migrations once per test file (~120 times). Tests clone this buffer
 * instead (better-sqlite3 deserialize, ~0.1ms).
 *
 * `provide` is typed inline (Vitest loads the default export dynamically, so the
 * exact context type is not required) — only the key we use needs to compile.
 */
export default async function setup({
  provide,
}: {
  provide: (key: "sqliteTemplate", value: Uint8Array) => void;
}) {
  const raw = new Database(":memory:");
  const db = new Kysely<DB>({ dialect: new SqliteDialect({ database: raw }) });
  await runMigrations(db, { quiet: true });
  const buffer = raw.serialize();
  await db.destroy();
  provide("sqliteTemplate", new Uint8Array(buffer));
}

declare module "vitest" {
  interface ProvidedContext {
    sqliteTemplate: Uint8Array;
  }
}
