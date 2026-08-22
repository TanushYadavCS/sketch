import { createHash } from "node:crypto";
import { normalizeName } from "./name-keys";

export type VerdictFingerprintEntity = {
  id: string;
  name: string;
  sourceType: string;
  status: string;
  deletedAt: string | null;
  mergedIntoEntityId: string | null;
};

export type VerdictFingerprintEvidence = {
  fileIds: string[];
  reviewIds: string[];
  notes?: string[];
};

export type VerdictFingerprintInput = {
  action: string;
  subject: VerdictFingerprintEntity | null;
  target: VerdictFingerprintEntity | null;
  evidence: VerdictFingerprintEvidence;
};

function sortedValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))].sort();
}

function canonicalEntity(entity: VerdictFingerprintEntity | null) {
  if (!entity) return null;
  return {
    id: entity.id.toLowerCase(),
    name: normalizeName(entity.name),
    sourceType: entity.sourceType.toLowerCase(),
    status: entity.status.toLowerCase(),
    live: entity.deletedAt === null,
    mergedIntoEntityId: entity.mergedIntoEntityId ? entity.mergedIntoEntityId.toLowerCase() : null,
  };
}

export function graphVerdictFingerprint(input: VerdictFingerprintInput): string {
  const canonical = {
    action: input.action.toLowerCase(),
    subject: canonicalEntity(input.subject),
    target: canonicalEntity(input.target),
    evidence: {
      fileIds: sortedValues(input.evidence.fileIds),
      reviewIds: sortedValues(input.evidence.reviewIds),
    },
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function fingerprintEntity(
  row: {
    id: string;
    name: string;
    source_type: string;
    status: string;
    deleted_at: string | null;
    merged_into_entity_id: string | null;
  } | null,
): VerdictFingerprintEntity | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    status: row.status,
    deletedAt: row.deleted_at,
    mergedIntoEntityId: row.merged_into_entity_id,
  };
}

export function fingerprintFor(input: {
  action: string;
  subject: Parameters<typeof fingerprintEntity>[0];
  target: Parameters<typeof fingerprintEntity>[0];
  evidence: VerdictFingerprintEvidence;
}): string {
  return graphVerdictFingerprint({
    action: input.action,
    subject: fingerprintEntity(input.subject),
    target: fingerprintEntity(input.target),
    evidence: input.evidence,
  });
}
