import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "./059-scheduled-tasks-fresh-session-only";

interface TestDB {
  scheduled_tasks: {
    id: string;
    session_mode: string;
  };
}

describe("059-scheduled-tasks-fresh-session-only migration", () => {
  let db: Kysely<TestDB>;

  beforeEach(async () => {
    db = new Kysely<TestDB>({
      dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
    });
    await db.schema
      .createTable("scheduled_tasks")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("session_mode", "text", (col) => col.notNull())
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("normalizes legacy chat and persistent tasks to fresh", async () => {
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
