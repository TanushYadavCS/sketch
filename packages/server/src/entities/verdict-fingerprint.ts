import { createHash } from "node:crypto";
import { normalizeName } from "../connectors/name-normalize";

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
