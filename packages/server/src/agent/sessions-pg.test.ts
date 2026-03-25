/**
 * Tests for DB-based session persistence on Postgres (PGlite).
 *
 * Exercises the same saveSessionId/getSessionId logic as sessions.test.ts but
 * against a real Postgres dialect. Specifically validates that the ON CONFLICT
 * target (workspace_key, thread_key) works correctly on Postgres, which requires
 * a plain column-based unique constraint (not an expression index).
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { createTestPgDb } from "../test-utils";
import { getSessionId, saveSessionId } from "./sessions";

describe("session persistence on Postgres", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestPgDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("workspace-level sessions (empty string thread_key sentinel)", () => {
    it("saveSessionId inserts a new session", async () => {
      await saveSessionId(db, "user-U1", "sess_abc123");
      const result = await getSessionId(db, "user-U1");
      expect(result).toBe("sess_abc123");
    });

    it("getSessionId returns undefined for unknown workspace", async () => {
      const result = await getSessionId(db, "user-unknown");
      expect(result).toBeUndefined();
    });

    it("saveSessionId with same workspace_key upserts the session_id", async () => {
      await saveSessionId(db, "user-U1", "id-first");
      await saveSessionId(db, "user-U1", "id-second");
      const result = await getSessionId(db, "user-U1");
      expect(result).toBe("id-second");
    });

    it("upsert leaves only one row per workspace when no thread_key", async () => {
      await saveSessionId(db, "user-U1", "id-first");
      await saveSessionId(db, "user-U1", "id-second");

      const rows = await db.selectFrom("chat_sessions").selectAll().where("workspace_key", "=", "user-U1").execute();

      expect(rows).toHaveLength(1);
    });
  });

  describe("per-thread sessions", () => {
    it("saveSessionId with thread_key inserts a thread-scoped session", async () => {
      await saveSessionId(db, "channel-C1", "sess_thread1", "1111.0000");
      const result = await getSessionId(db, "channel-C1", "1111.0000");
      expect(result).toBe("sess_thread1");
    });

    it("different thread_key values produce isolated sessions", async () => {
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

    it("upserts an existing thread session with same workspace_key + thread_key", async () => {
      await saveSessionId(db, "channel-C1", "old", "1111.0000");
      await saveSessionId(db, "channel-C1", "new", "1111.0000");

      expect(await getSessionId(db, "channel-C1", "1111.0000")).toBe("new");

      const rows = await db
        .selectFrom("chat_sessions")
        .selectAll()
        .where("workspace_key", "=", "channel-C1")
        .where("thread_key", "=", "1111.0000")
        .execute();

      expect(rows).toHaveLength(1);
    });
  });

  describe("empty string thread_key sentinel", () => {
    it("works with explicit empty string thread_key", async () => {
      await saveSessionId(db, "user-U2", "sess_explicit_empty", "");
      const result = await getSessionId(db, "user-U2", "");
      expect(result).toBe("sess_explicit_empty");
    });

    it("omitting thread_key is equivalent to empty string thread_key", async () => {
      await saveSessionId(db, "user-U3", "sess_no_thread");
      const result = await getSessionId(db, "user-U3", "");
      expect(result).toBe("sess_no_thread");
    });

    it("empty string thread_key and omitted thread_key share the same row", async () => {
      await saveSessionId(db, "user-U4", "sess_v1");
      await saveSessionId(db, "user-U4", "sess_v2", "");

      const rows = await db.selectFrom("chat_sessions").selectAll().where("workspace_key", "=", "user-U4").execute();

      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe("sess_v2");
    });
  });
});
