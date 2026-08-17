/**
 * Pessimistic whole-automation edit lock state machine.
 *
 * One lock row per automation (task_id primary key). A lock is held by one
 * user session at a time; another user can request a steal, which the holder
 * can approve (handing over the lock) or deny. Every transition is a guarded
 * SQL statement (the WHERE clause is the compare-and-swap condition) followed
 * by a read-back verification — affected-row counts are never trusted because
 * their semantics differ between SQLite and Postgres. The generation fences
 * stale renewals and releases after an expiry takeover or approved handover.
 *
 * Timestamps are app-generated ISO-8601 UTC strings and all expiry comparisons
 * happen in application code (lexicographic string comparison), so there is no
 * reliance on client clocks or dialect date functions. Lazy expiry on access
 * (assertEditableBy / acquire / steal) is the correctness mechanism; the
 * AutomationLockSweeper only provides hygiene for stale rows.
 */
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import {
  type AutomationTaskLockRow,
  LEGACY_LOCK_SESSION_ID,
  type LockHolderFields,
} from "../db/repositories/automation-locks";
import { createAutomationLocksRepository } from "../db/repositories/automation-locks";
import type { DB } from "../db/schema";

/** How long a lock stays valid after acquire or the last renewal. */
export const LOCK_TTL_MS = 15 * 60 * 1000;
/** Cadence clients should renew at (heartbeat) — well inside the lock TTL. */
export const LOCK_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;
/** How long a pending steal request stays valid before expiring. */
export const STEAL_TTL_MS = 5 * 60 * 1000;
/** Interval of the stale-row hygiene sweeper. */
export const LOCK_SWEEP_INTERVAL_MS = 60 * 1000;

export type { AutomationTaskLockRow, LockHolderFields };

export type AcquireResult =
  | { kind: "held"; lock: AutomationTaskLockRow }
  | { kind: "locked"; lock: AutomationTaskLockRow };

export type RenewResult =
  | { kind: "renewed"; lock: AutomationTaskLockRow }
  | { kind: "not_found" }
  | { kind: "not_holder" };

export type StealResult =
  | { kind: "pending"; lock: AutomationTaskLockRow }
  | { kind: "locked"; lock: AutomationTaskLockRow }
  | { kind: "not_locked" };

export type StealResponseResult =
  | { kind: "approved"; lock: AutomationTaskLockRow }
  | { kind: "denied"; lock: AutomationTaskLockRow }
  | { kind: "not_found" }
  | { kind: "not_holder" }
  | { kind: "no_pending_steal" };

export type EditableCheck = { kind: "editable" } | { kind: "locked"; lock: AutomationTaskLockRow };

/**
 * Result of checking the caller's exact authoring lease. The distinction
 * between an absent row, an expired row, a live conflict, and a stale fence is
 * part of the HTTP contract: callers must not collapse every failure into a
 * generic lock message.
 */
export type AuthoringLeaseAuthorization =
  | { kind: "no_lease" }
  | { kind: "held"; lock: AutomationTaskLockRow }
  | { kind: "conflict"; lock: AutomationTaskLockRow }
  | { kind: "stale"; lock: AutomationTaskLockRow }
  | { kind: "expired"; lock: AutomationTaskLockRow };

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/**
 * Checks an authoring lease. An exact live lease is touched with a guarded
 * update so a caller transaction can hold the row lock while it persists a
 * mutation. A live lease is authoritative only when the authenticated user,
 * client session, and generation all match. The caller may use `no_lease` or
 * `expired` to apply an operation's policy; neither result grants authority to
 * a browser save by itself.
 */
