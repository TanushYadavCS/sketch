import { randomUUID } from "node:crypto";
import type { Insertable, Kysely, Selectable } from "kysely";
import type { DB, GraphVerdictRunsTable, GraphVerdictsTable } from "../schema";

export type GraphVerdictRunRow = Selectable<GraphVerdictRunsTable>;
export type GraphVerdictRow = Selectable<GraphVerdictsTable>;
export type GraphVerdictStatus = "awaiting_human" | "bounced";
export type GraphVerdictValidationStatus = "ok" | "failed";

export interface CreateGraphVerdictRunInput {
  source: string;
  proposedByUserId: string;
  tokenId: string | null;
  note: string | null;
  verdictsProposed: number;
}

export interface StoreGraphVerdictInput {
  runId: string;
  action: string;
  subjectEntityId: string;
  subjectName: string | null;
  subjectEntityType: string | null;
  targetEntityId: string | null;
  targetName: string | null;
  reason: string;
  evidenceJson: string;
  evidenceFingerprint: string;
  validationStatus: GraphVerdictValidationStatus;
  validationReason: string | null;
  wouldChangeJson: string | null;
  status: GraphVerdictStatus;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("unique constraint") || message.includes("duplicate key");
}

function toInsert(input: StoreGraphVerdictInput, id: string, now: string): Insertable<GraphVerdictsTable> {
  return {
    id,
    run_id: input.runId,
    action: input.action,
    subject_entity_id: input.subjectEntityId,
    subject_name: input.subjectName,
    subject_entity_type: input.subjectEntityType,
    target_entity_id: input.targetEntityId,
    target_name: input.targetName,
    reason: input.reason,
    evidence_json: input.evidenceJson,
    evidence_fingerprint: input.evidenceFingerprint,
    validation_status: input.validationStatus,
    validation_reason: input.validationReason,
    would_change_json: input.wouldChangeJson,
    status: input.status,
    superseded_at: null,
    decided_at: null,
    decided_by_user_id: null,
    applied_ledger_ref: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Verdict rows deliberately keep their original entity ids through merges.
 * They are historical proposals about a specific graph state; PR3 apply detects
 * drift by recomputing the fingerprint instead of silently repointing pending
 * approvals to a different subject.
 */
export function createGraphVerdictRepository(db: Kysely<DB>) {
  return {
    async createRun(input: CreateGraphVerdictRunInput): Promise<{ id: string }> {
      const id = randomUUID();
      await db
        .insertInto("graph_verdict_runs")
        .values({
          id,
          source: input.source,
          proposed_by_user_id: input.proposedByUserId,
          token_id: input.tokenId,
          note: input.note,
          verdicts_proposed: input.verdictsProposed,
          verdicts_stored: 0,
          verdicts_bounced: 0,
        })
        .execute();
      return { id };
    },

    async storeVerdicts(verdicts: StoreGraphVerdictInput[]): Promise<{ ids: string[] }> {
      const now = new Date().toISOString();
      const ids = verdicts.map(() => randomUUID());
      const awaiting = verdicts.filter((verdict) => verdict.status === "awaiting_human");
      for (const verdict of awaiting) {
        await db
          .updateTable("graph_verdicts")
          .set({ superseded_at: now, updated_at: now })
          .where("subject_entity_id", "=", verdict.subjectEntityId)
          .where("action", "=", verdict.action)
          .where("status", "=", "awaiting_human")
          .where("superseded_at", "is", null)
          .execute();
      }
      if (verdicts.length > 0) {
        await db
          .insertInto("graph_verdicts")
          .values(verdicts.map((verdict, index) => toInsert(verdict, ids[index] ?? randomUUID(), now)))
          .execute();
        const runId = verdicts[0]?.runId;
        if (runId) {
          const bounced = verdicts.filter((verdict) => verdict.status === "bounced").length;
          await db
            .updateTable("graph_verdict_runs")
            .set({ verdicts_stored: awaiting.length, verdicts_bounced: bounced })
            .where("id", "=", runId)
            .execute();
        }
      }
      return { ids };
    },

    async listByRun(runId: string): Promise<GraphVerdictRow[]> {
      return db
        .selectFrom("graph_verdicts")
        .selectAll()
        .where("run_id", "=", runId)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();
    },

    async listAwaitingHuman(params?: { limit?: number; offset?: number }): Promise<GraphVerdictRow[]> {
      return db
        .selectFrom("graph_verdicts")
        .selectAll()
        .where("status", "=", "awaiting_human")
        .where("superseded_at", "is", null)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(params?.limit ?? 50)
        .offset(params?.offset ?? 0)
        .execute();
    },

    async findById(id: string): Promise<GraphVerdictRow | null> {
      const row = await db.selectFrom("graph_verdicts").selectAll().where("id", "=", id).executeTakeFirst();
      return row ?? null;
    },
  };
}

export async function withGraphVerdictUniqueRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === 1 || !isUniqueConstraintError(error)) throw error;
    }
  }
  throw new Error("Graph verdict unique retry exhausted.");
}

export type GraphVerdictRepository = ReturnType<typeof createGraphVerdictRepository>;
