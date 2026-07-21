import { type Kysely, sql } from "kysely";

/**
 * Slack channel indexing foundation.
 *
 * 1. `conversation_slices.provider_thread_id`: thread slices produced by the
 *    Slack chunker record which thread they belong to so salience rendering and
 *    recall can scope by thread. Channel-stream and WhatsApp slices leave it null.
 * 2. `conversation_slice_stream_cursors`: per-stream chunking cursors for Slack.
 *    A Slack channel conversation is chunked as multiple independent streams
 *    (one top-level "channel" stream plus one stream per thread), each with its
 *    own durable cursor so replay stays idempotent per stream and a busy thread
 *    cannot stall the channel stream. The reserved stream_key "::router" holds
 *    the per-conversation discovery high-water mark. The WhatsApp single-cursor
 *    table (`conversation_slice_cursors`) is intentionally left untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("conversation_slices").addColumn("provider_thread_id", "text").execute();
  await db.schema
    .createIndex("idx_conversation_slices_provider_thread")
    .on("conversation_slices")
    .columns(["conversation_id", "provider_thread_id"])
    .execute();

  await db.schema
    .createTable("conversation_slice_stream_cursors")
    .addColumn("conversation_id", "integer", (col) => col.notNull().references("conversations.id").onDelete("cascade"))
    .addColumn("stream_key", "text", (col) => col.notNull())
    .addColumn("last_message_id", "integer")
    .addColumn("claim_token", "text")
    .addColumn("claimed_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("conversation_slice_stream_cursors_pk", ["conversation_id", "stream_key"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("conversation_slice_stream_cursors").execute();
  await db.schema.dropIndex("idx_conversation_slices_provider_thread").execute();
  await db.schema.alterTable("conversation_slices").dropColumn("provider_thread_id").execute();
}