export async function authorizeAuthoringLease(
  db: Kysely<DB>,
  params: {
    taskId: string;
    userId: string | null;
    sessionId?: string;
    generation?: number;
    nowMs?: number;
  },
): Promise<AuthoringLeaseAuthorization> {
  const repo = createAutomationLocksRepository(db);
  const nowMs = params.nowMs ?? Date.now();
  const now = iso(nowMs);
  if (params.userId && params.sessionId && params.generation !== undefined) {
    const held = await repo.touchIfExactHolder({
      taskId: params.taskId,
      userId: params.userId,
      sessionId: params.sessionId,
      generation: params.generation,
      now,
    });
    if (held) return { kind: "held", lock: held };
  }

  const row = await repo.getByTaskId(params.taskId);
  if (!row) return { kind: "no_lease" };

  if (row.expires_at <= now) return { kind: "expired", lock: row };

  if (params.generation !== undefined && row.generation !== params.generation) {
    return { kind: "stale", lock: row };
  }
  if (row.holder_user_id !== params.userId || row.holder_session_id !== params.sessionId) {
    return { kind: "conflict", lock: row };
  }
  if (params.generation === undefined) return { kind: "stale", lock: row };
  return { kind: "held", lock: row };
}

async function requireRow(db: Kysely<DB>, taskId: string): Promise<AutomationTaskLockRow> {
  const row = await createAutomationLocksRepository(db).getByTaskId(taskId);
  if (!row) throw new Error(`Automation lock row for task ${taskId} disappeared mid-transaction`);
  return row;
}

/**
 * Acquire-or-renew. Inserts with ON CONFLICT DO NOTHING (safe when free),
 * takes over the row when the current holder's lock is expired, renews when
 * the caller already holds it, and reports the current holder otherwise.
 */
export async function acquireOrRenewLock(
  db: Kysely<DB>,
  params: { taskId: string; holder: LockHolderFields; nowMs?: number },
): Promise<AcquireResult> {
  const nowMs = params.nowMs ?? Date.now();
  const repo = createAutomationLocksRepository(db);
  const now = iso(nowMs);
  const expiresAt = iso(nowMs + LOCK_TTL_MS);

  await repo.insertIfAbsent(params.holder, { taskId: params.taskId, expiresAt, now });
  let row = await repo.getByTaskId(params.taskId);
  if (!row) {
    // Defensive retry for a concurrent insert that aborted between our
    // no-op conflict and the read-back. One retry is enough: after a second
    // no-op the winning row is guaranteed visible.
    await repo.insertIfAbsent(params.holder, { taskId: params.taskId, expiresAt, now });
    row = await requireRow(db, params.taskId);
  }

  if (row.expires_at <= now) {
    await repo.takeoverExpired(params.holder, { taskId: params.taskId, expiresAt, now });
    const taken = await requireRow(db, params.taskId);
    if (
      taken.holder_user_id !== params.holder.userId ||
      taken.holder_session_id !== (params.holder.sessionId ?? LEGACY_LOCK_SESSION_ID)
    ) {
      return { kind: "locked", lock: taken };
    }
    return { kind: "held", lock: taken };
  }

  if (
    row.holder_user_id === params.holder.userId &&
    row.holder_session_id === (params.holder.sessionId ?? LEGACY_LOCK_SESSION_ID)
  ) {
    await repo.renew({
      taskId: params.taskId,
      userId: params.holder.userId,
      sessionId: params.holder.sessionId,
      generation: row.generation,
      expiresAt,
      now,
    });
    const renewed = await requireRow(db, params.taskId);
    if (
      renewed.holder_user_id !== params.holder.userId ||
      renewed.holder_session_id !== (params.holder.sessionId ?? LEGACY_LOCK_SESSION_ID) ||
      renewed.generation !== row.generation ||
      renewed.expires_at <= now
    ) {
      return { kind: "locked", lock: renewed };
    }
    return { kind: "held", lock: renewed };
  }

  return { kind: "locked", lock: row };
}

/** Holder-scoped renewal; expires_at advances to now + LOCK_TTL_MS. */
export async function renewLock(
  db: Kysely<DB>,
  params: { taskId: string; userId: string; sessionId?: string; generation?: number; nowMs?: number },
): Promise<RenewResult> {
  const nowMs = params.nowMs ?? Date.now();
  const repo = createAutomationLocksRepository(db);
  await repo.renew({
    taskId: params.taskId,
    userId: params.userId,
    sessionId: params.sessionId,
    generation: params.generation,
    expiresAt: iso(nowMs + LOCK_TTL_MS),
    now: iso(nowMs),
  });
  const row = await repo.getByTaskId(params.taskId);
  if (!row) return { kind: "not_found" };
  if (
    row.holder_user_id !== params.userId ||
    row.holder_session_id !== (params.sessionId ?? LEGACY_LOCK_SESSION_ID) ||
    row.generation !== (params.generation ?? 1)
  ) {
    return { kind: "not_holder" };
  }
  return { kind: "renewed", lock: row };
}

