import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./110-settings-embedding-provider";

interface TestDb {
  settings: {
    id: string;
    gemini_api_key: string | null;
    embedding_provider?: string | null;
  };
}

function createDb(): Kysely<TestDb> {
  return new Kysely<TestDb>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("110-settings-embedding-provider migration", () => {
  let db: Kysely<TestDb>;

  function migrationDb(): Kysely<unknown> {
    return db as unknown as Kysely<unknown>;
  }

  beforeEach(async () => {
    db = createDb();
    await db.schema
      .createTable("settings")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("gemini_api_key", "text")
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("sets gemini only for existing rows with a Gemini API key", async () => {
    await db
      .insertInto("settings")
      .values([
        { id: "with-key", gemini_api_key: "AIza-key" },
        { id: "without-key", gemini_api_key: null },
        { id: "blank-key", gemini_api_key: " " },
      ])
      .execute();

    await up(migrationDb());

    const rows = await sql<{ id: string; embedding_provider: string | null }>`
      SELECT id, embedding_provider FROM settings ORDER BY id
    `.execute(db);

    expect(rows.rows).toEqual([
      { id: "blank-key", embedding_provider: null },
      { id: "with-key", embedding_provider: "gemini" },
      { id: "without-key", embedding_provider: null },
    ]);
  });

  it("does not overwrite existing embedding provider values", async () => {
    await db.schema.alterTable("settings").addColumn("embedding_provider", "text").execute();
    await db.insertInto("settings").values({ id: "configured", gemini_api_key: "AIza-key" }).execute();
    await db.updateTable("settings").set({ embedding_provider: "openrouter" }).where("id", "=", "configured").execute();

    await up(migrationDb());

    const row = await db.selectFrom("settings").select("embedding_provider").executeTakeFirstOrThrow();
    expect(row.embedding_provider).toBe("openrouter");
  });

  it("drops the column on down", async () => {
    await up(migrationDb());
    await down(migrationDb());

    const columns = await sql<{ name: string }>`PRAGMA table_info(settings)`.execute(db);
    expect(columns.rows.map((row) => row.name)).not.toContain("embedding_provider");
  });
});
