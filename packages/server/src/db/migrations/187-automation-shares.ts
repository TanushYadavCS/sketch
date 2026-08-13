import { type Kysely, sql } from "kysely";

const TASK_USER_UNIQUE_INDEX = "automation_task_shares_task_user_uidx";
const USER_INDEX = "automation_task_shares_user_idx";

/**
 * Per-person grants for automation (scheduled task) access. task_id has no
 * foreign key on purpose — it mirrors the automation_runs precedent and the
 * owner-only delete path removes share rows inside deleteAutomation's
 * transaction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("automation_task_shares")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("task_id", "text", (col) => col.notNull())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("granted_by_user_id", "text", (col) => col.notNull())
    .addColumn("granted_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
  await db.schema
    .createIndex(TASK_USER_UNIQUE_INDEX)
    .on("automation_task_shares")
    .columns(["task_id", "user_id"])
    .unique()
    .execute();
  await db.schema.createIndex(USER_INDEX).on("automation_task_shares").column("user_id").execute();
  await db.schema.alterTable("automation_runs").addColumn("triggered_by_user_id", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("automation_runs").dropColumn("triggered_by_user_id").execute();
  await db.schema.dropIndex(USER_INDEX).execute();
  await db.schema.dropIndex(TASK_USER_UNIQUE_INDEX).execute();
  await db.schema.dropTable("automation_task_shares").execute();
}
