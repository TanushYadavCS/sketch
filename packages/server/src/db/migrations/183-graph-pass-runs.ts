import { type Kysely, sql } from "kysely";

const TABLE = "graph_pass_runs";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable(TABLE)
    .addColumn("id", "text", (col) => col.notNull().primaryKey())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("started_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("finished_at", "text")
    .addColumn("error_message", "text")
    .addColumn("input_snapshot_json", "text", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable(TABLE).execute();
}
