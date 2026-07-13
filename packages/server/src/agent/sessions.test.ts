/**
 * Tests for DB-based session persistence.
 * Uses an in-memory SQLite database via Kysely + better-sqlite3 so tests are
 * fast and self-contained without touching the real migrations infrastructure.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import {
  archiveRuntimeSessions,
  archiveSdkSessionId,
  getSessionId,
  getSessionIdForRuntime,
  saveSessionId,
  saveSessionIdForRuntime,
} from "./sessions";

async function createTestDb(): Promise<Kysely<DB>> {
  const db = new Kysely<DB>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });

  await db.schema
    .createTable("chat_sessions")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("workspace_key", "text", (col) => col.notNull())
    .addColumn("thread_key", "text", (col) => col.notNull().defaultTo(sql`''`))
    .addColumn("runtime", "text", (col) => col.notNull().defaultTo("sdk"))
    .addColumn("session_id", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("archived_at", "text")
    .execute();

  await db.schema
    .createIndex("chat_sessions_workspace_thread_uidx")
    .unique()
    .on("chat_sessions")
    .columns(["workspace_key", "thread_key", "runtime"])
    .where(sql.ref("archived_at"), "is", null)
    .execute();

  return db;
}

describe("session persistence", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("workspace and thread key shapes", () => {
    it.each([
      { label: "user DM", workspaceKey: "user-U1", threadKey: undefined },
      { label: "Slack channel thread", workspaceKey: "channel-C1", threadKey: "1111.0000" },
      { label: "WhatsApp group", workspaceKey: "wa-group-group@g.us", threadKey: undefined },
    ])("round-trips a $label session", async ({ workspaceKey, threadKey }) => {
      await saveSessionId(db, workspaceKey, "sess_abc123", threadKey);
      const result = await getSessionId(db, workspaceKey, threadKey);
      expect(result).toBe("sess_abc123");
    });
  });

  describe("workspace-level sessions (DMs)", () => {
    it("getSessionId for unknown workspaceKey returns undefined", async () => {
      const result = await getSessionId(db, "user-U1");
      expect(result).toBeUndefined();
    });

    it("saveSessionId overwrites previous session ID", async () => {
      await saveSessionId(db, "user-U1", "id1");
      await saveSessionId(db, "user-U1", "id2");
      const result = await getSessionId(db, "user-U1");
      expect(result).toBe("id2");
    });

    it("archiveSdkSessionId archives a workspace session", async () => {
      await saveSessionId(db, "user-U1", "sess_abc123");
      await archiveSdkSessionId(db, "user-U1");
      const result = await getSessionId(db, "user-U1");
      expect(result).toBeUndefined();

      const row = await db
        .selectFrom("chat_sessions")
        .select(["session_id", "archived_at"])
        .where("workspace_key", "=", "user-U1")
        .executeTakeFirstOrThrow();
      expect(row.session_id).toBe("sess_abc123");
      expect(row.archived_at).toEqual(expect.any(String));
    });
  });

  describe("per-thread sessions (channels)", () => {
    it("saves and retrieves a thread session", async () => {
      await saveSessionId(db, "channel-C1", "sess_thread1", "1111.0000");
      const result = await getSessionId(db, "channel-C1", "1111.0000");
      expect(result).toBe("sess_thread1");
    });

    it("different threadKey values produce isolated sessions", async () => {
      await saveSessionId(db, "channel-C1", "sess_a", "1111.0000");
      await saveSessionId(db, "channel-C1", "sess_b", "2222.0000");

      expect(await getSessionId(db, "channel-C1", "1111.0000")).toBe("sess_a");
      expect(await getSessionId(db, "channel-C1", "2222.0000")).toBe("sess_b");
    });

    it("returns undefined for nonexistent thread session", async () => {
      const result = await getSessionId(db, "channel-C1", "9999.0000");
      expect(result).toBeUndefined();
    });

    it("thread session does not interfere with workspace session", async () => {
      await saveSessionId(db, "user-U1", "sess_dm");
      await saveSessionId(db, "channel-C1", "sess_thread", "1111.0000");

      expect(await getSessionId(db, "user-U1")).toBe("sess_dm");
      expect(await getSessionId(db, "channel-C1", "1111.0000")).toBe("sess_thread");
    });

    it("overwrites previous thread session ID", async () => {
      await saveSessionId(db, "channel-C1", "old", "1111.0000");
      await saveSessionId(db, "channel-C1", "new", "1111.0000");

      expect(await getSessionId(db, "channel-C1", "1111.0000")).toBe("new");
    });

    it("archiveSdkSessionId archives only the targeted thread session", async () => {
      await saveSessionId(db, "channel-C1", "sess_a", "1111.0000");
      await saveSessionId(db, "channel-C1", "sess_b", "2222.0000");
      await archiveSdkSessionId(db, "channel-C1", "1111.0000");

      expect(await getSessionId(db, "channel-C1", "1111.0000")).toBeUndefined();
      expect(await getSessionId(db, "channel-C1", "2222.0000")).toBe("sess_b");

      const rows = await db
        .selectFrom("chat_sessions")
        .select(["thread_key", "archived_at"])
        .where("workspace_key", "=", "channel-C1")
        .orderBy("thread_key", "asc")
        .execute();
      expect(rows).toEqual([
        { thread_key: "1111.0000", archived_at: expect.any(String) },
        { thread_key: "2222.0000", archived_at: null },
      ]);
    });
  });

  it("allows a new active SDK session after archiving the old one", async () => {
    await saveSessionId(db, "user-U1", "sess-old");
    await archiveSdkSessionId(db, "user-U1");
    await saveSessionId(db, "user-U1", "sess-new");

    expect(await getSessionId(db, "user-U1")).toBe("sess-new");

    const rows = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", "user-U1")
      .orderBy("id", "asc")
      .execute();
    expect(rows).toEqual([
      { session_id: "sess-old", archived_at: expect.any(String) },
      { session_id: "sess-new", archived_at: null },
    ]);
  });

  it("does not resurrect an archived runtime session id when save races with archive", async () => {
    await saveSessionIdForRuntime(db, "user-U1", "sess-race", undefined, "aisdk");
    await archiveRuntimeSessions(db, "user-U1");
    await saveSessionIdForRuntime(db, "user-U1", "sess-race", undefined, "aisdk");

    expect(await getSessionIdForRuntime(db, "user-U1", undefined, "aisdk")).toBeUndefined();

    const rows = await db
      .selectFrom("chat_sessions")
      .select(["workspace_key", "thread_key", "runtime", "session_id", "archived_at"])
      .where("session_id", "=", "sess-race")
      .execute();
    expect(rows).toEqual([
      {
        workspace_key: "user-U1",
        thread_key: "",
        runtime: "aisdk",
        session_id: "sess-race",
        archived_at: expect.any(String),
      },
    ]);
  });

  it("ignores non-SDK runtime rows for the same workspace and thread", async () => {
    await db
      .insertInto("chat_sessions")
      .values({ workspace_key: "user-U1", thread_key: "", runtime: "aisdk", session_id: "sess-ai" })
      .execute();
    await saveSessionId(db, "user-U1", "sess-sdk");

    expect(await getSessionId(db, "user-U1")).toBe("sess-sdk");

    const rows = await db
      .selectFrom("chat_sessions")
      .select(["runtime", "session_id"])
      .where("workspace_key", "=", "user-U1")
      .orderBy("runtime", "asc")
      .execute();
    expect(rows).toEqual([
      { runtime: "aisdk", session_id: "sess-ai" },
      { runtime: "sdk", session_id: "sess-sdk" },
    ]);
  });
});
