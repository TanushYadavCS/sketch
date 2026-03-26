/**
 * Tests for the 025-agent-usage migration.
 *
 * Uses a fresh blank in-memory SQLite database. Tests verify that both tables
 * are created with correct columns and defaults, that FK cascade works,
 * that indexes exist, and that down() drops everything cleanly.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./025-agent-usage";

type AgentRunRow = {
  id: string;
  trace_id: string;
  span_id: string | null;
  user_id: string | null;
  platform: string;
  context_type: string;
  cost_usd: number;
  is_error: number;
  duration_ms: number | null;
  created_at: string;
  attributes: string;
};

type ToolCallRow = {
  id: number;
  agent_run_id: string;
  tool_name: string;
  skill_name: string | null;
  attributes: string;
  outcome: string | null;
  denial_reason: string | null;
  is_mcp: number | null;
  mcp_server: string | null;
  app_slug: string | null;
  component_key: string | null;
  component_type: string | null;
  auth_type: string | null;
  execution_outcome: string | null;
};

type InsertAgentRun = {
  id: string;
  trace_id: string;
  platform: string;
  context_type: string;
  span_id?: string | null;
  user_id?: string | null;
  cost_usd?: number;
  is_error?: number;
  duration_ms?: number | null;
  attributes?: string;
};

function createBlankDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("025-agent-usage migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await up(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates agent_runs table and allows inserting a row", async () => {
    await (db as Kysely<{ agent_runs: InsertAgentRun }>)
      .insertInto("agent_runs")
      .values({
        id: "run-001",
        trace_id: "trace-001",
        platform: "slack",
        context_type: "dm",
      })
      .execute();

    const rows = await (db as Kysely<{ agent_runs: AgentRunRow }>).selectFrom("agent_runs").selectAll().execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("run-001");
    expect(rows[0].trace_id).toBe("trace-001");
    expect(rows[0].platform).toBe("slack");
    expect(rows[0].context_type).toBe("dm");
  });

  it("defaults is_error=0, cost_usd=0, attributes='{}', created_at defined", async () => {
    await (db as Kysely<{ agent_runs: InsertAgentRun }>)
      .insertInto("agent_runs")
      .values({ id: "run-defaults", trace_id: "trace-d", platform: "whatsapp", context_type: "channel_mention" })
      .execute();

    const rows = await (db as Kysely<{ agent_runs: AgentRunRow }>).selectFrom("agent_runs").selectAll().execute();

    expect(rows[0].is_error).toBe(0);
    expect(rows[0].cost_usd).toBe(0);
    expect(rows[0].attributes).toBe("{}");
    expect(rows[0].created_at).toBeDefined();
  });

  it("nullable columns accept null", async () => {
    await (db as Kysely<{ agent_runs: InsertAgentRun }>)
      .insertInto("agent_runs")
      .values({
        id: "run-nulls",
        trace_id: "trace-n",
        platform: "slack",
        context_type: "dm",
        user_id: null,
        span_id: null,
        duration_ms: null,
      })
      .execute();

    const rows = await (db as Kysely<{ agent_runs: AgentRunRow }>).selectFrom("agent_runs").selectAll().execute();

    expect(rows[0].user_id).toBeNull();
    expect(rows[0].span_id).toBeNull();
    expect(rows[0].duration_ms).toBeNull();
  });

  it("stores attributes as JSON string", async () => {
    const attrs = JSON.stringify({ "gen_ai.response.model": "claude-sonnet-4-20250514", "sketch.cost_usd": 0.005 });
    await (db as Kysely<{ agent_runs: InsertAgentRun }>)
      .insertInto("agent_runs")
      .values({ id: "run-json", trace_id: "trace-j", platform: "slack", context_type: "dm", attributes: attrs })
      .execute();

    const rows = await (db as Kysely<{ agent_runs: AgentRunRow }>).selectFrom("agent_runs").selectAll().execute();
    const parsed = JSON.parse(rows[0].attributes);

    expect(parsed["gen_ai.response.model"]).toBe("claude-sonnet-4-20250514");
    expect(parsed["sketch.cost_usd"]).toBe(0.005);
  });

  it("creates tool_calls table with hot-path and Phase 3 columns", async () => {
    await (db as Kysely<{ agent_runs: InsertAgentRun }>)
      .insertInto("agent_runs")
      .values({ id: "run-tools", trace_id: "trace-t", platform: "slack", context_type: "dm" })
      .execute();

    await (db as Kysely<{ tool_calls: Omit<ToolCallRow, "id"> }>)
      .insertInto("tool_calls")
      .values([
        { agent_run_id: "run-tools", tool_name: "Bash", skill_name: null, attributes: "{}" },
        {
          agent_run_id: "run-tools",
          tool_name: "Skill",
          skill_name: "canvas",
          attributes: '{"gen_ai.tool.name":"Skill"}',
        },
      ])
      .execute();

    const rows = await (db as Kysely<{ tool_calls: ToolCallRow }>).selectFrom("tool_calls").selectAll().execute();

    expect(rows).toHaveLength(2);
    expect(rows[0].tool_name).toBe("Bash");
    expect(rows[0].skill_name).toBeNull();
    expect(rows[1].skill_name).toBe("canvas");
  });

  it("tool_calls Phase 3 columns default to null", async () => {
    await (db as Kysely<{ agent_runs: InsertAgentRun }>)
      .insertInto("agent_runs")
      .values({ id: "run-p3", trace_id: "trace-p3", platform: "slack", context_type: "dm" })
      .execute();

    await (
      db as Kysely<{
        tool_calls: { agent_run_id: string; tool_name: string; skill_name: string | null; attributes: string };
      }>
    )
      .insertInto("tool_calls")
      .values({ agent_run_id: "run-p3", tool_name: "Read", skill_name: null, attributes: "{}" })
      .execute();

    const rows = await (db as Kysely<{ tool_calls: ToolCallRow }>).selectFrom("tool_calls").selectAll().execute();

    expect(rows[0].outcome).toBeNull();
    expect(rows[0].denial_reason).toBeNull();
    expect(rows[0].is_mcp).toBeNull();
    expect(rows[0].mcp_server).toBeNull();
    expect(rows[0].app_slug).toBeNull();
    expect(rows[0].component_key).toBeNull();
    expect(rows[0].component_type).toBeNull();
    expect(rows[0].auth_type).toBeNull();
    expect(rows[0].execution_outcome).toBeNull();
  });

  it("FK cascade: deleting agent_run deletes its tool_calls", async () => {
    await (db as Kysely<{ agent_runs: InsertAgentRun }>)
      .insertInto("agent_runs")
      .values({ id: "run-cascade", trace_id: "trace-c", platform: "slack", context_type: "dm" })
      .execute();

    await (
      db as Kysely<{
        tool_calls: { agent_run_id: string; tool_name: string; skill_name: string | null; attributes: string };
      }>
    )
      .insertInto("tool_calls")
      .values([
        { agent_run_id: "run-cascade", tool_name: "Bash", skill_name: null, attributes: "{}" },
        { agent_run_id: "run-cascade", tool_name: "Read", skill_name: null, attributes: "{}" },
      ])
      .execute();

    await sql`PRAGMA foreign_keys = ON`.execute(db);

    await (db as Kysely<{ agent_runs: AgentRunRow }>)
      .deleteFrom("agent_runs")
      .where("id", "=", "run-cascade")
      .execute();

    const remaining = await (db as Kysely<{ tool_calls: ToolCallRow }>).selectFrom("tool_calls").selectAll().execute();
    expect(remaining).toHaveLength(0);
  });

  it("indexes exist on agent_runs and tool_calls", async () => {
    const indexes = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name
    `.execute(db);

    const names = indexes.rows.map((r) => r.name);
    expect(names).toContain("idx_agent_runs_user_id");
    expect(names).toContain("idx_agent_runs_created_at");
    expect(names).toContain("idx_agent_runs_user_created");
    expect(names).toContain("idx_agent_runs_platform");
    expect(names).toContain("idx_tool_calls_run_id");
    expect(names).toContain("idx_tool_calls_tool_name");
    expect(names).toContain("idx_tool_calls_skill");
    expect(names).toContain("idx_tool_calls_app_slug");
  });

  it("tool_calls.id auto-increments", async () => {
    await (db as Kysely<{ agent_runs: InsertAgentRun }>)
      .insertInto("agent_runs")
      .values({ id: "run-autoinc", trace_id: "trace-ai", platform: "slack", context_type: "dm" })
      .execute();

    await (
      db as Kysely<{
        tool_calls: { agent_run_id: string; tool_name: string; skill_name: string | null; attributes: string };
      }>
    )
      .insertInto("tool_calls")
      .values([
        { agent_run_id: "run-autoinc", tool_name: "Bash", skill_name: null, attributes: "{}" },
        { agent_run_id: "run-autoinc", tool_name: "Read", skill_name: null, attributes: "{}" },
      ])
      .execute();

    const rows = await (db as Kysely<{ tool_calls: ToolCallRow }>)
      .selectFrom("tool_calls")
      .selectAll()
      .orderBy("id", "asc")
      .execute();

    expect(rows[0].id).toBeLessThan(rows[1].id);
  });

  it("down() drops both tables", async () => {
    await down(db);

    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_runs', 'tool_calls')
    `.execute(db);

    expect(tables.rows).toHaveLength(0);
  });
});
