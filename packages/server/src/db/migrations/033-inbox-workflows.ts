import { type Kysely, sql } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema
    .alterTable("inbox_messages")
    .addColumn("kind", "text", (col) => col.notNull().defaultTo("note"))
    .execute();
  await db.schema.alterTable("inbox_messages").addColumn("metadata", "text").execute();
  await db.schema
    .alterTable("inbox_messages")
    .addColumn("resolution_mode", "text", (col) => col.notNull().defaultTo("auto_consume"))
    .execute();
  await db.schema.alterTable("inbox_messages").addColumn("resolved_at", "text").execute();

  await sql`CREATE INDEX idx_inbox_recipient_resolution ON inbox_messages(recipient_user_id, resolution_mode, resolved_at, consumed_at)`.execute(
    db,
  );
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_inbox_recipient_resolution`.execute(db);
  await db.schema.alterTable("inbox_messages").dropColumn("resolved_at").execute();
  await db.schema.alterTable("inbox_messages").dropColumn("resolution_mode").execute();
  await db.schema.alterTable("inbox_messages").dropColumn("metadata").execute();
  await db.schema.alterTable("inbox_messages").dropColumn("kind").execute();
}
