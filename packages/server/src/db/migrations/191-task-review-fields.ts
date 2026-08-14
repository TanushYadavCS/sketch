import type { Kysely } from "kysely";

/**
 * Fields the task review surface reads: how a task was derived, when it expires, and what
 * evidence backs both its existence and its current status.
 *
 * `perishable` is `integer` rather than `boolean` so the column behaves identically on SQLite
 * and Postgres, matching `is_archived` and `share_with_everyone` on `indexed_files`.
 *
 * Nothing in the application writes these columns today. They are filled by the extraction
 * pipeline out of band, and the product only reads them — so every column is nullable and
 * carries no default beyond `perishable`.
 */

const COLUMNS = [
  "owner_scope",
  "owner_basis",
  "expiry_state",
  "due_basis",
  "urgency",
  "raised_at",
  "evidence_quote",
  "confidence",
  "client_name",
  "status_signal",
  "status_reason",
  "status_confidence",
  "status_at",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const column of COLUMNS) {
    await db.schema.alterTable("tasks").addColumn(column, "text").execute();
  }
  await db.schema
    .alterTable("tasks")
    .addColumn("perishable", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable("tasks")
    .addColumn("client_entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .execute();

  await db.schema.createIndex("idx_tasks_status_expiry").on("tasks").columns(["status", "expiry_state"]).execute();
  await db.schema.createIndex("idx_tasks_client_entity").on("tasks").column("client_entity_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_tasks_client_entity").execute();
  await db.schema.dropIndex("idx_tasks_status_expiry").execute();
  await db.schema.alterTable("tasks").dropColumn("client_entity_id").execute();
  await db.schema.alterTable("tasks").dropColumn("perishable").execute();
  for (const column of [...COLUMNS].reverse()) {
    await db.schema.alterTable("tasks").dropColumn(column).execute();
  }
}
