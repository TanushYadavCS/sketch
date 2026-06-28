import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../../auth/encryption";
import { down, up } from "./111-settings-embedding-provider";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

describe("111-settings-embedding-provider migration", () => {
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
    vi.unstubAllEnvs();
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

  it("backfills encrypted Gemini keys but skips encrypted blanks", async () => {
    vi.stubEnv("ENCRYPTION_KEY", TEST_KEY);
    await db
      .insertInto("settings")
      .values([
        { id: "encrypted-real", gemini_api_key: encrypt("AIza-key", TEST_KEY) },
        { id: "encrypted-blank", gemini_api_key: encrypt("", TEST_KEY) },
      ])
      .execute();

    await up(migrationDb());

    const rows = await sql<{ id: string; embedding_provider: string | null }>`
      SELECT id, embedding_provider FROM settings ORDER BY id
    `.execute(db);

    expect(rows.rows).toEqual([
      { id: "encrypted-blank", embedding_provider: null },
      { id: "encrypted-real", embedding_provider: "gemini" },
    ]);
  });

  it("drops the column on down", async () => {
    await up(migrationDb());
    await down(migrationDb());

    const columns = await sql<{ name: string }>`PRAGMA table_info(settings)`.execute(db);
    expect(columns.rows.map((row) => row.name)).not.toContain("embedding_provider");
  });
});
