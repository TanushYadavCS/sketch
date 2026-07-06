import type { Kysely } from "kysely";
import type { MilestoneFactRaw } from "../../connectors/types";
import type { DB } from "../schema";
import { createIndexedFileFactRepository } from "./indexed-file-facts";
import { type SubEntityRow, createSubEntityRepository } from "./sub-entities";

export type MilestoneStatus = "planned" | "hit" | "missed";

export interface UpsertMilestoneFactInput {
  experimentalFlag?: boolean;
  indexedFileId?: string | null;
  connectorConfigId: string;
  createdByUserId?: string | null;
  lastSeenSyncRunId?: string | null;
  contentHash?: string | null;
  source: string;
  milestoneId: string;
  milestoneName: string;
  parentRef?: { source: string; sourceId: string };
  parentEntityId?: string;
  status: MilestoneStatus;
  dueAt: string;
  observedAt?: string;
  evidence: { fileIds: string[]; entityIds: string[] };
  contextSnippet?: string | null;
}

export async function upsertMilestoneFact(
  db: Kysely<DB>,
  input: UpsertMilestoneFactInput,
): Promise<{ emitted: boolean }> {
  const connectorConfigId = requireNonEmpty(input.connectorConfigId, "connectorConfigId");
  const source = requireNonEmpty(input.source, "source");
  const milestoneId = requireNonEmpty(input.milestoneId, "milestoneId");
  if (!input.experimentalFlag) return { emitted: false };

  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: input.indexedFileId ?? null,
    connectorConfigId,
    createdByUserId: input.createdByUserId ?? null,
    lastSeenSyncRunId: input.lastSeenSyncRunId ?? null,
    contentHash: input.contentHash ?? null,
    source,
    factType: "milestone",
    relation: "mentioned",
    subjectName: input.milestoneName,
    subjectSource: source,
    subjectSourceId: milestoneId,
    contextSnippet: input.contextSnippet ?? null,
    raw: buildMilestoneRaw(input, milestoneId),
  });
  return { emitted: true };
}

export async function listCurrentMilestones(
  db: Kysely<DB>,
  opts: { experimentalFlag?: boolean; parentEntityId: string },
): Promise<SubEntityRow[]> {
  if (!opts.experimentalFlag) return [];
  return createSubEntityRepository(db).listCurrentByKind({
    parentEntityId: opts.parentEntityId,
    kind: "milestone",
  });
}

export async function resolveCurrentMilestoneForTask(db: Kysely<DB>, taskId: string): Promise<SubEntityRow | null> {
  const task = await db.selectFrom("tasks").select("milestone_series_key").where("id", "=", taskId).executeTakeFirst();
  if (!task?.milestone_series_key) return null;
  return (
    (await db
      .selectFrom("sub_entities")
      .selectAll()
      .where("series_key", "=", task.milestone_series_key)
      .where("valid_to", "is", null)
      .executeTakeFirst()) ?? null
  );
}

function buildMilestoneRaw(input: UpsertMilestoneFactInput, milestoneId: string): MilestoneFactRaw {
  return {
    milestoneId,
    milestoneName: input.milestoneName,
    parentRef: input.parentRef,
    parentEntityId: input.parentEntityId,
    status: input.status,
    dueAt: input.dueAt,
    observedAt: input.observedAt,
    evidence: input.evidence,
  };
}

function requireNonEmpty(value: string | null | undefined, name: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`milestone ${name} is required`);
  return trimmed;
}
