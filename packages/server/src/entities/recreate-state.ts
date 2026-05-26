/**
 * In-process recreate lock with three states:
 *   idle    — nothing happening
 *   pending — step 1 of the two-step rebuild has finished; the caller has a
 *             pendingRebuildId they can present to step 2 within the TTL.
 *             Sync and enrichment treat pending as "do not start" so nothing
 *             slips in between the destructive step and the generative step.
 *   active  — recreate is currently executing.
 *
 * `isRecreateActive()` returns true for both pending and active because every
 * legacy caller (sync gate, job-status response) wants "something is holding
 * the recreate lane." Route handlers that need to distinguish a promotable
 * caller from a generic conflict use `getPendingRebuild()` directly.
 */

interface PendingState {
  kind: "pending";
  pendingRebuildId: string;
  expiresAt: number;
  createdAt: number;
}

type LockState = { kind: "idle" } | PendingState | { kind: "active" };

let state: LockState = { kind: "idle" };

function tickExpiry(): void {
  if (state.kind === "pending" && state.expiresAt <= Date.now()) {
    state = { kind: "idle" };
  }
}

export function isRecreateActive(): boolean {
  tickExpiry();
  return state.kind !== "idle";
}

export function isRecreatePending(): boolean {
  tickExpiry();
  return state.kind === "pending";
}

export function getPendingRebuild(): { pendingRebuildId: string; expiresAt: number; createdAt: number } | null {
  tickExpiry();
  if (state.kind !== "pending") return null;
  return {
    pendingRebuildId: state.pendingRebuildId,
    expiresAt: state.expiresAt,
    createdAt: state.createdAt,
  };
}

export function beginRecreateLock(): void {
  tickExpiry();
  if (state.kind !== "idle") {
    throw new Error("ENTITY_RECREATE_ACTIVE");
  }
  state = { kind: "active" };
}

export function endRecreateLock(): void {
  state = { kind: "idle" };
}

export async function withRecreateLock<T>(fn: () => Promise<T>): Promise<T> {
  beginRecreateLock();
  try {
    return await fn();
  } finally {
    endRecreateLock();
  }
}

const DEFAULT_PENDING_TTL_MS = 15 * 60 * 1000;

export function beginPendingRebuild(opts: { ttlMs?: number; pendingRebuildId: string }): {
  pendingRebuildId: string;
  expiresAt: number;
} {
  tickExpiry();
  if (state.kind !== "idle") {
    throw new Error("ENTITY_RECREATE_ACTIVE");
  }
  const ttl = opts.ttlMs ?? DEFAULT_PENDING_TTL_MS;
  const createdAt = Date.now();
  const expiresAt = createdAt + ttl;
  state = {
    kind: "pending",
    pendingRebuildId: opts.pendingRebuildId,
    expiresAt,
    createdAt,
  };
  return { pendingRebuildId: opts.pendingRebuildId, expiresAt };
}

export type PromoteResult = "promoted" | "not_found" | "expired" | "active";

/**
 * Move from pending → active. Returns "promoted" on success; the caller is
 * responsible for endRecreateLock() when the long-running step finishes.
 *
 * "not_found" covers both "no pending lock" and "id mismatch" — the route
 * surface treats them the same (409). "expired" means a pending lock did
 * exist for this id but the TTL elapsed; "active" means someone else
 * already promoted (or began a fresh) lock.
 */
export function promotePendingRebuild(pendingRebuildId: string): PromoteResult {
  if (state.kind === "pending" && state.expiresAt <= Date.now()) {
    state = { kind: "idle" };
    return "expired";
  }
  if (state.kind === "active") return "active";
  if (state.kind === "idle") return "not_found";
  if (state.pendingRebuildId !== pendingRebuildId) return "not_found";
  state = { kind: "active" };
  return "promoted";
}

export type CancelResult = "released" | "not_found" | "expired" | "already_promoted";

export function cancelPendingRebuild(pendingRebuildId: string): CancelResult {
  if (state.kind === "pending" && state.expiresAt <= Date.now()) {
    state = { kind: "idle" };
    return "expired";
  }
  if (state.kind === "active") return "already_promoted";
  if (state.kind === "idle") return "not_found";
  if (state.pendingRebuildId !== pendingRebuildId) return "not_found";
  state = { kind: "idle" };
  return "released";
}

export function _resetForTests(): void {
  state = { kind: "idle" };
}
