import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { up } from "./169-scheduled-task-execution-mode";

type MigrationDb = {
  scheduled_tasks: {
    id: string;
    prompt: string;
    execution_mode: string | null;
  };
};

function createDb(): Kysely<MigrationDb> {
  return new Kysely<MigrationDb>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("169-scheduled-task-execution-mode migration", () => {
  const databases: Kysely<MigrationDb>[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.destroy()));
  });

  it("adds a hybrid default for existing scheduled tasks", async () => {
    const db = createDb();
    databases.push(db);
    await db.schema
      .createTable("scheduled_tasks")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("prompt", "text", (column) => column.notNull())
      .execute();
    await db.insertInto("scheduled_tasks").values({ id: "legacy-task", prompt: "Summarize updates" }).execute();

    await up(db as unknown as Kysely<unknown>);

    await expect(db.selectFrom("scheduled_tasks").selectAll().execute()).resolves.toEqual([
      { id: "legacy-task", prompt: "Summarize updates", execution_mode: "hybrid" },
    ]);
    await expect(
      sql`SELECT "notnull" AS is_not_null, dflt_value FROM pragma_table_info('scheduled_tasks') WHERE name = 'execution_mode'`.execute(
        db,
      ),
    ).resolves.toMatchObject({ rows: [{ is_not_null: 1, dflt_value: "'hybrid'" }] });
  });

  it("backfills null values when the column already exists", async () => {
    const db = createDb();
    databases.push(db);
    await db.schema
      .createTable("scheduled_tasks")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("prompt", "text", (column) => column.notNull())
      .addColumn("execution_mode", "text")
      .execute();
    await db
      .insertInto("scheduled_tasks")
      .values([
        { id: "legacy-null", prompt: "Keep old behavior", execution_mode: null },
        { id: "agent-led", prompt: "Keep explicit mode", execution_mode: "agent-led" },
      ])
      .execute();

    await up(db as unknown as Kysely<unknown>);

    await expect(
      db.selectFrom("scheduled_tasks").select(["id", "execution_mode"]).orderBy("id").execute(),
    ).resolves.toEqual([
      { id: "agent-led", execution_mode: "agent-led" },
      { id: "legacy-null", execution_mode: "hybrid" },
    ]);
  });
});
