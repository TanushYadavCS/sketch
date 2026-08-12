import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("webhook_endpoints").dropColumn("secret").execute();
  await db.schema.alterTable("webhook_endpoints").dropColumn("rotated_at").execute();
  await db.schema.alterTable("webhook_endpoints").dropColumn("revoked_at").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("webhook_endpoints")
    .addColumn("secret", "text", (column) => column.notNull().defaultTo(""))
    .execute();
  await db.schema.alterTable("webhook_endpoints").addColumn("rotated_at", "text").execute();
  await db.schema.alterTable("webhook_endpoints").addColumn("revoked_at", "text").execute();
}
