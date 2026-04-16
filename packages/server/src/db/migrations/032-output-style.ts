import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").addColumn("tool_progress", "text").execute();
  await db.schema.alterTable("users").addColumn("reasoning_text", "integer").execute();
  await db.schema.alterTable("channels").addColumn("tool_progress", "text").execute();
  await db.schema.alterTable("channels").addColumn("reasoning_text", "integer").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("tool_progress", "text").execute();
  await db.schema.alterTable("whatsapp_groups").addColumn("reasoning_text", "integer").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("whatsapp_groups").dropColumn("reasoning_text").execute();
  await db.schema.alterTable("whatsapp_groups").dropColumn("tool_progress").execute();
  await db.schema.alterTable("channels").dropColumn("reasoning_text").execute();
  await db.schema.alterTable("channels").dropColumn("tool_progress").execute();
  await db.schema.alterTable("users").dropColumn("reasoning_text").execute();
  await db.schema.alterTable("users").dropColumn("tool_progress").execute();
}
