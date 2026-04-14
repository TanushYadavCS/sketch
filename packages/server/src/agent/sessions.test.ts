/**
 * Tests for DB-based session persistence.
 * Uses an in-memory SQLite database via Kysely + better-sqlite3 so tests are
 * fast and self-contained without touching the real migrations infrastructure.
 */
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { deleteSessionId, getSessionId, saveSessionId } from "./sessions";

async function createTestDb(): Promise<Kysely<DB>> {
  const db = new Kysely<DB>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });

  await db.schema
    .createTable("chat_sessions")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("workspace_key", "text", (col) => col.notNull())
    .addColumn("thread_key", "text", (col) => col.notNull().defaultTo(sql`''`))
    .addColumn("session_id", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("chat_sessions_workspace_thread_uidx", ["workspace_key", "thread_key"])
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

  describe("workspace-level sessions (DMs)", () => {
    it("saveSessionId then getSessionId returns the same ID", async () => {
      await saveSessionId(db, "user-U1", "sess_abc123");
      const result = await getSessionId(db, "user-U1");
      expect(result).toBe("sess_abc123");
    });

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

    it("deleteSessionId removes a workspace session", async () => {
      await saveSessionId(db, "user-U1", "sess_abc123");
      await deleteSessionId(db, "user-U1");
      const result = await getSessionId(db, "user-U1");
      expect(result).toBeUndefined();
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

    it("deleteSessionId removes only the targeted thread session", async () => {
      await saveSessionId(db, "channel-C1", "sess_a", "1111.0000");
      await saveSessionId(db, "channel-C1", "sess_b", "2222.0000");
      await deleteSessionId(db, "channel-C1", "1111.0000");

      expect(await getSessionId(db, "channel-C1", "1111.0000")).toBeUndefined();
      expect(await getSessionId(db, "channel-C1", "2222.0000")).toBe("sess_b");
    });
  });
});
