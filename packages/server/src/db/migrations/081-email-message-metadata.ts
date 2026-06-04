import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("email_message_envelopes")
    .addColumn("indexed_file_id", "text", (col) => col.primaryKey().references("indexed_files.id").onDelete("cascade"))
    .addColumn("connector_config_id", "text", (col) =>
      col.notNull().references("connector_configs.id").onDelete("cascade"),
    )
    .addColumn("provider_file_id", "text", (col) => col.notNull())
    .addColumn("provider_message_id", "text", (col) => col.notNull())
    .addColumn("thread_id", "text")
    .addColumn("subject", "text")
    .addColumn("sent_at", "text")
    .addColumn("from_json", "text", (col) => col.notNull())
    .addColumn("to_json", "text", (col) => col.notNull())
    .addColumn("cc_json", "text", (col) => col.notNull())
    .addColumn("owner_email", "text")
    .addColumn("provider_url", "text")
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await sql`
    CREATE INDEX idx_email_message_envelopes_thread
    ON email_message_envelopes(connector_config_id, thread_id, sent_at)
    WHERE thread_id IS NOT NULL
  `.execute(db);

  await db.schema
    .createTable("email_suppressed_messages")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("connector_config_id", "text", (col) =>
      col.notNull().references("connector_configs.id").onDelete("cascade"),
    )
    .addColumn("provider_file_id", "text", (col) => col.notNull())
    .addColumn("provider_message_id", "text")
    .addColumn("thread_id", "text")
    .addColumn("reason", "text", (col) => col.notNull())
    .addColumn("observed_at", "text", (col) => col.notNull())
    .execute();

  await sql`
    CREATE UNIQUE INDEX uq_email_suppressed_messages_provider
    ON email_suppressed_messages(connector_config_id, provider_file_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_email_suppressed_messages_provider`.execute(db);
  await db.schema.dropTable("email_suppressed_messages").execute();
  await sql`DROP INDEX IF EXISTS idx_email_message_envelopes_thread`.execute(db);
  await db.schema.dropTable("email_message_envelopes").execute();
}