/** Holder-scoped release; idempotent — a non-holder release is a no-op. */
export async function releaseLock(
  db: Kysely<DB>,
  params: { taskId: string; userId: string; sessionId?: string; generation?: number },
): Promise<{ kind: "released" }> {
  await createAutomationLocksRepository(db).release({
    taskId: params.taskId,
    userId: params.userId,
    sessionId: params.sessionId,
    generation: params.generation,
  });
  return { kind: "released" };
}

/**
 * Steal request. Only succeeds when the lock is held by someone else,
 * unexpired, and no steal is pending (CAS on NULL). Re-requesting by the same
 * requester while the steal is still pending is idempotent.
 */
export async function requestSteal(
  db: Kysely<DB>,
  params: { taskId: string; requester: LockHolderFields; nowMs?: number },
): Promise<StealResult> {
  const nowMs = params.nowMs ?? Date.now();
  const repo = createAutomationLocksRepository(db);
  const now = iso(nowMs);
  const row = await repo.getByTaskId(params.taskId);
  if (!row) return { kind: "not_locked" };
  if (row.expires_at <= now) return { kind: "not_locked" };
  if (
    row.holder_user_id === params.requester.userId &&
    row.holder_session_id === (params.requester.sessionId ?? LEGACY_LOCK_SESSION_ID)
  ) {
    return { kind: "not_locked" };
  }

  if (row.steal_requester_user_id !== null) {
    const pendingUnexpired =
      row.steal_requester_user_id === params.requester.userId &&
      row.steal_requester_session_id === (params.requester.sessionId ?? LEGACY_LOCK_SESSION_ID) &&
      row.steal_expires_at !== null &&
      row.steal_expires_at > now;
    if (pendingUnexpired) return { kind: "pending", lock: row };
    if (row.steal_expires_at !== null && row.steal_expires_at <= now) {
      // Expired pending steal — clear it so the CAS below can proceed.
      await repo.clearSteal({
        taskId: params.taskId,
        holderUserId: row.holder_user_id,
        holderSessionId: row.holder_session_id,
        holderGeneration: row.generation,
        now,
      });
    } else {
      return { kind: "locked", lock: row };
    }
  }

  const stealRequestedAt = iso(nowMs);
  await repo.requestSteal(params.requester, {
    taskId: params.taskId,
    stealRequestedAt,
    stealExpiresAt: iso(nowMs + STEAL_TTL_MS),
  });
  const after = await repo.getByTaskId(params.taskId);
  if (!after) return { kind: "not_locked" };
  if (
    after.steal_requester_user_id === params.requester.userId &&
    after.steal_requester_session_id === (params.requester.sessionId ?? LEGACY_LOCK_SESSION_ID)
  ) {
    return { kind: "pending", lock: after };
  }
  if (after.expires_at <= now || after.holder_user_id === params.requester.userId) {
    return { kind: "not_locked" };
  }
  return { kind: "locked", lock: after };
}

/**
 * Holder approves the pending steal: the requester becomes the holder with a
 * fresh TTL and the steal fields are cleared. An expired pending steal is
 * cleared instead of approved.
 */
