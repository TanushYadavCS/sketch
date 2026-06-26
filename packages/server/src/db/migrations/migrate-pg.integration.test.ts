/**
 * Integration tests for the full migration sequence on Postgres (PGlite).
 *
 * PGlite runs Postgres 17 compiled to WASM in-process. The ~1s WASM cold-boot
 * dominates pg test cost, so the read-only schema-assertion tests share a single
 * process-wide instance (getSharedPgDb) that is already fully migrated — exactly
 * the state these tests assert. Tests that re-run migrations or mutate schema use
 * a fresh createTestPgDb() so they do not pollute the shared instance.
 *
 * Migrations 014, 019, and 023 contain SQLite-specific DDL (table-copy-rename,
 * FTS5 virtual table, SQLite triggers). Those migrations will need dialect guards
 * in production code. These tests document the expected behavior once those guards
 * are in place: the base tables must exist, SQLite-only objects are not created.
 */
import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPgDb, getSharedPgDb } from "../../test-utils";
import { runMigrations } from "../migrate";
import type { DB } from "../schema";

const EXPECTED_MIGRATION_COUNT = 107;

describe("runMigrations on Postgres — full sequence", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  it("runs all migrations on a fresh Postgres database without error", async () => {
    // createTestPgDb() already ran migrations — just verify no error was thrown.
    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);
    expect(rows.rows.length).toBeGreaterThan(0);
  }, 30000);

  it("records all migration entries in kysely_migration", async () => {
    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);
    expect(rows.rows).toHaveLength(EXPECTED_MIGRATION_COUNT);
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
    expect(names[25]).toBe("026-normalize-created-at");
    expect(names[26]).toBe("027-entities");
    expect(names[27]).toBe("028-backfill-admin-user");
    expect(names[28]).toBe("029-settings-model-id");
    expect(names[29]).toBe("030-inbox-messages");
    expect(names[30]).toBe("031-extend-scheduled-tasks");
    expect(names[31]).toBe("032-output-style");
    expect(names[32]).toBe("033-inbox-workflows");
    expect(names[33]).toBe("034-drop-tags-from-fts");
    expect(names[34]).toBe("035-smart-enrichment");
    expect(names[35]).toBe("036-org-context");
    expect(names[36]).toBe("037-browse-cache");
    expect(names[37]).toBe("038-sync-interval");
    expect(names[38]).toBe("039-drop-outreach-messages");
    expect(names[39]).toBe("040-user-auth-role");
    expect(names[40]).toBe("041-per-user-fireflies");
    expect(names[41]).toBe("042-agent-environment-variables");
    expect(names[42]).toBe("043-sketch-api-key");
    expect(names[43]).toBe("048-entity-mentions-composite-index");
    expect(names[44]).toBe("049-users-timezone");
    expect(names[45]).toBe("050-agent-tool-allowlist");
    expect(names[46]).toBe("051-channel-agent-binding");
    expect(names[47]).toBe("052-whatsapp-group-agent-binding");
    expect(names[48]).toBe("053-whatsapp-fallback-agent");
    expect(names[49]).toBe("054-agent-environment-variable-shares");
    expect(names[50]).toBe("055-normalize-automation-run-timestamps");
    expect(names[51]).toBe("056-scheduled-task-output-mode");
    expect(names[52]).toBe("057-entity-review-queue");
    expect(names[53]).toBe("058-entity-mentions-unique");
    expect(names[54]).toBe("059-scheduled-tasks-fresh-session-only");
    expect(names[55]).toBe("060-mention-provenance");
    expect(names[56]).toBe("061-indexed-file-facts");
    expect(names[57]).toBe("062-fact-materialization-state");
    expect(names[58]).toBe("063-entity-domains");
    expect(names[59]).toBe("064-entity-domains-seed");
    expect(names[60]).toBe("065-entity-domains-reserved-seed");
    expect(names[61]).toBe("066-entity-review-domain-candidates");
    expect(names[62]).toBe("067-relation-evidence-fact-link");
    expect(names[63]).toBe("068-entities-ai-brief");
    expect(names[64]).toBe("069-admin-can-read-all-files");
    expect(names[65]).toBe("070-file-shares");
    expect(names[66]).toBe("071-entity-shares");
    expect(names[67]).toBe("072-enrichment-retry-backoff");
    expect(names[68]).toBe("073-api-tokens");
    expect(names[69]).toBe("074-external-mcp-tool-calls");
    expect(names[70]).toBe("075-conversation-messages");
    expect(names[71]).toBe("076-slack-conversation-thread-metadata");
    expect(names[72]).toBe("077-scheduled-task-output-thread");
    expect(names[73]).toBe("078-local-devices");
    expect(names[74]).toBe("079-conversation-message-search");
    expect(names[75]).toBe("080-message-id-idempotency");
    expect(names[76]).toBe("081-email-message-metadata");
    expect(names[77]).toBe("082-email-thread-summaries");
    expect(names[78]).toBe("083-local-claude-sessions");
    expect(names[79]).toBe("084-entity-contact-points");
    expect(names[80]).toBe("085-crm-activity-rollups");
    expect(names[81]).toBe("086-local-claude-session-origin-runtime");
    expect(names[82]).toBe("087-rename-openrouter-provider");
    expect(names[83]).toBe("088-agent-run-aux-cost");
    expect(names[84]).toBe("089-mcp-oauth");
    expect(names[85]).toBe("090-orphan-entity-cleanup");
    expect(names[86]).toBe("091-cleanup-empty-relationships-and-review");
    expect(names[87]).toBe("092-teams-provider-file-scope");
    expect(names[88]).toBe("093-microsoft-oauth-settings");
    expect(names[89]).toBe("094-microsoft-oauth-tenant");
    expect(names[90]).toBe("095-entity-review-connector-identity");
    expect(names[91]).toBe("096-linear-project-entity-seeding-cleanup");
    expect(names[92]).toBe("097-clickup-project-entity-seeding-cleanup");
    expect(names[93]).toBe("098-entity-merge-ledger");
    expect(names[94]).toBe("099-review-queue-seed-handle");
    expect(names[95]).toBe("100-entity-project-bindings");
    expect(names[96]).toBe("101-entity-project-member-overrides");
    expect(names[97]).toBe("102-entity-creation-suppressions");
    expect(names[98]).toBe("103-daily-briefs");
    expect(names[99]).toBe("104-daily-brief-item-metadata");
    expect(names[100]).toBe("105-normalize-indexed-file-source-timestamps");
    expect(names[101]).toBe("106-agents");
    expect(names[102]).toBe("107-scheduled-task-builder-revisions");
    expect(names[103]).toBe("108-scheduled-task-origin-chat");
    expect(names[104]).toBe("109-scheduled-task-origin-message-id");
    expect(names[105]).toBe("110-google-calendar-provider-file-scope");
    expect(names[106]).toBe("111-connector-credential-source");
  });

  it("running migrations twice is idempotent", async () => {
    /**
     * Re-runs migrations (DDL mutation via Kysely's Migrator, which also takes
     * its own lock). Uses a fresh instance so it cannot pollute the shared
     * schema that the read-only tests depend on.
     */
    const freshDb = await createTestPgDb();
    try {
      await runMigrations(freshDb, { quiet: true });

      const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(freshDb);
      expect(rows.rows).toHaveLength(EXPECTED_MIGRATION_COUNT);
    } finally {
      await freshDb.destroy();
    }
  });

  it("creates entity_contact_points table", async () => {
    const result = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'entity_contact_points'
    `.execute(db);
    expect(result.rows).toHaveLength(1);
  });

  it("creates the entity merge ledger tombstone schema", async () => {
    const entityColumns = await sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'entities'
        AND column_name IN ('deleted_at', 'merged_into_entity_id')
    `.execute(db);
    expect(entityColumns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column_name: "deleted_at", data_type: "text", is_nullable: "YES" }),
        expect.objectContaining({ column_name: "merged_into_entity_id", data_type: "text", is_nullable: "YES" }),
      ]),
    );

    const mergeColumns = await sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'entity_merges'
    `.execute(db);
    expect(mergeColumns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column_name: "id", data_type: "text", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "survivor_entity_id", data_type: "text", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "merged_entity_id", data_type: "text", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "entity_type", data_type: "text", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "moves", data_type: "text", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "merged_by_user_id", data_type: "text", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "merged_at", data_type: "text", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "unmerged_at", data_type: "text", is_nullable: "YES" }),
        expect.objectContaining({ column_name: "unmerged_by_user_id", data_type: "text", is_nullable: "YES" }),
      ]),
    );
    expect(mergeColumns.rows.find((row) => row.column_name === "merged_at")?.column_default).toContain(
      "CURRENT_TIMESTAMP",
    );

    const foreignKeys = await sql<{
      column_name: string;
      foreign_table_name: string;
      foreign_column_name: string;
      delete_rule: string;
    }>`
      SELECT kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
       AND rc.constraint_schema = tc.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = 'entity_merges'
        AND tc.constraint_type = 'FOREIGN KEY'
    `.execute(db);
    expect(foreignKeys.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column_name: "survivor_entity_id",
          foreign_table_name: "entities",
          foreign_column_name: "id",
          delete_rule: "RESTRICT",
        }),
        expect.objectContaining({
          column_name: "merged_entity_id",
          foreign_table_name: "entities",
          foreign_column_name: "id",
          delete_rule: "RESTRICT",
        }),
        expect.objectContaining({
          column_name: "merged_by_user_id",
          foreign_table_name: "users",
          foreign_column_name: "id",
          delete_rule: "RESTRICT",
        }),
        expect.objectContaining({
          column_name: "unmerged_by_user_id",
          foreign_table_name: "users",
          foreign_column_name: "id",
          delete_rule: "RESTRICT",
        }),
      ]),
    );

    const indexes = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'entity_merges'
    `.execute(db);
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(["entity_merges_survivor_idx", "entity_merges_merged_idx"]),
    );
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

    const columns = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'indexed_files'
        AND column_name = 'rollup_group_id'
    `.execute(db);
    expect(columns.rows).toHaveLength(1);

    const connectorColumns = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'connector_configs'
        AND column_name = 'credential_source'
    `.execute(db);
    expect(connectorColumns.rows).toHaveLength(1);
  });

  it("creates CRM object summaries table", async () => {
    const table = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'crm_object_summaries'
    `.execute(db);
    expect(table.rows).toHaveLength(1);

    const indexes = await sql<{ indexname: string }>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('indexed_files', 'crm_object_summaries')
    `.execute(db);
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(["idx_indexed_files_rollup_group", "idx_crm_object_summaries_updated"]),
    );
  });

  it("creates MCP OAuth tables and token columns", async () => {
    for (const table of ["oauth_clients", "oauth_authorization_codes"]) {
      const result = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }

    const columns = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'api_tokens'
        AND column_name IN ('kind', 'client_id', 'scopes', 'refresh_token_hash')
    `.execute(db);
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      "client_id",
      "kind",
      "refresh_token_hash",
      "scopes",
    ]);
  });

  it("creates fact-aware relationship evidence columns and unique index", async () => {
    const columns = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'entity_relationship_evidence'
    `.execute(db);
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(["source_fact_id", "evidence_key"]),
    );

    const indexes = await sql<{ indexname: string }>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'entity_relationship_evidence'
    `.execute(db);
    expect(indexes.rows.map((row) => row.indexname)).toContain("idx_entity_relationship_evidence_key");
    expect(indexes.rows.map((row) => row.indexname)).not.toContain("entity_relationship_evidence_unique");
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

  it("creates mcp_servers, chat_sessions, scheduled_tasks, inbox_messages, and conversation tables", async () => {
    for (const table of [
      "mcp_servers",
      "chat_sessions",
      "scheduled_tasks",
      "inbox_messages",
      "conversations",
      "conversation_messages",
      "conversation_cursors",
    ]) {
      const result = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates local device tables", async () => {
    for (const table of ["local_devices", "local_device_tool_calls"]) {
      const result = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates local Claude session tables", async () => {
    for (const table of ["local_claude_sessions", "local_claude_session_events"]) {
      const result = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates generic agent tables and retires the daily brief tables", async () => {
    for (const table of ["agent_outputs", "agent_output_items", "agent_user_configs"]) {
      const result = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }

    for (const table of ["daily_briefs", "daily_brief_items", "daily_brief_configs"]) {
      const result = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(0);
    }
  });

  it("does not leave the legacy outreach_messages table behind after migration 033", async () => {
    const result = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'outreach_messages'
    `.execute(db);
    expect(result.rows).toHaveLength(0);
  });
});

describe("runMigrations on Postgres — search schema", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

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

  it("conversation_messages has a search_vector column of type tsvector", async () => {
    const result = await sql<{ column_name: string; data_type: string; udt_name: string }>`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'conversation_messages'
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

  it("a GIN index exists on the search_vector column of conversation_messages", async () => {
    const result = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'conversation_messages'
        AND indexname = 'conversation_messages_search_vector_idx'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indexdef).toContain("USING gin");
    expect(result.rows[0].indexdef).toContain("search_vector");
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
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  /**
   * This block includes a data-insert test, so every test runs inside a
   * transaction that is rolled back afterward. The schema-read tests are
   * unaffected by the wrapping transaction; the insert never leaks into the
   * shared instance.
   */
  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
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
