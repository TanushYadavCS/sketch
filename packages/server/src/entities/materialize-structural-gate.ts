const PROJECT_CANDIDATE_SOURCE_TYPES = new Set(["linear_project", "clickup_space", "clickup_folder"]);

/** A connector container that must be human-confirmed before a `project` entity exists. */
export function isProjectCandidateSeed(sourceType: string): boolean {
  return PROJECT_CANDIDATE_SOURCE_TYPES.has(sourceType);
}

/** Short human-readable provenance for the review evidence note. */
export function buildSeedProvenanceNote(raw: Record<string, unknown>, sourceType: string): string {
  const path = typeof raw.sourcePath === "string" ? raw.sourcePath : undefined;
  const url = typeof raw.providerUrl === "string" ? raw.providerUrl : undefined;
  return [sourceType, path ?? url].filter(Boolean).join(" · ");
}
