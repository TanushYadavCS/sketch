import type { EntityRelationshipType } from "../db/repositories/entity-domains";

export const NON_PERSON_MENTION_TYPES = ["project", "company", "product", "team"] as const;
export const ENTITY_GRAPH_RELATION_TYPES = [
  "works_at",
  "engaged_with",
  "leads",
  "contributes_to",
  "builds",
  "part_of",
  "partner_of",
] as const satisfies readonly EntityRelationshipType[];

export const LLM_RELATION_CONFIDENCE_THRESHOLD = 0.85;
export const LLM_RELATION_ENDPOINT_CONFIDENCE_THRESHOLD = 0.8;

export type NonPersonMentionType = (typeof NON_PERSON_MENTION_TYPES)[number];
export type MentionType = "person" | NonPersonMentionType;
export type EntityGraphMentionType = MentionType;
export type EntityGraphRelationType = (typeof ENTITY_GRAPH_RELATION_TYPES)[number];

type AssertNever<T extends never> = T;
export type EntityGraphRelationTypeExhaustivenessCheck = AssertNever<
  Exclude<EntityRelationshipType, EntityGraphRelationType> | Exclude<EntityGraphRelationType, EntityRelationshipType>
>;

export interface EntityGraphRelationEndpoint {
  name: string;
  type: MentionType;
  variations: string[];
}

export function normalizeMentionType(raw: unknown): MentionType | null {
  if (typeof raw !== "string") return null;
  const lowered = raw.trim().toLowerCase();
  if (lowered === "person") return "person";
  if ((NON_PERSON_MENTION_TYPES as readonly string[]).includes(lowered)) {
    return lowered as NonPersonMentionType;
  }
  return null;
}

export function normalizeRelationType(raw: unknown): EntityRelationshipType | null {
  if (typeof raw !== "string") return null;
  const lowered = raw.trim().toLowerCase();
  return (ENTITY_GRAPH_RELATION_TYPES as readonly string[]).includes(lowered)
    ? (lowered as EntityRelationshipType)
    : null;
}

export function readRelationEndpoint(
  raw: Record<string, unknown>,
  key: "source" | "target",
): EntityGraphRelationEndpoint | null {
  const endpoint = raw[key];
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) return null;
  const record = endpoint as Record<string, unknown>;
  if (typeof record.name !== "string") return null;
  const type = normalizeMentionType(record.type);
  if (!type) return null;
  const variations = Array.isArray(record.variations)
    ? record.variations.filter((value): value is string => typeof value === "string")
    : [];
  return { name: record.name, type, variations };
}

export function relationDirectionAllowed(
  relationType: EntityRelationshipType,
  sourceType: MentionType,
  targetType: MentionType,
): boolean {
  if (relationType === "works_at") return sourceType === "person" && targetType === "company";
  if (relationType === "engaged_with") {
    return (sourceType === "person" || sourceType === "team") && targetType === "company";
  }
  if (relationType === "leads") {
    return sourceType === "person" && (targetType === "project" || targetType === "product" || targetType === "team");
  }
  if (relationType === "contributes_to") {
    return (sourceType === "person" || sourceType === "team") && (targetType === "project" || targetType === "product");
  }
  if (relationType === "builds") return sourceType === "company" && targetType === "product";
  if (relationType === "part_of") {
    return (
      (sourceType === "project" && targetType === "project") ||
      (sourceType === "product" && targetType === "product") ||
      (sourceType === "team" && targetType === "company")
    );
  }
  return sourceType === "company" && targetType === "company";
}

export function isHighConfidenceRelation(confidence: unknown): confidence is number {
  return typeof confidence === "number" && confidence >= LLM_RELATION_CONFIDENCE_THRESHOLD;
}

export function isHighConfidenceEndpoint(confidence: unknown): confidence is number {
  return typeof confidence === "number" && confidence >= LLM_RELATION_ENDPOINT_CONFIDENCE_THRESHOLD;
}
