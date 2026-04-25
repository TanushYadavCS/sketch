import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { down, up } from "./033-inbox-workflows";

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
  kind?: string;
  metadata?: string | null;
  resolution_mode?: string;
  resolved_at?: string | null;
}

function createBlankDb() {
  return new Kysely<{ users: UsersRow; inbox_messages: InboxRow }>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

describe("033-inbox-workflows migration", () => {
  let db: ReturnType<typeof createBlankDb>;

  beforeEach(async () => {
    db = createBlankDb();
    await db.schema
      .createTable("users")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("name", "text", (col) => col.notNull())
      .execute();
    await db.schema
      .createTable("inbox_messages")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("sender_user_id", "text", (col) => col.notNull().references("users.id"))
      .addColumn("recipient_user_id", "text", (col) => col.notNull().references("users.id"))
      .addColumn("message", "text", (col) => col.notNull())
      .addColumn("platform", "text", (col) => col.notNull())
      .addColumn("channel_id", "text")
      .addColumn("message_ref", "text")
      .addColumn("created_at", "text", (col) => col.notNull())
      .addColumn("consumed_at", "text")
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("adds workflow columns with defaults", async () => {
    await up(db as unknown as Kysely<unknown>);

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

    const row = await db.selectFrom("inbox_messages").selectAll().where("id", "=", "i1").executeTakeFirstOrThrow();

    expect(row.kind).toBe("note");
    expect(row.metadata).toBeNull();
    expect(row.resolution_mode).toBe("auto_consume");
    expect(row.resolved_at).toBeNull();
  });

  it("creates the recipient_resolution index", async () => {
    await up(db as unknown as Kysely<unknown>);

    const result = await sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type='index' AND name='idx_inbox_recipient_resolution'
    `.execute(db);

    expect(result.rows).toHaveLength(1);
  });

  it("drops workflow columns in down migration", async () => {
    await up(db as unknown as Kysely<unknown>);
    await down(db as unknown as Kysely<unknown>);

    const result = await sql<{ name: string }>`
      SELECT p.name
      FROM sqlite_master m
      JOIN pragma_table_info(m.name) p
      WHERE m.type='table'
        AND m.name='inbox_messages'
        AND p.name IN ('kind', 'metadata', 'resolution_mode', 'resolved_at')
    `.execute(db);

    expect(result.rows).toHaveLength(0);
  });
});
