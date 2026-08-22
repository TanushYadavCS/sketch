/**
 * One trust order for entity_relationships.source, shared by write-time
 * conflict guards, evidence-sweep carve-outs, and read-time edge ranking.
 * Human declarations sit above the weekly-pass acceptance flow, which sits
 * above everything the pipeline infers. The protected allow-list is
 * deliberately (source, type)-paired: source and relationship_type are
 * unconstrained text columns, so a source-only carve-out would make any
 * mistyped row immortal.
 */

export const DECLARED_RELATIONSHIP_SOURCE = "declared";

export const HUMAN_RELATIONSHIP_SOURCES: readonly string[] = [DECLARED_RELATIONSHIP_SOURCE, "user_grouping"];

/**
 * Sources in this closed list describe weak machine co-occurrence, not a
 * human- or system-vouched reason for either endpoint entity to remain live.
 * `co_mention` is included with `llm_extraction` because it ranks below that
 * tier and is pure co-occurrence; unknown future sources deliberately vouch
 * by default so new writers block archive until classified here.
 */
export const NON_VOUCHING_RELATIONSHIP_SOURCES: readonly string[] = ["llm_extraction", "co_mention"];

export const PROTECTED_RELATIONSHIP_SOURCES: readonly string[] = [
  ...HUMAN_RELATIONSHIP_SOURCES,
  "project_minting_acceptance",
  "project_cleanup_apply",
];

export const PROTECTED_RELATIONSHIP_TYPES: readonly string[] = [
  "engagement_for",
  "part_of",
  "works_at",
  "engaged_with",
];

export function isHumanRelationshipSource(source: string | null | undefined): boolean {
  return source != null && HUMAN_RELATIONSHIP_SOURCES.includes(source);
}

export function relationshipSourceVouchesForEntity(source: string | null | undefined): boolean {
  return source == null || !NON_VOUCHING_RELATIONSHIP_SOURCES.includes(source);
}

/**
 * Lower is more trusted. Callers that need the opposite direction derive it;
 * the two pre-existing rank helpers pointed in opposite directions, so the
 * order lives here once and each keeps its comparison semantics.
 */
export function relationshipSourceOrder(source: string | null | undefined): number {
  if (source != null && HUMAN_RELATIONSHIP_SOURCES.includes(source)) return 0;
  if (source === "project_minting_acceptance" || source === "project_cleanup_apply") return 1;
  if (source === "structural_assignee") return 2;
  if (source === "llm_extraction") return 3;
  if (source === "co_mention") return 4;
  return 5;
}
