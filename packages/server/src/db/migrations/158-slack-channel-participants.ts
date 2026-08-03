import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("slack_channel_participants")
    .addColumn("channel_id", "text", (col) => col.notNull())
    .addColumn("slack_user_id", "text", (col) => col.notNull())
    .addColumn("last_seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("slack_channel_participants_channel_user_uidx", ["channel_id", "slack_user_id"])
    .execute();

  await db.schema
    .createIndex("idx_slack_channel_participants_user")
    .on("slack_channel_participants")
    .columns(["slack_user_id", "last_seen_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_slack_channel_participants_user").execute();
  await db.schema.dropTable("slack_channel_participants").execute();
}
