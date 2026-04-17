import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { up } from "./030-inbox-messages";

interface UsersRow {
  id: string;
  name: string;
}

interface InboxRow {
  id: string;
  sender_user_id: string;
  recipient_user_id: string;
  message: string;
  platform: string;
  channel_id: string | null;
  message_ref: string | null;
  created_at: string;
  consumed_at: string | null;
}

function createBlankDb() {
  return new Kysely<{ users: UsersRow; inbox_messages: InboxRow }>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("030-inbox-messages migration", () => {
  let db: ReturnType<typeof createBlankDb>;

  beforeEach(() => {
    db = createBlankDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates the inbox_messages table and allows inserting rows", async () => {
    await db.schema
      .createTable("users")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();
    await up(db);

    await db
      .insertInto("users")
      .values([
        { id: "u1", name: "Alice" },
        { id: "u2", name: "Bob" },
      ])
      .execute();

    await db
      .insertInto("inbox_messages")
      .values({
        id: "i1",
        sender_user_id: "u1",
        recipient_user_id: "u2",
        message: "Hello from Alice",
        platform: "slack",
        channel_id: "D123",
        message_ref: "111.222",
        created_at: new Date().toISOString(),
        consumed_at: null,
      })
      .execute();

    const rows = await db.selectFrom("inbox_messages").selectAll().execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("Hello from Alice");
    expect(rows[0].consumed_at).toBeNull();
    expect(rows[0].created_at).toBeDefined();
  });

  it("creates the recipient_consumed index to support pending inbox lookups", async () => {
    await db.schema
      .createTable("users")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();
    await up(db);

    const result = await sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type='index' AND name='idx_inbox_recipient_consumed'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
  });
});
