import { normalizeName } from "../connectors/name-normalize";

/**
 * Phase 1 of PROJECT_ENTITY_CLEANUP.md: the pure core of the adjudication
 * pass. Grouping, prompt construction, and fail-closed verdict validation
 * live here so they are unit-testable without a model; the CLI script wires
 * in the DB, the agentic judge, and the lookup_name tool.
 *
 * Fail closed means every input project ends with exactly one verdict, and
 * anything malformed, missing, duplicated, or rule-violating becomes
 * `needs_human_fix` — never a silent keep. The apply CLI (Phase 2) executes
 * only verdicts a human flipped to `approved: true`.
 */

export type CleanupReportProject = {
  entityId: string;
  name: string;
  aliases: string[];
  createdAt: string;
  provenanceTier: string;
  lifecycleStatus: string | null;
  origin: string | null;
  learnedFacts: number;
  verdictBorn: boolean;
  engagedCompany: string | null;
  mentionCount: number;
  fileCount: number;
  lastActivity: string | null;
  companyShares: Array<{ company: string; files: number }>;
  taskCount: number;
  relationshipCount: number;
  genericName: boolean;
  family: string | null;
  bucket: "keeper" | "junk_candidate" | "merge_family" | "needs_judge";
};

export type CleanupAction = "keep" | "merge_into" | "nest_under" | "archive";

export type CleanupVerdict = {
  entityId: string;
  name: string;
  action: CleanupAction | "needs_human_fix";
  targetEntityId: string | null;
  targetName: string | null;
  reason: string;
  evidence: string[];
  mechanical: boolean;
  approved: boolean;
  validation: "ok" | "needs_human_fix";
  validationReason: string | null;
};

export const UNKNOWN_GROUP_KEY = "unknown";

export type AdjudicationGroup = {
  key: string;
  companyLabel: string;
  projects: CleanupReportProject[];
};

function companyOf(project: CleanupReportProject): string | null {
  return project.engagedCompany ?? project.companyShares[0]?.company ?? null;
}

/**
 * Verdict-born keepers and structural-tier projects skip the judge entirely
 * (their edges are still audited in Phase 3). Everything else is judged.
 */
export function splitMechanicalKeepers(projects: CleanupReportProject[]): {
  mechanical: CleanupVerdict[];
  judged: CleanupReportProject[];
} {
  const mechanical: CleanupVerdict[] = [];
  const judged: CleanupReportProject[] = [];
  for (const project of projects) {
    if (project.verdictBorn || project.provenanceTier === "structural") {
      mechanical.push({
        entityId: project.entityId,
        name: project.name,
        action: "keep",
        targetEntityId: null,
        targetName: null,
        reason: project.verdictBorn ? "verdict_born_keeper" : "structural_provenance",
        evidence: [],
        mechanical: true,
        approved: false,
        validation: "ok",
        validationReason: null,
      });
    } else {
      judged.push(project);
    }
  }
  return { mechanical, judged };
}

/**
 * Judge scope is the company dedup group, so shard companies ("Sml Ltd" vs
 * "SML Limited") do not split a real project family. Projects with no company
 * signal at all pool into the `unknown` group, which gets stricter target
 * validation downstream.
 */
