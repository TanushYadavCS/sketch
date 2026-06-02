import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`CREATE TABLE conversations (
      id serial PRIMARY KEY,
      platform text NOT NULL,
      kind text NOT NULL,
      provider_conversation_id text NOT NULL,
      display_name text,
      last_seen_message_id integer,
      created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`.execute(db);

    await sql`CREATE TABLE conversation_messages (
      id serial PRIMARY KEY,
      conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      provider_message_id text NOT NULL,
      sender_jid text NOT NULL DEFAULT '',
      sender_name text NOT NULL,
      sender_user_id text REFERENCES users(id),
      is_bot integer NOT NULL DEFAULT 0,
      addressed_to_sketch integer NOT NULL DEFAULT 0,
      text text NOT NULL DEFAULT '',
      attachments text,
      provider_timestamp text,
      received_at text NOT NULL,
      created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`.execute(db);
  } else {
    await db.schema
      .createTable("conversations")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("platform", "text", (col) => col.notNull())
      .addColumn("kind", "text", (col) => col.notNull())
      .addColumn("provider_conversation_id", "text", (col) => col.notNull())
      .addColumn("display_name", "text")
      .addColumn("last_seen_message_id", "integer")
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();

    await db.schema
      .createTable("conversation_messages")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("conversation_id", "integer", (col) =>
        col.notNull().references("conversations.id").onDelete("cascade"),
      )
      .addColumn("provider_message_id", "text", (col) => col.notNull())
      .addColumn("sender_jid", "text", (col) => col.notNull().defaultTo(""))
      .addColumn("sender_name", "text", (col) => col.notNull())
      .addColumn("sender_user_id", "text", (col) => col.references("users.id"))
      .addColumn("is_bot", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("addressed_to_sketch", "integer", (col) => col.notNull().defaultTo(0))
      .addColumn("text", "text", (col) => col.notNull().defaultTo(""))
      .addColumn("attachments", "text")
      .addColumn("provider_timestamp", "text")
      .addColumn("received_at", "text", (col) => col.notNull())
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
  }

  await sql`CREATE UNIQUE INDEX conversations_provider_uidx ON conversations(platform, kind, provider_conversation_id)`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX conversation_messages_provider_uidx ON conversation_messages(conversation_id, provider_message_id, sender_jid, is_bot)`.execute(
    db,
  );
  await sql`CREATE INDEX conversation_messages_conversation_id_idx ON conversation_messages(conversation_id, id)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS conversation_messages_conversation_id_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS conversation_messages_provider_uidx`.execute(db);
  await sql`DROP INDEX IF EXISTS conversations_provider_uidx`.execute(db);
  await db.schema.dropTable("conversation_messages").execute();
  await db.schema.dropTable("conversations").execute();
}
