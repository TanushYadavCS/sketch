import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("tasks")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("parent_entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .addColumn("parent_source_ref", "text")
    .addColumn("parent_name", "text")
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("external_ref", "text")
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("normalized_title", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("status_raw", "text")
    .addColumn("status_authority", "text", (col) => col.notNull())
    .addColumn("assignee_entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .addColumn("priority", "text")
    .addColumn("due_at", "text")
    .addColumn("provenance", "text", (col) => col.notNull())
    .addColumn("source_task_id", "text", (col) => col.notNull())
    .addColumn("status_changed_at", "text")
    .addColumn("completed_at", "text")
    .addColumn("valid_from", "text")
    .addColumn("valid_to", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createTable("task_evidence")
    .addColumn("task_id", "text", (col) => col.notNull().references("tasks.id").onDelete("cascade"))
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("ref_id", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("task_evidence_pkey", ["task_id", "kind", "ref_id"])
    .execute();

  await db.schema
    .createIndex("idx_tasks_source_task")
    .on("tasks")
    .columns(["source", "source_task_id"])
    .unique()
    .execute();
  await db.schema.createIndex("idx_tasks_parent_status").on("tasks").columns(["parent_entity_id", "status"]).execute();
  await db.schema
    .createIndex("idx_tasks_assignee_status")
    .on("tasks")
    .columns(["assignee_entity_id", "status"])
    .execute();
  await db.schema.createIndex("idx_task_evidence_kind_ref").on("task_evidence").columns(["kind", "ref_id"]).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("task_evidence").execute();
  await db.schema.dropTable("tasks").execute();
}
