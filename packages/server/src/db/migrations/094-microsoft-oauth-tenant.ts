import type { Kysely } from "kysely";
import type { DB } from "../schema";

export async function up(db: Kysely<DB>): Promise<void> {
  await db.schema.alterTable("settings").addColumn("microsoft_oauth_tenant", "text").execute();
}

export async function down(db: Kysely<DB>): Promise<void> {
  await db.schema.alterTable("settings").dropColumn("microsoft_oauth_tenant").execute();
}
