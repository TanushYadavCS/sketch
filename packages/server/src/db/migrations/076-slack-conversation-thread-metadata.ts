import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("conversation_messages").addColumn("provider_thread_id", "text").execute();
  await db.schema.alterTable("conversation_messages").addColumn("provider_parent_message_id", "text").execute();
  await db.schema
    .alterTable("conversation_messages")
    .addColumn("is_thread_reply", "integer", (col) => col.notNull().defaultTo(0))
    .execute();

  if (isPg(db)) {
    await sql`CREATE TABLE conversation_cursors (
      id serial PRIMARY KEY,
      conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      scope_type text NOT NULL,
      scope_key text NOT NULL,
      last_seen_message_id integer,
      created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`.execute(db);
  } else {
    await db.schema
      .createTable("conversation_cursors")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("conversation_id", "integer", (col) =>
        col.notNull().references("conversations.id").onDelete("cascade"),
      )
      .addColumn("scope_type", "text", (col) => col.notNull())
      .addColumn("scope_key", "text", (col) => col.notNull())
      .addColumn("last_seen_message_id", "integer")
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
  }

  await sql`CREATE UNIQUE INDEX conversation_cursors_scope_uidx ON conversation_cursors(conversation_id, scope_type, scope_key)`.execute(
    db,
  );
  await sql`CREATE INDEX conversation_messages_thread_idx ON conversation_messages(conversation_id, provider_thread_id, id)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS conversation_messages_thread_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS conversation_cursors_scope_uidx`.execute(db);
  await db.schema.dropTable("conversation_cursors").execute();
  await db.schema.alterTable("conversation_messages").dropColumn("is_thread_reply").execute();
  await db.schema.alterTable("conversation_messages").dropColumn("provider_parent_message_id").execute();
  await db.schema.alterTable("conversation_messages").dropColumn("provider_thread_id").execute();
}
