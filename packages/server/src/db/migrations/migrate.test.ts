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
import { createMigrator, runMigrations } from "../migrate";
import type { DB } from "../schema";
import * as m107 from "./107-scheduled-task-builder-revisions";
import * as m108 from "./108-scheduled-task-origin-chat";
import * as m109 from "./109-scheduled-task-origin-message-id";
import * as m110 from "./110-google-calendar-provider-file-scope";
import * as m111 from "./111-settings-embedding-provider";
import * as m112 from "./112-agent-output-structured-payload";
import * as m113 from "./113-indexed-file-all-day-flag";
import * as m116 from "./116-connector-credential-source";
import * as m119 from "./119-agent-outputs-source-scope";
import * as m120 from "./120-agent-output-period-key";
import * as chatSessionRuntimeMigration from "./133-chat-session-runtime";
import * as chatSessionArchiveMigration from "./134-chat-session-archived-at";
import * as combinedDurabilityReseedMigration from "./152-reseed-combined-durability-routes";
import * as slackEntityLifecycleMigration from "./160-slack-entity-lifecycle-sync";
import * as slackRosterEvidenceMigration from "./161-slack-roster-evidence";
import * as outlookCalendarProviderFileScopeMigration from "./164-outlook-calendar-provider-file-scope";
import * as entityMergeGroupsMigration from "./186-entity-merge-groups";
import * as entityNameProposalsMigration from "./187-entity-name-proposals";

