import type { Kysely, Selectable } from "kysely";
import { type GraphVerdictRow, createGraphVerdictRepository } from "../db/repositories/graph-verdicts";
import type { DB, EntitiesTable } from "../db/schema";
import type { CleanupAction, CleanupVerdict } from "./cleanup-adjudication";
import {
  type CleanupApplyEffect,
  type CleanupApplyPlanRow,
  type RollbackManifestEntry,
  type ValidPlannedRow,
  applyArchive,
  applyMerge,
  applyNest,
  planProjectCleanup,
} from "./cleanup-apply";
import { unmergeEntitiesInTransaction } from "./merge";
import { type VerdictFingerprintEvidence, fingerprintFor } from "./verdict-fingerprint";

export type GraphVerdictApplyErrorCode =
  | "NOT_FOUND"
  | "INVALID_VERDICT_STATE"
  | "STALE_VERDICT"
  | "PLAN_BLOCKED"
  | "PLAN_DRIFT"
  | "APPLY_CONFLICT"
  | "NOTHING_TO_REVERT";

export class GraphVerdictApplyError extends Error {
  constructor(
    public readonly code: GraphVerdictApplyErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GraphVerdictApplyError";
  }
}

export type GraphVerdictApplyResult = {
  verdictId: string;
  dryRun: boolean;
  status: "approved" | "awaiting_human" | "applied";
  ledgerRef: string | null;
  wouldChange: Record<string, number>;
  plan: CleanupApplyPlanRow;
};

export type GraphVerdictReversionResult = {
  verdictId: string;
  status: "reverted";
  ledgerRef: string;
};

type EntityRow = Selectable<EntitiesTable>;

function updatedCount(
  result: { numUpdatedRows?: bigint | number | string; numDeletedRows?: bigint | number | string } | undefined,
): number {
  return Number(result?.numUpdatedRows ?? result?.numDeletedRows ?? 0);
}

function parseEvidence(raw: string): VerdictFingerprintEvidence {
  try {
    const parsed = JSON.parse(raw) as { fileIds?: unknown; reviewIds?: unknown; notes?: unknown };
    return {
      fileIds: Array.isArray(parsed.fileIds)
        ? parsed.fileIds.filter((item): item is string => typeof item === "string")
        : [],
      reviewIds: Array.isArray(parsed.reviewIds)
        ? parsed.reviewIds.filter((item): item is string => typeof item === "string")
        : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return { fileIds: [], reviewIds: [], notes: [] };
  }
}

async function loadEntities(
  db: Kysely<DB>,
  verdict: GraphVerdictRow,
): Promise<{ subject: EntityRow | null; target: EntityRow | null }> {
  const ids = [
    ...new Set([verdict.subject_entity_id, verdict.target_entity_id].filter((id): id is string => Boolean(id))),
  ];
  if (ids.length === 0) return { subject: null, target: null };
  const rows = await db.selectFrom("entities").selectAll().where("id", "in", ids).execute();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    subject: byId.get(verdict.subject_entity_id) ?? null,
    target: verdict.target_entity_id ? (byId.get(verdict.target_entity_id) ?? null) : null,
  };
}

function toCleanupVerdict(verdict: GraphVerdictRow): CleanupVerdict {
  return {
    entityId: verdict.subject_entity_id,
    name: verdict.subject_name ?? verdict.subject_entity_id,
    action: verdict.action as CleanupAction,
    targetEntityId: verdict.target_entity_id,
    targetName: verdict.target_name,
    reason: verdict.reason,
    evidence: parseEvidence(verdict.evidence_json).notes ?? [],
    mechanical: false,
    approved: true,
    validation: "ok",
    validationReason: null,
  };
}

async function verifiedPlan(db: Kysely<DB>, verdict: GraphVerdictRow): Promise<CleanupApplyPlanRow> {
  const { subject, target } = await loadEntities(db, verdict);
  const fingerprint = fingerprintFor({
    action: verdict.action,
    subject,
    target,
    evidence: parseEvidence(verdict.evidence_json),
  });
  if (fingerprint !== verdict.evidence_fingerprint) {
    throw new GraphVerdictApplyError("STALE_VERDICT", "Evidence changed since proposal", { verdictId: verdict.id });
  }
  const rows = await planProjectCleanup(db, [toCleanupVerdict(verdict)]);
  const plan = rows[0];
  if (!plan) throw new GraphVerdictApplyError("PLAN_BLOCKED", "Planner returned no row", { verdictId: verdict.id });
  if (plan.state !== "applied") {
    throw new GraphVerdictApplyError("PLAN_BLOCKED", plan.reason ?? "plan_not_applied", {
      verdictId: verdict.id,
      reason: plan.reason,
    });
  }
  if (plan.resolvedTargetEntityId !== verdict.resolved_target_entity_id) {
    throw new GraphVerdictApplyError("PLAN_DRIFT", "Resolved target changed since proposal", {
      verdictId: verdict.id,
      reason: "plan_drift",
    });
  }
  return plan;
}

