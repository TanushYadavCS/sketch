import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("scheduled_tasks")
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();
  await db.schema
    .alterTable("scheduled_tasks")
    .addColumn("revision", "integer", (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable("scheduled_tasks").addColumn("last_edited_by", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("scheduled_tasks").dropColumn("last_edited_by").execute();
  await db.schema.alterTable("scheduled_tasks").dropColumn("revision").execute();
  await db.schema.alterTable("scheduled_tasks").dropColumn("updated_at").execute();
}
