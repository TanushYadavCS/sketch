import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("scheduled_tasks")
    .addColumn("output_mode", "text", (col) => col.notNull().defaultTo("deliver"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("scheduled_tasks").dropColumn("output_mode").execute();
}
