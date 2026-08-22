import type { Kysely, Selectable } from "kysely";
import { z } from "zod/v4";
import {
  type GraphVerdictValidationStatus,
  type StoreGraphVerdictInput,
  createGraphVerdictRepository,
  withGraphVerdictUniqueRetry,
} from "../../db/repositories/graph-verdicts";
import type { DB, EntitiesTable } from "../../db/schema";
import type { CleanupAction, CleanupVerdict } from "../../entities/cleanup-adjudication";
import { planProjectCleanup } from "../../entities/cleanup-apply";
import { fingerprintFor } from "../../entities/verdict-fingerprint";
import { jsonResult } from "./queries";

const actions = ["keep", "merge_into", "nest_under", "archive"] as const;

const evidenceSchema = z.object({
  fileIds: z.array(z.string()).optional(),
  reviewIds: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
});

export const proposeGraphVerdictsSchema = {
  note: z.string().optional(),
  verdicts: z
    .array(
      z.object({
        action: z.enum(actions),
        subjectEntityId: z.string().min(1),
        targetEntityId: z.string().min(1).optional(),
        reason: z.string().min(1),
        evidence: evidenceSchema.optional(),
      }),
    )
    .min(1)
    .max(25),
};

export type ProposeGraphVerdictsArgs = z.infer<z.ZodObject<typeof proposeGraphVerdictsSchema>>;

type EntityRow = Selectable<EntitiesTable>;

type NormalizedEvidence = {
  fileIds: string[];
  reviewIds: string[];
  notes: string[];
};

type Proposal = ProposeGraphVerdictsArgs["verdicts"][number];

type PreparedProposal = {
  index: number;
  proposal: Proposal;
  evidence: NormalizedEvidence;
  subject: EntityRow | null;
  target: EntityRow | null;
};

type ProposalResult = {
  verdictId: string;
  action: CleanupAction;
  subjectEntityId: string;
  validationStatus: GraphVerdictValidationStatus;
  validationReason: string | null;
  wouldChange: Record<string, number> | null;
};

function sortedCapped(values: string[] | undefined, max: number): string[] {
  return [...new Set(values ?? [])].sort((a, b) => a.localeCompare(b)).slice(0, max);
}

function normalizeEvidence(proposal: Proposal): NormalizedEvidence {
  return {
    fileIds: sortedCapped(proposal.evidence?.fileIds, 25),
    reviewIds: sortedCapped(proposal.evidence?.reviewIds, 25),
    notes: sortedCapped(proposal.evidence?.notes, 6),
  };
}

function preparedFingerprint(prepared: PreparedProposal): string {
  return fingerprintFor({
    action: prepared.proposal.action,
    subject: prepared.subject,
    target: prepared.target,
    evidence: prepared.evidence,
  });
}

function bouncedVerdict(prepared: PreparedProposal, validationReason: string): StoreGraphVerdictInput {
  return {
    runId: "",
    action: prepared.proposal.action,
    subjectEntityId: prepared.proposal.subjectEntityId,
    subjectName: prepared.subject?.name ?? null,
    subjectEntityType: prepared.subject?.source_type ?? null,
    targetEntityId: prepared.proposal.targetEntityId ?? null,
    targetName: prepared.target?.name ?? null,
    reason: prepared.proposal.reason,
    evidenceJson: JSON.stringify(prepared.evidence),
    evidenceFingerprint: preparedFingerprint(prepared),
    validationStatus: "failed",
    validationReason,
    wouldChangeJson: null,
    status: "bounced",
  };
}

function plannedVerdict(
  prepared: PreparedProposal,
  validationStatus: GraphVerdictValidationStatus,
  validationReason: string | null,
  wouldChange: Record<string, number> | null,
  resolvedTargetEntityId: string | null,
): StoreGraphVerdictInput {
  return {
    runId: "",
    action: prepared.proposal.action,
    subjectEntityId: prepared.proposal.subjectEntityId,
    subjectName: prepared.subject?.name ?? null,
    subjectEntityType: prepared.subject?.source_type ?? null,
    targetEntityId: prepared.proposal.targetEntityId ?? null,
    resolvedTargetEntityId,
    targetName: prepared.target?.name ?? null,
    reason: prepared.proposal.reason,
    evidenceJson: JSON.stringify(prepared.evidence),
    evidenceFingerprint: preparedFingerprint(prepared),
    validationStatus,
    validationReason,
    wouldChangeJson: wouldChange ? JSON.stringify(wouldChange) : null,
    status: validationStatus === "ok" ? "awaiting_human" : "bounced",
  };
}

