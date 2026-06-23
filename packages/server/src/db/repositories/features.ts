import type { Kysely } from "kysely";
import type { FeatureFactRaw } from "../../connectors/types";
import type { DB } from "../schema";
import { createIndexedFileFactRepository } from "./indexed-file-facts";

export type FeatureStatus = "proposed" | "building" | "shipped" | "deprecated";

export interface UpsertFeatureFactInput {
  experimentalFlag?: boolean;
  indexedFileId?: string | null;
  connectorConfigId: string;
  createdByUserId?: string | null;
  lastSeenSyncRunId?: string | null;
  contentHash?: string | null;
  source: string;
  featureId: string;
  featureName: string;
  parentProductRef?: { source: string; sourceId: string };
  parentEntityId?: string;
  status: FeatureStatus;
  dueAt?: string;
  evidence: { fileIds: string[]; entityIds: string[] };
  contextSnippet?: string | null;
}

export async function upsertFeatureFact(db: Kysely<DB>, input: UpsertFeatureFactInput): Promise<{ emitted: boolean }> {
  const connectorConfigId = requireNonEmpty(input.connectorConfigId, "connectorConfigId");
  const source = requireNonEmpty(input.source, "source");
  const featureId = requireNonEmpty(input.featureId, "featureId");
  if (!input.experimentalFlag) return { emitted: false };

  await createIndexedFileFactRepository(db).upsertFact({
    indexedFileId: input.indexedFileId ?? null,
    connectorConfigId,
    createdByUserId: input.createdByUserId ?? null,
    lastSeenSyncRunId: input.lastSeenSyncRunId ?? null,
    contentHash: input.contentHash ?? null,
    source,
    factType: "feature",
    relation: "mentioned",
    subjectName: input.featureName,
    subjectSource: source,
    subjectSourceId: featureId,
    contextSnippet: input.contextSnippet ?? null,
    raw: buildFeatureRaw(input, featureId),
  });
  return { emitted: true };
}

function buildFeatureRaw(input: UpsertFeatureFactInput, featureId: string): FeatureFactRaw {
  return {
    featureId,
    featureName: input.featureName,
    parentProductRef: input.parentProductRef,
    parentEntityId: input.parentEntityId,
    status: input.status,
    dueAt: input.dueAt,
    evidence: input.evidence,
  };
}

function requireNonEmpty(value: string | null | undefined, name: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`feature ${name} is required`);
  return trimmed;
}
