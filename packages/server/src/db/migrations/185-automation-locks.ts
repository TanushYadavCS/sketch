import { type Kysely, sql } from "kysely";

const EXPIRES_INDEX = "automation_task_locks_expires_idx";

/**
 * Pessimistic whole-automation edit locks with steal-confirmation. task_id is
 * the primary key with no foreign key on purpose — it mirrors the
 * automation_task_shares / automation_runs precedent and the owner-only delete
 * path removes lock rows inside deleteAutomation's transaction. All
 * timestamps are app-generated ISO-8601 UTC strings; expiry comparisons happen
 * in application code, so the column types are plain text on both SQLite and
 * Postgres.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("automation_task_locks")
    .addColumn("task_id", "text", (col) => col.primaryKey())
    .addColumn("holder_user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("holder_platform", "text", (col) => col.notNull())
    .addColumn("holder_surface", "text", (col) => col.notNull())
    .addColumn("holder_conversation_id", "text")
    .addColumn("acquired_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("expires_at", "text", (col) => col.notNull())
    .addColumn("steal_requester_user_id", "text")
    .addColumn("steal_requester_platform", "text")
    .addColumn("steal_requester_surface", "text")
    .addColumn("steal_requester_conversation_id", "text")
    .addColumn("steal_requested_at", "text")
    .addColumn("steal_expires_at", "text")
    .execute();
  await db.schema.createIndex(EXPIRES_INDEX).on("automation_task_locks").column("expires_at").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex(EXPIRES_INDEX).execute();
  await db.schema.dropTable("automation_task_locks").execute();
}
