import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("settings").addColumn("microsoft_oauth_client_id", "text").execute();
  await db.schema.alterTable("settings").addColumn("microsoft_oauth_client_secret", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("settings").dropColumn("microsoft_oauth_client_secret").execute();
  await db.schema.alterTable("settings").dropColumn("microsoft_oauth_client_id").execute();
}