const EXPECTED_MIGRATION_COUNT = 193;

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

  it("backfills placeholder status only for WhatsApp identity names", async () => {
    const migrator = createMigrator(db);
    await migrator.migrateTo("180-whatsapp-chunk-conversion-state");
    await db
      .insertInto("entities")
      .values([
        {
          id: "whatsapp-phone",
          name: "+919969577769",
          source_type: "person",
          status: "confirmed",
          hotness: 0,
          created_at: "2026-08-13T00:00:00.000Z",
          updated_at: "2026-08-13T00:00:00.000Z",
        },
        {
          id: "email-phone",
          name: "+919891688787",
          source_type: "person",
          status: "confirmed",
          hotness: 0,
          created_at: "2026-08-13T00:00:00.000Z",
          updated_at: "2026-08-13T00:00:00.000Z",
        },
      ])
      .execute();
    await db
      .insertInto("entity_contact_points")
      .values({
        id: "whatsapp-phone-point",
        entity_id: "whatsapp-phone",
        kind: "phone",
        value: "+919969577769",
        source: "whatsapp_identity",
      })
      .execute();

    await migrator.migrateToLatest();

    const rows = await sql<{ id: string; name_status: string }>`
      SELECT id, name_status FROM entities ORDER BY id
    `.execute(db);
    expect(rows.rows).toEqual([
      { id: "email-phone", name_status: "confirmed" },
      { id: "whatsapp-phone", name_status: "placeholder" },
    ]);
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
    expect(names[178]).toBe("183-graph-pass-runs");
    expect(names[179]).toBe("184-person-contact-point-cutover");
    expect(names[180]).toBe("185-queue-pass-reason");
    expect(names[181]).toBe("186-entity-merge-groups");
    expect(names[182]).toBe("187-entity-name-proposals");
    expect(names[183]).toBe("188-automation-shares");
    expect(names[184]).toBe("189-automation-locks");
    expect(names[185]).toBe("190-cli-integration-connections");
    expect(names[186]).toBe("191-task-review-fields");
    expect(names[187]).toBe("192-scheduled-task-builder-lock-expires-at");
    expect(names[188]).toBe("193-automation-lock-sessions");
    expect(names[189]).toBe("194-remove-scheduled-task-builder-locks");
  });

  it("adds portable session fencing columns with safe legacy defaults", async () => {
    await runMigrations(db, { quiet: true });
    const columns = await sql<{ name: string }>`
      SELECT name
      FROM pragma_table_info('automation_task_locks')
      WHERE name IN ('holder_session_id', 'generation', 'steal_requester_session_id')
      ORDER BY name
    `.execute(db);

    expect(columns.rows.map((row) => row.name)).toEqual([
      "generation",
      "holder_session_id",
      "steal_requester_session_id",
    ]);

    await db.insertInto("users").values({ id: "migration-lock-user", name: "Migration Lock User" }).execute();
    await db
      .insertInto("automation_task_locks")
      .values({
        task_id: "migration-lock-task",
        holder_user_id: "migration-lock-user",
        holder_platform: "web",
        holder_surface: "builder",
        holder_session_id: "legacy",
        generation: 1,
        acquired_at: "2026-08-17T10:00:00.000Z",
        updated_at: "2026-08-17T10:00:00.000Z",
        expires_at: "2026-08-17T10:15:00.000Z",
      })
      .execute();

    await expect(
      db
        .selectFrom("automation_task_locks")
        .select(["holder_session_id", "generation", "steal_requester_session_id"])
        .where("task_id", "=", "migration-lock-task")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ holder_session_id: "legacy", generation: 1, steal_requester_session_id: null });
  });

  it("backfills legacy pending steal sessions during the upgrade", async () => {
    const migrator = createMigrator(db);
    await migrator.migrateTo("192-scheduled-task-builder-lock-expires-at");
    await db
      .insertInto("users")
      .values([
        { id: "legacy-lock-holder", name: "Legacy Lock Holder" },
        { id: "legacy-lock-requester", name: "Legacy Lock Requester" },
      ])
      .execute();
    await sql`
      INSERT INTO automation_task_locks
        (task_id, holder_user_id, holder_platform, holder_surface, acquired_at, updated_at, expires_at,
         steal_requester_user_id, steal_requester_platform, steal_requester_surface, steal_requested_at, steal_expires_at)
      VALUES
        ('legacy-lock-task', 'legacy-lock-holder', 'web', 'builder', '2026-08-17T10:00:00.000Z',
         '2026-08-17T10:00:00.000Z', '2026-08-17T10:15:00.000Z', 'legacy-lock-requester', 'web', 'builder',
         '2026-08-17T10:01:00.000Z', '2026-08-17T10:05:00.000Z')
    `.execute(db);

    await migrator.migrateToLatest();

    await expect(
      db
        .selectFrom("automation_task_locks")
        .select(["holder_session_id", "generation", "steal_requester_session_id"])
        .where("task_id", "=", "legacy-lock-task")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ holder_session_id: "legacy", generation: 1, steal_requester_session_id: "legacy" });
  });

  it("keeps the automation-sharing migration ledger in order", async () => {
    await runMigrations(db, { quiet: true });

    const rows = await sql<{ name: string }>`
      SELECT name FROM kysely_migration ORDER BY name ASC
    `.execute(db);
    const names = rows.rows.map((row) => row.name);

    expect(names.slice(176, 185)).toEqual([
      "181-project-minting-verdicts",
      "182-project-minting-states",
      "183-graph-pass-runs",
      "184-person-contact-point-cutover",
      "185-queue-pass-reason",
      "186-entity-merge-groups",
      "187-entity-name-proposals",
      "188-automation-shares",
      "189-automation-locks",
    ]);
  });

  it("upgrades databases that already applied entity-name proposals before automation sharing", async () => {
    const migrator = createMigrator(db);
    await migrator.migrateTo("186-entity-merge-groups");

    await entityNameProposalsMigration.up(db as unknown as Kysely<unknown>);
    await sql`
      INSERT INTO kysely_migration (name, timestamp)
      VALUES ('187-entity-name-proposals', ${new Date().toISOString()})
    `.execute(db);

    const { error } = await migrator.migrateToLatest();

    expect(error).toBeUndefined();
  });

  it("backfills only exact web origin task conversations", async () => {
    const migrator = createMigrator(db);
    await migrator.migrateTo("158-slack-channel-participants");

    await db
      .insertInto("scheduled_tasks")
      .values([
        {
          id: "task-origin-backfill",
          platform: "slack",
          context_type: "dm",
          delivery_target: "D123",
          prompt: "Use the exact origin",
          schedule_type: "cron",
          schedule_value: "0 9 * * *",
          created_by: "origin-owner",
          origin_platform: "web",
          origin_conversation_id: "normal-chat-1",
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "task-without-origin",
          platform: "slack",
          context_type: "dm",
          delivery_target: "D123",
          prompt: "Do not infer a relationship",
          schedule_type: "cron",
          schedule_value: "0 10 * * *",
          created_by: "origin-owner",
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-01T00:00:00.000Z",
        },
      ])
      .execute();

    await migrator.migrateToLatest();

    await expect(
      db
        .selectFrom("scheduled_task_conversations")
        .select(["task_id", "conversation_id", "transcript_user_id", "kind"])
        .orderBy("task_id", "asc")
        .execute(),
    ).resolves.toEqual([
      {
        task_id: "task-origin-backfill",
        conversation_id: "normal-chat-1",
        transcript_user_id: "origin-owner",
        kind: "web_chat",
      },
    ]);
  });

  it("migration 164 down restores Google Calendar and Teams scoped provider indexes", async () => {
    await runMigrations(db, { quiet: true });

    await outlookCalendarProviderFileScopeMigration.down(db as unknown as Kysely<unknown>);

    const indexes = await sql<{ name: string; sql: string }>`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN ('idx_indexed_files_source_provider', 'uq_indexed_files_scoped_provider')
      ORDER BY name ASC
    `.execute(db);

    expect(indexes.rows).toEqual([
      {
        name: "idx_indexed_files_source_provider",
        sql: expect.stringContaining("source NOT IN ('teams', 'google_calendar')"),
      },
      {
        name: "uq_indexed_files_scoped_provider",
        sql: expect.stringContaining("source IN ('teams', 'google_calendar')"),
      },
    ]);
  });

  it("creates the Slack entity lifecycle schema and allows source-scoped review rows", async () => {
    await runMigrations(db, { quiet: true });

    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
      AND name IN ('organization_domains', 'slack_user_sync_state', 'slack_sync_runs')
      ORDER BY name
    `.execute(db);
    expect(tables.rows.map((row) => row.name)).toEqual([
      "organization_domains",
      "slack_sync_runs",
      "slack_user_sync_state",
    ]);

    const columns = await sql<{ name: string }>`
      SELECT name FROM pragma_table_info('entity_review_queue')
      WHERE name = 'candidate_entity_ids'
    `.execute(db);
    expect(columns.rows).toEqual([{ name: "candidate_entity_ids" }]);

    const index = await sql<{ name: string; sql: string }>`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND name = 'entity_review_queue_normalized_partial_unique'
    `.execute(db);
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.sql).toContain("WHERE source IS NULL");

    const queueRow = {
      id: "review-source-a",
      proposed_name: "Same Name",
      normalized_name: "same name",
      entity_type: "person",
      source: "slack_user",
      source_id: "T123:U1",
      proposed_email: null,
      candidate_entity_id: null,
      candidate_entity_ids: null,
      candidate_score: null,
      candidate_reason: "exact-name-match",
      candidate_generated_at: null,
      triggered_by_user_id: "admin",
    };
    await db.insertInto("entity_review_queue").values(queueRow).execute();
    await db
      .insertInto("entity_review_queue")
      .values({ ...queueRow, id: "review-source-b", source_id: "T123:U2" })
      .execute();
    await expect(
      db.selectFrom("entity_review_queue").select("id").where("normalized_name", "=", "same name").execute(),
    ).resolves.toHaveLength(2);
  });

  it("upgrades schema 158 with existing rows through the roster evidence migration", async () => {
    const legacyDb = createBlankDb();
    try {
      const migrationResult = await createMigrator(legacyDb).migrateTo("158-slack-channel-participants");
      expect(migrationResult.error).toBeUndefined();
      await legacyDb
        .insertInto("slack_channel_participants")
        .values({ channel_id: "C-existing", slack_user_id: "U-existing", last_seen_at: "2026-08-07T00:00:00.000Z" })
        .execute();

      await runMigrations(legacyDb, { quiet: true });
      await slackRosterEvidenceMigration.up(legacyDb as unknown as Kysely<unknown>);

      const tables = await sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('organization_domains', 'slack_user_sync_state', 'slack_sync_runs')
        ORDER BY name
      `.execute(legacyDb);
      expect(tables.rows.map((row) => row.name)).toEqual([
        "organization_domains",
        "slack_sync_runs",
        "slack_user_sync_state",
      ]);

      const stateColumns = await sql<{ name: string }>`
        SELECT name FROM pragma_table_info('slack_user_sync_state')
      `.execute(legacyDb);
      expect(stateColumns.rows.map((row) => row.name)).toEqual(
        expect.arrayContaining(["team_id", "slack_user_id", "entity_created_by_sync", "last_roster_seen_at"]),
      );
      const settingsColumns = await sql<{ name: string }>`
        SELECT name FROM pragma_table_info('settings') WHERE name = 'slack_team_id'
      `.execute(legacyDb);
      expect(settingsColumns.rows).toEqual([{ name: "slack_team_id" }]);

      const indexes = await sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND name IN ('idx_slack_user_sync_state_entity', 'idx_slack_sync_runs_status_heartbeat')
        ORDER BY name
      `.execute(legacyDb);
      expect(indexes.rows.map((row) => row.name)).toEqual([
        "idx_slack_sync_runs_status_heartbeat",
        "idx_slack_user_sync_state_entity",
      ]);

      const definitions = await sql<{ name: string; sql: string }>`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('organization_domains', 'slack_user_sync_state', 'slack_sync_runs')
      `.execute(legacyDb);
      expect(definitions.rows.find((row) => row.name === "slack_user_sync_state")?.sql).toContain("primary key");
      expect(definitions.rows.find((row) => row.name === "organization_domains")?.sql).toContain(
        'constraint "organization_domains_domain_unique"',
      );
      expect(definitions.rows.find((row) => row.name === "slack_sync_runs")?.sql).toContain(
        'constraint "slack_sync_runs_team_trigger_unique"',
      );
      await expect(
        legacyDb.selectFrom("slack_channel_participants").select(["channel_id", "slack_user_id"]).execute(),
      ).resolves.toEqual([{ channel_id: "C-existing", slack_user_id: "U-existing" }]);
    } finally {
      await legacyDb.destroy();
    }
  });

  it("upgrades schema 161 with existing rows through the user entity link migration", async () => {
    const legacyDb = createBlankDb();
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

      const tables = await sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('user_entity_links', 'user_entity_link_sweep_runs')
        ORDER BY name
      `.execute(legacyDb);
      expect(tables.rows.map((row) => row.name)).toEqual(["user_entity_link_sweep_runs", "user_entity_links"]);
      const reviewColumns = await sql<{ name: string }>`
        SELECT name FROM pragma_table_info('entity_review_queue') WHERE name = 'candidate_user_ids'
      `.execute(legacyDb);
      expect(reviewColumns.rows).toEqual([{ name: "candidate_user_ids" }]);
      const indexes = await sql<{ name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_entity_review_queue_source_source_id'
      `.execute(legacyDb);
      expect(indexes.rows).toEqual([{ name: "idx_entity_review_queue_source_source_id" }]);
      const definitions = await sql<{ name: string; sql: string }>`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND name IN ('user_entity_links', 'user_entity_link_sweep_runs')
      `.execute(legacyDb);
      expect(definitions.rows.find((row) => row.name === "user_entity_links")?.sql).toContain(
        'constraint "user_entity_links_user_unique"',
      );
      expect(definitions.rows.find((row) => row.name === "user_entity_links")?.sql).toContain(
        'constraint "user_entity_links_entity_unique"',
      );
      expect(definitions.rows.find((row) => row.name === "user_entity_link_sweep_runs")?.sql).toContain(
        'constraint "user_entity_link_sweep_runs_key_unique"',
      );
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

  it("preserves review queue, evidence, and domain candidates across the SQLite rebuild", async () => {
    const legacyDb = createBlankDb();
    try {
      const migrationResult = await createMigrator(legacyDb).migrateTo("158-slack-channel-participants");
      expect(migrationResult.error).toBeUndefined();
      await legacyDb
        .insertInto("connector_configs")
        .values({
          id: "migration-connector",
          connector_type: "slack",
          auth_type: "system",
          credentials: "{}",
          created_by: "migration-owner",
        })
        .execute();
      await legacyDb
        .insertInto("indexed_files")
        .values({
          id: "migration-file",
          connector_config_id: "migration-connector",
          provider_file_id: "migration-provider-file",
          provider_url: null,
          file_name: "migration-file.txt",
          file_type: "document",
          content_category: "document",
          content: "review evidence",
          summary: null,
          source: "slack",
          source_path: null,
          content_hash: null,
          synced_at: "2026-08-05T00:00:00.000Z",
        })
        .execute();
      await legacyDb
        .insertInto("entity_review_queue")
        .values({
          id: "migration-review",
          proposed_name: "Migration Review",
          normalized_name: "migration review",
          entity_type: "person",
          source: null,
          source_id: null,
          proposed_email: null,
          candidate_entity_id: null,
          candidate_score: null,
          candidate_reason: "migration-fixture",
          candidate_generated_at: null,
          triggered_by_user_id: "migration-owner",
        })
        .execute();
      await legacyDb
        .insertInto("entity_review_evidence")
        .values({
          id: "migration-evidence",
          review_id: "migration-review",
          indexed_file_id: "migration-file",
          source: "slack",
          note: "preserve me",
        })
        .execute();
      await legacyDb
        .insertInto("entity_candidates")
        .values({
          id: "migration-domain-candidate",
          name: "migration.example.com",
          type: "domain_observation",
          variations: null,
          first_seen_file_id: "migration-file",
          seen_file_ids: JSON.stringify(["migration-file"]),
          seen_count: 1,
          promoted_entity_id: null,
          created_at: "2026-08-05T00:00:00.000Z",
          updated_at: "2026-08-05T00:00:00.000Z",
          domain: "migration.example.com",
          proposed_company_name: null,
          first_observed_by_user_id: null,
          observed_person_entity_ids: null,
          evidence_file_ids: JSON.stringify(["migration-file"]),
        })
        .execute();
      await legacyDb
        .insertInto("entity_review_domain_candidates")
        .values({
          review_id: "migration-review",
          domain_candidate_id: "migration-domain-candidate",
        })
        .execute();

      await slackEntityLifecycleMigration.up(legacyDb as unknown as Kysely<unknown>);
      await slackEntityLifecycleMigration.up(legacyDb as unknown as Kysely<unknown>);

      await expect(
        legacyDb.selectFrom("entity_review_queue").select("id").where("id", "=", "migration-review").execute(),
      ).resolves.toHaveLength(1);
      await expect(
        legacyDb.selectFrom("entity_review_evidence").select("id").where("id", "=", "migration-evidence").execute(),
      ).resolves.toHaveLength(1);
      await expect(
        legacyDb
          .selectFrom("entity_review_domain_candidates")
          .selectAll()
          .where("review_id", "=", "migration-review")
          .execute(),
      ).resolves.toEqual([
        {
          review_id: "migration-review",
          domain_candidate_id: "migration-domain-candidate",
          created_at: expect.any(String),
        },
      ]);
    } finally {
      await legacyDb.destroy();
    }
  });

  it("resets reviewed combined durability routes for member-source reseeding", async () => {
    await runMigrations(db, { quiet: true });
    await db.insertInto("users").values({ id: "reseed-user", name: "Reseed User" }).execute();
    await db
      .insertInto("task_durability_route_state")
      .values([
        {
          agent_key: "conversation_summary",
          user_id: "reseed-user",
          route_id: "combined-reviewed",
          source_key: "route:combined",
          mode: "durable_only",
          seed_state: "reviewed",
          seed_reviewed_at: "2026-07-01T00:00:00.000Z",
          incremental_success_at: "2026-07-02T00:00:00.000Z",
        },
        {
          agent_key: "conversation_summary",
          user_id: "reseed-user",
          route_id: "direct-reviewed",
          source_key: "slack:channel:C_DIRECT",
          mode: "durable_only",
          seed_state: "reviewed",
          seed_reviewed_at: "2026-07-01T00:00:00.000Z",
          incremental_success_at: "2026-07-02T00:00:00.000Z",
        },
        {
          agent_key: "conversation_summary",
          user_id: "reseed-user",
          route_id: "combined-pending",
          source_key: "route:pending",
          mode: "hybrid",
          seed_state: "pending",
          seed_reviewed_at: null,
          incremental_success_at: null,
        },
      ])
      .execute();

    await combinedDurabilityReseedMigration.up(db as unknown as Kysely<unknown>);

    await expect(
      db
        .selectFrom("task_durability_route_state")
        .select(["route_id", "mode", "seed_state", "seed_reviewed_at", "incremental_success_at"])
        .where("user_id", "=", "reseed-user")
        .orderBy("route_id", "asc")
        .execute(),
    ).resolves.toEqual([
      {
        route_id: "combined-pending",
        mode: "hybrid",
        seed_state: "pending",
        seed_reviewed_at: null,
        incremental_success_at: null,
      },
      {
        route_id: "combined-reviewed",
        mode: "hybrid",
        seed_state: "pending",
        seed_reviewed_at: null,
        incremental_success_at: "2026-07-02T00:00:00.000Z",
      },
      {
        route_id: "direct-reviewed",
        mode: "durable_only",
        seed_state: "reviewed",
        seed_reviewed_at: "2026-07-01T00:00:00.000Z",
        incremental_success_at: "2026-07-02T00:00:00.000Z",
      },
    ]);
  });

  it("creates the bounded open-materializable partial index", async () => {
    await runMigrations(db, { quiet: true });

    const result = await sql<{ name: string; sql: string }>`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_indexed_file_facts_open_materializable'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
    const indexSql = result.rows[0].sql.toLowerCase().replaceAll('"', "");
    expect(indexSql).toContain("fact_type");
    expect(indexSql).toContain("created_at");
    expect(indexSql).toContain("id");
    expect(indexSql).toContain("deleted_at is null");
    expect(indexSql).toContain("materialized_at is null");
    expect(indexSql).toContain("materialization_attempts < 5");
  });

  it("creates the durable conversation follow-up schema", async () => {
    await runMigrations(db, { quiet: true });

    const taskColumns = await sql<{ name: string; type: string; notnull: number }>`PRAGMA table_info(tasks)`.execute(
      db,
    );
    expect(taskColumns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "source_platform", type: "TEXT", notnull: 0 }),
        expect.objectContaining({ name: "source_conversation_id", type: "INTEGER", notnull: 0 }),
        expect.objectContaining({ name: "source_provider_thread_id", type: "TEXT", notnull: 0 }),
        expect.objectContaining({ name: "source_anchor_key", type: "TEXT", notnull: 0 }),
        expect.objectContaining({ name: "origin_agent_output_id", type: "TEXT", notnull: 0 }),
      ]),
    );

    for (const table of [
      "task_message_evidence",
      "task_completion_recommendations",
      "task_completion_recommendation_evidence",
      "task_completion_recommendation_deliveries",
      "task_durability_route_state",
      "task_seed_candidates",
    ]) {
      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name=${sql.lit(table)}
      `.execute(db);
      expect(result.rows).toHaveLength(1);
    }

    const recommendationColumns = await sql<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>`PRAGMA table_info(task_completion_recommendations)`.execute(db);
    expect(recommendationColumns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "review_code", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "evidence_fingerprint", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "delivery_count", type: "INTEGER", notnull: 1, dflt_value: "0" }),
        expect.objectContaining({ name: "expires_at", type: "TEXT", notnull: 1 }),
      ]),
    );

    const routeColumns = await sql<{
      name: string;
      type: string;
      notnull: number;
    }>`PRAGMA table_info(task_durability_route_state)`.execute(db);
    expect(routeColumns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "agent_key", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "user_id", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "route_id", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "source_key", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "mode", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "seed_state", type: "TEXT", notnull: 1 }),
      ]),
    );

    const indexes = await sql<{ name: string }>`
      SELECT name
      FROM sqlite_master
      WHERE type='index'
        AND tbl_name IN (
          'tasks',
          'task_message_evidence',
          'task_completion_recommendations',
          'task_completion_recommendation_deliveries',
          'task_durability_route_state',
          'task_seed_candidates'
        )
    `.execute(db);
    expect(indexes.rows.map((row) => row.name)).toEqual(
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

    const evidenceForeignKeys = await sql<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>`PRAGMA foreign_key_list(task_message_evidence)`.execute(db);
    expect(evidenceForeignKeys.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "tasks", from: "task_id", to: "id", on_delete: "CASCADE" }),
        expect.objectContaining({
          table: "conversation_messages",
          from: "conversation_message_id",
          to: "id",
          on_delete: "CASCADE",
        }),
        expect.objectContaining({
          table: "conversations",
          from: "source_conversation_id",
          to: "id",
          on_delete: "CASCADE",
        }),
      ]),
    );
  });

  it("creates canonical agent output item task links and nulls them when the task is deleted", async () => {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
    await runMigrations(db, { quiet: true });

    const columns = await sql<{ name: string; type: string; notnull: number }>`
      PRAGMA table_info(agent_output_items)
    `.execute(db);
    expect(columns.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "task_id", type: "TEXT", notnull: 0 })]),
    );

    const foreignKeys = await sql<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>`PRAGMA foreign_key_list(agent_output_items)`.execute(db);
    expect(foreignKeys.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "tasks", from: "task_id", to: "id", on_delete: "SET NULL" }),
      ]),
    );

    const indexes = await sql<{ name: string }>`PRAGMA index_list(agent_output_items)`.execute(db);
    expect(indexes.rows.map((row) => row.name)).toContain("idx_agent_output_items_task_id");

    await sql`
      INSERT INTO users (id, name) VALUES ('task-link-user', 'Task Link User')
    `.execute(db);
    await sql`
      INSERT INTO agent_outputs (
        id, agent_key, user_id, output_date, source_key, timezone, status,
        trigger_type, agent_version
      ) VALUES (
        'task-link-output', 'daily_brief', 'task-link-user', '2026-07-17',
        '__global__', 'UTC', 'completed', 'manual', 'test'
      )
    `.execute(db);
    await sql`
      INSERT INTO tasks (
        id, source, title, normalized_title, status, status_authority,
        provenance, source_task_id
      ) VALUES (
        'task-link-task', 'brief', 'Linked task', 'linked task', 'open',
        'local', 'brief', 'task-link-source'
      )
    `.execute(db);
    await sql`
      INSERT INTO agent_output_items (
        id, agent_output_id, section_key, title, summary, priority,
        knowledge_refs_json, sort_order, task_id
      ) VALUES (
        'task-link-item', 'task-link-output', 'todos', 'Snapshot task',
        'Snapshot summary', 'medium', '{"entityIds":[],"fileIds":[]}', 0,
        'task-link-task'
      )
    `.execute(db);

    await sql`DELETE FROM tasks WHERE id = 'task-link-task'`.execute(db);

    const item = await sql<{ task_id: string | null }>`
      SELECT task_id FROM agent_output_items WHERE id = 'task-link-item'
    `.execute(db);
    expect(item.rows).toEqual([{ task_id: null }]);
  });

  it("creates the append-only task activity schema and indexes", async () => {
    await runMigrations(db, { quiet: true });

    const columns = await sql<{ name: string }>`
      SELECT name
      FROM pragma_table_info('task_activity_events')
      ORDER BY cid ASC
    `.execute(db);
    expect(columns.rows.map((row) => row.name)).toEqual([
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

    const indexes = await sql<{ name: string; unique: number }>`
      SELECT name, "unique"
      FROM pragma_index_list('task_activity_events')
      WHERE name IN (
        'idx_task_activity_events_task_time',
        'idx_task_activity_events_kind_time',
        'idx_task_activity_events_dedupe_key'
      )
      ORDER BY name ASC
    `.execute(db);
    expect(indexes.rows).toEqual([
      { name: "idx_task_activity_events_dedupe_key", unique: 1 },
      { name: "idx_task_activity_events_kind_time", unique: 0 },
      { name: "idx_task_activity_events_task_time", unique: 0 },
    ]);

    await sql`
      INSERT INTO tasks
        (id, source, title, normalized_title, status, status_authority, provenance, source_task_id, updated_at)
      VALUES
        ('activity-contract-task', 'summary', 'Contract task', 'contract task', 'open', 'local', 'summary', 'contract-task', '2026-07-23T00:00:00.000Z')
    `.execute(db);
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
      `.execute(db);
    }
    await expect(
      sql`
      INSERT INTO task_activity_events
        (id, task_id, event_kind, actor_type, surface, dedupe_key, occurred_at)
      VALUES
        ('invalid-activity-kind', 'activity-contract-task', 'task_created', 'provider', 'sync', 'invalid-kind', '2026-07-23T00:00:00.000Z')
    `.execute(db),
    ).rejects.toThrow();
    await expect(
      sql`
      INSERT INTO task_activity_events
        (id, task_id, event_kind, actor_type, surface, dedupe_key, occurred_at)
      VALUES
        ('invalid-activity-actor', 'activity-contract-task', 'created', 'integration', 'sync', 'invalid-actor', '2026-07-23T00:00:00.000Z')
    `.execute(db),
    ).rejects.toThrow();
    await expect(
      sql`
      INSERT INTO task_activity_events
        (id, task_id, event_kind, actor_type, surface, dedupe_key, occurred_at)
      VALUES
        ('invalid-activity-surface', 'activity-contract-task', 'created', 'provider', 'teams', 'invalid-surface', '2026-07-23T00:00:00.000Z')
    `.execute(db),
    ).rejects.toThrow();
  });

  it("migration 140 retires unassigned local agent tasks without touching structural tasks", async () => {
    const migrator = createMigrator(db);
    const partial = await migrator.migrateTo("139-tasks-proposed-assignee");
    expect(partial.error).toBeUndefined();

    await sql`
      INSERT INTO tasks
        (id, source, title, normalized_title, status, status_authority, provenance, source_task_id, updated_at)
      VALUES
        ('summary-unassigned', 'summary', 'Summary unassigned', 'summary unassigned', 'open', 'local', 'summary', 'summary-unassigned', '2026-07-10T00:00:00.000Z'),
        ('brief-unassigned', 'brief', 'Brief unassigned', 'brief unassigned', 'open', 'local', 'brief', 'brief-unassigned', '2026-07-10T00:00:00.000Z'),
        ('structural-unassigned', 'linear', 'Linear unassigned', 'linear unassigned', 'open', 'external', 'structural', 'structural-unassigned', '2026-07-10T00:00:00.000Z')
    `.execute(db);

    const latest = await migrator.migrateToLatest();
    expect(latest.error).toBeUndefined();

    const rows = await sql<{ id: string; valid_to: string | null }>`
      SELECT id, valid_to
      FROM tasks
      WHERE id IN ('summary-unassigned', 'brief-unassigned', 'structural-unassigned')
      ORDER BY id ASC
    `.execute(db);

    expect(rows.rows).toEqual([
      { id: "brief-unassigned", valid_to: expect.any(String) },
      { id: "structural-unassigned", valid_to: null },
      { id: "summary-unassigned", valid_to: expect.any(String) },
    ]);
  });

  it("migration 141 reassigns sentinel connector and fact owners to the earliest admin user", async () => {
    const migrator = createMigrator(db);
    const partial = await migrator.migrateTo("140-retire-unassigned-agent-tasks");
    expect(partial.error).toBeUndefined();

    await sql`
      INSERT INTO users (id, name, email, auth_role, created_at)
      VALUES
        ('member-1', 'Member', 'member@example.com', 'member', '2026-01-01T00:00:00.000Z'),
        ('admin-late', 'Admin Late', 'admin-late@example.com', 'admin', '2026-03-01T00:00:00.000Z'),
        ('admin-early', 'Admin Early', 'admin-early@example.com', 'admin', '2026-02-01T00:00:00.000Z')
    `.execute(db);
    await sql`
      INSERT INTO connector_configs (id, connector_type, auth_type, credentials, scope_config, created_by)
      VALUES
        ('conn-admin', 'clickup', 'api_key', '{}', '{}', 'admin'),
        ('conn-api-key', 'gmail', 'oauth', '{}', '{}', 'sketch-api-key'),
        ('conn-owned', 'linear', 'api_key', '{}', '{}', 'member-1')
    `.execute(db);
    await sql`
      INSERT INTO indexed_file_facts (id, source, fact_type, relation, fact_key, created_by_user_id)
      VALUES
        ('fact-admin', 'clickup', 'llm_task', 'mentioned', 'key-1', 'admin'),
        ('fact-api-key', 'gmail', 'commitment', 'mentioned', 'key-2', 'sketch-api-key'),
        ('fact-owned', 'linear', 'commitment', 'mentioned', 'key-3', 'member-1')
    `.execute(db);

    const latest = await migrator.migrateToLatest();
    expect(latest.error).toBeUndefined();

    const configs = await sql<{ id: string; created_by: string }>`
      SELECT id, created_by FROM connector_configs ORDER BY id ASC
    `.execute(db);
    expect(configs.rows).toEqual([
      { id: "conn-admin", created_by: "admin-early" },
      { id: "conn-api-key", created_by: "admin-early" },
      { id: "conn-owned", created_by: "member-1" },
    ]);

    const facts = await sql<{ id: string; created_by_user_id: string; materialization_attempts: number }>`
      SELECT id, created_by_user_id, materialization_attempts FROM indexed_file_facts ORDER BY id ASC
    `.execute(db);
    expect(facts.rows).toEqual([
      { id: "fact-admin", created_by_user_id: "admin-early", materialization_attempts: 0 },
      { id: "fact-api-key", created_by_user_id: "admin-early", materialization_attempts: 0 },
      { id: "fact-owned", created_by_user_id: "member-1", materialization_attempts: 0 },
    ]);
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
        expect.objectContaining({ name: "merged_by_user_id", type: "TEXT", notnull: 0 }),
        expect.objectContaining({ name: "group_id", type: "TEXT", notnull: 0 }),
        expect.objectContaining({ name: "merged_by", type: "TEXT", notnull: 0 }),
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
      expect.arrayContaining(["entity_merges_survivor_idx", "entity_merges_merged_idx", "entity_merges_group_idx"]),
    );
  });

  it("migration 171 down restores the NOT NULL ledger without indexing a dropped column", async () => {
    await runMigrations(db, { quiet: true });

    await entityMergeGroupsMigration.down(db as unknown as Kysely<unknown>);

    const columns = await sql<{ name: string; notnull: number }>`PRAGMA table_info(entity_merges)`.execute(db);
    expect(columns.rows.map((row) => row.name)).not.toContain("group_id");
    expect(columns.rows.map((row) => row.name)).not.toContain("merged_by");
    expect(columns.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "merged_by_user_id", notnull: 1 })]),
    );

    const indexes = await sql<{ name: string }>`PRAGMA index_list(entity_merges)`.execute(db);
    const names = indexes.rows.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["entity_merges_survivor_idx", "entity_merges_merged_idx"]));
    expect(names).not.toContain("entity_merges_group_idx");
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

  it("creates agent_messages and evolves chat_sessions for runtime-scoped sessions", async () => {
    await runMigrations(db, { quiet: true });

    const agentMessageColumns = await sql<{ name: string; notnull: number }>`PRAGMA table_info(agent_messages)`.execute(
      db,
    );
    expect(agentMessageColumns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", notnull: 0 }),
        expect.objectContaining({ name: "session_id", notnull: 1 }),
        expect.objectContaining({ name: "seq", notnull: 1 }),
        expect.objectContaining({ name: "role", notnull: 1 }),
        expect.objectContaining({ name: "content", notnull: 1 }),
        expect.objectContaining({ name: "created_at", notnull: 1 }),
      ]),
    );

    const chatSessionColumns = await sql<{ name: string; notnull: number; dflt_value: string | null }>`
      PRAGMA table_info(chat_sessions)
    `.execute(db);
    expect(chatSessionColumns.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "runtime", notnull: 1, dflt_value: "'sdk'" }),
        expect.objectContaining({ name: "archived_at", notnull: 0 }),
      ]),
    );

    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "workspace-1", thread_key: "", runtime: "sdk", session_id: "sess-sdk" })
      .execute();
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "workspace-1", thread_key: "", runtime: "aisdk", session_id: "sess-ai" })
      .execute();

    const rows = await db
      .selectFrom("chat_sessions")
      .select(["runtime", "session_id"])
      .where("workspace_key", "=", "workspace-1")
      .orderBy("runtime", "asc")
      .execute();
    expect(rows).toEqual([
      { runtime: "aisdk", session_id: "sess-ai" },
      { runtime: "sdk", session_id: "sess-sdk" },
    ]);
  });

  it("allows archived chat_session duplicates while enforcing one active row on SQLite", async () => {
    await runMigrations(db, { quiet: true });

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

  it("134 down drops archived rows and restores the pre-archive SQLite uniqueness", async () => {
    await runMigrations(db, { quiet: true });
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

    const columns = await sql<{ name: string }>`PRAGMA table_info(chat_sessions)`.execute(db);
    expect(columns.rows.map((row) => row.name)).not.toContain("archived_at");

    const rows = await db
      .selectFrom("chat_sessions")
      .select(["workspace_key", "thread_key", "runtime", "session_id"])
      .where("workspace_key", "=", "down-archive")
      .execute();
    expect(rows).toEqual([
      { workspace_key: "down-archive", thread_key: "", runtime: "sdk", session_id: "sess-active" },
    ]);
  });

  it("133 down keeps the sdk chat_session row when dual runtime rows share a workspace and thread", async () => {
    await runMigrations(db, { quiet: true });
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "down-workspace", thread_key: "", runtime: "sdk", session_id: "sess-sdk" })
      .execute();
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "down-workspace", thread_key: "", runtime: "aisdk", session_id: "sess-ai" })
      .execute();

    await expect(chatSessionRuntimeMigration.down(db as Kysely<unknown>)).resolves.not.toThrow();

    const rows = await sql<{ workspace_key: string; thread_key: string; session_id: string }>`
      SELECT workspace_key, thread_key, session_id
      FROM chat_sessions
      WHERE workspace_key = 'down-workspace'
      ORDER BY session_id ASC
    `.execute(db);
    expect(rows.rows).toEqual([{ workspace_key: "down-workspace", thread_key: "", session_id: "sess-sdk" }]);

    const runtimeColumns = await sql<{ name: string }>`
      PRAGMA table_info(chat_sessions)
    `.execute(db);
    expect(runtimeColumns.rows.map((row) => row.name)).not.toContain("runtime");
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
    /**
     * Models a real incident: migrations 107-120 ran their DDL but the ledger
     * writes for some of them were lost, so on restart Kysely found the
     * columns/tables already present. 107-116/119/120 guard their DDL via
     * introspection (safe to run twice); 114/115/117/118 unconditionally
     * CREATE TABLE/INDEX (not safe to run twice) and were never hardened for
     * this recovery because they were part of the same incident's fix, not
     * its cause — see migrate.ts's per-migration up() implementations.
     *
     * Reproducing this by deleting kysely_migration rows after a full
     * migrateToLatest() only stayed a valid Kysely ledger state while 120 was
     * the tail of the migration list; Kysely's ensureMigrationsInOrder always
     * requires the executed set to be a prefix of the full sorted migration
     * list, and once migrations landed after 120 the surviving executed set
     * (…106, 121+) stopped being a prefix.
     *
     * Instead, build the DB to migration 106 via the real migrator (matching
     * reality: 106 genuinely ran and got recorded), then call the 10 guarded
     * migrations' up() directly — bypassing the ledger entirely — to apply
     * their DDL without recording them as executed. The 4 unguarded
     * migrations are left untouched (genuinely pending). This never touches
     * anything past 120 and never depends on the Migrator/ledger for the
     * simulated range, so it can't be destabilized by any migration landing
     * after 120, no matter how many more are added.
     */
    const migrator = createMigrator(db);
    const { error: upTo106Error } = await migrator.migrateTo("106-agents");
    if (upTo106Error) throw upTo106Error;

    for (const guarded of [m107, m108, m109, m110, m111, m112, m113, m116, m119, m120]) {
      await guarded.up(db as Kysely<unknown>);
    }

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
        '120-agent-output-period-key',
        '121-tasks',
        '122-tasks-owner',
        '123-sub-entities',
        '124-tasks-assignee-name',
        '125-milestone-series-and-value-signature',
        '126-work-cycles',
        '127-work-cycles-connector',
        '128-work-cycles-connector-key',
        '129-container-name-qualification',
        '130-entity-provenance-tier',
        '131-trunk-name-embeddings',
        '132-agent-messages',
        '133-chat-session-runtime',
        '134-chat-session-archived-at',
        '135-whatsapp-context-graph-indexing',
        '136-whatsapp-slice-denoised-message-ids',
        '137-whatsapp-group-participants',
        '138-whatsapp-identity-candidates',
        '139-tasks-proposed-assignee',
        '140-retire-unassigned-agent-tasks'
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
      { name: "121-tasks" },
      { name: "122-tasks-owner" },
      { name: "123-sub-entities" },
      { name: "124-tasks-assignee-name" },
      { name: "125-milestone-series-and-value-signature" },
      { name: "126-work-cycles" },
      { name: "127-work-cycles-connector" },
      { name: "128-work-cycles-connector-key" },
      { name: "129-container-name-qualification" },
      { name: "130-entity-provenance-tier" },
      { name: "131-trunk-name-embeddings" },
      { name: "132-agent-messages" },
      { name: "133-chat-session-runtime" },
      { name: "134-chat-session-archived-at" },
      { name: "135-whatsapp-context-graph-indexing" },
      { name: "136-whatsapp-slice-denoised-message-ids" },
      { name: "137-whatsapp-group-participants" },
      { name: "138-whatsapp-identity-candidates" },
      { name: "139-tasks-proposed-assignee" },
      { name: "140-retire-unassigned-agent-tasks" },
    ]);

    // runMigrations() always migrates to latest, so recovering 107-120 above
    // should also carry cleanly through every migration added after it.
    const allRows = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(db);
    expect(allRows.rows).toHaveLength(EXPECTED_MIGRATION_COUNT);
  });
});
