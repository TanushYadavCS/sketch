/**
 * Tests for the 039-drop-outreach-messages migration.
 *
 * Runs 017 up() first to create the outreach_messages table (along with the users
 * table it references), then runs 033 up() and verifies the table and both indexes
 * are gone. Also verifies that 033 down() recreates the table and indexes.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up as up017 } from "./017-outreach-messages";
import { down as down033, up as up033 } from "./039-drop-outreach-messages";

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
    .execute();
}

async function tableExists(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type='table' AND name=${name}
  `.execute(db);
  return result.rows.length > 0;
}

async function indexExists(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type='index' AND name=${name}
  `.execute(db);
  return result.rows.length > 0;
}

describe("039-drop-outreach-messages migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createBlankDb();
    await createUsersTable(db);
    await up017(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("drops the outreach_messages table and its two indexes", async () => {
    expect(await tableExists(db, "outreach_messages")).toBe(true);
    expect(await indexExists(db, "idx_outreach_recipient_status")).toBe(true);
    expect(await indexExists(db, "idx_outreach_requester_status")).toBe(true);

    await up033(db);

    expect(await tableExists(db, "outreach_messages")).toBe(false);
    expect(await indexExists(db, "idx_outreach_recipient_status")).toBe(false);
    expect(await indexExists(db, "idx_outreach_requester_status")).toBe(false);
  });

  it("down() recreates the outreach_messages table and its indexes", async () => {
    await up033(db);
    expect(await tableExists(db, "outreach_messages")).toBe(false);

    await down033(db);

    expect(await tableExists(db, "outreach_messages")).toBe(true);
    expect(await indexExists(db, "idx_outreach_recipient_status")).toBe(true);
    expect(await indexExists(db, "idx_outreach_requester_status")).toBe(true);
  });
});
