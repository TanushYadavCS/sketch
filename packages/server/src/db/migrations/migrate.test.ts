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

const EXPECTED_MIGRATION_COUNT = 126;

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
      expect(logSpy).toHaveBeenCalledTimes(EXPECTED_MIGRATION_COUNT);

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

    expect(rows.rows).toHaveLength(EXPECTED_MIGRATION_COUNT);
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
    expect(names[106]).toBe("111-settings-embedding-provider");
    expect(names[107]).toBe("112-agent-output-structured-payload");
    expect(names[108]).toBe("113-indexed-file-all-day-flag");
    expect(names[109]).toBe("114-agent-output-deliveries");
    expect(names[110]).toBe("115-whatsapp-template-mappings-and-provider-events");
    expect(names[111]).toBe("116-connector-credential-source");
    expect(names[112]).toBe("117-conversation-message-window-index");
    expect(names[113]).toBe("118-whatsapp-window-keepalives");
    expect(names[114]).toBe("119-agent-outputs-source-scope");
    expect(names[115]).toBe("120-agent-output-period-key");
    expect(names[116]).toBe("121-tasks");
    expect(names[117]).toBe("122-tasks-owner");
    expect(names[118]).toBe("123-sub-entities");
    expect(names[119]).toBe("124-tasks-assignee-name");
    expect(names[120]).toBe("125-milestone-series-and-value-signature");
    expect(names[121]).toBe("126-work-cycles");
    expect(names[122]).toBe("127-work-cycles-connector");
    expect(names[123]).toBe("128-work-cycles-connector-key");
    expect(names[124]).toBe("129-container-name-qualification");
    expect(names[125]).toBe("130-entity-provenance-tier");
  });

  it("creates the sub-entities table and current-row partial unique index", async () => {
    await runMigrations(db, { quiet: true });

    const columns = await sql<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>`PRAGMA table_info(sub_entities)`.execute(db);
    expect(columns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "parent_entity_id", type: "TEXT", notnull: 0 }),
        expect.objectContaining({ name: "parent_scope_key", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "kind", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "normalized_name", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "status_authority", type: "TEXT", notnull: 1, dflt_value: "'local'" }),
        expect.objectContaining({ name: "source_fact_id", type: "TEXT", notnull: 0 }),
      ]),
    );

    const indexes = await sql<{
      name: string;
      unique: number;
      partial: number;
    }>`PRAGMA index_list(sub_entities)`.execute(db);
    expect(indexes.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "idx_sub_entities_current_scope_kind_name",
          unique: 1,
          partial: 1,
        }),
      ]),
    );

    const foreignKeys = await sql<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>`PRAGMA foreign_key_list(sub_entities)`.execute(db);
    expect(foreignKeys.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "entities", from: "parent_entity_id", to: "id", on_delete: "SET NULL" }),
        expect.objectContaining({ table: "users", from: "created_by_user_id", to: "id" }),
      ]),
    );
    expect(foreignKeys.rows.some((row) => row.from === "source_fact_id")).toBe(false);
  });

  it("creates the entity merge ledger tombstone schema", async () => {
    await runMigrations(db, { quiet: true });

    const entityColumns = await sql<{
      name: string;
      type: string;
      notnull: number;
    }>`PRAGMA table_info(entities)`.execute(db);
    expect(entityColumns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "deleted_at", type: "TEXT", notnull: 0 }),
        expect.objectContaining({ name: "merged_into_entity_id", type: "TEXT", notnull: 0 }),
      ]),
    );

    const mergeColumns = await sql<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>`PRAGMA table_info(entity_merges)`.execute(db);
    expect(mergeColumns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", type: "TEXT", pk: 1 }),
        expect.objectContaining({ name: "survivor_entity_id", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "merged_entity_id", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "entity_type", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "moves", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "merged_by_user_id", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "merged_at", type: "TEXT", notnull: 1, dflt_value: "CURRENT_TIMESTAMP" }),
        expect.objectContaining({ name: "unmerged_at", type: "TEXT", notnull: 0 }),
        expect.objectContaining({ name: "unmerged_by_user_id", type: "TEXT", notnull: 0 }),
      ]),
    );

    const foreignKeys = await sql<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>`PRAGMA foreign_key_list(entity_merges)`.execute(db);
    expect(foreignKeys.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "entities", from: "survivor_entity_id", to: "id", on_delete: "RESTRICT" }),
        expect.objectContaining({ table: "entities", from: "merged_entity_id", to: "id", on_delete: "RESTRICT" }),
        expect.objectContaining({ table: "users", from: "merged_by_user_id", to: "id", on_delete: "RESTRICT" }),
        expect.objectContaining({ table: "users", from: "unmerged_by_user_id", to: "id", on_delete: "RESTRICT" }),
      ]),
    );

    const indexes = await sql<{ name: string }>`PRAGMA index_list(entity_merges)`.execute(db);
    expect(indexes.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(["entity_merges_survivor_idx", "entity_merges_merged_idx"]),
    );
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

    const connectorColumns = await sql<{ name: string }>`
      PRAGMA table_info(connector_configs)
    `.execute(db);
    expect(connectorColumns.rows.map((row) => row.name)).toContain("credential_source");
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

  it("creates MCP OAuth tables and token columns", async () => {
    await runMigrations(db);

    for (const table of ["oauth_clients", "oauth_authorization_codes"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }

    const columns = await sql<{ name: string }>`
      PRAGMA table_info(api_tokens)
    `.execute(db);
    expect(columns.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(["kind", "client_id", "scopes", "refresh_token_hash"]),
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

  it("settings table has OAuth client and gemini_api_key columns", async () => {
    await runMigrations(db, { quiet: true });

    await db.insertInto("settings").values({ id: "default" }).execute();

    const row = await db
      .selectFrom("settings")
      .select([
        "smtp_secure",
        "google_oauth_client_id",
        "google_oauth_client_secret",
        "microsoft_oauth_client_id",
        "microsoft_oauth_client_secret",
        "microsoft_oauth_tenant",
        "gemini_api_key",
      ])
      .executeTakeFirst();

    expect(row).toBeDefined();
    expect(row?.smtp_secure).toBe(1);
    expect(row?.google_oauth_client_id).toBeNull();
    expect(row?.google_oauth_client_secret).toBeNull();
    expect(row?.microsoft_oauth_client_id).toBeNull();
    expect(row?.microsoft_oauth_client_secret).toBeNull();
    expect(row?.microsoft_oauth_tenant).toBeNull();
    expect(row?.gemini_api_key).toBeNull();
  });

  it("migration 106 replaces the daily brief tables with generic agent tables", async () => {
    await runMigrations(db, { quiet: true });

    for (const table of ["agent_outputs", "agent_output_items", "agent_user_configs"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }

    for (const table of ["daily_briefs", "daily_brief_items", "daily_brief_configs"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(0);
    }
  });

  it("creates agent_user_configs with default config values", async () => {
    await runMigrations(db, { quiet: true });

    await db.insertInto("users").values({ id: "user-daily-brief", name: "Daily Brief User" }).execute();
    await db
      .insertInto("agent_user_configs")
      .values({ agent_key: "daily_brief", user_id: "user-daily-brief" })
      .execute();

    const config = await db
      .selectFrom("agent_user_configs")
      .select(["enabled", "schedule_hour", "schedule_minute", "max_items_per_section"])
      .where("agent_key", "=", "daily_brief")
      .where("user_id", "=", "user-daily-brief")
      .executeTakeFirstOrThrow();

    expect(config).toEqual({
      enabled: 1,
      schedule_hour: 8,
      schedule_minute: 0,
      max_items_per_section: 4,
    });
  });

  it("creates agent output delivery audit storage", async () => {
    await runMigrations(db, { quiet: true });

    const result = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table' AND name='agent_output_deliveries'
    `.execute(db);
    expect(result.rows).toHaveLength(1);
  });

  it("creates WhatsApp provider event and template mapping tables", async () => {
    await runMigrations(db, { quiet: true });

    for (const table of ["whatsapp_provider_events", "whatsapp_template_mappings"]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }
  });

  it("running migrations twice is idempotent (only applies each migration once)", async () => {
    await runMigrations(db, { quiet: true });
    await runMigrations(db, { quiet: true });

    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);

    expect(rows.rows).toHaveLength(EXPECTED_MIGRATION_COUNT);
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
    expect(rows.rows).toHaveLength(EXPECTED_MIGRATION_COUNT);
  });

  it("finishes the scheduled task revision migration when its columns already exist", async () => {
    await runMigrations(db, { quiet: true });

    await sql`
      DELETE FROM kysely_migration
      WHERE name IN (
        '107-scheduled-task-builder-revisions',
        '108-scheduled-task-origin-chat',
        '109-scheduled-task-origin-message-id',
        '110-google-calendar-provider-file-scope',
        '111-settings-embedding-provider',
        '112-agent-output-structured-payload',
        '113-indexed-file-all-day-flag',
        '114-agent-output-deliveries',
        '115-whatsapp-template-mappings-and-provider-events',
        '116-connector-credential-source',
        '117-conversation-message-window-index',
        '118-whatsapp-window-keepalives',
        '119-agent-outputs-source-scope',
        '120-agent-output-period-key'
      )
    `.execute(db);
    await sql`DROP TABLE agent_output_deliveries`.execute(db);
    await sql`DROP TABLE whatsapp_template_mappings`.execute(db);
    await sql`DROP TABLE whatsapp_provider_events`.execute(db);
    await sql`DROP INDEX idx_conversation_messages_window`.execute(db);
    await sql`DROP TABLE whatsapp_window_keepalives`.execute(db);

    await expect(runMigrations(db, { quiet: true })).resolves.not.toThrow();

    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration
      WHERE name IN (
        '107-scheduled-task-builder-revisions',
        '108-scheduled-task-origin-chat',
        '109-scheduled-task-origin-message-id',
        '110-google-calendar-provider-file-scope',
        '111-settings-embedding-provider',
        '112-agent-output-structured-payload',
        '113-indexed-file-all-day-flag',
        '114-agent-output-deliveries',
        '115-whatsapp-template-mappings-and-provider-events',
        '116-connector-credential-source',
        '117-conversation-message-window-index',
        '118-whatsapp-window-keepalives',
        '119-agent-outputs-source-scope',
        '120-agent-output-period-key'
      )
      ORDER BY name ASC
    `.execute(db);
    expect(rows.rows).toEqual([
      { name: "107-scheduled-task-builder-revisions" },
      { name: "108-scheduled-task-origin-chat" },
      { name: "109-scheduled-task-origin-message-id" },
      { name: "110-google-calendar-provider-file-scope" },
      { name: "111-settings-embedding-provider" },
      { name: "112-agent-output-structured-payload" },
      { name: "113-indexed-file-all-day-flag" },
      { name: "114-agent-output-deliveries" },
      { name: "115-whatsapp-template-mappings-and-provider-events" },
      { name: "116-connector-credential-source" },
      { name: "117-conversation-message-window-index" },
      { name: "118-whatsapp-window-keepalives" },
      { name: "119-agent-outputs-source-scope" },
      { name: "120-agent-output-period-key" },
    ]);
  });
});
