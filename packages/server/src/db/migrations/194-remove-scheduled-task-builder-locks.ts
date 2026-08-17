import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

const TABLE = "scheduled_task_builder_locks";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(TABLE).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable(TABLE)
    .addColumn("task_id", "text", (col) => col.notNull().primaryKey())
    .addColumn("conversation_id", "text", (col) => col.notNull())
    .addColumn("transcript_user_id", "text", (col) => col.notNull())
    .addColumn("acquired_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("renewed_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("expires_at", isPg(db) ? "bigint" : "integer", (col) => col.notNull())
    .execute();
}
