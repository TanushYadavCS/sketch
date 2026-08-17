import type { Kysely } from "kysely";
import { sql } from "kysely";

const TABLE = "automation_task_locks";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable(TABLE)
    .addColumn("holder_session_id", "text", (col) => col.notNull().defaultTo("legacy"))
    .execute();
  await db.schema
    .alterTable(TABLE)
    .addColumn("generation", "integer", (col) => col.notNull().defaultTo(1))
    .execute();
  await db.schema.alterTable(TABLE).addColumn("steal_requester_session_id", "text").execute();
  await sql`
    UPDATE ${sql.table(TABLE)}
    SET steal_requester_session_id = ${"legacy"}
    WHERE steal_requester_user_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable(TABLE).dropColumn("steal_requester_session_id").execute();
  await db.schema.alterTable(TABLE).dropColumn("generation").execute();
  await db.schema.alterTable(TABLE).dropColumn("holder_session_id").execute();
}
