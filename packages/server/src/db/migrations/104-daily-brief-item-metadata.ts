import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("daily_brief_items").addColumn("label", "text").execute();
  await db.schema.alterTable("daily_brief_items").addColumn("display_ref", "text").execute();
  await db.schema.alterTable("daily_brief_items").addColumn("action_label", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("daily_brief_items").dropColumn("action_label").execute();
  await db.schema.alterTable("daily_brief_items").dropColumn("display_ref").execute();
  await db.schema.alterTable("daily_brief_items").dropColumn("label").execute();
}
