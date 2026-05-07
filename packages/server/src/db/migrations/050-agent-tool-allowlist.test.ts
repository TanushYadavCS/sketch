/**
 * Tests for the 050-agent-tool-allowlist migration.
 *
 * Confirms that the column is added and that existing rows (agent or not)
 * are left at NULL — backfilling with built-ins would silently strip MCP
 * access from agents that previously had unrestricted tool use.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./050-agent-tool-allowlist";

function createBlankDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

async function createUsersTable(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("users")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull().defaultTo("human"))
    .addColumn("description", "text")
    .execute();
}

let db: Kysely<unknown>;

beforeEach(async () => {
  db = createBlankDb();
  await createUsersTable(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("050-agent-tool-allowlist", () => {
  it("adds the allowed_tools column", async () => {
    await up(db);

    const cols = await sql<{ name: string }>`PRAGMA table_info(users)`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).toContain("allowed_tools");
  });

  it("leaves existing agent and human rows at NULL", async () => {
    await sql`INSERT INTO users (id, name, type) VALUES ('a1', 'Marketing Maven', 'agent')`.execute(db);
    await sql`INSERT INTO users (id, name, type) VALUES ('a2', 'Sales Coach', 'agent')`.execute(db);
    await sql`INSERT INTO users (id, name, type) VALUES ('h1', 'Real Person', 'human')`.execute(db);

    await up(db);

    const rows = await sql<{ id: string; type: string; allowed_tools: string | null }>`
      SELECT id, type, allowed_tools FROM users ORDER BY id
    `.execute(db);

    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get("a1")?.allowed_tools).toBeNull();
    expect(byId.get("a2")?.allowed_tools).toBeNull();
    expect(byId.get("h1")?.allowed_tools).toBeNull();
  });

  it("is reversible via down()", async () => {
    await up(db);
    await down(db);

    const cols = await sql<{ name: string }>`PRAGMA table_info(users)`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).not.toContain("allowed_tools");
  });
});
