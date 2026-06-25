import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "./105-normalize-indexed-file-source-timestamps";

type TestDb = {
  indexed_files: {
    id: string;
    source_created_at: string | null;
    source_updated_at: string | null;
  };
};

function createBlankDb(): Kysely<TestDb> {
  return new Kysely<TestDb>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("105-normalize-indexed-file-source-timestamps migration", () => {
  let db: Kysely<TestDb>;

  beforeEach(async () => {
    db = createBlankDb();
    await db.schema
      .createTable("indexed_files")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("source_created_at", "text")
      .addColumn("source_updated_at", "text")
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("normalizes valid source timestamps and preserves invalid or null values", async () => {
    await db
      .insertInto("indexed_files")
      .values([
        {
          id: "offset",
          source_created_at: "2026-01-01T00:00:00+05:30",
          source_updated_at: "2026-01-02T00:00:00+05:30",
        },
        {
          id: "sqlite-current-timestamp",
          source_created_at: "2026-01-03 10:15:30",
          source_updated_at: "2026-01-03 11:15:30",
        },
        {
          id: "invalid",
          source_created_at: "not-a-date",
          source_updated_at: null,
        },
      ])
      .execute();

    await up(db as unknown as Kysely<unknown>);

    const rows = await db
      .selectFrom("indexed_files")
      .select(["id", "source_created_at", "source_updated_at"])
      .orderBy("id", "asc")
      .execute();

    expect(rows).toEqual([
      {
        id: "invalid",
        source_created_at: "not-a-date",
        source_updated_at: null,
      },
      {
        id: "offset",
        source_created_at: "2025-12-31T18:30:00.000Z",
        source_updated_at: "2026-01-01T18:30:00.000Z",
      },
      {
        id: "sqlite-current-timestamp",
        source_created_at: "2026-01-03T10:15:30.000Z",
        source_updated_at: "2026-01-03T11:15:30.000Z",
      },
    ]);
  });
});
