/**
 * Integration tests for the full migration sequence on Postgres (PGlite).
 *
 * PGlite runs Postgres 17 compiled to WASM in-process. Each describe block
 * creates a fresh in-memory Postgres instance so tests are fully isolated.
 *
 * Migrations 014, 019, and 023 contain SQLite-specific DDL (table-copy-rename,
 * FTS5 virtual table, SQLite triggers). Those migrations will need dialect guards
 * in production code. These tests document the expected behavior once those guards
 * are in place: the base tables must exist, SQLite-only objects are not created.
 */
import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb } from "../../test-utils";
import { runMigrations } from "../migrate";
import type { DB } from "../schema";

describe("runMigrations on Postgres — full sequence", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("runs all 025 migrations on a fresh Postgres database without error", async () => {
    // createTestPgDb() already ran migrations — just verify no error was thrown.
    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);
    expect(rows.rows.length).toBeGreaterThan(0);
  });

  it("records all 24 migration entries in kysely_migration", async () => {
    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);
    expect(rows.rows).toHaveLength(25);
  });

  it("records migrations with correct names in order", async () => {
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

  it("running migrations twice is idempotent", async () => {
    await runMigrations(db);

    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);
    expect(rows.rows).toHaveLength(25);
  });

  it("creates the users table", async () => {
    const result = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users'
    `.execute(db);
    expect(result.rows).toHaveLength(1);
  });

  it("creates the settings table", async () => {
    const result = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'settings'
    `.execute(db);
    expect(result.rows).toHaveLength(1);
  });

  it("creates connector_configs and indexed_files tables", async () => {
    for (const table of ["connector_configs", "indexed_files"]) {
      const result = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates user_provider_identities table", async () => {
    const result = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'user_provider_identities'
    `.execute(db);
    expect(result.rows).toHaveLength(1);
  });

  it("creates access_scopes, access_scope_members, connector_files, file_access tables", async () => {
    for (const table of ["access_scopes", "access_scope_members", "connector_files", "file_access"]) {
      const result = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates document_chunks and document_timeframes tables", async () => {
    for (const table of ["document_chunks", "document_timeframes"]) {
      const result = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates mcp_servers, chat_sessions, scheduled_tasks, outreach_messages tables", async () => {
    for (const table of ["mcp_servers", "chat_sessions", "scheduled_tasks", "outreach_messages"]) {
      const result = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });
});

describe("runMigrations on Postgres — search schema", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("indexed_files has a search_vector column of type tsvector", async () => {
    const result = await sql<{ column_name: string; data_type: string; udt_name: string }>`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'indexed_files'
        AND column_name = 'search_vector'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].data_type).toBe("tsvector");
  });

  it("a GIN index exists on the search_vector column of indexed_files", async () => {
    const result = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'indexed_files'
        AND indexdef LIKE '%gin%'
    `.execute(db);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    const hasSearchVectorIndex = result.rows.some((r) => r.indexdef.includes("search_vector"));
    expect(hasSearchVectorIndex).toBe(true);
  });

  it("chunk_embeddings table exists with chunk_id (text PK) and embedding (vector type) columns", async () => {
    const pkResult = await sql<{ column_name: string; data_type: string }>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'chunk_embeddings'
        AND column_name = 'chunk_id'
    `.execute(db);

    expect(pkResult.rows).toHaveLength(1);
    expect(pkResult.rows[0].data_type).toBe("text");

    const vecResult = await sql<{ column_name: string; data_type: string; udt_name: string }>`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'chunk_embeddings'
        AND column_name = 'embedding'
    `.execute(db);

    expect(vecResult.rows).toHaveLength(1);
    expect(vecResult.rows[0].data_type).toBe("USER-DEFINED");
    expect(vecResult.rows[0].udt_name).toBe("vector");
  });

  it("file_embeddings table exists with indexed_file_id (text PK) and embedding (vector type) columns", async () => {
    const pkResult = await sql<{ column_name: string; data_type: string }>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'file_embeddings'
        AND column_name = 'indexed_file_id'
    `.execute(db);

    expect(pkResult.rows).toHaveLength(1);
    expect(pkResult.rows[0].data_type).toBe("text");

    const vecResult = await sql<{ column_name: string; data_type: string; udt_name: string }>`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'file_embeddings'
        AND column_name = 'embedding'
    `.execute(db);

    expect(vecResult.rows).toHaveLength(1);
    expect(vecResult.rows[0].data_type).toBe("USER-DEFINED");
    expect(vecResult.rows[0].udt_name).toBe("vector");
  });

  it("indexed_files_fts table does NOT exist on Postgres (FTS5 is SQLite-only)", async () => {
    const result = await sql<{ table_name: string }>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'indexed_files_fts'
    `.execute(db);

    expect(result.rows).toHaveLength(0);
  });
});

describe("runMigrations on Postgres — chat_sessions schema", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("chat_sessions has thread_key NOT NULL with default empty string", async () => {
    const result = await sql<{ column_name: string; is_nullable: string; column_default: string }>`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'chat_sessions'
        AND column_name = 'thread_key'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].is_nullable).toBe("NO");
    expect(result.rows[0].column_default).toContain("''");
  });

  it("chat_sessions has id as auto-incrementing integer primary key", async () => {
    const result = await sql<{ column_name: string; data_type: string; column_default: string }>`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'chat_sessions'
        AND column_name = 'id'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].data_type).toBe("integer");
    // auto-increment in Postgres is expressed as nextval(sequence)
    expect(result.rows[0].column_default).toMatch(/nextval/i);
  });

  it("UNIQUE constraint on (workspace_key, thread_key) exists", async () => {
    const result = await sql<{ constraint_name: string; constraint_type: string }>`
      SELECT tc.constraint_name, tc.constraint_type
      FROM information_schema.table_constraints tc
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'chat_sessions'
        AND tc.constraint_type = 'UNIQUE'
    `.execute(db);

    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    // Verify the unique constraint covers workspace_key and thread_key
    const constraintName = result.rows[0].constraint_name;
    const columns = await sql<{ column_name: string }>`
      SELECT kcu.column_name
      FROM information_schema.key_column_usage kcu
      WHERE kcu.table_schema = 'public'
        AND kcu.table_name = 'chat_sessions'
        AND kcu.constraint_name = ${constraintName}
      ORDER BY kcu.ordinal_position
    `.execute(db);

    const colNames = columns.rows.map((r) => r.column_name);
    expect(colNames).toContain("workspace_key");
    expect(colNames).toContain("thread_key");
  });

  it("chat_sessions allows inserting a row with empty string thread_key", async () => {
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "test-workspace", thread_key: "", session_id: "sess-001" })
      .execute();

    const row = await db
      .selectFrom("chat_sessions")
      .select(["workspace_key", "thread_key", "session_id"])
      .where("workspace_key", "=", "test-workspace")
      .executeTakeFirst();

    expect(row?.thread_key).toBe("");
    expect(row?.session_id).toBe("sess-001");
  });
});
