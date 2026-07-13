import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "./141-fact-materialization-quarantine";

interface MigrationTestDb {
  users: {
    id: string;
    auth_role: string;
    created_at: string;
  };
  connector_configs: {
    id: string;
    connector_type: string;
    created_by: string;
    created_at?: string;
  };
  indexed_file_facts: {
    id: string;
    created_by_user_id: string | null;
    materialization_attempts?: number;
  };
}

function createBlankDb(): Kysely<MigrationTestDb> {
  return new Kysely<MigrationTestDb>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

async function createPrerequisites(db: Kysely<MigrationTestDb>) {
  await db.schema
    .createTable("users")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("auth_role", "text")
    .addColumn("created_at", "text")
    .execute();
  await db.schema
    .createTable("connector_configs")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("connector_type", "text", (col) => col.notNull())
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "text")
    .execute();
  await sql`
    CREATE UNIQUE INDEX idx_connector_configs_fireflies_owner_unique
    ON connector_configs (created_by)
    WHERE connector_type = 'fireflies'
  `.execute(db);
  await db.schema
    .createTable("indexed_file_facts")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("created_by_user_id", "text")
    .execute();
}

describe("141-fact-materialization-quarantine migration", () => {
  let db: Kysely<MigrationTestDb>;

  beforeEach(async () => {
    db = createBlankDb();
    await createPrerequisites(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("adds materialization_attempts defaulting to 0", async () => {
    await up(db as Kysely<unknown>);

    await db.insertInto("indexed_file_facts").values({ id: "fact-1", created_by_user_id: null }).execute();
    const row = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(row.materialization_attempts).toBe(0);
  });

  it("reassigns sentinel owners to the earliest admin user", async () => {
    await db
      .insertInto("users")
      .values([
        { id: "member-1", auth_role: "member", created_at: "2026-01-01" },
        { id: "admin-late", auth_role: "admin", created_at: "2026-03-01" },
        { id: "admin-early", auth_role: "admin", created_at: "2026-02-01" },
      ])
      .execute();
    await db
      .insertInto("connector_configs")
      .values([
        { id: "conn-admin", connector_type: "clickup", created_by: "admin" },
        { id: "conn-api-key", connector_type: "gmail", created_by: "sketch-api-key" },
        { id: "conn-owned", connector_type: "linear", created_by: "member-1" },
      ])
      .execute();
    await db
      .insertInto("indexed_file_facts")
      .values([
        { id: "fact-admin", created_by_user_id: "admin" },
        { id: "fact-api-key", created_by_user_id: "sketch-api-key" },
        { id: "fact-owned", created_by_user_id: "member-1" },
        { id: "fact-null", created_by_user_id: null },
      ])
      .execute();

    await up(db as Kysely<unknown>);

    const configs = await db.selectFrom("connector_configs").selectAll().orderBy("id").execute();
    expect(configs.map((c) => c.created_by)).toEqual(["admin-early", "admin-early", "member-1"]);
    const facts = await db.selectFrom("indexed_file_facts").selectAll().orderBy("id").execute();
    expect(facts.map((f) => f.created_by_user_id)).toEqual(["admin-early", "admin-early", null, "member-1"]);
  });

  it("leaves sentinel owners untouched when no admin user exists", async () => {
    await db.insertInto("users").values({ id: "member-1", auth_role: "member", created_at: "2026-01-01" }).execute();
    await db
      .insertInto("connector_configs")
      .values({ id: "conn-admin", connector_type: "clickup", created_by: "admin" })
      .execute();
    await db.insertInto("indexed_file_facts").values({ id: "fact-admin", created_by_user_id: "admin" }).execute();

    await up(db as Kysely<unknown>);

    const config = await db.selectFrom("connector_configs").selectAll().executeTakeFirstOrThrow();
    expect(config.created_by).toBe("admin");
    const fact = await db.selectFrom("indexed_file_facts").selectAll().executeTakeFirstOrThrow();
    expect(fact.created_by_user_id).toBe("admin");
  });

  it("skips fireflies configs when the admin already owns one", async () => {
    await db.insertInto("users").values({ id: "admin-1", auth_role: "admin", created_at: "2026-01-01" }).execute();
    await db
      .insertInto("connector_configs")
      .values([
        { id: "ff-owned", connector_type: "fireflies", created_by: "admin-1" },
        { id: "ff-orphan", connector_type: "fireflies", created_by: "admin" },
        { id: "conn-admin", connector_type: "clickup", created_by: "admin" },
      ])
      .execute();

    await up(db as Kysely<unknown>);

    const configs = await db.selectFrom("connector_configs").selectAll().orderBy("id").execute();
    expect(configs.map((c) => [c.id, c.created_by])).toEqual([
      ["conn-admin", "admin-1"],
      ["ff-orphan", "admin"],
      ["ff-owned", "admin-1"],
    ]);
  });

  it("reassigns orphaned fireflies configs when the admin owns none", async () => {
    await db.insertInto("users").values({ id: "admin-1", auth_role: "admin", created_at: "2026-01-01" }).execute();
    await db
      .insertInto("connector_configs")
      .values({ id: "ff-orphan", connector_type: "fireflies", created_by: "admin" })
      .execute();

    await up(db as Kysely<unknown>);

    const config = await db.selectFrom("connector_configs").selectAll().executeTakeFirstOrThrow();
    expect(config.created_by).toBe("admin-1");
  });

  it("reassigns only one fireflies config when both sentinel owners exist", async () => {
    await db.insertInto("users").values({ id: "admin-1", auth_role: "admin", created_at: "2026-01-01" }).execute();
    await db
      .insertInto("connector_configs")
      .values([
        { id: "ff-admin", connector_type: "fireflies", created_by: "admin", created_at: "2026-02-01" },
        { id: "ff-api-key", connector_type: "fireflies", created_by: "sketch-api-key", created_at: "2026-01-15" },
      ])
      .execute();

    await up(db as Kysely<unknown>);

    const configs = await db.selectFrom("connector_configs").selectAll().orderBy("id").execute();
    expect(configs.map((c) => [c.id, c.created_by])).toEqual([
      ["ff-admin", "admin"],
      ["ff-api-key", "admin-1"],
    ]);
  });
});
