import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("daily_briefs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("brief_date", "text", (col) => col.notNull())
    .addColumn("timezone", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("trigger_type", "text", (col) => col.notNull())
    .addColumn("agent_key", "text", (col) => col.notNull())
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
    .createIndex("idx_daily_briefs_user_date")
    .on("daily_briefs")
    .columns(["user_id", "brief_date"])
    .execute();
  await db.schema.createIndex("idx_daily_briefs_status").on("daily_briefs").columns(["status"]).execute();
  await db.schema
    .createIndex("idx_daily_briefs_latest")
    .on("daily_briefs")
    .columns(["user_id", "brief_date", "status", "generated_at"])
    .execute();
  await sql`
    CREATE UNIQUE INDEX idx_daily_briefs_running_unique
      ON daily_briefs (user_id, brief_date)
     WHERE status = 'running'
  `.execute(db);

  await db.schema
    .createTable("daily_brief_items")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("daily_brief_id", "text", (col) => col.notNull().references("daily_briefs.id").onDelete("cascade"))
    .addColumn("section_key", "text", (col) => col.notNull())
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("summary", "text", (col) => col.notNull())
    .addColumn("priority", "text", (col) => col.notNull())
    .addColumn("action_type", "text")
    .addColumn("action_prompt", "text")
    .addColumn("knowledge_refs_json", "text", (col) => col.notNull())
    .addColumn("source_url", "text")
    .addColumn("sort_order", "integer", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_daily_brief_items_brief")
    .on("daily_brief_items")
    .columns(["daily_brief_id", "section_key", "sort_order"])
    .execute();

  await db.schema
    .createTable("daily_brief_configs")
    .addColumn("user_id", "text", (col) => col.primaryKey())
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("schedule_hour", "integer", (col) => col.notNull().defaultTo(8))
    .addColumn("schedule_minute", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("timezone", "text")
    .addColumn("max_items_per_section", "integer", (col) => col.notNull().defaultTo(4))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("daily_brief_configs").execute();
  await db.schema.dropTable("daily_brief_items").execute();
  await db.schema.dropTable("daily_briefs").execute();
}