export async function approveSteal(
  db: Kysely<DB>,
  params: {
    taskId: string;
    approverUserId: string;
    approverSessionId?: string;
    approverGeneration?: number;
    nowMs?: number;
  },
): Promise<StealResponseResult> {
  const nowMs = params.nowMs ?? Date.now();
  const repo = createAutomationLocksRepository(db);
  const now = iso(nowMs);
  const row = await repo.getByTaskId(params.taskId);
  if (!row) return { kind: "not_found" };
  if (
    row.holder_user_id !== params.approverUserId ||
    row.holder_session_id !== (params.approverSessionId ?? LEGACY_LOCK_SESSION_ID) ||
    row.generation !== (params.approverGeneration ?? 1)
  ) {
    return { kind: "not_holder" };
  }
  if (row.steal_requester_user_id === null) return { kind: "no_pending_steal" };
  if (row.steal_expires_at === null || row.steal_expires_at <= now) {
    await repo.clearSteal({
      taskId: params.taskId,
      holderUserId: params.approverUserId,
      holderSessionId: row.holder_session_id,
      holderGeneration: row.generation,
      now,
    });
    return { kind: "no_pending_steal" };
  }

  const requesterUserId = row.steal_requester_user_id;
  await repo.approveSteal({
    taskId: params.taskId,
    approverUserId: params.approverUserId,
    approverSessionId: row.holder_session_id,
    approverGeneration: row.generation,
    expiresAt: iso(nowMs + LOCK_TTL_MS),
    now,
  });
  const after = await requireRow(db, params.taskId);
  if (after.holder_user_id === requesterUserId && after.generation === row.generation + 1) {
    return { kind: "approved", lock: after };
  }
  return { kind: "no_pending_steal" };
}

/** Holder denies the pending steal (holder-scoped clear). */
export async function denySteal(
  db: Kysely<DB>,
  params: {
    taskId: string;
    holderUserId: string;
    holderSessionId?: string;
    holderGeneration?: number;
    nowMs?: number;
  },
): Promise<StealResponseResult> {
  const nowMs = params.nowMs ?? Date.now();
  const repo = createAutomationLocksRepository(db);
  const row = await repo.getByTaskId(params.taskId);
  if (!row) return { kind: "not_found" };
  if (
    row.holder_user_id !== params.holderUserId ||
    row.holder_session_id !== (params.holderSessionId ?? LEGACY_LOCK_SESSION_ID) ||
    row.generation !== (params.holderGeneration ?? 1)
  ) {
    return { kind: "not_holder" };
  }
  if (row.steal_requester_user_id === null) return { kind: "no_pending_steal" };

  await repo.clearSteal({
    taskId: params.taskId,
    holderUserId: params.holderUserId,
    holderSessionId: row.holder_session_id,
    holderGeneration: row.generation,
    now: iso(nowMs),
  });
  const after = await requireRow(db, params.taskId);
  if (after.steal_requester_user_id !== null) return { kind: "no_pending_steal" };
  return { kind: "denied", lock: after };
}

/**
 * Edit-access gate for persistence mutations. Editable when there is no lock
 * row, the row is expired (lazy expiry), or the caller is the holder.
 */
export async function assertEditableBy(
  db: Kysely<DB>,
  taskId: string,
  userId: string | null,
  nowMs?: number,
  lease?: { sessionId?: string; generation?: number },
): Promise<EditableCheck> {
  if (!userId) return { kind: "editable" };
  const row = await createAutomationLocksRepository(db).getByTaskId(taskId);
  if (!row) return { kind: "editable" };
  const now = iso(nowMs ?? Date.now());
  if (row.expires_at <= now) return { kind: "editable" };
  if (
    row.holder_user_id === userId &&
    row.holder_session_id === (lease?.sessionId ?? LEGACY_LOCK_SESSION_ID) &&
    row.generation === (lease?.generation ?? 1)
  ) {
    return { kind: "editable" };
  }
  return { kind: "locked", lock: row };
}

/**
 * 60s hygiene sweeper for stale lock rows and expired pending steals
 * (webhook-delivery-sweeper precedent). Correctness relies on lazy expiry at
 * access time, so this only prevents stale-row accumulation.
 */
export class AutomationLockSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      logger?: Logger;
      intervalMs?: number;
      nowMs?: () => number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.active) return;
      const sweep = this.sweep()
        .then(() => undefined)
        .catch((error) => {
          this.deps.logger?.warn({ err: error }, "Automation lock sweep failed");
        });
      this.active = sweep;
      void sweep.finally(() => {
        if (this.active === sweep) this.active = null;
      });
    }, this.deps.intervalMs ?? LOCK_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<{ deletedLocks: number; clearedSteals: number }> {
    const nowMs = (this.deps.nowMs ?? Date.now)();
    return createAutomationLocksRepository(this.deps.db).sweepExpired(iso(nowMs));
  }
}
