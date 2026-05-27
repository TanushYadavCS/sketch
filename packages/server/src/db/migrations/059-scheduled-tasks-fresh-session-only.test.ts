import { PGlite } from "@electric-sql/pglite";
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteDialect } from "../../test-pglite-dialect";
import { up } from "./059-scheduled-tasks-fresh-session-only";

interface TestDB {
  scheduled_tasks: {
    id: string;
    session_mode: string;
  };
}

describe.each([
  {
    name: "SQLite",
    createDb: () =>
      new Kysely<TestDB>({
        dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
      }),
  },
  {
    name: "Postgres",
    createDb: () =>
      new Kysely<TestDB>({
        dialect: new PGliteDialect({ pglite: new PGlite() }),
      }),
  },
])("059-scheduled-tasks-fresh-session-only migration on $name", ({ createDb }) => {
  let db: Kysely<TestDB>;

  beforeEach(async () => {
    db = createDb();
    await db.schema
      .createTable("scheduled_tasks")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("session_mode", "text", (col) => col.notNull())
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("normalizes every non-fresh task mode to fresh", async () => {
    await db
      .insertInto("scheduled_tasks")
      .values([
        { id: "fresh-task", session_mode: "fresh" },
        { id: "chat-task", session_mode: "chat" },
        { id: "persistent-task", session_mode: "persistent" },
        { id: "unknown-task", session_mode: "task-local" },
      ])
      .execute();

    await up(db as Kysely<unknown>);

    const rows = await db.selectFrom("scheduled_tasks").select(["id", "session_mode"]).orderBy("id").execute();
    expect(rows).toEqual([
      { id: "chat-task", session_mode: "fresh" },
      { id: "fresh-task", session_mode: "fresh" },
      { id: "persistent-task", session_mode: "fresh" },
      { id: "unknown-task", session_mode: "fresh" },
    ]);
  });
});
