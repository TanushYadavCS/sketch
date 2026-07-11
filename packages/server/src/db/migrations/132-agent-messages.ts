import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  if (isPg(db)) {
    await sql`CREATE TABLE agent_messages (
      id serial PRIMARY KEY,
      session_id text NOT NULL,
      seq integer NOT NULL,
      role text NOT NULL,
      content text NOT NULL,
      created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, seq)
    )`.execute(db);
  } else {
    await db.schema
      .createTable("agent_messages")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("session_id", "text", (col) => col.notNull())
      .addColumn("seq", "integer", (col) => col.notNull())
      .addColumn("role", "text", (col) => col.notNull())
      .addColumn("content", "text", (col) => col.notNull())
      .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addUniqueConstraint("agent_messages_session_seq_uidx", ["session_id", "seq"])
      .execute();
  }

  await db.schema.createIndex("idx_agent_messages_session_id").on("agent_messages").column("session_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_agent_messages_session_id").ifExists().execute();
  await db.schema.dropTable("agent_messages").execute();
}
