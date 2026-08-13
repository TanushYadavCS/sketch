/**
 * Storage for project-minting cluster verdicts (PR-P2).
 *
 * A verdict is a proposal, never a write to the entity graph. Re-running a
 * cluster supersedes the previous pending row instead of mutating it, so the
 * history of what the model said as the cluster grew stays readable. "Pending"
 * means status = 'pending' AND superseded_at IS NULL.
 */
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import type { DB, ProjectMintingVerdictsTable } from "../schema";

export type ProjectMintingVerdictRow = Selectable<ProjectMintingVerdictsTable>;

export interface StorePendingVerdictInput {
  companyEntityId: string;
  companyName: string;
  fileCount: number;
  dossier: string;
  verdict: string;
  model: string;
  promptVersion: string;
  relationshipState?: string;
  flags?: string[];
  voteStats?: object;
}

export interface AcceptVerdictInput {
  id: string;
  actorUserId: string;
  struckProjects: string[];
  result: object;
}

export interface RejectVerdictInput {
  id: string;
  actorUserId: string;
}

function updatedCount(result: { numUpdatedRows?: bigint | number | string } | undefined): number {
  return Number(result?.numUpdatedRows ?? 0);
}

export function createProjectMintingVerdictRepository(db: Kysely<DB>) {
  return {
    async storePending(input: StorePendingVerdictInput): Promise<{ id: string }> {
      const now = new Date().toISOString();
      await db
        .updateTable("project_minting_verdicts")
        .set({ superseded_at: now, updated_at: now })
        .where("company_entity_id", "=", input.companyEntityId)
        .where("status", "=", "pending")
        .where("superseded_at", "is", null)
        .execute();
      const id = randomUUID();
      await db
        .insertInto("project_minting_verdicts")
        .values({
          id,
          company_entity_id: input.companyEntityId,
          company_name: input.companyName,
          file_count: input.fileCount,
          dossier: input.dossier,
          verdict: input.verdict,
          model: input.model,
          prompt_version: input.promptVersion,
          status: "pending",
          superseded_at: null,
          relationship_state: input.relationshipState ?? null,
          flags: input.flags && input.flags.length > 0 ? JSON.stringify(input.flags) : null,
          vote_stats: input.voteStats ? JSON.stringify(input.voteStats) : null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      return { id };
    },

    async listPending(): Promise<ProjectMintingVerdictRow[]> {
      return db
        .selectFrom("project_minting_verdicts")
        .selectAll()
        .where("status", "=", "pending")
        .where("superseded_at", "is", null)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();
    },

    async findById(id: string): Promise<ProjectMintingVerdictRow | null> {
      const row = await db.selectFrom("project_minting_verdicts").selectAll().where("id", "=", id).executeTakeFirst();
      return row ?? null;
    },

    async markAccepted(input: AcceptVerdictInput): Promise<boolean> {
      const now = new Date().toISOString();
      const result = await db
        .updateTable("project_minting_verdicts")
        .set({
          status: "accepted",
          decided_at: now,
          decided_by_user_id: input.actorUserId,
          struck_projects: JSON.stringify(input.struckProjects),
          accepted_result: JSON.stringify(input.result),
          updated_at: now,
        })
        .where("id", "=", input.id)
        .where("status", "=", "pending")
        .where("superseded_at", "is", null)
        .executeTakeFirst();
      return updatedCount(result) === 1;
    },

    async markRejected(input: RejectVerdictInput): Promise<boolean> {
      const now = new Date().toISOString();
      const result = await db
        .updateTable("project_minting_verdicts")
        .set({
          status: "rejected",
          decided_at: now,
          decided_by_user_id: input.actorUserId,
          updated_at: now,
        })
        .where("id", "=", input.id)
        .where("status", "=", "pending")
        .where("superseded_at", "is", null)
        .executeTakeFirst();
      return updatedCount(result) === 1;
    },
  };
}

export type ProjectMintingVerdictRepository = ReturnType<typeof createProjectMintingVerdictRepository>;
