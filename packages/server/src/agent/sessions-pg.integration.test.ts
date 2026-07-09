/**
 * Tests for DB-based session persistence on Postgres (PGlite).
 *
 * Exercises the same saveSessionId/getSessionId logic as sessions.test.ts but
 * against a real Postgres dialect. Specifically validates that update-then-insert
 * session saves work against the active-session partial unique index.
 */
import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../db/schema";
import { getSharedPgDb } from "../test-utils";
import {
  archiveRuntimeSessions,
  archiveSdkSessionId,
  getSessionId,
  getSessionIdForRuntime,
  saveSessionId,
  saveSessionIdForRuntime,
} from "./sessions";

describe("session persistence on Postgres", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  describe("workspace-level sessions (empty string thread_key sentinel)", () => {
    it.each([
      { label: "user DM", workspaceKey: "user-U1", threadKey: undefined },
      { label: "Slack channel thread", workspaceKey: "channel-C1", threadKey: "1111.0000" },
      { label: "WhatsApp group", workspaceKey: "wa-group-group@g.us", threadKey: undefined },
    ])("round-trips a $label session", async ({ workspaceKey, threadKey }) => {
      await saveSessionId(db, workspaceKey, "sess_abc123", threadKey);
      const result = await getSessionId(db, workspaceKey, threadKey);
      expect(result).toBe("sess_abc123");
    });

    it("saveSessionId inserts a new session", async () => {
      await saveSessionId(db, "user-U1", "sess_abc123");
      const result = await getSessionId(db, "user-U1");
      expect(result).toBe("sess_abc123");
    }, 30000);

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
    await saveSessionId(db, "user-U5", "sess-old");
    await archiveSdkSessionId(db, "user-U5");
    await saveSessionId(db, "user-U5", "sess-new");

    expect(await getSessionId(db, "user-U5")).toBe("sess-new");

    const rows = await db
      .selectFrom("chat_sessions")
      .select(["session_id", "archived_at"])
      .where("workspace_key", "=", "user-U5")
      .orderBy("id", "asc")
      .execute();
    expect(rows).toEqual([
      { session_id: "sess-old", archived_at: expect.any(String) },
      { session_id: "sess-new", archived_at: null },
    ]);
  });

  it("does not resurrect an archived runtime session id when save races with archive", async () => {
    await saveSessionIdForRuntime(db, "user-U6", "sess-race", undefined, "aisdk");
    await archiveRuntimeSessions(db, "user-U6");
    await saveSessionIdForRuntime(db, "user-U6", "sess-race", undefined, "aisdk");

    expect(await getSessionIdForRuntime(db, "user-U6", undefined, "aisdk")).toBeUndefined();

    const rows = await db
      .selectFrom("chat_sessions")
      .select(["workspace_key", "thread_key", "runtime", "session_id", "archived_at"])
      .where("session_id", "=", "sess-race")
      .execute();
    expect(rows).toEqual([
      {
        workspace_key: "user-U6",
        thread_key: "",
        runtime: "aisdk",
        session_id: "sess-race",
        archived_at: expect.any(String),
      },
    ]);
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
