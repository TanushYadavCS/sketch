/**
 * Tests for the 046-whatsapp-group-agent-binding migration.
 *
 * Confirms the whatsapp_groups.agent_user_id column is added and existing
 * rows default to NULL.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./046-whatsapp-group-agent-binding";

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
    .createTable("whatsapp_groups")
    .addColumn("jid", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
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

describe("046-whatsapp-group-agent-binding", () => {
  it("adds the agent_user_id column", async () => {
    await up(db);

    const cols = await sql<{ name: string }>`PRAGMA table_info(whatsapp_groups)`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).toContain("agent_user_id");
  });

  it("leaves existing rows with agent_user_id = NULL", async () => {
    await sql`INSERT INTO whatsapp_groups (jid, name) VALUES ('123@g.us', 'Marketing Crew')`.execute(db);

    await up(db);

    const rows = await sql<{ jid: string; agent_user_id: string | null }>`
      SELECT jid, agent_user_id FROM whatsapp_groups
    `.execute(db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].agent_user_id).toBeNull();
  });

  it("is reversible via down()", async () => {
    await up(db);
    await down(db);

    const cols = await sql<{ name: string }>`PRAGMA table_info(whatsapp_groups)`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).not.toContain("agent_user_id");
  });
});
