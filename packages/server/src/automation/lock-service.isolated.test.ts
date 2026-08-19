/**
 * Isolated tests for the automation lock state machine (lock-service.ts) with
 * fake timers: acquire/CAS/renew/release, expiry takeover, steal
 * approve/deny/expire matrices, the steal-vs-renew race, the edit gate, and
 * the 60s hygiene sweeper.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomationLocksRepository } from "../db/repositories/automation-locks";
import type { LockHolderFields } from "../db/repositories/automation-locks";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import {
  AutomationLockSweeper,
  LOCK_HEARTBEAT_INTERVAL_MS,
  LOCK_TTL_MS,
  STEAL_TTL_MS,
  acquireOrRenewLock,
  approveSteal,
  assertEditableBy,
  authorizeAuthoringLease,
  denySteal,
  releaseLock,
  renewLock,
  requestSteal,
} from "./lock-service";

const T0 = "2026-08-01T10:00:00.000Z";
const T0_MS = Date.parse(T0);

const HOLDER_A: LockHolderFields = { userId: "user-a", platform: "web", surface: "builder", conversationId: null };
const HOLDER_B: LockHolderFields = { userId: "user-b", platform: "slack", surface: "dm", conversationId: "C1" };

describe("automation lock service", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    db = await createTestDb();
    for (const id of ["user-a", "user-b", "user-c"]) {
      await db.insertInto("users").values({ id, name: id }).execute();
    }
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.destroy();
  });

  describe("acquire", () => {
    it("holds a free task with a fresh TTL", async () => {
      const result = await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });

      expect(result.kind).toBe("held");
      if (result.kind !== "held") return;
      expect(result.lock).toMatchObject({
        task_id: "task-1",
        holder_user_id: "user-a",
        holder_platform: "web",
        holder_surface: "builder",
        holder_conversation_id: null,
        acquired_at: T0,
        updated_at: T0,
        expires_at: new Date(T0_MS + LOCK_TTL_MS).toISOString(),
      });
    });

    it("is safe against a conflicting insert for the same task (insert conflict)", async () => {
      const repo = createAutomationLocksRepository(db);
      await repo.insertIfAbsent(HOLDER_A, {
        taskId: "task-1",
        now: T0,
        expiresAt: new Date(T0_MS + LOCK_TTL_MS).toISOString(),
      });

      // The insert is a no-op; the read-back surfaces the winning holder.
      const result = await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_B });

      expect(result.kind).toBe("locked");
      if (result.kind !== "locked") return;
      expect(result.lock.holder_user_id).toBe("user-a");
    });

    it("renews when the caller already holds the lock", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });
      vi.setSystemTime(new Date(T0_MS + LOCK_HEARTBEAT_INTERVAL_MS));

      const result = await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });

      expect(result.kind).toBe("held");
      if (result.kind !== "held") return;
      expect(result.lock.expires_at).toBe(new Date(T0_MS + LOCK_HEARTBEAT_INTERVAL_MS + LOCK_TTL_MS).toISOString());
      expect(result.lock.acquired_at).toBe(T0);
    });

    it("reports the holder when another user holds an unexpired lock", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });

      const result = await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_B });

      expect(result.kind).toBe("locked");
      if (result.kind !== "locked") return;
      expect(result.lock.holder_user_id).toBe("user-a");
    });

    it("shares one lease generation across sessions for the same user", async () => {
      const firstSession: LockHolderFields = { ...HOLDER_A, sessionId: "tab-a" };
      const secondSession: LockHolderFields = { ...HOLDER_A, sessionId: "tab-b" };

      const first = await acquireOrRenewLock(db, { taskId: "task-session", holder: firstSession });
      expect(first.kind).toBe("held");
      if (first.kind !== "held") return;
      expect(first.lock).toMatchObject({ holder_session_id: "tab-a", generation: 1 });

      const second = await acquireOrRenewLock(db, { taskId: "task-session", holder: secondSession });
      expect(second.kind).toBe("held");
      if (second.kind !== "held") return;
      expect(second.lock).toMatchObject({
        holder_user_id: "user-a",
        holder_session_id: "tab-b",
        generation: 1,
      });

      const firstHeartbeat = await acquireOrRenewLock(db, {
        taskId: "task-session",
        holder: firstSession,
        requestedGeneration: 1,
      });
      expect(firstHeartbeat.kind).toBe("held");
      if (firstHeartbeat.kind !== "held") return;
      expect(firstHeartbeat.lock).toMatchObject({ holder_session_id: "tab-a", generation: 1 });
    });

    it("takes over an expired lock and clears pending steals", async () => {
      const repo = createAutomationLocksRepository(db);
      await repo.insertIfAbsent(HOLDER_A, {
        taskId: "task-1",
        now: "2026-08-01T09:00:00.000Z",
        expiresAt: "2026-08-01T09:59:59.000Z",
      });
      await repo.requestSteal(HOLDER_B, {
        taskId: "task-1",
        stealRequestedAt: "2026-08-01T09:30:00.000Z",
        stealExpiresAt: "2026-08-01T09:35:00.000Z",
      });

      const result = await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_B });

      expect(result.kind).toBe("held");
      if (result.kind !== "held") return;
      expect(result.lock).toMatchObject({
        holder_user_id: "user-b",
        holder_session_id: "legacy",
        generation: 2,
        expires_at: new Date(T0_MS + LOCK_TTL_MS).toISOString(),
        steal_requester_user_id: null,
        steal_requested_at: null,
        steal_expires_at: null,
      });
    });
  });

  describe("renew", () => {
    it("extends the lock TTL for the holder", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });
      vi.setSystemTime(new Date(T0_MS + LOCK_HEARTBEAT_INTERVAL_MS));

      const result = await renewLock(db, { taskId: "task-1", userId: "user-a" });

      expect(result.kind).toBe("renewed");
      if (result.kind !== "renewed") return;
      expect(result.lock.expires_at).toBe(new Date(T0_MS + LOCK_HEARTBEAT_INTERVAL_MS + LOCK_TTL_MS).toISOString());
    });

    it("fails for a non-holder and a missing task", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });

      await expect(renewLock(db, { taskId: "task-1", userId: "user-b" })).resolves.toEqual({ kind: "not_holder" });
      await expect(renewLock(db, { taskId: "missing", userId: "user-a" })).resolves.toEqual({ kind: "not_found" });
    });
  });

  describe("release", () => {
    it("releases the holder's lock and is idempotent", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });

      await expect(releaseLock(db, { taskId: "task-1", userId: "user-a" })).resolves.toEqual({ kind: "released" });
      await expect(createAutomationLocksRepository(db).getByTaskId("task-1")).resolves.toBeUndefined();
      await expect(releaseLock(db, { taskId: "task-1", userId: "user-a" })).resolves.toEqual({ kind: "released" });
    });

    it("is a no-op for a non-holder", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });

      await expect(releaseLock(db, { taskId: "task-1", userId: "user-b" })).resolves.toEqual({ kind: "released" });
      await expect(createAutomationLocksRepository(db).getByTaskId("task-1")).resolves.toMatchObject({
        holder_user_id: "user-a",
      });
    });
  });

  describe("steal", () => {
    it("records a pending steal for another holder's unexpired lock", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });

      const result = await requestSteal(db, { taskId: "task-1", requester: HOLDER_B });

      expect(result.kind).toBe("pending");
      if (result.kind !== "pending") return;
      expect(result.lock).toMatchObject({
        holder_user_id: "user-a",
        steal_requester_user_id: "user-b",
        steal_requester_platform: "slack",
        steal_requested_at: T0,
        steal_expires_at: new Date(T0_MS + STEAL_TTL_MS).toISOString(),
      });
    });

    it("is idempotent for the same requester while pending", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });
      await requestSteal(db, { taskId: "task-1", requester: HOLDER_B });

      const again = await requestSteal(db, { taskId: "task-1", requester: HOLDER_B });

      expect(again.kind).toBe("pending");
    });

    it("rejects a second requester while a steal is pending", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });
      await requestSteal(db, { taskId: "task-1", requester: HOLDER_B });

      const result = await requestSteal(db, {
        taskId: "task-1",
        requester: { ...HOLDER_B, userId: "user-c" },
      });

      expect(result.kind).toBe("locked");
      if (result.kind !== "locked") return;
      expect(result.lock.steal_requester_user_id).toBe("user-b");
    });

    it("rejects stealing a lock held by the requester", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });

      await expect(requestSteal(db, { taskId: "task-1", requester: HOLDER_A })).resolves.toEqual({
        kind: "not_locked",
      });
    });

    it("does not create a takeover request between sessions for the same user", async () => {
      const holder = { ...HOLDER_A, sessionId: "tab-a" };
      const requester = { ...HOLDER_A, sessionId: "tab-b" };
      await acquireOrRenewLock(db, { taskId: "task-same-user-steal", holder });

      await expect(requestSteal(db, { taskId: "task-same-user-steal", requester })).resolves.toEqual({
        kind: "not_locked",
      });
    });

    it("rejects stealing when there is no lock", async () => {
      await expect(requestSteal(db, { taskId: "task-1", requester: HOLDER_B })).resolves.toEqual({
        kind: "not_locked",
      });
    });

    it("rejects stealing an expired lock (acquire instead)", async () => {
      const repo = createAutomationLocksRepository(db);
      await repo.insertIfAbsent(HOLDER_A, {
        taskId: "task-1",
        now: "2026-08-01T09:00:00.000Z",
        expiresAt: "2026-08-01T09:59:59.000Z",
      });

      await expect(requestSteal(db, { taskId: "task-1", requester: HOLDER_B })).resolves.toEqual({
        kind: "not_locked",
      });
    });

    it("clears an expired pending steal and lets a new request proceed", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });
      const repo = createAutomationLocksRepository(db);
      await repo.requestSteal(HOLDER_B, {
        taskId: "task-1",
        stealRequestedAt: "2026-08-01T09:30:00.000Z",
        stealExpiresAt: "2026-08-01T09:35:00.000Z",
      });

      const result = await requestSteal(db, {
        taskId: "task-1",
        requester: { ...HOLDER_B, userId: "user-c" },
      });

      expect(result.kind).toBe("pending");
      if (result.kind !== "pending") return;
      expect(result.lock.steal_requester_user_id).toBe("user-c");
    });
  });

  describe("steal response", () => {
    it("approves: hands the lock to the requester with a fresh TTL", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });
      await requestSteal(db, { taskId: "task-1", requester: HOLDER_B });

      const result = await approveSteal(db, { taskId: "task-1", approverUserId: "user-a" });

      expect(result.kind).toBe("approved");
      if (result.kind !== "approved") return;
      expect(result.lock).toMatchObject({
        holder_user_id: "user-b",
        holder_platform: "slack",
        holder_surface: "dm",
        holder_conversation_id: "C1",
        expires_at: new Date(T0_MS + LOCK_TTL_MS).toISOString(),
        steal_requester_user_id: null,
        steal_expires_at: null,
      });
    });

    it("denies: clears the pending steal and keeps the holder", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });
      await requestSteal(db, { taskId: "task-1", requester: HOLDER_B });

      const result = await denySteal(db, { taskId: "task-1", holderUserId: "user-a" });

      expect(result.kind).toBe("denied");
      if (result.kind !== "denied") return;
      expect(result.lock).toMatchObject({
        holder_user_id: "user-a",
        steal_requester_user_id: null,
        steal_requested_at: null,
        steal_expires_at: null,
      });
    });

    it("is holder-only for approve and deny", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });
      await requestSteal(db, { taskId: "task-1", requester: HOLDER_B });

      await expect(approveSteal(db, { taskId: "task-1", approverUserId: "user-b" })).resolves.toEqual({
        kind: "not_holder",
      });
      await expect(denySteal(db, { taskId: "task-1", holderUserId: "user-b" })).resolves.toEqual({
        kind: "not_holder",
      });
    });

    it("reports no_pending_steal when nothing is pending", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });

      await expect(approveSteal(db, { taskId: "task-1", approverUserId: "user-a" })).resolves.toEqual({
        kind: "no_pending_steal",
      });
      await expect(denySteal(db, { taskId: "task-1", holderUserId: "user-a" })).resolves.toEqual({
        kind: "no_pending_steal",
      });
    });

    it("clears an expired pending steal instead of approving it", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });
      const repo = createAutomationLocksRepository(db);
      await repo.requestSteal(HOLDER_B, {
        taskId: "task-1",
        stealRequestedAt: "2026-08-01T09:30:00.000Z",
        stealExpiresAt: "2026-08-01T09:35:00.000Z",
      });

      const result = await approveSteal(db, { taskId: "task-1", approverUserId: "user-a" });

      expect(result.kind).toBe("no_pending_steal");
      await expect(repo.getByTaskId("task-1")).resolves.toMatchObject({
        holder_user_id: "user-a",
        steal_requester_user_id: null,
      });
    });

    it("keeps a pending steal across a holder renewal (steal-vs-renew race)", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });
      await requestSteal(db, { taskId: "task-1", requester: HOLDER_B });

      // The holder heartbeats while the steal is pending.
      vi.setSystemTime(new Date(T0_MS + LOCK_HEARTBEAT_INTERVAL_MS));
      const renewed = await renewLock(db, { taskId: "task-1", userId: "user-a" });
      expect(renewed.kind).toBe("renewed");
      if (renewed.kind !== "renewed") return;
      expect(renewed.lock.steal_requester_user_id).toBe("user-b");

      const approved = await approveSteal(db, { taskId: "task-1", approverUserId: "user-a" });
      expect(approved.kind).toBe("approved");
      if (approved.kind !== "approved") return;
      expect(approved.lock.holder_user_id).toBe("user-b");
    });
  });

  describe("cross-lane lock races", () => {
    it("increments the generation on expiry takeover and rejects stale holder transitions", async () => {
      const repo = createAutomationLocksRepository(db);
      const firstSession: LockHolderFields = { ...HOLDER_A, sessionId: "tab-a" };
      const nextSession: LockHolderFields = { ...HOLDER_B, sessionId: "tab-b" };
      await repo.insertIfAbsent(firstSession, {
        taskId: "task-generation-expiry",
        now: "2026-08-01T09:00:00.000Z",
        expiresAt: "2026-08-01T09:59:59.000Z",
      });

      const takeover = await acquireOrRenewLock(db, {
        taskId: "task-generation-expiry",
        holder: nextSession,
        nowMs: T0_MS,
      });
      expect(takeover.kind).toBe("held");
      if (takeover.kind !== "held") return;
      expect(takeover.lock).toMatchObject({ holder_session_id: "tab-b", generation: 2 });

      await expect(
        renewLock(db, { taskId: "task-generation-expiry", userId: "user-a", sessionId: "tab-a", generation: 1 }),
      ).resolves.toEqual({ kind: "not_holder" });
      await releaseLock(db, { taskId: "task-generation-expiry", userId: "user-a", sessionId: "tab-a", generation: 1 });
      await expect(repo.getByTaskId("task-generation-expiry")).resolves.toMatchObject({
        holder_user_id: "user-b",
        holder_session_id: "tab-b",
        generation: 2,
      });
    });

    it("increments the generation and transfers the requester session on approved takeover", async () => {
      const repo = createAutomationLocksRepository(db);
      const holder: LockHolderFields = { ...HOLDER_A, sessionId: "tab-a" };
      const requester: LockHolderFields = { ...HOLDER_B, sessionId: "tab-b" };
      await repo.insertIfAbsent(holder, {
        taskId: "task-generation-approve",
        now: T0,
        expiresAt: new Date(T0_MS + LOCK_TTL_MS).toISOString(),
      });
      await requestSteal(db, { taskId: "task-generation-approve", requester });

      const approved = await approveSteal(db, {
        taskId: "task-generation-approve",
        approverUserId: "user-a",
        approverSessionId: "tab-a",
        approverGeneration: 1,
      });
      expect(approved.kind).toBe("approved");
      if (approved.kind !== "approved") return;
      expect(approved.lock).toMatchObject({ holder_user_id: "user-b", holder_session_id: "tab-b", generation: 2 });

      await expect(
        renewLock(db, { taskId: "task-generation-approve", userId: "user-a", sessionId: "tab-a", generation: 1 }),
      ).resolves.toEqual({ kind: "not_holder" });
    });

    it("renewal loses when an expired lock is taken over first (expiry-takeover vs renewal)", async () => {
      const repo = createAutomationLocksRepository(db);
      await repo.insertIfAbsent(HOLDER_A, {
        taskId: "task-expiry-renew",
        now: "2026-08-01T09:00:00.000Z",
        expiresAt: "2026-08-01T09:59:59.000Z",
      });

      // B's acquire takes over the lapsed lock at T0.
      const takeover = await acquireOrRenewLock(db, { taskId: "task-expiry-renew", holder: HOLDER_B, nowMs: T0_MS });
      expect(takeover.kind).toBe("held");
      if (takeover.kind !== "held") return;

      // The lapsed holder's heartbeat and re-acquire both lose the CAS.
      await expect(renewLock(db, { taskId: "task-expiry-renew", userId: "user-a", nowMs: T0_MS })).resolves.toEqual({
        kind: "not_holder",
      });
      const relock = await acquireOrRenewLock(db, { taskId: "task-expiry-renew", holder: HOLDER_A, nowMs: T0_MS });
      expect(relock.kind).toBe("locked");
      if (relock.kind !== "locked") return;
      expect(relock.lock.holder_user_id).toBe("user-b");
    });

    it("takeover loses when the holder renews before expiry (expiry-takeover vs renewal)", async () => {
      const repo = createAutomationLocksRepository(db);
      await repo.insertIfAbsent(HOLDER_A, {
        taskId: "task-renew-takeover",
        now: "2026-08-01T09:00:00.000Z",
        expiresAt: "2026-08-01T09:59:59.000Z",
      });

      // The holder heartbeats just before the TTL lapses.
      const renewed = await renewLock(db, { taskId: "task-renew-takeover", userId: "user-a", nowMs: T0_MS });
      expect(renewed.kind).toBe("renewed");
      if (renewed.kind !== "renewed") return;
      expect(renewed.lock.expires_at).toBe(new Date(T0_MS + LOCK_TTL_MS).toISOString());

      // B's acquire sees a live lock; the takeover CAS itself is a no-op.
      const attempt = await acquireOrRenewLock(db, { taskId: "task-renew-takeover", holder: HOLDER_B, nowMs: T0_MS });
      expect(attempt.kind).toBe("locked");
      if (attempt.kind !== "locked") return;
      expect(attempt.lock.holder_user_id).toBe("user-a");

      await repo.takeoverExpired(HOLDER_B, {
        taskId: "task-renew-takeover",
        now: new Date(T0_MS + 60_000).toISOString(),
        expiresAt: new Date(T0_MS + LOCK_TTL_MS + 60_000).toISOString(),
      });
      await expect(repo.getByTaskId("task-renew-takeover")).resolves.toMatchObject({
        holder_user_id: "user-a",
        expires_at: new Date(T0_MS + LOCK_TTL_MS).toISOString(),
      });
    });

    it("approving a pending steal re-arms a lock whose TTL lapsed before the response (steal-approve vs expiry)", async () => {
      const repo = createAutomationLocksRepository(db);
      await repo.insertIfAbsent(HOLDER_A, {
        taskId: "task-approve-expired",
        now: "2026-08-01T09:00:00.000Z",
        expiresAt: "2026-08-01T09:59:59.000Z",
      });
      await repo.requestSteal(HOLDER_B, {
        taskId: "task-approve-expired",
        stealRequestedAt: "2026-08-01T09:30:00.000Z",
        stealExpiresAt: "2026-08-01T10:05:00.000Z",
      });

      // Nobody took over the lapsed lock and the steal is still pending, so
      // the approve CAS hands over with a fresh TTL for the new holder.
      const result = await approveSteal(db, { taskId: "task-approve-expired", approverUserId: "user-a", nowMs: T0_MS });
      expect(result.kind).toBe("approved");
      if (result.kind !== "approved") return;
      expect(result.lock).toMatchObject({
        holder_user_id: "user-b",
        expires_at: new Date(T0_MS + LOCK_TTL_MS).toISOString(),
        steal_requester_user_id: null,
      });
    });

    it("a late approve loses to an expired-lock takeover (steal vs expiry-takeover interleave)", async () => {
      const repo = createAutomationLocksRepository(db);
      await repo.insertIfAbsent(HOLDER_A, {
        taskId: "task-approve-takeover",
        now: "2026-08-01T09:00:00.000Z",
        expiresAt: "2026-08-01T09:59:59.000Z",
      });
      await repo.requestSteal(HOLDER_B, {
        taskId: "task-approve-takeover",
        stealRequestedAt: "2026-08-01T09:30:00.000Z",
        stealExpiresAt: "2026-08-01T09:35:00.000Z",
      });

      // A third editor's acquire takes over the expired lock and clears the steal.
      const takeover = await acquireOrRenewLock(db, {
        taskId: "task-approve-takeover",
        holder: { userId: "user-c", platform: "web", surface: "builder", conversationId: null },
        nowMs: T0_MS,
      });
      expect(takeover.kind).toBe("held");

      // The old holder's late approve cannot promote a cleared steal.
      const approved = await approveSteal(db, {
        taskId: "task-approve-takeover",
        approverUserId: "user-a",
        nowMs: T0_MS,
      });
      expect(approved.kind).toBe("not_holder");
      await expect(repo.getByTaskId("task-approve-takeover")).resolves.toMatchObject({
        holder_user_id: "user-c",
        steal_requester_user_id: null,
      });
    });

    it("approving a steal on a swept expired lock row reports not_found", async () => {
      const repo = createAutomationLocksRepository(db);
      await repo.insertIfAbsent(HOLDER_A, {
        taskId: "task-approve-swept",
        now: "2026-08-01T09:00:00.000Z",
        expiresAt: "2026-08-01T09:59:59.000Z",
      });
      await repo.requestSteal(HOLDER_B, {
        taskId: "task-approve-swept",
        stealRequestedAt: "2026-08-01T09:30:00.000Z",
        stealExpiresAt: "2026-08-01T09:35:00.000Z",
      });
      await repo.sweepExpired("2026-08-01T10:00:00.000Z");

      await expect(
        approveSteal(db, { taskId: "task-approve-swept", approverUserId: "user-a", nowMs: T0_MS }),
      ).resolves.toEqual({ kind: "not_found" });
    });
  });

  describe("assertEditableBy", () => {
    it("allows edits with no lock, an expired lock, the holder, or no identity", async () => {
      await expect(assertEditableBy(db, "task-1", "user-a")).resolves.toEqual({ kind: "editable" });

      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });
      await expect(assertEditableBy(db, "task-1", "user-a")).resolves.toEqual({ kind: "editable" });

      await db
        .updateTable("automation_task_locks")
        .set({ expires_at: "2026-08-01T09:59:59.000Z" })
        .where("task_id", "=", "task-1")
        .execute();
      await expect(assertEditableBy(db, "task-1", "user-b")).resolves.toEqual({ kind: "editable" });
      await expect(assertEditableBy(db, "task-1", null)).resolves.toEqual({ kind: "editable" });
    });

    it("blocks a non-holder while the lock is unexpired", async () => {
      await acquireOrRenewLock(db, { taskId: "task-1", holder: HOLDER_A });

      const result = await assertEditableBy(db, "task-1", "user-b");

      expect(result.kind).toBe("locked");
      if (result.kind !== "locked") return;
      expect(result.lock.holder_user_id).toBe("user-a");
    });
  });

  describe("authorizeAuthoringLease", () => {
    it("distinguishes an unleased task, a conflicting session, and the exact fenced holder", async () => {
      await expect(
        authorizeAuthoringLease(db, {
          taskId: "task-authorization",
          userId: "user-b",
          sessionId: "tab-b",
          generation: 1,
        }),
      ).resolves.toEqual({ kind: "no_lease" });

      await acquireOrRenewLock(db, {
        taskId: "task-authorization",
        holder: { ...HOLDER_A, sessionId: "tab-a" },
      });

      await expect(
        authorizeAuthoringLease(db, {
          taskId: "task-authorization",
          userId: "user-b",
          sessionId: "tab-b",
          generation: 1,
        }),
      ).resolves.toMatchObject({ kind: "conflict", lock: { holder_session_id: "tab-a", generation: 1 } });

      await expect(
        authorizeAuthoringLease(db, {
          taskId: "task-authorization",
          userId: "user-a",
          sessionId: "tab-a",
          generation: 1,
        }),
      ).resolves.toMatchObject({ kind: "held", lock: { holder_session_id: "tab-a", generation: 1 } });

      await expect(
        authorizeAuthoringLease(db, {
          taskId: "task-authorization",
          userId: "user-a",
          sessionId: "tab-b",
          generation: 1,
        }),
      ).resolves.toMatchObject({ kind: "held", lock: { generation: 1 } });

      await expect(
        authorizeAuthoringLease(db, {
          taskId: "task-authorization",
          userId: "user-a",
          sessionId: "tab-a",
          generation: 0,
        }),
      ).resolves.toMatchObject({ kind: "stale", lock: { holder_session_id: "tab-a", generation: 1 } });
    });
  });

  describe("sweeper", () => {
    it("deletes expired lock rows and clears expired steals on its interval", async () => {
      const repo = createAutomationLocksRepository(db);
      await repo.insertIfAbsent(HOLDER_A, {
        taskId: "task-expired",
        now: "2026-08-01T09:00:00.000Z",
        expiresAt: "2026-08-01T09:59:59.000Z",
      });
      await repo.insertIfAbsent(HOLDER_A, {
        taskId: "task-live",
        now: T0,
        expiresAt: new Date(T0_MS + LOCK_TTL_MS).toISOString(),
      });
      await repo.requestSteal(HOLDER_B, {
        taskId: "task-live",
        stealRequestedAt: "2026-08-01T09:50:00.000Z",
        stealExpiresAt: "2026-08-01T09:55:00.000Z",
      });

      const sweeper = new AutomationLockSweeper({ db, intervalMs: 60_000 });
      sweeper.start();
      await vi.advanceTimersByTimeAsync(60_000);
      sweeper.stop();

      await expect(repo.getByTaskId("task-expired")).resolves.toBeUndefined();
      await expect(repo.getByTaskId("task-live")).resolves.toMatchObject({
        holder_user_id: "user-a",
        steal_requester_user_id: null,
      });
    });

    it("leaves live locks and unexpired steals alone", async () => {
      const repo = createAutomationLocksRepository(db);
      await repo.insertIfAbsent(HOLDER_A, {
        taskId: "task-1",
        now: T0,
        expiresAt: new Date(T0_MS + LOCK_TTL_MS).toISOString(),
      });
      await repo.requestSteal(HOLDER_B, {
        taskId: "task-1",
        stealRequestedAt: T0,
        stealExpiresAt: new Date(T0_MS + STEAL_TTL_MS).toISOString(),
      });

      const sweeper = new AutomationLockSweeper({ db, intervalMs: 60_000 });
      sweeper.start();
      await vi.advanceTimersByTimeAsync(60_000);
      sweeper.stop();

      await expect(repo.getByTaskId("task-1")).resolves.toMatchObject({
        holder_user_id: "user-a",
        steal_requester_user_id: "user-b",
      });
    });
  });
});
