import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { up } from "./163-slack-file-access-backfill-cleanup";

type MigrationDb = {
  slack_file_access_backfill: { id: string };
};

function createDb(): Kysely<MigrationDb> {
  return new Kysely<MigrationDb>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("163-slack-file-access-backfill-cleanup migration", () => {
  const databases: Kysely<MigrationDb>[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.destroy()));
  });

  it("drops the stale table when it exists", async () => {
    const db = createDb();
    databases.push(db);
    await db.schema.createTable("slack_file_access_backfill").addColumn("id", "text").execute();

    await expect(up(db as unknown as Kysely<unknown>)).resolves.toBeUndefined();
    await expect(db.introspection.getTables()).resolves.not.toContainEqual(
      expect.objectContaining({ name: "slack_file_access_backfill" }),
    );
  });

  it("leaves databases without the stale table unaffected", async () => {
    const db = createDb();
    databases.push(db);

    await expect(up(db as unknown as Kysely<unknown>)).resolves.toBeUndefined();
    await expect(db.introspection.getTables()).resolves.not.toContainEqual(
      expect.objectContaining({ name: "slack_file_access_backfill" }),
    );
  });
});
