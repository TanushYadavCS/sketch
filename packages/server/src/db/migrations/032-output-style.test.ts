import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./032-output-style";

function createBlankDb() {
  return new Kysely<{
    users: { id: string; name: string; tool_progress?: string | null; reasoning_text?: number | null };
    channels: {
      id: string;
      slack_channel_id: string;
      name: string;
      type: string;
      tool_progress?: string | null;
      reasoning_text?: number | null;
    };
    whatsapp_groups: {
      jid: string;
      name: string;
      description: string | null;
      tool_progress?: string | null;
      reasoning_text?: number | null;
    };
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

  it("adds tool_progress and reasoning_text to users, channels, and whatsapp_groups", async () => {
    await up(db as unknown as Kysely<unknown>);

    await db
      .insertInto("users")
      .values({ id: "u1", name: "Alice", tool_progress: "friendly", reasoning_text: 1 })
      .execute();
    await db
      .insertInto("channels")
      .values({
        id: "c1",
        slack_channel_id: "C1",
        name: "general",
        type: "public_channel",
        tool_progress: "verbose",
        reasoning_text: 0,
      })
      .execute();
    await db
      .insertInto("whatsapp_groups")
      .values({ jid: "g1@g.us", name: "Group", description: null, tool_progress: "technical", reasoning_text: 1 })
      .execute();

    const user = await db
      .selectFrom("users")
      .select(["tool_progress", "reasoning_text"])
      .where("id", "=", "u1")
      .executeTakeFirstOrThrow();
    const channel = await db
      .selectFrom("channels")
      .select(["tool_progress", "reasoning_text"])
      .where("id", "=", "c1")
      .executeTakeFirstOrThrow();
    const group = await db
      .selectFrom("whatsapp_groups")
      .select(["tool_progress", "reasoning_text"])
      .where("jid", "=", "g1@g.us")
      .executeTakeFirstOrThrow();

    expect(user.tool_progress).toBe("friendly");
    expect(user.reasoning_text).toBe(1);
    expect(channel.tool_progress).toBe("verbose");
    expect(channel.reasoning_text).toBe(0);
    expect(group.tool_progress).toBe("technical");
    expect(group.reasoning_text).toBe(1);
  });

  it("drops tool_progress and reasoning_text in down migration", async () => {
    await up(db as unknown as Kysely<unknown>);
    await down(db as unknown as Kysely<unknown>);

    const result = await sql<{ table_name: string; column_name: string }>`
      SELECT m.name as table_name, p.name as column_name
      FROM sqlite_master m
      JOIN pragma_table_info(m.name) p
      WHERE m.type = 'table'
        AND m.name IN ('users', 'channels', 'whatsapp_groups')
        AND p.name IN ('tool_progress', 'reasoning_text')
    `.execute(db);

    expect(result.rows).toHaveLength(0);
  });
});
