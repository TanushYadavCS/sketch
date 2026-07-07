import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("tasks")
    .addColumn("created_by_user_id", "text", (col) => col.references("users.id"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("tasks").dropColumn("created_by_user_id").execute();
}
