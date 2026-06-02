import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("external_mcp_tool_calls")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("token_id", "text", (col) => col.notNull().references("api_tokens.id").onDelete("cascade"))
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("tool_name", "text", (col) => col.notNull())
    .addColumn("success", "integer", (col) => col.notNull())
    .addColumn("duration_ms", "integer", (col) => col.notNull())
    .addColumn("called_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await sql`
    CREATE INDEX idx_external_mcp_tool_calls_token_id_called_at
    ON external_mcp_tool_calls(token_id, called_at)
  `.execute(db);
  await sql`
    CREATE INDEX idx_external_mcp_tool_calls_user_id_called_at
    ON external_mcp_tool_calls(user_id, called_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_external_mcp_tool_calls_user_id_called_at`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_external_mcp_tool_calls_token_id_called_at`.execute(db);
  await db.schema.dropTable("external_mcp_tool_calls").execute();
}