function ledgerRefForEffect(effect: CleanupApplyEffect): string {
  if (effect.action === "merge_into") {
    if (!effect.mergeGroupId) throw new GraphVerdictApplyError("APPLY_CONFLICT", "Merge ledger group missing");
    return `merge-group:${effect.mergeGroupId}`;
  }
  if (effect.action === "nest_under") {
    if ("existing" in effect) return "noop:existing";
    return `relationship:${effect.relationshipId}`;
  }
  return `archived-at:${effect.archivedAt}`;
}

async function applyPlannedRow(
  db: Kysely<DB>,
  verdict: GraphVerdictRow,
  plan: ValidPlannedRow,
  actorUserId: string,
): Promise<string> {
  const mutations: RollbackManifestEntry[] = [];
  if (plan.action === "keep") return "keep";
  if (plan.action === "merge_into") {
    const groupId = `graph-verdict:${verdict.id}`;
    return ledgerRefForEffect(await applyMerge(db, plan, mutations, { mergeGroupId: groupId, userId: actorUserId }));
  }
  if (plan.action === "nest_under") return ledgerRefForEffect(await applyNest(db, plan, mutations));
  return ledgerRefForEffect(await applyArchive(db, plan, mutations));
}

function appliedResult(verdict: GraphVerdictRow, plan: CleanupApplyPlanRow): GraphVerdictApplyResult {
  return {
    verdictId: verdict.id,
    dryRun: false,
    status: "applied",
    ledgerRef: verdict.applied_ledger_ref,
    wouldChange: plan.wouldChange,
    plan,
  };
}

