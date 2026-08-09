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
import { createMigrator, runMigrations } from "../migrate";
import type { DB } from "../schema";
import * as chatSessionRuntimeMigration from "./133-chat-session-runtime";
import * as chatSessionArchiveMigration from "./134-chat-session-archived-at";
import * as slackRosterEvidenceMigration from "./161-slack-roster-evidence";
import * as slackFileAccessBackfillCleanupMigration from "./163-slack-file-access-backfill-cleanup";
import * as typedAccessPrincipalsMigration from "./165-typed-access-principals";

const EXPECTED_MIGRATION_COUNT = 178;

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
    expect(names[126]).toBe("131-trunk-name-embeddings");
    expect(names[127]).toBe("132-agent-messages");
    expect(names[128]).toBe("133-chat-session-runtime");
    expect(names[129]).toBe("134-chat-session-archived-at");
    expect(names[130]).toBe("135-whatsapp-context-graph-indexing");
    expect(names[131]).toBe("136-whatsapp-slice-denoised-message-ids");
    expect(names[132]).toBe("137-whatsapp-group-participants");
    expect(names[133]).toBe("138-whatsapp-identity-candidates");
    expect(names[134]).toBe("139-tasks-proposed-assignee");
    expect(names[135]).toBe("140-retire-unassigned-agent-tasks");
    expect(names[136]).toBe("141-fact-materialization-quarantine");
    expect(names[137]).toBe("142-verdict-safe-fact-upserts");
    expect(names[138]).toBe("143-indexed-corroboration");
    expect(names[139]).toBe("144-whatsapp-gateway-queue");
    expect(names[140]).toBe("145-whatsapp-history-capture-foundation");
    expect(names[141]).toBe("146-whatsapp-history-top-up");
    expect(names[142]).toBe("147-whatsapp-backfill-graph-admission");
    expect(names[143]).toBe("148-whatsapp-pending-slices-index");
    expect(names[144]).toBe("149-whatsapp-backfill-lifecycle-durability");
    expect(names[145]).toBe("150-task-durability-steel-thread");
    expect(names[146]).toBe("151-agent-output-item-task-links");
    expect(names[147]).toBe("152-reseed-combined-durability-routes");
    expect(names[148]).toBe("153-slack-conversation-indexing");
    expect(names[149]).toBe("154-reclassify-mpim-conversations");
    expect(names[150]).toBe("155-requeue-kept-slice-reemission");
    expect(names[151]).toBe("156-operational-alerts");
    expect(names[152]).toBe("157-task-activity-events");
    expect(names[153]).toBe("158-slack-channel-participants");
    expect(names[154]).toBe("159-scheduled-task-conversations");
    expect(names[155]).toBe("160-slack-entity-lifecycle-sync");
    expect(names[156]).toBe("161-slack-roster-evidence");
    expect(names[157]).toBe("162-user-entity-links");
    expect(names[158]).toBe("163-slack-file-access-backfill-cleanup");
    expect(names[159]).toBe("164-outlook-calendar-provider-file-scope");
    expect(names[160]).toBe("165-typed-access-principals");
    expect(names[161]).toBe("166-scheduled-task-builder-locks");
    expect(names[162]).toBe("167-normalize-whatsapp-numbers");
    expect(names[163]).toBe("168-whatsapp-group-scope-authority");
    expect(names[164]).toBe("169-scheduled-task-execution-mode");
    expect(names[165]).toBe("170-question-interactions");
    expect(names[166]).toBe("171-question-interaction-active-keys");
    expect(names[167]).toBe("172-whatsapp-identity-observations");
    expect(names[168]).toBe("173-native-webhook-endpoints");
    expect(names[169]).toBe("174-webhook-delivery-generation-fencing");
    expect(names[170]).toBe("175-native-webhook-no-credentials");
    expect(names[171]).toBe("176-whatsapp-llm-flush-reason");
    expect(names[172]).toBe("177-whatsapp-topic-tables");
    expect(names[173]).toBe("178-whatsapp-chunk-knobs");
    expect(names[174]).toBe("179-whatsapp-open-slices");
    expect(names[175]).toBe("180-whatsapp-chunk-conversion-state");
    expect(names[176]).toBe("181-project-minting-verdicts");
    expect(names[177]).toBe("182-project-minting-states");
  });

  it("upgrades existing email access rows on Postgres", async () => {
    const freshDb = await createTestPgDb();
    try {
      await sql`DROP INDEX IF EXISTS idx_scope_members_pk`.execute(freshDb);
      await sql`DROP INDEX IF EXISTS idx_scope_members_email`.execute(freshDb);
      await sql`DROP INDEX IF EXISTS idx_file_access_pk`.execute(freshDb);
      await sql`DROP INDEX IF EXISTS idx_file_access_email`.execute(freshDb);
      await sql`DROP INDEX IF EXISTS idx_users_whatsapp_lid`.execute(freshDb);
      await sql`ALTER TABLE access_scope_members DROP COLUMN IF EXISTS principal_type`.execute(freshDb);
      await sql`ALTER TABLE access_scope_members RENAME COLUMN principal_value TO email`.execute(freshDb);
      await sql`ALTER TABLE file_access DROP COLUMN IF EXISTS principal_type`.execute(freshDb);
      await sql`ALTER TABLE file_access RENAME COLUMN principal_value TO email`.execute(freshDb);
      await sql`ALTER TABLE users DROP COLUMN IF EXISTS whatsapp_lid`.execute(freshDb);

      await sql`
        INSERT INTO connector_configs (id, connector_type, auth_type, credentials, created_by)
        VALUES ('m164-config', 'google_drive', 'oauth', '{}', 'm164-user')
      `.execute(freshDb);
      await sql`
        INSERT INTO access_scopes (id, connector_config_id, scope_type, provider_scope_id)
        VALUES ('m164-scope', 'm164-config', 'drive', 'drive-1')
      `.execute(freshDb);
      await sql`
        INSERT INTO indexed_files (id, connector_config_id, provider_file_id, file_name, content_category, source, synced_at)
        VALUES ('m164-file', 'm164-config', 'file-1', 'File', 'document', 'google_drive', CURRENT_TIMESTAMP)
      `.execute(freshDb);
      await sql`
        INSERT INTO access_scope_members (access_scope_id, email)
        VALUES ('m164-scope', 'legacy@example.com')
      `.execute(freshDb);
      await sql`
        INSERT INTO file_access (indexed_file_id, email)
        VALUES ('m164-file', 'legacy@example.com')
      `.execute(freshDb);

      await typedAccessPrincipalsMigration.up(freshDb as unknown as Kysely<unknown>);

      await expect(
        sql`SELECT principal_type, principal_value FROM access_scope_members WHERE access_scope_id = 'm164-scope'`.execute(
          freshDb,
        ),
      ).resolves.toMatchObject({ rows: [{ principal_type: "email", principal_value: "legacy@example.com" }] });
      await expect(
        sql`SELECT principal_type, principal_value FROM file_access WHERE indexed_file_id = 'm164-file'`.execute(
          freshDb,
        ),
      ).resolves.toMatchObject({ rows: [{ principal_type: "email", principal_value: "legacy@example.com" }] });
      await expect(
        sql`INSERT INTO file_access (indexed_file_id, principal_type, principal_value) VALUES ('m164-file', 'phone', '+15550000001')`.execute(
          freshDb,
        ),
      ).resolves.toBeTruthy();
      await expect(
        sql`INSERT INTO file_access (indexed_file_id, principal_type, principal_value) VALUES ('m164-file', 'phone', '+15550000001')`.execute(
          freshDb,
        ),
      ).rejects.toThrow();
    } finally {
      await freshDb.destroy();
    }
  }, 30000);

  it("creates the task conversation association table", async () => {
    const rows = await sql<{ relname: string }>`
      SELECT relname
      FROM pg_class
      WHERE relname = 'scheduled_task_conversations'
    `.execute(db);

    expect(rows.rows).toEqual([{ relname: "scheduled_task_conversations" }]);
  });

  it("creates the Slack entity lifecycle schema and partial review uniqueness", async () => {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('organization_domains', 'scheduled_task_builder_locks', 'slack_user_sync_state', 'slack_sync_runs')
      ORDER BY table_name
    `.execute(db);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "organization_domains",
      "scheduled_task_builder_locks",
      "slack_sync_runs",
      "slack_user_sync_state",
    ]);

    const columns = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'entity_review_queue'
        AND column_name = 'candidate_entity_ids'
    `.execute(db);
    expect(columns.rows).toEqual([{ column_name: "candidate_entity_ids" }]);

    const index = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'entity_review_queue'
        AND indexname = 'entity_review_queue_normalized_partial_unique'
    `.execute(db);
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.indexdef).toContain("WHERE (source IS NULL)");
  });

  it("creates the bounded open-materializable partial index", async () => {
    const result = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'indexed_file_facts'
        AND indexname = 'idx_indexed_file_facts_open_materializable'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
    const indexDef = result.rows[0].indexdef.toLowerCase();
    expect(indexDef).toContain("fact_type");
    expect(indexDef).toContain("created_at");
    expect(indexDef).toContain("id");
    expect(indexDef).toContain("deleted_at is null");
    expect(indexDef).toContain("materialized_at is null");
    expect(indexDef).toContain("materialization_attempts < 5");
  });

  it("creates the durable conversation follow-up schema", async () => {
    const taskColumns = await sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'tasks'
        AND column_name IN (
          'source_platform',
          'source_conversation_id',
          'source_provider_thread_id',
          'source_anchor_key',
          'origin_agent_output_id'
        )
    `.execute(db);
    expect(taskColumns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column_name: "source_platform", data_type: "text", is_nullable: "YES" }),
        expect.objectContaining({ column_name: "source_conversation_id", data_type: "integer", is_nullable: "YES" }),
        expect.objectContaining({ column_name: "source_provider_thread_id", data_type: "text", is_nullable: "YES" }),
        expect.objectContaining({ column_name: "source_anchor_key", data_type: "text", is_nullable: "YES" }),
        expect.objectContaining({ column_name: "origin_agent_output_id", data_type: "text", is_nullable: "YES" }),
      ]),
    );

    const tables = await sql<{ table_name: string }>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'task_message_evidence',
          'task_completion_recommendations',
          'task_completion_recommendation_evidence',
          'task_completion_recommendation_deliveries',
          'task_durability_route_state',
          'task_seed_candidates'
        )
    `.execute(db);
    expect(tables.rows.map((row) => row.table_name)).toHaveLength(6);

    const recommendationColumns = await sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'task_completion_recommendations'
    `.execute(db);
    expect(recommendationColumns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column_name: "review_code", data_type: "text", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "evidence_fingerprint", data_type: "text", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "delivery_count", data_type: "integer", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "expires_at", data_type: "text", is_nullable: "NO" }),
      ]),
    );
    expect(recommendationColumns.rows.find((row) => row.column_name === "delivery_count")?.column_default).toBe("0");

    const indexes = await sql<{ indexname: string }>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN (
          'tasks',
          'task_message_evidence',
          'task_completion_recommendations',
          'task_completion_recommendation_deliveries',
          'task_durability_route_state',
          'task_seed_candidates'
        )
    `.execute(db);
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "idx_tasks_conversation_anchor_status",
        "idx_task_message_evidence_anchor",
        "task_completion_recommendations_review_code_uidx",
        "task_completion_recommendations_fingerprint_uidx",
        "idx_task_completion_recommendations_task_state_expiry",
        "task_completion_recommendations_pending_task_uidx",
        "task_completion_recommendation_deliveries_uidx",
        "task_durability_route_state_uidx",
        "idx_task_durability_route_state_source",
        "task_seed_candidates_review_code_uidx",
        "task_seed_candidates_fingerprint_uidx",
        "idx_task_seed_candidates_route_state",
      ]),
    );
  });

  it("creates the append-only task activity schema and indexes", async () => {
    const columns = await sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'task_activity_events'
      ORDER BY ordinal_position ASC
    `.execute(db);
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "id",
      "task_id",
      "event_kind",
      "actor_type",
      "actor_user_id",
      "actor_key",
      "surface",
      "source_agent_output_id",
      "changes_json",
      "evidence_json",
      "dedupe_key",
      "occurred_at",
      "created_at",
    ]);

    const indexes = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'task_activity_events'
        AND indexname IN (
          'idx_task_activity_events_task_time',
          'idx_task_activity_events_kind_time',
          'idx_task_activity_events_dedupe_key'
        )
      ORDER BY indexname ASC
    `.execute(db);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "idx_task_activity_events_dedupe_key",
      "idx_task_activity_events_kind_time",
      "idx_task_activity_events_task_time",
    ]);
    expect(indexes.rows.find((row) => row.indexname === "idx_task_activity_events_dedupe_key")?.indexdef).toContain(
      "UNIQUE",
    );
  });

  it("enforces the task activity event, actor, and surface contract", async () => {
    const freshDb = await createTestPgDb();
    try {
      await sql`
        INSERT INTO tasks
          (id, source, title, normalized_title, status, status_authority, provenance, source_task_id, updated_at)
        VALUES
          ('activity-contract-task', 'summary', 'Contract task', 'contract task', 'open', 'local', 'summary', 'contract-task', '2026-07-23T00:00:00.000Z')
      `.execute(freshDb);
      const eventKinds = [
        "created",
        "evidence_added",
        "fields_changed",
        "status_changed",
        "completion_proposed",
        "completion_reviewed",
      ];
      for (const [index, eventKind] of eventKinds.entries()) {
        await sql`
          INSERT INTO task_activity_events
            (id, task_id, event_kind, actor_type, surface, dedupe_key, occurred_at)
          VALUES
            (${`activity-contract-${index}`}, 'activity-contract-task', ${eventKind}, 'provider', 'sync', ${`contract-${index}`}, '2026-07-23T00:00:00.000Z')
        `.execute(freshDb);
      }
      await expect(
        sql`
        INSERT INTO task_activity_events
          (id, task_id, event_kind, actor_type, surface, dedupe_key, occurred_at)
        VALUES
          ('invalid-activity-kind', 'activity-contract-task', 'task_created', 'provider', 'sync', 'invalid-kind', '2026-07-23T00:00:00.000Z')
      `.execute(freshDb),
      ).rejects.toThrow();
      await expect(
        sql`
        INSERT INTO task_activity_events
          (id, task_id, event_kind, actor_type, surface, dedupe_key, occurred_at)
        VALUES
          ('invalid-activity-actor', 'activity-contract-task', 'created', 'integration', 'sync', 'invalid-actor', '2026-07-23T00:00:00.000Z')
      `.execute(freshDb),
      ).rejects.toThrow();
      await expect(
        sql`
        INSERT INTO task_activity_events
          (id, task_id, event_kind, actor_type, surface, dedupe_key, occurred_at)
        VALUES
          ('invalid-activity-surface', 'activity-contract-task', 'created', 'provider', 'teams', 'invalid-surface', '2026-07-23T00:00:00.000Z')
      `.execute(freshDb),
      ).rejects.toThrow();
    } finally {
      await freshDb.destroy();
    }
  }, 30000);

  it("creates canonical agent output item task links and nulls them when the task is deleted", async () => {
    const freshDb = await createTestPgDb();
    try {
      const columns = await sql<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'agent_output_items'
          AND column_name = 'task_id'
      `.execute(freshDb);
      expect(columns.rows).toEqual([{ column_name: "task_id", data_type: "text", is_nullable: "YES" }]);

      const foreignKeys = await sql<{
        column_name: string;
        foreign_table_name: string;
        foreign_column_name: string;
        delete_rule: string;
      }>`
        SELECT
          kcu.column_name,
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name,
          rc.delete_rule
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
          AND tc.table_name = 'agent_output_items'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'task_id'
      `.execute(freshDb);
      expect(foreignKeys.rows).toEqual([
        {
          column_name: "task_id",
          foreign_table_name: "tasks",
          foreign_column_name: "id",
          delete_rule: "SET NULL",
        },
      ]);

      const indexes = await sql<{ indexname: string }>`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'agent_output_items'
          AND indexname = 'idx_agent_output_items_task_id'
      `.execute(freshDb);
      expect(indexes.rows).toEqual([{ indexname: "idx_agent_output_items_task_id" }]);

      await sql`
        INSERT INTO users (id, name) VALUES ('task-link-user', 'Task Link User')
      `.execute(freshDb);
      await sql`
        INSERT INTO agent_outputs (
          id, agent_key, user_id, output_date, source_key, timezone, status,
          trigger_type, agent_version
        ) VALUES (
          'task-link-output', 'daily_brief', 'task-link-user', '2026-07-17',
          '__global__', 'UTC', 'completed', 'manual', 'test'
        )
      `.execute(freshDb);
      await sql`
        INSERT INTO tasks (
          id, source, title, normalized_title, status, status_authority,
          provenance, source_task_id
        ) VALUES (
          'task-link-task', 'brief', 'Linked task', 'linked task', 'open',
          'local', 'brief', 'task-link-source'
        )
      `.execute(freshDb);
      await sql`
        INSERT INTO agent_output_items (
          id, agent_output_id, section_key, title, summary, priority,
          knowledge_refs_json, sort_order, task_id
        ) VALUES (
          'task-link-item', 'task-link-output', 'todos', 'Snapshot task',
          'Snapshot summary', 'medium', '{"entityIds":[],"fileIds":[]}', 0,
          'task-link-task'
        )
      `.execute(freshDb);

      await sql`DELETE FROM tasks WHERE id = 'task-link-task'`.execute(freshDb);

      const item = await sql<{ task_id: string | null }>`
        SELECT task_id FROM agent_output_items WHERE id = 'task-link-item'
      `.execute(freshDb);
      expect(item.rows).toEqual([{ task_id: null }]);
    } finally {
      await freshDb.destroy();
    }
  });

  it("creates the sub-entities table and current-row partial unique index", async () => {
    const columns = await sql<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'sub_entities'
    `.execute(db);
    expect(columns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column_name: "parent_entity_id", data_type: "text", is_nullable: "YES" }),
        expect.objectContaining({ column_name: "parent_scope_key", data_type: "text", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "kind", data_type: "text", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "normalized_name", data_type: "text", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "source_fact_id", data_type: "text", is_nullable: "YES" }),
      ]),
    );

    const indexes = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'sub_entities'
    `.execute(db);
    const currentIndex = indexes.rows.find((row) => row.indexname === "idx_sub_entities_current_scope_kind_name");
    expect(currentIndex?.indexdef).toContain("UNIQUE INDEX");
    expect(currentIndex?.indexdef).toContain("parent_scope_key");
    expect(currentIndex?.indexdef).toContain("kind");
    expect(currentIndex?.indexdef).toContain("normalized_name");
    expect(currentIndex?.indexdef).toContain("WHERE (valid_to IS NULL)");

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
        AND tc.table_name = 'sub_entities'
        AND tc.constraint_type = 'FOREIGN KEY'
    `.execute(db);
    expect(foreignKeys.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column_name: "parent_entity_id",
          foreign_table_name: "entities",
          foreign_column_name: "id",
          delete_rule: "SET NULL",
        }),
        expect.objectContaining({
          column_name: "created_by_user_id",
          foreign_table_name: "users",
          foreign_column_name: "id",
        }),
      ]),
    );
    expect(foreignKeys.rows.some((row) => row.column_name === "source_fact_id")).toBe(false);
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

  it("upgrades schema 158 with existing rows through the roster evidence migration", async () => {
    const legacyDb = await createTestPgDb();
    try {
      const migrationResult = await createMigrator(legacyDb).migrateTo("158-slack-channel-participants");
      expect(migrationResult.error).toBeUndefined();
      await legacyDb
        .insertInto("slack_channel_participants")
        .values({ channel_id: "C-existing", slack_user_id: "U-existing", last_seen_at: "2026-08-07T00:00:00.000Z" })
        .execute();

      await runMigrations(legacyDb, { quiet: true });
      await slackRosterEvidenceMigration.up(legacyDb as unknown as Kysely<unknown>);

      const tables = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('organization_domains', 'slack_user_sync_state', 'slack_sync_runs')
        ORDER BY table_name
      `.execute(legacyDb);
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "organization_domains",
        "slack_sync_runs",
        "slack_user_sync_state",
      ]);

      const stateColumns = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'slack_user_sync_state'
      `.execute(legacyDb);
      expect(stateColumns.rows.map((row) => row.column_name)).toEqual(
        expect.arrayContaining(["team_id", "slack_user_id", "entity_created_by_sync", "last_roster_seen_at"]),
      );
      const settingsColumns = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'slack_team_id'
      `.execute(legacyDb);
      expect(settingsColumns.rows).toEqual([{ column_name: "slack_team_id" }]);

      const indexes = await sql<{ indexname: string }>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('idx_slack_user_sync_state_entity', 'idx_slack_sync_runs_status_heartbeat')
        ORDER BY indexname
      `.execute(legacyDb);
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        "idx_slack_sync_runs_status_heartbeat",
        "idx_slack_user_sync_state_entity",
      ]);

      const constraints = await sql<{ constraint_name: string }>`
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND constraint_name IN (
            'slack_user_sync_state_pk',
            'organization_domains_domain_unique',
            'slack_sync_runs_team_trigger_unique'
          )
        ORDER BY constraint_name
      `.execute(legacyDb);
      expect(constraints.rows.map((row) => row.constraint_name)).toEqual([
        "organization_domains_domain_unique",
        "slack_sync_runs_team_trigger_unique",
        "slack_user_sync_state_pk",
      ]);
      await expect(
        legacyDb.selectFrom("slack_channel_participants").select(["channel_id", "slack_user_id"]).execute(),
      ).resolves.toEqual([{ channel_id: "C-existing", slack_user_id: "U-existing" }]);
    } finally {
      await legacyDb.destroy();
    }
  });

  it("upgrades schema 161 with existing rows through the user entity link migration", async () => {
    const legacyDb = await createTestPgDb();
    try {
      const migrationResult = await createMigrator(legacyDb).migrateTo("161-slack-roster-evidence");
      expect(migrationResult.error).toBeUndefined();
      await legacyDb.insertInto("users").values({ id: "migration-user", name: "Migration User" }).execute();
      const now = "2026-08-07T00:00:00.000Z";
      await legacyDb
        .insertInto("entities")
        .values([
          {
            id: "migration-entity",
            name: "Migration User",
            source_type: "person",
            status: "confirmed",
            hotness: 0,
            created_at: now,
            updated_at: now,
          },
          {
            id: "migration-entity-2",
            name: "Migration User 2",
            source_type: "person",
            status: "confirmed",
            hotness: 0,
            created_at: now,
            updated_at: now,
          },
        ])
        .execute();
      await legacyDb
        .insertInto("entity_review_queue")
        .values({
          id: "migration-review",
          proposed_name: "Migration User",
          normalized_name: "migration user",
          entity_type: "person",
          triggered_by_user_id: "migration-user",
        })
        .execute();

      await runMigrations(legacyDb, { quiet: true });

      const tables = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('user_entity_links', 'user_entity_link_sweep_runs')
        ORDER BY table_name
      `.execute(legacyDb);
      expect(tables.rows.map((row) => row.table_name)).toEqual(["user_entity_link_sweep_runs", "user_entity_links"]);
      const reviewColumns = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'entity_review_queue'
          AND column_name = 'candidate_user_ids'
      `.execute(legacyDb);
      expect(reviewColumns.rows).toEqual([{ column_name: "candidate_user_ids" }]);
      const indexes = await sql<{ indexname: string }>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_entity_review_queue_source_source_id'
      `.execute(legacyDb);
      expect(indexes.rows).toEqual([{ indexname: "idx_entity_review_queue_source_source_id" }]);
      const constraints = await sql<{ constraint_name: string }>`
        SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema = 'public'
          AND constraint_name IN (
            'user_entity_links_user_unique',
            'user_entity_links_entity_unique',
            'user_entity_link_sweep_runs_key_unique'
          )
        ORDER BY constraint_name
      `.execute(legacyDb);
      expect(constraints.rows.map((row) => row.constraint_name)).toEqual([
        "user_entity_link_sweep_runs_key_unique",
        "user_entity_links_entity_unique",
        "user_entity_links_user_unique",
      ]);
      await expect(
        legacyDb.selectFrom("entity_review_queue").select("id").where("id", "=", "migration-review").execute(),
      ).resolves.toEqual([{ id: "migration-review" }]);
      await legacyDb
        .insertInto("user_entity_links")
        .values({
          id: "migration-link",
          user_id: "migration-user",
          entity_id: "migration-entity",
          matched_via: "email",
        })
        .execute();
      await expect(
        legacyDb
          .insertInto("user_entity_links")
          .values({
            id: "migration-link-2",
            user_id: "migration-user",
            entity_id: "migration-entity-2",
            matched_via: "phone",
          })
          .execute(),
      ).rejects.toThrow();
    } finally {
      await legacyDb.destroy();
    }
  });

  it("creates entity_contact_points table", async () => {
    const result = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'entity_contact_points'
    `.execute(db);
    expect(result.rows).toHaveLength(1);
  });

  it("drops the stale Slack file access backfill table and tolerates its absence", async () => {
    const cleanupDb = await createTestPgDb();
    try {
      await cleanupDb.schema.createTable("slack_file_access_backfill").addColumn("id", "text").execute();
      await slackFileAccessBackfillCleanupMigration.up(cleanupDb as unknown as Kysely<unknown>);
      await expect(
        sql`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'slack_file_access_backfill'
        `.execute(cleanupDb),
      ).resolves.toMatchObject({ rows: [] });
      await expect(
        slackFileAccessBackfillCleanupMigration.up(cleanupDb as unknown as Kysely<unknown>),
      ).resolves.toBeUndefined();
    } finally {
      await cleanupDb.destroy();
    }
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

  it("creates mcp_servers, chat_sessions, agent_messages, scheduled_tasks, inbox_messages, and conversation tables", async () => {
    for (const table of [
      "mcp_servers",
      "chat_sessions",
      "agent_messages",
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

  it("creates WhatsApp provider event and template mapping tables", async () => {
    for (const table of ["whatsapp_provider_events", "whatsapp_template_mappings"]) {
      const result = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
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

  it("chat_sessions has runtime NOT NULL with default sdk", async () => {
    const result = await sql<{ column_name: string; is_nullable: string; column_default: string }>`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'chat_sessions'
        AND column_name = 'runtime'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].is_nullable).toBe("NO");
    expect(result.rows[0].column_default).toContain("'sdk'");
  });

  it("chat_sessions has nullable archived_at", async () => {
    const result = await sql<{ column_name: string; is_nullable: string; column_default: string | null }>`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'chat_sessions'
        AND column_name = 'archived_at'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].is_nullable).toBe("YES");
    expect(result.rows[0].column_default).toBeNull();
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

  it("partial UNIQUE index on active (workspace_key, thread_key, runtime) exists", async () => {
    const result = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'chat_sessions'
        AND indexname = 'chat_sessions_workspace_thread_uidx'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
    const indexDef = result.rows[0].indexdef.toLowerCase();
    expect(indexDef).toContain("unique");
    expect(indexDef).toContain("workspace_key");
    expect(indexDef).toContain("thread_key");
    expect(indexDef).toContain("runtime");
    expect(indexDef).toContain("archived_at is null");
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

  it("chat_sessions allows the same workspace and thread for different runtimes", async () => {
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "runtime-workspace", thread_key: "", runtime: "sdk", session_id: "sess-sdk" })
      .execute();
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "runtime-workspace", thread_key: "", runtime: "aisdk", session_id: "sess-ai" })
      .execute();

    const rows = await db
      .selectFrom("chat_sessions")
      .select(["runtime", "session_id"])
      .where("workspace_key", "=", "runtime-workspace")
      .orderBy("runtime", "asc")
      .execute();

    expect(rows).toEqual([
      { runtime: "aisdk", session_id: "sess-ai" },
      { runtime: "sdk", session_id: "sess-sdk" },
    ]);
  });

  it("allows archived duplicates while enforcing one active row", async () => {
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "archive-workspace", thread_key: "thread-1", runtime: "aisdk", session_id: "sess-1" })
      .execute();
    await db
      .updateTable("chat_sessions")
      .set({ archived_at: "2026-07-01T00:00:00.000Z" })
      .where("session_id", "=", "sess-1")
      .execute();
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "archive-workspace", thread_key: "thread-1", runtime: "aisdk", session_id: "sess-2" })
      .execute();
    await db
      .updateTable("chat_sessions")
      .set({ archived_at: "2026-07-02T00:00:00.000Z" })
      .where("session_id", "=", "sess-2")
      .execute();
    await db
      .insertInto("chat_sessions")
      .values({
        workspace_key: "archive-workspace",
        thread_key: "thread-1",
        runtime: "aisdk",
        session_id: "sess-active",
      })
      .execute();

    await sql`SAVEPOINT duplicate_active_session`.execute(db);
    await expect(
      db
        .insertInto("chat_sessions")
        .values({
          workspace_key: "archive-workspace",
          thread_key: "thread-1",
          runtime: "aisdk",
          session_id: "sess-active-2",
        })
        .execute(),
    ).rejects.toThrow();
    await sql`ROLLBACK TO SAVEPOINT duplicate_active_session`.execute(db);
    await sql`RELEASE SAVEPOINT duplicate_active_session`.execute(db);

    const rows = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", "archive-workspace")
      .orderBy("id", "asc")
      .execute();
    expect(rows).toEqual([
      { session_id: "sess-1", archived_at: "2026-07-01T00:00:00.000Z" },
      { session_id: "sess-2", archived_at: "2026-07-02T00:00:00.000Z" },
      { session_id: "sess-active", archived_at: null },
    ]);
  });
});

describe("runMigrations on Postgres — chat_session runtime down migration", () => {
  it("134 down drops archived rows and restores pre-archive uniqueness", async () => {
    const db = await createTestPgDb();
    try {
      await db
        .insertInto("chat_sessions")
        .values({ workspace_key: "down-archive", thread_key: "", runtime: "sdk", session_id: "sess-old" })
        .execute();
      await db
        .updateTable("chat_sessions")
        .set({ archived_at: "2026-07-01T00:00:00.000Z" })
        .where("session_id", "=", "sess-old")
        .execute();
      await db
        .insertInto("chat_sessions")
        .values({ workspace_key: "down-archive", thread_key: "", runtime: "sdk", session_id: "sess-active" })
        .execute();

      await expect(chatSessionArchiveMigration.down(db as Kysely<unknown>)).resolves.not.toThrow();

      const archivedAtColumns = await sql<{ column_name: string }>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'chat_sessions'
          AND column_name = 'archived_at'
      `.execute(db);
      expect(archivedAtColumns.rows).toEqual([]);

      const rows = await db
        .selectFrom("chat_sessions")
        .select(["workspace_key", "thread_key", "runtime", "session_id"])
        .where("workspace_key", "=", "down-archive")
        .execute();
      expect(rows).toEqual([
        { workspace_key: "down-archive", thread_key: "", runtime: "sdk", session_id: "sess-active" },
      ]);
    } finally {
      await db.destroy();
    }
  }, 30000);

  it("keeps the sdk row when dual runtime rows share a workspace and thread", async () => {
    const db = await createTestPgDb();
    try {
      await db
        .insertInto("chat_sessions")
        .values({ workspace_key: "down-workspace", thread_key: "", runtime: "sdk", session_id: "sess-sdk" })
        .execute();
      await db
        .insertInto("chat_sessions")
        .values({ workspace_key: "down-workspace", thread_key: "", runtime: "aisdk", session_id: "sess-ai" })
        .execute();

      await expect(chatSessionArchiveMigration.down(db as Kysely<unknown>)).resolves.not.toThrow();
      await expect(chatSessionRuntimeMigration.down(db as Kysely<unknown>)).resolves.not.toThrow();

      const rows = await sql<{ workspace_key: string; thread_key: string; session_id: string }>`
        SELECT workspace_key, thread_key, session_id
        FROM chat_sessions
        WHERE workspace_key = 'down-workspace'
        ORDER BY session_id ASC
      `.execute(db);
      expect(rows.rows).toEqual([{ workspace_key: "down-workspace", thread_key: "", session_id: "sess-sdk" }]);

      const runtimeColumns = await sql<{ column_name: string }>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'chat_sessions'
          AND column_name = 'runtime'
      `.execute(db);
      expect(runtimeColumns.rows).toEqual([]);
    } finally {
      await db.destroy();
    }
  }, 30000);
});
