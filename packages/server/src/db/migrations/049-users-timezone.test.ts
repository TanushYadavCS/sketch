import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./049-users-timezone";

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
    .addColumn("email", "text")
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
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

describe("049-users-timezone", () => {
  it("adds a nullable timezone column with no default", async () => {
    await up(db);

    await sql`INSERT INTO users (id, name) VALUES ('u1', 'Alice')`.execute(db);

    const rows = await sql<{ id: string; timezone: string | null }>`
      SELECT id, timezone FROM users
    `.execute(db);
    expect(rows.rows).toEqual([{ id: "u1", timezone: null }]);
  });

  it("accepts an IANA timezone string", async () => {
    await up(db);

    await sql`INSERT INTO users (id, name, timezone) VALUES ('u1', 'Alice', 'Asia/Kolkata')`.execute(db);

    const rows = await sql<{ id: string; timezone: string | null }>`
      SELECT id, timezone FROM users WHERE id = 'u1'
    `.execute(db);
    expect(rows.rows[0]?.timezone).toBe("Asia/Kolkata");
  });

  it("preserves existing rows (NULL timezone) — lazy hydration model", async () => {
    await sql`INSERT INTO users (id, name) VALUES ('u1', 'Alice')`.execute(db);

    await up(db);

    const rows = await sql<{ id: string; timezone: string | null }>`
      SELECT id, timezone FROM users
    `.execute(db);
    expect(rows.rows).toEqual([{ id: "u1", timezone: null }]);
  });

  it("down() drops the column", async () => {
    await up(db);
    await down(db);

    const cols = await sql<{ name: string }>`PRAGMA table_info(users)`.execute(db);
    const names = cols.rows.map((r) => r.name);
    expect(names).not.toContain("timezone");
  });
});
