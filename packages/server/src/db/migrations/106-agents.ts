import { type Kysely, sql } from "kysely";

/**
 * Generalizes the bespoke Daily Brief storage into the prebuilt-agent engine.
 *
 * Creates the generic `agent_outputs` / `agent_output_items` / `agent_user_configs`
 * tables (keyed by `agent_key`), backfills the existing Daily Brief data into them,
 * then drops the legacy `daily_brief_*` tables. Migrations 103/104 are left intact:
 * deployed databases already recorded them, so the generic schema arrives as a new
 * forward migration rather than an edit to the historical ones.
 *
 * Cross-dialect: portable Kysely builders throughout; the partial unique index that
 * coalesces concurrent runs is raw SQL (valid on both SQLite and Postgres), mirroring
 * migration 103.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("agent_outputs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("agent_key", "text", (col) => col.notNull())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("output_date", "text", (col) => col.notNull())
    .addColumn("timezone", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("trigger_type", "text", (col) => col.notNull())
    .addColumn("agent_version", "text", (col) => col.notNull())
    .addColumn("agent_run_id", "text")
    .addColumn("masthead_json", "text")
    .addColumn("raw_payload_json", "text")
    .addColumn("error_message", "text")
    .addColumn("generated_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_agent_outputs_key_user_date")
    .on("agent_outputs")
    .columns(["agent_key", "user_id", "output_date"])
    .execute();
  await db.schema.createIndex("idx_agent_outputs_status").on("agent_outputs").columns(["status"]).execute();
  await db.schema
    .createIndex("idx_agent_outputs_latest")
    .on("agent_outputs")
    .columns(["agent_key", "user_id", "output_date", "status", "generated_at"])
    .execute();
  await sql`
    CREATE UNIQUE INDEX idx_agent_outputs_running_unique
      ON agent_outputs (agent_key, user_id, output_date)
     WHERE status = 'running'
  `.execute(db);

  await db.schema
    .createTable("agent_output_items")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("agent_output_id", "text", (col) => col.notNull().references("agent_outputs.id").onDelete("cascade"))
    .addColumn("section_key", "text", (col) => col.notNull())
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("summary", "text", (col) => col.notNull())
    .addColumn("priority", "text", (col) => col.notNull())
    .addColumn("label", "text")
    .addColumn("display_ref", "text")
    .addColumn("action_type", "text")
    .addColumn("action_label", "text")
    .addColumn("action_prompt", "text")
    .addColumn("knowledge_refs_json", "text", (col) => col.notNull())
    .addColumn("source_url", "text")
    .addColumn("sort_order", "integer", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_agent_output_items_output")
    .on("agent_output_items")
    .columns(["agent_output_id", "section_key", "sort_order"])
    .execute();

  await db.schema
    .createTable("agent_user_configs")
    .addColumn("agent_key", "text", (col) => col.notNull())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("schedule_hour", "integer", (col) => col.notNull().defaultTo(8))
    .addColumn("schedule_minute", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("timezone", "text")
    .addColumn("max_items_per_section", "integer", (col) => col.notNull().defaultTo(4))
    .addColumn("prefs_json", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("agent_user_configs_pkey", ["agent_key", "user_id"])
    .execute();

  await backfillFromDailyBrief(db);

  await db.schema.dropTable("daily_brief_items").execute();
  await db.schema.dropTable("daily_briefs").execute();
  await db.schema.dropTable("daily_brief_configs").execute();
}

/**
 * Copies existing Daily Brief rows into the generic tables. The legacy rows already
 * carry `agent_key='daily_brief'` and `agent_version`, so the only column rename is
 * `brief_date` -> `output_date` and `daily_brief_id` -> `agent_output_id`. Section
 * toggles and focus have no legacy data, so `prefs_json` stays NULL; `max_items_per_section`
 * is preserved as a column to keep the backfill a portable INSERT ... SELECT.
 */
async function backfillFromDailyBrief(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO agent_outputs (
      id, agent_key, user_id, output_date, timezone, status, trigger_type,
      agent_version, agent_run_id, masthead_json, raw_payload_json, error_message,
      generated_at, created_at, updated_at
    )
    SELECT
      id, agent_key, user_id, brief_date, timezone, status, trigger_type,
      agent_version, agent_run_id, masthead_json, raw_payload_json, error_message,
      generated_at, created_at, updated_at
    FROM daily_briefs
  `.execute(db);

  await sql`
    INSERT INTO agent_output_items (
      id, agent_output_id, section_key, title, summary, priority, label, display_ref,
      action_type, action_label, action_prompt, knowledge_refs_json, source_url,
      sort_order, created_at
    )
    SELECT
      id, daily_brief_id, section_key, title, summary, priority, label, display_ref,
      action_type, action_label, action_prompt, knowledge_refs_json, source_url,
      sort_order, created_at
    FROM daily_brief_items
  `.execute(db);

  await sql`
    INSERT INTO agent_user_configs (
      agent_key, user_id, enabled, schedule_hour, schedule_minute, timezone,
      max_items_per_section, created_at, updated_at
    )
    SELECT
      'daily_brief', user_id, enabled, schedule_hour, schedule_minute, timezone,
      max_items_per_section, created_at, updated_at
    FROM daily_brief_configs
  `.execute(db);
}

/**
 * Irreversible: the up() migration consolidated and dropped the legacy `daily_brief_*`
 * tables, so simply dropping the generic tables would leave migration 104 without the
 * `daily_brief_items` table its own down() expects, and would discard the migrated brief
 * data. We fail fast here rather than corrupt the chain. Roll back by restoring a backup
 * taken before this migration ran.
 */
export async function down(): Promise<void> {
  throw new Error(
    "Migration 106-agents is irreversible: it consolidated and dropped the legacy daily_brief_* tables. " +
      "Restore from a backup taken before migration 106 instead of rolling back.",
  );
}
