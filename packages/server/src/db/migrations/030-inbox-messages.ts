import { type Kysely, sql } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema
    .createTable("inbox_messages")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("sender_user_id", "text", (col) => col.notNull().references("users.id"))
    .addColumn("recipient_user_id", "text", (col) => col.notNull().references("users.id"))
    .addColumn("message", "text", (col) => col.notNull())
    .addColumn("platform", "text", (col) => col.notNull())
    .addColumn("channel_id", "text")
    .addColumn("message_ref", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("consumed_at", "text")
    .execute();

  await sql`CREATE INDEX idx_inbox_recipient_consumed ON inbox_messages(recipient_user_id, consumed_at)`.execute(db);
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.dropTable("inbox_messages").execute();
}
