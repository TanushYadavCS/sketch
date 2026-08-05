import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("slack_user_sync_state").addColumn("last_roster_seen_at", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("slack_user_sync_state").dropColumn("last_roster_seen_at").execute();
}
