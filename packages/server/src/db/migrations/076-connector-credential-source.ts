import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("connector_configs")
    .addColumn("credential_source", "text", (col) => col.notNull().defaultTo("local"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("connector_configs").dropColumn("credential_source").execute();
}
