import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("local_claude_sessions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("device_id", "text", (col) => col.notNull().references("local_devices.id").onDelete("cascade"))
    .addColumn("tmux_session_name", "text", (col) => col.notNull().unique())
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("cwd", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("starting"))
    .addColumn("event_token_hash", "text", (col) => col.notNull().unique())
    .addColumn("origin_platform", "text")
    .addColumn("origin_context_type", "text")
    .addColumn("origin_delivery_target", "text")
    .addColumn("origin_thread_ts", "text")
    .addColumn("last_event_type", "text")
    .addColumn("last_event_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("ended_at", "text")
    .execute();

  await db.schema
    .createTable("local_claude_session_events")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("session_id", "text", (col) => col.notNull().references("local_claude_sessions.id").onDelete("cascade"))
    .addColumn("event_type", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("message", "text")
    .addColumn("payload", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await sql`CREATE INDEX idx_local_claude_sessions_user_id ON local_claude_sessions(user_id, created_at)`.execute(db);
  await sql`CREATE INDEX idx_local_claude_sessions_device_id ON local_claude_sessions(device_id, created_at)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_local_claude_session_events_session_id ON local_claude_session_events(session_id, created_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_local_claude_session_events_session_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_local_claude_sessions_device_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_local_claude_sessions_user_id`.execute(db);
  await db.schema.dropTable("local_claude_session_events").execute();
  await db.schema.dropTable("local_claude_sessions").execute();
}