export function groupForAdjudication(
  projects: CleanupReportProject[],
  groupKeyForCompany: (companyName: string) => string,
): AdjudicationGroup[] {
  const groups = new Map<string, AdjudicationGroup>();
  for (const project of projects) {
    const company = companyOf(project);
    const key = company ? groupKeyForCompany(company) : UNKNOWN_GROUP_KEY;
    const held = groups.get(key);
    if (held) {
      held.projects.push(project);
    } else {
      groups.set(key, { key, companyLabel: company ?? "no company signal", projects: [project] });
    }
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function buildAdjudicationPrompt(group: AdjudicationGroup, snippets: Map<string, string[]>): string {
  const lines: string[] = [
    "You are adjudicating existing PROJECT entities in a work knowledge graph for cleanup.",
    `All projects below share one client context: ${group.companyLabel}.`,
    "These entities were minted by an old, noisy per-file pipeline. Many are duplicates of each other, sub-projects of a real project, or not projects at all (a recurring meeting, a one-off document, a date).",
    "",
    "For EVERY project below return exactly one verdict:",
    '- "keep" — a real, distinct project.',
    '- "merge_into" — a duplicate; targetEntityId is the entity that should survive. Merge the weaker evidence into the stronger.',
    '- "nest_under" — a real but subordinate workstream; targetEntityId is its parent project.',
    '- "archive" — not a project (meeting series, artifact name, junk). Only legal when the project has zero tasks and zero relationships; anything referenced must be merged instead.',
    "",
    "Rules:",
    "- Targets must be projects listed below, or projects you first found with the lookup_name tool. Never invent an entity id.",
    "- When a name sounds like it could duplicate a project outside this list, call lookup_name with the name BEFORE deciding.",
    "- Prefer merging fragments into the entity with the most real evidence (mentions, tasks, files), not the prettiest name.",
    "- A generic-named project (flagged GENERIC) is usually junk or a fragment of a sibling.",
    "- Cite the evidence lines that drove each verdict.",
    "",
    "Projects:",
  ];
  for (const project of group.projects) {
    const parts = [
      `- entityId: ${project.entityId}`,
      `  name: ${project.name}${project.genericName ? "  [GENERIC]" : ""}`,
      project.aliases.length > 0 ? `  aliases: ${project.aliases.join(", ")}` : null,
      `  evidence: ${project.mentionCount} mentions across ${project.fileCount} files, ${project.taskCount} tasks, ${project.relationshipCount} relationships`,
      project.lastActivity ? `  lastActivity: ${project.lastActivity.slice(0, 10)}` : "  lastActivity: none",
      project.companyShares.length > 0
        ? `  companyFileShares: ${project.companyShares.map((share) => `${share.company} (${share.files})`).join(", ")}`
        : null,
      project.family ? `  familyHint: ${project.family}` : null,
      `  reportBucket: ${project.bucket}`,
    ].filter((line): line is string => line !== null);
    const projectSnippets = snippets.get(project.entityId) ?? [];
    for (const snippet of projectSnippets.slice(0, 3)) {
      parts.push(`  snippet: ${snippet.replace(/\s+/g, " ").slice(0, 200)}`);
    }
    lines.push(...parts);
  }
  lines.push(
    "",
    'Respond with JSON only: {"verdicts": [{"entityId": "...", "action": "keep|merge_into|nest_under|archive", "targetEntityId": "... or null", "reason": "...", "evidence": ["..."]}]}',
    "One verdict per project, covering every project exactly once.",
  );
  return lines.join("\n");
}

export type TargetContext = {
  /** Live project entities the verdicts may reference, with the company group each belongs to (null = no engagement edge). */
  liveTargets: Map<string, { name: string; groupKey: string | null }>;
  /** Entity ids the judge surfaced via lookup_name, already re-verified against the DB by the caller. */
  surfacedIds: Set<string>;
  /** Existing part_of child → parent edges among live projects, for cycle checks. */
  partOfParent: Map<string, string>;
};

type RawVerdict = {
  entityId?: unknown;
  action?: unknown;
  targetEntityId?: unknown;
  reason?: unknown;
  evidence?: unknown;
};

const ACTIONS: ReadonlySet<string> = new Set(["keep", "merge_into", "nest_under", "archive"]);

function needsHumanFix(project: CleanupReportProject, why: string, raw?: RawVerdict): CleanupVerdict {
  return {
    entityId: project.entityId,
    name: project.name,
    action: "needs_human_fix",
    targetEntityId: typeof raw?.targetEntityId === "string" ? raw.targetEntityId : null,
    targetName: null,
    reason: typeof raw?.reason === "string" ? raw.reason : "",
    evidence: Array.isArray(raw?.evidence)
      ? raw.evidence.filter((item): item is string => typeof item === "string")
      : [],
    mechanical: false,
    approved: false,
    validation: "needs_human_fix",
    validationReason: why,
  };
}

/**
 * Fail-closed validation of one group's raw model output. Every project in
 * the group gets exactly one verdict; every violation downgrades to
 * needs_human_fix with the reason recorded. Targets must be live projects
 * that appeared in this group's prompt or were surfaced by lookup_name, be
 * company-group-compatible, not be archived in this same run, and introduce
 * no part_of cycle. Archive is only legal for unreferenced projects.
 */
export function validateGroupVerdicts(group: AdjudicationGroup, raw: unknown, ctx: TargetContext): CleanupVerdict[] {
  const byId = new Map(group.projects.map((project) => [project.entityId, project]));
  const inGroup = new Set(group.projects.map((project) => project.entityId));

  const rawVerdicts: RawVerdict[] =
    raw && typeof raw === "object" && Array.isArray((raw as { verdicts?: unknown }).verdicts)
      ? ((raw as { verdicts: unknown[] }).verdicts.filter(
          (item): item is RawVerdict => item !== null && typeof item === "object",
        ) as RawVerdict[])
      : [];

  const seen = new Map<string, RawVerdict>();
  const duplicated = new Set<string>();
  for (const verdict of rawVerdicts) {
    if (typeof verdict.entityId !== "string" || !byId.has(verdict.entityId)) continue;
    if (seen.has(verdict.entityId)) duplicated.add(verdict.entityId);
    else seen.set(verdict.entityId, verdict);
  }

  const archivedThisRun = new Set<string>();
  for (const [entityId, verdict] of seen) {
    if (verdict.action === "archive" && !duplicated.has(entityId)) archivedThisRun.add(entityId);
  }

  const proposedParent = new Map(ctx.partOfParent);
  const results: CleanupVerdict[] = [];

  for (const project of group.projects) {
    const verdict = seen.get(project.entityId);
    if (!verdict) {
      results.push(needsHumanFix(project, "no_verdict"));
      continue;
    }
    if (duplicated.has(project.entityId)) {
      results.push(needsHumanFix(project, "duplicate_verdict", verdict));
      continue;
    }
    const action = typeof verdict.action === "string" ? verdict.action : "";
    if (!ACTIONS.has(action)) {
      results.push(needsHumanFix(project, "invalid_action", verdict));
      continue;
    }

    if (action === "archive") {
      if (project.taskCount > 0 || project.relationshipCount > 0) {
        results.push(needsHumanFix(project, "archive_referenced", verdict));
        continue;
      }
    }

    let targetEntityId: string | null = null;
    let targetName: string | null = null;
    if (action === "merge_into" || action === "nest_under") {
      targetEntityId = typeof verdict.targetEntityId === "string" ? verdict.targetEntityId : null;
      if (!targetEntityId) {
        results.push(needsHumanFix(project, "missing_target", verdict));
        continue;
      }
      if (targetEntityId === project.entityId) {
        results.push(needsHumanFix(project, "self_target", verdict));
        continue;
      }
      const target = ctx.liveTargets.get(targetEntityId);
      if (!target) {
        results.push(needsHumanFix(project, "target_not_live_project", verdict));
        continue;
      }
      if (archivedThisRun.has(targetEntityId)) {
        results.push(needsHumanFix(project, "target_archived_this_run", verdict));
        continue;
      }
      const surfaced = ctx.surfacedIds.has(targetEntityId);
      if (!inGroup.has(targetEntityId) && !surfaced) {
        results.push(needsHumanFix(project, "target_not_in_prompt_or_lookup", verdict));
        continue;
      }
      const compatible =
        inGroup.has(targetEntityId) ||
        group.key === UNKNOWN_GROUP_KEY ||
        target.groupKey === null ||
        target.groupKey === group.key;
      if (!compatible) {
        results.push(needsHumanFix(project, "target_company_group_mismatch", verdict));
        continue;
      }
      if (action === "nest_under") {
        let cursor: string | undefined = targetEntityId;
        let cycle = false;
        const walked = new Set<string>();
        while (cursor) {
          if (cursor === project.entityId) {
            cycle = true;
            break;
          }
          if (walked.has(cursor)) break;
          walked.add(cursor);
          cursor = proposedParent.get(cursor);
        }
        if (cycle) {
          results.push(needsHumanFix(project, "part_of_cycle", verdict));
          continue;
        }
        proposedParent.set(project.entityId, targetEntityId);
      }
      targetName = target.name;
    }

    results.push({
      entityId: project.entityId,
      name: project.name,
      action: action as CleanupAction,
      targetEntityId,
      targetName,
      reason: typeof verdict.reason === "string" ? verdict.reason : "",
      evidence: Array.isArray(verdict.evidence)
        ? verdict.evidence.filter((item): item is string => typeof item === "string").slice(0, 6)
        : [],
      mechanical: false,
      approved: false,
      validation: "ok",
      validationReason: null,
    });
  }
  return results;
}

/** Builds the company-name → dedup-group-key mapper the grouping step needs. */
export function makeGroupKeyForCompany(memberNamesByGroup: Map<string, string[]>): (companyName: string) => string {
  const byName = new Map<string, string>();
  for (const [groupKey, names] of memberNamesByGroup) {
    for (const name of names) byName.set(normalizeName(name), groupKey);
  }
  return (companyName: string) => byName.get(normalizeName(companyName)) ?? normalizeName(companyName);
}
