/**
 * Tests for the 053-whatsapp-fallback-agent migration.
 *
 * Confirms the settings.whatsapp_fallback_agent_id column is added and
 * existing rows default to NULL.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./053-whatsapp-fallback-agent";

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
    .createTable("settings")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("org_name", "text")
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

describe("053-whatsapp-fallback-agent", () => {
  it("adds the whatsapp_fallback_agent_id column", async () => {
    await up(db);

    const cols = await sql<{ name: string }>`PRAGMA table_info(settings)`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).toContain("whatsapp_fallback_agent_id");
  });

  it("leaves existing rows with whatsapp_fallback_agent_id = NULL", async () => {
    await sql`INSERT INTO settings (id, org_name) VALUES ('singleton', 'TestOrg')`.execute(db);

    await up(db);

    const rows = await sql<{ id: string; whatsapp_fallback_agent_id: string | null }>`
      SELECT id, whatsapp_fallback_agent_id FROM settings
    `.execute(db);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].whatsapp_fallback_agent_id).toBeNull();
  });

  it("is reversible via down()", async () => {
    await up(db);
    await down(db);

    const cols = await sql<{ name: string }>`PRAGMA table_info(settings)`.execute(db);
    const names = cols.rows.map((c) => c.name);
    expect(names).not.toContain("whatsapp_fallback_agent_id");
  });
});
