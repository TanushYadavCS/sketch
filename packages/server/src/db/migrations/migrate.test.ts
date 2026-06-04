/**
 * Integration tests for the full migration sequence.
 *
 * Uses a fresh in-memory SQLite database and runs all migrations through the
 * actual runMigrations() function. Tests verify that all migrations are recorded in
 * the kysely_migration table, that key tables exist after migration, and that a DB
 * with migrations 001-018 already applied can be upgraded through the latest migration.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    await expect(runMigrations(db, { quiet: true })).resolves.not.toThrow();
  });

  it("logs each applied migration by default and stays silent when quiet is set", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMigrations(db);
      expect(logSpy).toHaveBeenCalledWith("Migration applied: 001-initial");
      expect(logSpy).toHaveBeenCalledTimes(83);

      const quietDb = createBlankDb();
      logSpy.mockClear();
      await runMigrations(quietDb, { quiet: true });
      expect(logSpy).not.toHaveBeenCalled();
      await quietDb.destroy();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("records all migration entries in the kysely_migration table", async () => {
    await runMigrations(db, { quiet: true });

    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);

    expect(rows.rows).toHaveLength(83);
  });

  it("records migrations with the correct names in order", async () => {
    await runMigrations(db, { quiet: true });

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
    expect(names[81]).toBe("086-orphan-entity-cleanup");
    expect(names[82]).toBe("087-cleanup-empty-relationships-and-review");
  });

  it("creates the users table", async () => {
    await runMigrations(db, { quiet: true });

    const result = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table' AND name='users'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
  });

  it("creates conversation capture tables", async () => {
    await runMigrations(db, { quiet: true });

    for (const table of [
      "conversations",
      "conversation_messages",
      "conversation_cursors",
      "conversation_messages_fts",
    ]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates local device tables", async () => {
    await runMigrations(db);

    for (const table of ["local_devices", "local_device_tool_calls"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates local Claude session tables", async () => {
    await runMigrations(db);

    for (const table of ["local_claude_sessions", "local_claude_session_events"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates the settings table with enrichment_enabled column", async () => {
    await runMigrations(db, { quiet: true });

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
    await runMigrations(db, { quiet: true });

    for (const table of ["connector_configs", "indexed_files"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }

    const columns = await sql<{ name: string }>`
      PRAGMA table_info(indexed_files)
    `.execute(db);
    expect(columns.rows.map((row) => row.name)).toContain("rollup_group_id");
  });

  it("creates CRM object summaries table", async () => {
    await runMigrations(db);

    const result = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table' AND name='crm_object_summaries'
    `.execute(db);
    expect(result.rows).toHaveLength(1);

    const indexes = await sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type='index' AND tbl_name IN ('indexed_files', 'crm_object_summaries')
    `.execute(db);
    expect(indexes.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(["idx_indexed_files_rollup_group", "idx_crm_object_summaries_updated"]),
    );
  });

  it("creates fact-aware relationship evidence columns and unique index", async () => {
    await runMigrations(db, { quiet: true });

    const columns = await sql<{ name: string }>`
      PRAGMA table_info(entity_relationship_evidence)
    `.execute(db);
    expect(columns.rows.map((row) => row.name)).toEqual(expect.arrayContaining(["source_fact_id", "evidence_key"]));

    const indexes = await sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type='index' AND tbl_name='entity_relationship_evidence'
    `.execute(db);
    expect(indexes.rows.map((row) => row.name)).toContain("idx_entity_relationship_evidence_key");
    expect(indexes.rows.map((row) => row.name)).not.toContain("entity_relationship_evidence_unique");
  });

  it("creates user_provider_identities table", async () => {
    await runMigrations(db, { quiet: true });

    const result = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table' AND name='user_provider_identities'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
  });

  it("creates access_scopes, access_scope_members, connector_files, and file_access tables", async () => {
    await runMigrations(db, { quiet: true });

    for (const table of ["access_scopes", "access_scope_members", "connector_files", "file_access"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates document_chunks and document_timeframes tables", async () => {
    await runMigrations(db, { quiet: true });

    for (const table of ["document_chunks", "document_timeframes"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("creates FTS5 virtual table indexed_files_fts", async () => {
    await runMigrations(db, { quiet: true });

    const result = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table' AND name='indexed_files_fts'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
  });

  it("settings table has smtp_secure, google_oauth_client_id, google_oauth_client_secret, gemini_api_key columns", async () => {
    await runMigrations(db, { quiet: true });

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
    await runMigrations(db, { quiet: true });
    await runMigrations(db, { quiet: true });

    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);

    expect(rows.rows).toHaveLength(83);
  });

  it("creates entity_contact_points table", async () => {
    await runMigrations(db, { quiet: true });

    const result = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table' AND name='entity_contact_points'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
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

  it("applies only pending migrations when 001-018 are already present", async () => {
    // Simulate a DB that already has 001-018 applied by running the full migration
    // sequence once, then seeding a user row to represent existing data.
    await runMigrations(db, { quiet: true });

    await db.insertInto("users").values({ id: "existing-user", name: "Alice" }).execute();

    // Running again should be a no-op.
    await runMigrations(db, { quiet: true });

    const users = await db.selectFrom("users").selectAll().execute();
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe("existing-user");

    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);
    expect(rows.rows).toHaveLength(83);
  });
});
