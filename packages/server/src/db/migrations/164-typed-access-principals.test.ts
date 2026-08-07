import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { up } from "./164-typed-access-principals";

type MigrationDb = {
  users: { id: string; name: string; email: string | null; whatsapp_lid: string | null };
  access_scope_members: { access_scope_id: string; principal_type: string; principal_value: string };
  file_access: { indexed_file_id: string; principal_type: string; principal_value: string };
};

function createDb(): Kysely<MigrationDb> {
  return new Kysely<MigrationDb>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("164-typed-access-principals migration", () => {
  const databases: Kysely<MigrationDb>[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.destroy()));
  });

  it("upgrades existing email rows and replaces the legacy indexes", async () => {
    const db = createDb();
    databases.push(db);

    await db.schema
      .createTable("users")
      .addColumn("id", "text", (column) => column.primaryKey())
      .addColumn("name", "text", (column) => column.notNull())
      .addColumn("email", "text")
      .execute();
    await db.schema
      .createTable("access_scope_members")
      .addColumn("access_scope_id", "text", (column) => column.notNull())
      .addColumn("email", "text", (column) => column.notNull())
      .execute();
    await db.schema
      .createTable("file_access")
      .addColumn("indexed_file_id", "text", (column) => column.notNull())
      .addColumn("email", "text", (column) => column.notNull())
      .execute();
    await sql`CREATE UNIQUE INDEX idx_scope_members_pk ON access_scope_members(access_scope_id, email)`.execute(db);
    await sql`CREATE INDEX idx_scope_members_email ON access_scope_members(email)`.execute(db);
    await sql`CREATE UNIQUE INDEX idx_file_access_pk ON file_access(indexed_file_id, email)`.execute(db);
    await sql`CREATE INDEX idx_file_access_email ON file_access(email)`.execute(db);
    await db.insertInto("users").values({ id: "u1", name: "User", email: "user@example.com" }).execute();
    await sql`INSERT INTO access_scope_members (access_scope_id, email) VALUES ('scope-1', 'user@example.com')`.execute(
      db,
    );
    await sql`INSERT INTO file_access (indexed_file_id, email) VALUES ('file-1', 'user@example.com')`.execute(db);

    await up(db as unknown as Kysely<unknown>);

    await expect(db.selectFrom("access_scope_members").selectAll().execute()).resolves.toEqual([
      { access_scope_id: "scope-1", principal_type: "email", principal_value: "user@example.com" },
    ]);
    await expect(db.selectFrom("file_access").selectAll().execute()).resolves.toEqual([
      { indexed_file_id: "file-1", principal_type: "email", principal_value: "user@example.com" },
    ]);
    await expect(db.selectFrom("users").select(["id", "whatsapp_lid"]).execute()).resolves.toEqual([
      { id: "u1", whatsapp_lid: null },
    ]);

    const indexes = await sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_scope_members_pk', 'idx_scope_members_email', 'idx_scope_members_principal',
          'idx_file_access_pk', 'idx_file_access_email', 'idx_file_access_principal',
          'idx_users_whatsapp_lid'
        )
      ORDER BY name
    `.execute(db);
    expect(indexes.rows.map((row) => row.name)).toEqual([
      "idx_file_access_pk",
      "idx_file_access_principal",
      "idx_scope_members_pk",
      "idx_scope_members_principal",
      "idx_users_whatsapp_lid",
    ]);

    await expect(
      db
        .insertInto("file_access")
        .values({ indexed_file_id: "file-1", principal_type: "email", principal_value: "user@example.com" })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto("file_access")
        .values({ indexed_file_id: "file-1", principal_type: "phone", principal_value: "+15550000001" })
        .execute(),
    ).resolves.toEqual([expect.objectContaining({ numInsertedOrUpdatedRows: 1n })]);
  });
});