function storedWouldChange(verdict: GraphVerdictRow): Record<string, number> {
  if (!verdict.would_change_json) return {};
  try {
    const parsed = JSON.parse(verdict.would_change_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

async function loadAppliedResult(db: Kysely<DB>, verdictId: string): Promise<GraphVerdictApplyResult | null> {
  const verdict = await createGraphVerdictRepository(db).findById(verdictId);
  if (!verdict || verdict.status !== "applied") return null;
  return appliedResult(verdict, {
    entityId: verdict.subject_entity_id,
    name: verdict.subject_name ?? verdict.subject_entity_id,
    action: verdict.action as CleanupAction,
    state: "applied",
    targetEntityId: verdict.target_entity_id,
    resolvedTargetEntityId: verdict.resolved_target_entity_id,
    reason: null,
    wouldChange: storedWouldChange(verdict),
  });
}

export async function applyGraphVerdict(
  db: Kysely<DB>,
  input: { verdictId: string; actorUserId: string; dryRun?: boolean },
): Promise<GraphVerdictApplyResult> {
  const repo = createGraphVerdictRepository(db);
  const existing = await repo.findById(input.verdictId);
  if (!existing) {
    throw new GraphVerdictApplyError("NOT_FOUND", "Graph verdict not found", { verdictId: input.verdictId });
  }
  if (existing.status === "applied" && !input.dryRun) {
    const applied = await loadAppliedResult(db, input.verdictId);
    if (applied) return applied;
  }
  if (existing.status !== "approved" && !(input.dryRun && existing.status === "awaiting_human")) {
    throw new GraphVerdictApplyError("INVALID_VERDICT_STATE", "Graph verdict is not applicable", {
      verdictId: input.verdictId,
      status: existing.status,
    });
  }

  try {
    return await db.transaction().execute(async (trx) => {
      const txRepo = createGraphVerdictRepository(trx);
      const verdict = await txRepo.findById(input.verdictId);
      if (!verdict) {
        throw new GraphVerdictApplyError("NOT_FOUND", "Graph verdict not found", { verdictId: input.verdictId });
      }
      if (verdict.status !== "approved" && !(input.dryRun && verdict.status === "awaiting_human")) {
        throw new GraphVerdictApplyError("INVALID_VERDICT_STATE", "Graph verdict is not applicable", {
          verdictId: input.verdictId,
          status: verdict.status,
        });
      }
      const plan = await verifiedPlan(trx, verdict);
      if (input.dryRun) {
        return {
          verdictId: verdict.id,
          dryRun: true,
          status: verdict.status as "approved" | "awaiting_human",
          ledgerRef: verdict.applied_ledger_ref,
          wouldChange: plan.wouldChange,
          plan,
        };
      }
      const claimed = await txRepo.markApplied({ id: verdict.id, ledgerRef: null });
      if (!claimed) {
        throw new GraphVerdictApplyError("APPLY_CONFLICT", "Graph verdict apply claim lost", { verdictId: verdict.id });
      }
      const ledgerRef = await applyPlannedRow(trx, verdict, plan as ValidPlannedRow, input.actorUserId);
      await txRepo.setAppliedLedgerRef({ id: verdict.id, ledgerRef });
      return appliedResult({ ...verdict, status: "applied", applied_ledger_ref: ledgerRef }, plan);
    });
  } catch (err) {
    if (err instanceof GraphVerdictApplyError && err.code === "APPLY_CONFLICT") {
      const applied = await loadAppliedResult(db, input.verdictId);
      if (applied) return applied;
    }
    throw err;
  }
}

function parseLedgerRef(
  ref: string,
):
  | { kind: "merge"; groupId: string }
  | { kind: "relationship"; id: string }
  | { kind: "archive"; at: string }
  | { kind: "existing" }
  | { kind: "keep" } {
  if (ref.startsWith("merge-group:")) return { kind: "merge", groupId: ref.slice("merge-group:".length) };
  if (ref.startsWith("relationship:")) return { kind: "relationship", id: ref.slice("relationship:".length) };
  if (ref.startsWith("archived-at:")) return { kind: "archive", at: ref.slice("archived-at:".length) };
  if (ref === "noop:existing") return { kind: "existing" };
  if (ref === "keep") return { kind: "keep" };
  throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Unknown graph verdict ledger ref");
}

export async function revertGraphVerdict(
  db: Kysely<DB>,
  input: { verdictId: string; actorUserId: string },
): Promise<GraphVerdictReversionResult> {
  const row = await createGraphVerdictRepository(db).findById(input.verdictId);
  if (!row) {
    throw new GraphVerdictApplyError("NOT_FOUND", "Graph verdict not found", { verdictId: input.verdictId });
  }
  if (row.status !== "applied" || !row.applied_ledger_ref) {
    throw new GraphVerdictApplyError("INVALID_VERDICT_STATE", "Graph verdict is not revertible", {
      verdictId: input.verdictId,
      status: row.status,
    });
  }
  const appliedLedgerRef = row.applied_ledger_ref;
  const ledger = parseLedgerRef(appliedLedgerRef);
  return db.transaction().execute(async (trx) => {
    const repo = createGraphVerdictRepository(trx);
    const won = await repo.markReverted({ id: row.id });
    if (!won) {
      throw new GraphVerdictApplyError("APPLY_CONFLICT", "Graph verdict reversion claim lost", { verdictId: row.id });
    }
    if (ledger.kind === "merge") {
      const merge = await trx
        .selectFrom("entity_merges")
        .select("id")
        .where("group_id", "=", ledger.groupId)
        .where("unmerged_at", "is", null)
        .executeTakeFirst();
      if (!merge) throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Merge ledger row is not active");
      await unmergeEntitiesInTransaction(trx, { mergeId: merge.id, userId: input.actorUserId });
    } else if (ledger.kind === "relationship") {
      const result = await trx.deleteFrom("entity_relationships").where("id", "=", ledger.id).executeTakeFirst();
      if (updatedCount(result) !== 1) {
        throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Relationship row is already gone");
      }
    } else if (ledger.kind === "archive") {
      const result = await trx
        .updateTable("entities")
        .set({ deleted_at: null, updated_at: new Date().toISOString() })
        .where("id", "=", row.subject_entity_id)
        .where("deleted_at", "=", ledger.at)
        .where("merged_into_entity_id", "is", null)
        .executeTakeFirst();
      if (updatedCount(result) !== 1) {
        throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "Archive row no longer matches ledger");
      }
    } else {
      throw new GraphVerdictApplyError("NOTHING_TO_REVERT", "This verdict did not create a reversible graph row");
    }
    return { verdictId: row.id, status: "reverted", ledgerRef: appliedLedgerRef };
  });
}