function toCleanupVerdict(prepared: PreparedProposal): CleanupVerdict {
  return {
    entityId: prepared.proposal.subjectEntityId,
    name: prepared.subject?.name ?? prepared.proposal.subjectEntityId,
    action: prepared.proposal.action,
    targetEntityId: prepared.proposal.targetEntityId ?? null,
    targetName: prepared.target?.name ?? null,
    reason: prepared.proposal.reason,
    evidence: prepared.evidence.notes,
    mechanical: false,
    approved: true,
    validation: "ok",
    validationReason: null,
  };
}

async function loadEntities(db: Kysely<DB>, proposals: Proposal[]): Promise<Map<string, EntityRow>> {
  const ids = [
    ...new Set(
      proposals.flatMap((proposal) =>
        proposal.targetEntityId ? [proposal.subjectEntityId, proposal.targetEntityId] : [proposal.subjectEntityId],
      ),
    ),
  ];
  if (ids.length === 0) return new Map();
  const rows = await db.selectFrom("entities").selectAll().where("id", "in", ids).execute();
  return new Map(rows.map((row) => [row.id, row]));
}

function prepareProposals(args: ProposeGraphVerdictsArgs, entities: Map<string, EntityRow>) {
  const seenPairs = new Set<string>();
  const rows: Array<StoreGraphVerdictInput | null> = [];
  const plannerInputs: PreparedProposal[] = [];

  for (const [index, proposal] of args.verdicts.entries()) {
    const prepared: PreparedProposal = {
      index,
      proposal,
      evidence: normalizeEvidence(proposal),
      subject: entities.get(proposal.subjectEntityId) ?? null,
      target: proposal.targetEntityId ? (entities.get(proposal.targetEntityId) ?? null) : null,
    };
    const pairKey = `${proposal.subjectEntityId}\u0000${proposal.action}`;
    const duplicate = seenPairs.has(pairKey);
    seenPairs.add(pairKey);
    let validationReason: string | null = null;
    if (duplicate) validationReason = "duplicate_in_batch";
    else if (!prepared.subject) validationReason = "subject_not_found";
    else if ((proposal.action === "merge_into" || proposal.action === "nest_under") && !proposal.targetEntityId)
      validationReason = "target_required";
    else if (proposal.targetEntityId && !prepared.target) validationReason = "target_not_found";

    if (validationReason) {
      rows[index] = bouncedVerdict(prepared, validationReason);
    } else {
      rows[index] = null;
      plannerInputs.push(prepared);
    }
  }

  return { rows, plannerInputs };
}

/**
 * The cleanup planner is the validator here, not the approval gate. These
 * synthesized flags let it reach structural checks while still performing only
 * SELECTs against the transaction handle.
 */
async function validateWithCleanupPlanner(db: Kysely<DB>, proposals: PreparedProposal[]) {
  return planProjectCleanup(db, proposals.map(toCleanupVerdict));
}

export async function handleProposeGraphVerdicts(
  args: ProposeGraphVerdictsArgs,
  db: Kysely<DB>,
  authContext: { userId: string; tokenId: string },
) {
  return jsonResult(
    await withGraphVerdictUniqueRetry(async () =>
      db.transaction().execute(async (trx) => {
        const entities = await loadEntities(trx, args.verdicts);
        const { rows, plannerInputs } = prepareProposals(args, entities);
        const plannedRows = await validateWithCleanupPlanner(trx, plannerInputs);

        for (const [plannerIndex, planRow] of plannedRows.entries()) {
          const prepared = plannerInputs[plannerIndex];
          if (!prepared) continue;
          rows[prepared.index] =
            planRow.state === "applied"
              ? plannedVerdict(prepared, "ok", null, planRow.wouldChange, planRow.resolvedTargetEntityId)
              : plannedVerdict(
                  prepared,
                  "failed",
                  planRow.reason ?? "invalid_action",
                  null,
                  planRow.resolvedTargetEntityId,
                );
        }

        const repo = createGraphVerdictRepository(trx);
        const run = await repo.createRun({
          source: "curation_mcp",
          proposedByUserId: authContext.userId,
          tokenId: authContext.tokenId,
          note: args.note ?? null,
          verdictsProposed: args.verdicts.length,
        });
        const verdictRows = rows.map((row) => {
          if (!row) throw new Error("Missing graph verdict row.");
          return { ...row, runId: run.id };
        });
        const stored = await repo.storeVerdicts(verdictRows);
        const results: ProposalResult[] = stored.rows.map((row, index) => ({
          verdictId: stored.ids[index] ?? "",
          action: row.action as CleanupAction,
          subjectEntityId: row.subjectEntityId,
          validationStatus: row.validationStatus,
          validationReason: row.validationReason,
          wouldChange: row.wouldChangeJson ? (JSON.parse(row.wouldChangeJson) as Record<string, number>) : null,
        }));
        return {
          runId: run.id,
          stored: stored.rows.filter((row) => row.status === "awaiting_human").length,
          bounced: stored.rows.filter((row) => row.status === "bounced").length,
          results,
        };
      }),
    ),
  );
}
