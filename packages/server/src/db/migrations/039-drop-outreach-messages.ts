/**
 * Drops the legacy outreach_messages table. The tracked request/response outreach flow
 * was retired in v0.18.0 in favor of one-way inbox messaging (see migration 030). The
 * table has been unused since then; this migration removes it and its two indexes.
 *
 * `down()` recreates the table with the original 017 shape so rollback is symmetric.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("outreach_messages").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("outreach_messages")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("requester_user_id", "text", (col) => col.notNull().references("users.id"))
    .addColumn("recipient_user_id", "text", (col) => col.notNull().references("users.id"))
    .addColumn("message", "text", (col) => col.notNull())
    .addColumn("task_context", "text")
    .addColumn("response", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("platform", "text", (col) => col.notNull())
    .addColumn("channel_id", "text")
    .addColumn("message_ref", "text")
    .addColumn("requester_platform", "text", (col) => col.notNull())
    .addColumn("requester_channel", "text", (col) => col.notNull())
    .addColumn("requester_thread_ts", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("responded_at", "text")
    .execute();

  await sql`CREATE INDEX idx_outreach_recipient_status ON outreach_messages(recipient_user_id, status)`.execute(db);
  await sql`CREATE INDEX idx_outreach_requester_status ON outreach_messages(requester_user_id, status)`.execute(db);
}
