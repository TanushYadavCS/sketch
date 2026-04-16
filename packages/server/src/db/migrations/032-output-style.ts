import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").addColumn("output_style", "text").execute();
  await db.schema.alterTable("channels").addColumn("output_style", "text").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("output_style", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("whatsapp_groups").dropColumn("output_style").execute();
  await db.schema.alterTable("channels").dropColumn("output_style").execute();
  await db.schema.alterTable("users").dropColumn("output_style").execute();
}
