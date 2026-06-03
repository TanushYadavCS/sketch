import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("local_devices")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("platform", "text", (col) => col.notNull().defaultTo("macos"))
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("prefix", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("offline"))
    .addColumn("last_seen_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("revoked_at", "text")
    .execute();

  await db.schema
    .createTable("local_device_tool_calls")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("device_id", "text", (col) => col.notNull().references("local_devices.id").onDelete("cascade"))
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("tool_name", "text", (col) => col.notNull())
    .addColumn("command", "text", (col) => col.notNull())
    .addColumn("cwd", "text")
    .addColumn("success", "integer", (col) => col.notNull())
    .addColumn("exit_code", "integer")
    .addColumn("timed_out", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("duration_ms", "integer", (col) => col.notNull())
    .addColumn("stdout_bytes", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("stderr_bytes", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("stdout_truncated", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("stderr_truncated", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("error_message", "text")
    .addColumn("called_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await sql`CREATE INDEX idx_local_devices_user_id ON local_devices(user_id, created_at)`.execute(db);
  await sql`CREATE INDEX idx_local_devices_token_hash ON local_devices(token_hash)`.execute(db);
  await sql`CREATE INDEX idx_local_device_tool_calls_device_id_called_at ON local_device_tool_calls(device_id, called_at)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_local_device_tool_calls_user_id_called_at ON local_device_tool_calls(user_id, called_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_local_device_tool_calls_user_id_called_at`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_local_device_tool_calls_device_id_called_at`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_local_devices_token_hash`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_local_devices_user_id`.execute(db);
  await db.schema.dropTable("local_device_tool_calls").execute();
  await db.schema.dropTable("local_devices").execute();
}
