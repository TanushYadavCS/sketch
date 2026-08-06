import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "./161-user-entity-links";

type MigrationDb = {
  users: { id: string };
  entities: { id: string };
  entity_review_queue: { id: string };
};

function createBlankDb(): Kysely<MigrationDb> {
  return new Kysely<MigrationDb>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("161-user-entity-links migration", () => {
  let db: Kysely<MigrationDb>;

  beforeEach(async () => {
    db = createBlankDb();
    await db.schema
      .createTable("users")
      .addColumn("id", "text", (col) => col.primaryKey())
      .execute();
    await db.schema
      .createTable("entities")
      .addColumn("id", "text", (col) => col.primaryKey())
      .execute();
    await db.schema
      .createTable("entity_review_queue")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("source", "text")
      .addColumn("source_id", "text")
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates the link table and identity review payload column", async () => {
    await up(db as unknown as Kysely<unknown>);

    const tables = await db.introspection.getTables();
    expect(tables.map((table) => table.name)).toContain("user_entity_links");
    expect(
      tables.find((table) => table.name === "entity_review_queue")?.columns.map((column) => column.name),
    ).toContain("candidate_user_ids");
  });

  it("enforces one link per user and entity and cascades user deletion", async () => {
    await up(db as unknown as Kysely<unknown>);
    await db
      .insertInto("users")
      .values([{ id: "u1" }, { id: "u2" }])
      .execute();
    await db
      .insertInto("entities")
      .values([{ id: "e1" }, { id: "e2" }])
      .execute();
    await sql`
      PRAGMA foreign_keys = ON
    `.execute(db);
    await sql`
      INSERT INTO user_entity_links (id, user_id, entity_id, matched_via)
      VALUES ('l1', 'u1', 'e1', 'email')
    `.execute(db);

    await expect(
      sql`
        INSERT INTO user_entity_links (id, user_id, entity_id, matched_via)
        VALUES ('l2', 'u1', 'e2', 'phone')
      `.execute(db),
    ).rejects.toThrow();
    await expect(
      sql`
        INSERT INTO user_entity_links (id, user_id, entity_id, matched_via)
        VALUES ('l3', 'u2', 'e1', 'phone')
      `.execute(db),
    ).rejects.toThrow();

    await db.deleteFrom("users").where("id", "=", "u1").execute();
    await expect(sql`SELECT id FROM user_entity_links WHERE id = 'l1'`.execute(db)).resolves.toMatchObject({
      rows: [],
    });
  });
});
