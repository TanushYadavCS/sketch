import SQLite from "better-sqlite3";
import { type Generated, Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./054-agent-environment-variable-shares";

interface MigrationTestDb {
  users: {
    id: string;
    name: string;
  };
  agent_environment_variables: {
    id: string;
    user_id: string;
    name: string;
    value: string;
  };
  agent_environment_variable_shares: {
    id: string;
    variable_id: string;
    variable_name: string;
    target_type: string;
    target_id: string;
    created_by: string;
    created_at: Generated<string>;
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
    .addColumn("name", "text")
    .execute();
  await db.schema
    .createTable("agent_environment_variables")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("value", "text", (col) => col.notNull())
    .execute();
}

describe("054-agent-environment-variable-shares migration", () => {
  let db: Kysely<MigrationTestDb>;

  beforeEach(async () => {
    db = createBlankDb();
    await sql`PRAGMA foreign_keys = ON`.execute(db);
    await createPrerequisites(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates share grants with uniqueness and cascade behavior", async () => {
    await up(db as Kysely<unknown>);

    await db.insertInto("users").values({ id: "owner", name: "Owner" }).execute();
    await db.insertInto("users").values({ id: "creator", name: "Creator" }).execute();
    await db
      .insertInto("agent_environment_variables")
      .values({ id: "var-1", user_id: "owner", name: "API_TOKEN", value: "secret" })
      .execute();

    await db
      .insertInto("agent_environment_variable_shares")
      .values({
        id: "share-1",
        variable_id: "var-1",
        variable_name: "API_TOKEN",
        target_type: "slack_channel",
        target_id: "C123",
        created_by: "creator",
      })
      .execute();

    await expect(
      db
        .insertInto("agent_environment_variable_shares")
        .values({
          id: "share-2",
          variable_id: "var-1",
          variable_name: "API_TOKEN",
          target_type: "slack_channel",
          target_id: "C123",
          created_by: "creator",
        })
        .execute(),
    ).rejects.toThrow();

    await db.deleteFrom("agent_environment_variables").where("id", "=", "var-1").execute();

    const shares = await db.selectFrom("agent_environment_variable_shares").selectAll().execute();
    expect(shares).toEqual([]);
  });

  it("enforces one variable name per share target", async () => {
    await up(db as Kysely<unknown>);

    await db.insertInto("users").values({ id: "first-owner", name: "First Owner" }).execute();
    await db.insertInto("users").values({ id: "second-owner", name: "Second Owner" }).execute();
    await db
      .insertInto("agent_environment_variables")
      .values({ id: "var-1", user_id: "first-owner", name: "API_TOKEN", value: "secret" })
      .execute();
    await db
      .insertInto("agent_environment_variables")
      .values({ id: "var-2", user_id: "second-owner", name: "API_TOKEN", value: "other-secret" })
      .execute();

    await db
      .insertInto("agent_environment_variable_shares")
      .values({
        id: "share-1",
        variable_id: "var-1",
        variable_name: "API_TOKEN",
        target_type: "slack_channel",
        target_id: "C123",
        created_by: "first-owner",
      })
      .execute();

    await expect(
      db
        .insertInto("agent_environment_variable_shares")
        .values({
          id: "share-2",
          variable_id: "var-2",
          variable_name: "API_TOKEN",
          target_type: "slack_channel",
          target_id: "C123",
          created_by: "second-owner",
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("drops the share grants table", async () => {
    await up(db as Kysely<unknown>);
    await down(db as Kysely<unknown>);

    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_environment_variable_shares'
    `.execute(db);
    expect(tables.rows).toEqual([]);
  });
});
