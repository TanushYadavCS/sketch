import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("work_cycles")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("scope_entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("external_ref", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("sequence", "integer")
    .addColumn("starts_at", "text")
    .addColumn("ends_at", "text")
    .addColumn("state", "text", (col) => col.notNull().defaultTo("planned"))
    .addColumn("last_seen_sync_run_id", "text")
    .addColumn("deleted_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createTable("task_cycle_memberships")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("task_id", "text", (col) => col.notNull().references("tasks.id").onDelete("cascade"))
    .addColumn("cycle_id", "text", (col) => col.notNull().references("work_cycles.id").onDelete("cascade"))
    .addColumn("assigned_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("removed_at", "text")
    .addColumn("source_fact_id", "text", (col) => col.references("indexed_file_facts.id").onDelete("set null"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_work_cycles_source_ref")
    .unique()
    .on("work_cycles")
    .columns(["source", "external_ref"])
    .execute();
  await db.schema.createIndex("idx_work_cycles_last_seen").on("work_cycles").column("last_seen_sync_run_id").execute();
  await sql`
    CREATE UNIQUE INDEX idx_task_cycle_current
    ON task_cycle_memberships(task_id)
    WHERE removed_at IS NULL
  `.execute(db);
  await db.schema
    .createIndex("idx_task_cycle_memberships_cycle")
    .on("task_cycle_memberships")
    .column("cycle_id")
    .execute();
  await db.schema
    .createIndex("idx_task_cycle_memberships_task")
    .on("task_cycle_memberships")
    .column("task_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_task_cycle_memberships_task").ifExists().execute();
  await db.schema.dropIndex("idx_task_cycle_memberships_cycle").ifExists().execute();
  await sql`DROP INDEX IF EXISTS idx_task_cycle_current`.execute(db);
  await db.schema.dropIndex("idx_work_cycles_last_seen").ifExists().execute();
  await db.schema.dropIndex("idx_work_cycles_source_ref").ifExists().execute();
  await db.schema.dropTable("task_cycle_memberships").execute();
  await db.schema.dropTable("work_cycles").execute();
}
