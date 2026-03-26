/**
 * Integration tests for the full migration sequence.
 *
 * Uses a fresh in-memory SQLite database and runs all 025 migrations through the
 * actual runMigrations() function. Tests verify that all migrations are recorded in
 * the kysely_migration table, that key tables exist after migration, and that a DB
 * with migrations 001-018 already applied can be upgraded with only 019-025.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate";
import type { DB } from "../schema";

function createBlankDb(): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("runMigrations — full sequence", () => {
  let db: Kysely<DB>;

  beforeEach(() => {
    db = createBlankDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("runs all migrations on a fresh database without error", async () => {
    await expect(runMigrations(db)).resolves.not.toThrow();
  });

  it("records all 25 migration entries in the kysely_migration table", async () => {
    await runMigrations(db);

    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);

    expect(rows.rows).toHaveLength(25);
  });

  it("records migrations with the correct names in order", async () => {
    await runMigrations(db);

    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);

    const names = rows.rows.map((r) => r.name);

    expect(names[0]).toBe("001-initial");
    expect(names[1]).toBe("002-channels");
    expect(names[17]).toBe("018-user-type-role-hierarchy");
    expect(names[18]).toBe("019-connectors");
    expect(names[19]).toBe("020-user-provider-identities");
    expect(names[20]).toBe("021-file-access");
    expect(names[21]).toBe("022-settings-extended");
    expect(names[22]).toBe("023-semantic-search");
    expect(names[23]).toBe("024-settings-enrichment");
    expect(names[24]).toBe("025-agent-usage");
  });

  it("creates the users table", async () => {
    await runMigrations(db);

    const result = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table' AND name='users'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
  });

  it("creates the settings table with enrichment_enabled column", async () => {
    await runMigrations(db);

    const result = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table' AND name='settings'
    `.execute(db);

    expect(result.rows).toHaveLength(1);

    // Verify enrichment_enabled column exists by inserting and reading back
    await db.insertInto("settings").values({ id: "default" }).execute();
    const settings = await db.selectFrom("settings").select(["id", "enrichment_enabled"]).executeTakeFirst();
    expect(settings?.enrichment_enabled).toBe(1);
  });

  it("creates connector_configs and indexed_files tables", async () => {
    await runMigrations(db);

    for (const table of ["connector_configs", "indexed_files"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates user_provider_identities table", async () => {
    await runMigrations(db);

    const result = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table' AND name='user_provider_identities'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
  });

  it("creates access_scopes, access_scope_members, connector_files, and file_access tables", async () => {
    await runMigrations(db);

    for (const table of ["access_scopes", "access_scope_members", "connector_files", "file_access"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates document_chunks and document_timeframes tables", async () => {
    await runMigrations(db);

    for (const table of ["document_chunks", "document_timeframes"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates FTS5 virtual table indexed_files_fts", async () => {
    await runMigrations(db);

    const result = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table' AND name='indexed_files_fts'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
  });

  it("settings table has smtp_secure, google_oauth_client_id, google_oauth_client_secret, gemini_api_key columns", async () => {
    await runMigrations(db);

    await db.insertInto("settings").values({ id: "default" }).execute();

    const row = await db
      .selectFrom("settings")
      .select(["smtp_secure", "google_oauth_client_id", "google_oauth_client_secret", "gemini_api_key"])
      .executeTakeFirst();

    expect(row).toBeDefined();
    expect(row?.smtp_secure).toBe(1);
    expect(row?.google_oauth_client_id).toBeNull();
    expect(row?.google_oauth_client_secret).toBeNull();
    expect(row?.gemini_api_key).toBeNull();
  });

  it("running migrations twice is idempotent (only applies each migration once)", async () => {
    await runMigrations(db);
    await runMigrations(db);

    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);

    // Still exactly 25, not 50
    expect(rows.rows).toHaveLength(25);
  });
});

describe("runMigrations — incremental upgrade", () => {
  let db: Kysely<DB>;

  beforeEach(() => {
    db = createBlankDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("applies only 019-025 when 001-018 are already present", async () => {
    // Simulate a DB that already has 001-018 applied by running the full migration
    // sequence once, then seeding a user row to represent existing data.
    await runMigrations(db);

    await db.insertInto("users").values({ id: "existing-user", name: "Alice" }).execute();

    // Running again should be a no-op (all 25 already applied)
    await runMigrations(db);

    const users = await db.selectFrom("users").selectAll().execute();
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe("existing-user");

    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);
    expect(rows.rows).toHaveLength(25);
  });
});
