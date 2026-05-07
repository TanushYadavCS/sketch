/**
 * Tests for the 051-channel-agent-binding migration.
 *
 * Confirms the channels.agent_user_id column is added and that existing rows
 * default to NULL.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./051-channel-agent-binding";

function createBlankDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

async function createTables(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("users")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .execute();
  await db.schema
    .createTable("channels")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("slack_channel_id", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull())
    .execute();
}

let db: Kysely<unknown>;

beforeEach(async () => {
  db = createBlankDb();
  await createTables(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("051-channel-agent-binding", () => {
  it("adds the agent_user_id column", async () => {
    await up(db);

    const cols = await sql<{ name: string }>`PRAGMA table_info(channels)`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).toContain("agent_user_id");
  });

  it("leaves existing rows with agent_user_id = NULL", async () => {
    await sql`INSERT INTO channels (id, slack_channel_id, name, type) VALUES ('c1', 'C1', 'general', 'public_channel')`.execute(
      db,
    );

    await up(db);

    const rows = await sql<{ id: string; agent_user_id: string | null }>`
      SELECT id, agent_user_id FROM channels
    `.execute(db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].agent_user_id).toBeNull();
  });

  it("is reversible via down()", async () => {
    await up(db);
    await down(db);

    const cols = await sql<{ name: string }>`PRAGMA table_info(channels)`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).not.toContain("agent_user_id");
  });
});
