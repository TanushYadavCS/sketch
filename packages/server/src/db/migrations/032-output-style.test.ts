import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./032-output-style";

function createBlankDb() {
  return new Kysely<{
    users: { id: string; name: string; output_style?: string | null };
    channels: { id: string; slack_channel_id: string; name: string; type: string; output_style?: string | null };
    whatsapp_groups: { jid: string; name: string; description: string | null; output_style?: string | null };
  }>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("032-output-style migration", () => {
  let db: ReturnType<typeof createBlankDb>;

  beforeEach(async () => {
    db = createBlankDb();
    await db.schema
      .createTable("users")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();
    await db.schema
      .createTable("channels")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("slack_channel_id", "text", (col) => col.notNull())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("type", "text", (col) => col.notNull())
      .execute();
    await db.schema
      .createTable("whatsapp_groups")
      .addColumn("jid", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .addColumn("description", "text")
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("adds output_style to users, channels, and whatsapp_groups", async () => {
    await up(db as unknown as Kysely<unknown>);

    await db.insertInto("users").values({ id: "u1", name: "Alice", output_style: "friendly" }).execute();
    await db
      .insertInto("channels")
      .values({ id: "c1", slack_channel_id: "C1", name: "general", type: "public_channel", output_style: "verbose" })
      .execute();
    await db
      .insertInto("whatsapp_groups")
      .values({ jid: "g1@g.us", name: "Group", description: null, output_style: "technical" })
      .execute();

    const user = await db.selectFrom("users").select("output_style").where("id", "=", "u1").executeTakeFirstOrThrow();
    const channel = await db
      .selectFrom("channels")
      .select("output_style")
      .where("id", "=", "c1")
      .executeTakeFirstOrThrow();
    const group = await db
      .selectFrom("whatsapp_groups")
      .select("output_style")
      .where("jid", "=", "g1@g.us")
      .executeTakeFirstOrThrow();

    expect(user.output_style).toBe("friendly");
    expect(channel.output_style).toBe("verbose");
    expect(group.output_style).toBe("technical");
  });

  it("drops output_style in down migration", async () => {
    await up(db as unknown as Kysely<unknown>);
    await down(db as unknown as Kysely<unknown>);

    const result = await sql<{ table_name: string; column_name: string }>`
      SELECT m.name as table_name, p.name as column_name
      FROM sqlite_master m
      JOIN pragma_table_info(m.name) p
      WHERE m.type = 'table'
        AND m.name IN ('users', 'channels', 'whatsapp_groups')
        AND p.name = 'output_style'
    `.execute(db);

    expect(result.rows).toHaveLength(0);
  });
});
