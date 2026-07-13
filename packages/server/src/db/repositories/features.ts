import type { Kysely } from "kysely";
import type { FeatureFactRaw } from "../../connectors/types";
import type { DB } from "../schema";
import { buildIndexedFileFactKey, createIndexedFileFactRepository } from "./indexed-file-facts";

export type FeatureStatus = "proposed" | "building" | "shipped" | "deprecated";

export interface UpsertFeatureFactInput {
  indexedFileId?: string | null;
  connectorConfigId: string;
  createdByUserId?: string | null;
  lastSeenSyncRunId?: string | null;
  contentHash?: string | null;
  source: string;
  featureId: string;
  featureName: string;
  corroborationKey?: string;
  parentProductRef?: { source: string; sourceId: string };
  parentProductName?: string;
  parentEntityId?: string;
  status: FeatureStatus;
  dueAt?: string;
  evidence: { fileIds: string[]; entityIds: string[] };
  contextSnippet?: string | null;
  promptVersion?: string;
  model?: string;
  confidence?: number;
}

export async function upsertFeatureFact(
  db: Kysely<DB>,
  input: UpsertFeatureFactInput,
): Promise<{ emitted: boolean; factKey?: string }> {
  const connectorConfigId = requireNonEmpty(input.connectorConfigId, "connectorConfigId");
  const source = requireNonEmpty(input.source, "source");
  const featureId = requireNonEmpty(input.featureId, "featureId");

  const factInput = {
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
  } as const;
  await createIndexedFileFactRepository(db).upsertFact(factInput);
  return { emitted: true, factKey: buildIndexedFileFactKey(factInput) };
}

function buildFeatureRaw(input: UpsertFeatureFactInput, featureId: string): FeatureFactRaw {
  return {
    featureId,
    featureName: input.featureName,
    corroborationKey: input.corroborationKey,
    parentProductRef: input.parentProductRef,
    parentProductName: input.parentProductName,
    parentEntityId: input.parentEntityId,
    status: input.status,
    dueAt: input.dueAt,
    evidence: input.evidence,
    promptVersion: input.promptVersion,
    model: input.model,
    confidence: input.confidence,
  };
}

function requireNonEmpty(value: string | null | undefined, name: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`feature ${name} is required`);
  return trimmed;
}
