import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("webhook_endpoints")
    .addColumn("generation", "integer", (column) => column.notNull().defaultTo(1))
    .execute();
  await db.schema
    .alterTable("webhook_deliveries")
    .addColumn("task_revision", "integer", (column) => column.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable("webhook_deliveries")
    .addColumn("endpoint_generation", "integer", (column) => column.notNull().defaultTo(1))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("webhook_deliveries").dropColumn("endpoint_generation").execute();
  await db.schema.alterTable("webhook_deliveries").dropColumn("task_revision").execute();
  await db.schema.alterTable("webhook_endpoints").dropColumn("generation").execute();
}
