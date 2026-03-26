import { type Kysely, sql } from "kysely";
import { isPg } from "../dialect";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("agent_runs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("trace_id", "text", (col) => col.notNull())
    .addColumn("span_id", "text")
    // Hot-path columns (indexed, used in dashboard queries)
    .addColumn("user_id", "text")
    .addColumn("platform", "text", (col) => col.notNull())
    .addColumn("context_type", "text", (col) => col.notNull())
    .addColumn("cost_usd", "real", (col) => col.notNull().defaultTo(0))
    .addColumn("is_error", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("duration_ms", "integer")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    // All span attributes as OTLP-aligned JSON
    .addColumn("attributes", "text", (col) => col.notNull().defaultTo("{}"))
    .execute();

  await db.schema.createIndex("idx_agent_runs_user_id").on("agent_runs").columns(["user_id"]).execute();
  await db.schema.createIndex("idx_agent_runs_created_at").on("agent_runs").columns(["created_at"]).execute();
  await db.schema
    .createIndex("idx_agent_runs_user_created")
    .on("agent_runs")
    .columns(["user_id", "created_at"])
    .execute();
  await db.schema.createIndex("idx_agent_runs_platform").on("agent_runs").columns(["platform"]).execute();

  if (isPg(db)) {
    await sql`CREATE TABLE tool_calls (
      id serial PRIMARY KEY,
      agent_run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      tool_name text NOT NULL,
      skill_name text,
      attributes text NOT NULL DEFAULT '{}',
      outcome text,
      denial_reason text,
      is_mcp integer,
      mcp_server text,
      app_slug text,
      component_key text,
      component_type text,
      auth_type text,
      execution_outcome text
    )`.execute(db);
  } else {
    await db.schema
      .createTable("tool_calls")
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("agent_run_id", "text", (col) => col.notNull().references("agent_runs.id").onDelete("cascade"))
      .addColumn("tool_name", "text", (col) => col.notNull())
      .addColumn("skill_name", "text")
      .addColumn("attributes", "text", (col) => col.notNull().defaultTo("{}"))
      .addColumn("outcome", "text")
      .addColumn("denial_reason", "text")
      .addColumn("is_mcp", "integer")
      .addColumn("mcp_server", "text")
      .addColumn("app_slug", "text")
      .addColumn("component_key", "text")
      .addColumn("component_type", "text")
      .addColumn("auth_type", "text")
      .addColumn("execution_outcome", "text")
      .execute();
  }

  await db.schema.createIndex("idx_tool_calls_run_id").on("tool_calls").columns(["agent_run_id"]).execute();
  await db.schema.createIndex("idx_tool_calls_tool_name").on("tool_calls").columns(["tool_name"]).execute();
  await db.schema.createIndex("idx_tool_calls_skill").on("tool_calls").columns(["skill_name"]).execute();
  await db.schema.createIndex("idx_tool_calls_app_slug").on("tool_calls").columns(["app_slug"]).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("tool_calls").execute();
  await db.schema.dropTable("agent_runs").execute();
}
