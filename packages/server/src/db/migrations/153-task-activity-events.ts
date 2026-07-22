import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_activity_events")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("task_id", "text", (col) => col.notNull().references("tasks.id").onDelete("cascade"))
    .addColumn("event_kind", "text", (col) => col.notNull())
    .addColumn("actor_type", "text", (col) => col.notNull())
    .addColumn("actor_user_id", "text", (col) => col.references("users.id").onDelete("set null"))
    .addColumn("actor_key", "text")
    .addColumn("surface", "text", (col) => col.notNull())
    .addColumn("source_agent_output_id", "text", (col) => col.references("agent_outputs.id").onDelete("set null"))
    .addColumn("changes_json", "text")
    .addColumn("evidence_json", "text")
    .addColumn("dedupe_key", "text", (col) => col.notNull())
    .addColumn("occurred_at", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_task_activity_events_task_time")
    .on("task_activity_events")
    .columns(["task_id", "occurred_at", "id"])
    .execute();
  await db.schema
    .createIndex("idx_task_activity_events_kind_time")
    .on("task_activity_events")
    .columns(["event_kind", "occurred_at", "id"])
    .execute();
  await db.schema
    .createIndex("idx_task_activity_events_dedupe_key")
    .unique()
    .on("task_activity_events")
    .column("dedupe_key")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("task_activity_events").execute();
}
