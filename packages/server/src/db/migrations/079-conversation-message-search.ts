import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`ALTER TABLE conversation_messages ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce(text, '') || ' ' || coalesce(sender_name, ''))
    ) STORED`.execute(db);
    await sql`CREATE INDEX conversation_messages_search_vector_idx ON conversation_messages USING GIN (search_vector)`.execute(
      db,
    );
    return;
  }

  await sql`
    CREATE VIRTUAL TABLE conversation_messages_fts USING fts5(
      text,
      sender_name,
      content='conversation_messages',
      content_rowid='id'
    )
  `.execute(db);

  await sql`
    CREATE TRIGGER conversation_messages_ai AFTER INSERT ON conversation_messages BEGIN
      INSERT INTO conversation_messages_fts(rowid, text, sender_name)
      VALUES (new.id, new.text, new.sender_name);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER conversation_messages_ad AFTER DELETE ON conversation_messages BEGIN
      INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, text, sender_name)
      VALUES ('delete', old.id, old.text, old.sender_name);
    END
  `.execute(db);

  await sql`
    CREATE TRIGGER conversation_messages_au AFTER UPDATE ON conversation_messages BEGIN
      INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, text, sender_name)
      VALUES ('delete', old.id, old.text, old.sender_name);
      INSERT INTO conversation_messages_fts(rowid, text, sender_name)
      VALUES (new.id, new.text, new.sender_name);
    END
  `.execute(db);

  await sql`
    INSERT INTO conversation_messages_fts(rowid, text, sender_name)
    SELECT id, text, sender_name FROM conversation_messages
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`DROP INDEX IF EXISTS conversation_messages_search_vector_idx`.execute(db);
    await sql`ALTER TABLE conversation_messages DROP COLUMN IF EXISTS search_vector`.execute(db);
    return;
  }

  await sql`DROP TRIGGER IF EXISTS conversation_messages_au`.execute(db);
  await sql`DROP TRIGGER IF EXISTS conversation_messages_ad`.execute(db);
  await sql`DROP TRIGGER IF EXISTS conversation_messages_ai`.execute(db);
  await sql`DROP TABLE IF EXISTS conversation_messages_fts`.execute(db);
}
