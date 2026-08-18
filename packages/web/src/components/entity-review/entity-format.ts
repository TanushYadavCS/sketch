import type { EntityListItem, EntityReviewQueueRow } from "@/lib/api";

/** Map a raw entity/source type to a human-readable label. */
export function humanSourceType(sourceType: string): string {
  const map: Record<string, string> = {
    clickup_space: "Space",
    clickup_folder: "Folder",
    clickup_workspace: "Workspace",
    linear_project: "Project",
    notion_database: "Database",
    notion_page: "Page",
    person: "Person",
    project: "Project",
    company: "Company",
    product: "Product",
    team: "Team",
    other: "Other",
  };
  return map[sourceType] ?? sourceType;
}

/** Map a connector/source slug to a human-readable product name. */
export function humanConnector(source: string): string {
  const map: Record<string, string> = {
    clickup: "ClickUp",
    linear: "Linear",
    notion: "Notion",
    fireflies: "Fireflies",
    gmail: "Gmail",
    slack: "Slack",
    github: "GitHub",
    jira: "Jira",
    llm_relation: "AI",
    llm_extraction: "AI",
  };
  return map[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

/**
 * Where a review row was born. A `seed_source` means it was pulled structurally
 * from a tracker (ClickUp / Linear); a bare `source` means an AI extraction
 * inferred it from that connector's documents. Returns null when neither is set.
 */
export function birthOrigin(row: EntityReviewQueueRow): { kind: "tracker" | "ai"; label: string } | null {
  if (row.seed_source) return { kind: "tracker", label: humanConnector(row.seed_source) };
  if (row.source) return { kind: "ai", label: `AI · ${humanConnector(row.source)}` };
  return null;
}

/**
 * Project queue rows the weekly mint pass owns: file-evidence candidates
 * (LLM extraction sources, mirroring the server's WEEKLY_PASS_PROJECT_SOURCES)
 * with no structural seed. These never get a create-new path in the UI — the
 * server refuses the birth too (PROJECT_BIRTH_BLOCKED); the dossier is the
 * only way a project is born from file evidence. Structural connector rows
 * (tracker containers, seeded rows) keep the standard actions.
 */
const WEEKLY_PASS_PROJECT_SOURCES = new Set([
  "llm_extraction",
  "llm_relation",
  "candidate_promotion",
  "entity_candidate_promotion",
]);

export function isWeeklyPassProjectRow(row: EntityReviewQueueRow): boolean {
  return (
    row.entity_type === "project" &&
    !row.seed_source &&
    row.source !== null &&
    WEEKLY_PASS_PROJECT_SOURCES.has(row.source)
  );
}

/** Read an entity's email out of its metadata blob, if present. */
export function entityEmail(entity: EntityListItem | null): string | null {
  const value = entity?.metadata?.email;
  return typeof value === "string" && value.length > 0 ? value : null;
}
