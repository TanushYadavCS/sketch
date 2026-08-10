import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./168-whatsapp-group-scope-authority";

type MigrationDb = {
  connector_configs: { id: string; connector_type: string; scope_config: string };
  whatsapp_groups: { jid: string; index_enabled: number };
};

describe("168-whatsapp-group-scope-authority migration", () => {
  let db: Kysely<MigrationDb>;

  beforeEach(async () => {
    db = new Kysely<MigrationDb>({ dialect: new SqliteDialect({ database: new SQLite(":memory:") }) });
    await db.schema
      .createTable("connector_configs")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("connector_type", "text", (col) => col.notNull())
      .addColumn("scope_config", "text", (col) => col.notNull())
      .execute();
    await db.schema
      .createTable("whatsapp_groups")
      .addColumn("jid", "text", (col) => col.primaryKey())
      .addColumn("index_enabled", "integer", (col) => col.notNull())
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("removes legacy groupJids and reconstructs them from enabled rows on down", async () => {
    await db
      .insertInto("connector_configs")
      .values({
        id: "wa",
        connector_type: "whatsapp",
        scope_config: JSON.stringify({ groupJids: ["stale@g.us"], sliceGapMinutes: 15 }),
      })
      .execute();
    await db
      .insertInto("whatsapp_groups")
      .values([
        { jid: "enabled@g.us", index_enabled: 1 },
        { jid: "disabled@g.us", index_enabled: 0 },
      ])
      .execute();

    await up(db as unknown as Kysely<unknown>);

    const migrated = await db
      .selectFrom("connector_configs")
      .select("scope_config")
      .where("id", "=", "wa")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(migrated.scope_config)).toEqual({ sliceGapMinutes: 15 });
    await expect(db.selectFrom("whatsapp_groups").selectAll().orderBy("jid", "asc").execute()).resolves.toEqual([
      { jid: "disabled@g.us", index_enabled: 0 },
      { jid: "enabled@g.us", index_enabled: 1 },
    ]);

    await down(db as unknown as Kysely<unknown>);

    const restored = await db
      .selectFrom("connector_configs")
      .select("scope_config")
      .where("id", "=", "wa")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(restored.scope_config)).toEqual({
      sliceGapMinutes: 15,
      groupJids: ["enabled@g.us"],
    });
    await expect(db.selectFrom("whatsapp_groups").selectAll().orderBy("jid", "asc").execute()).resolves.toEqual([
      { jid: "disabled@g.us", index_enabled: 0 },
      { jid: "enabled@g.us", index_enabled: 1 },
    ]);
  });
});
