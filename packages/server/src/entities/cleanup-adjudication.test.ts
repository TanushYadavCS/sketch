import { describe, expect, it } from "vitest";
import {
  type AdjudicationGroup,
  type CleanupReportProject,
  type TargetContext,
  validateGroupVerdicts,
} from "./cleanup-adjudication";

function project(overrides: Partial<CleanupReportProject> & { entityId: string; name: string }): CleanupReportProject {
  return {
    aliases: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    provenanceTier: "llm",
    lifecycleStatus: null,
    origin: null,
    learnedFacts: 0,
    verdictBorn: false,
    engagedCompany: "Retireco",
    mentionCount: 3,
    fileCount: 2,
    lastActivity: null,
    companyShares: [],
    taskCount: 0,
    relationshipCount: 0,
    genericName: false,
    family: null,
    bucket: "needs_judge",
    ...overrides,
  };
}

function group(projects: CleanupReportProject[]): AdjudicationGroup {
  return { key: "retireco", companyLabel: "Retireco", projects };
}

function ctx(overrides: Partial<TargetContext> = {}): TargetContext {
  return {
    liveTargets: new Map([
      ["p1", { name: "Alpha", groupKey: "retireco" }],
      ["p2", { name: "Alpha Dashboard", groupKey: "retireco" }],
      ["other", { name: "Foreign Project", groupKey: "othercorp" }],
    ]),
    surfacedIds: new Set(),
    partOfParent: new Map(),
    ...overrides,
  };
}

describe("cleanup adjudication validation", () => {
  it("downgrades missing and malformed verdicts to needs_human_fix, never a silent keep", () => {
    const projects = [project({ entityId: "p1", name: "Alpha" }), project({ entityId: "p2", name: "Alpha Dashboard" })];
    const raw = { verdicts: [{ entityId: "p2", action: "obliterate", reason: "junk" }] };

    const verdicts = validateGroupVerdicts(group(projects), raw, ctx());

    const byId = new Map(verdicts.map((verdict) => [verdict.entityId, verdict]));
    expect(byId.get("p1")).toMatchObject({ action: "needs_human_fix", validationReason: "no_verdict" });
    expect(byId.get("p2")).toMatchObject({ action: "needs_human_fix", validationReason: "invalid_action" });
    expect(verdicts).toHaveLength(2);
  });

  it("rejects archiving a referenced project", () => {
    const projects = [project({ entityId: "p1", name: "Alpha", taskCount: 2 })];
    const raw = { verdicts: [{ entityId: "p1", action: "archive", reason: "looks like junk" }] };

    const verdicts = validateGroupVerdicts(group(projects), raw, ctx());

    expect(verdicts[0]).toMatchObject({ action: "needs_human_fix", validationReason: "archive_referenced" });
  });

  it("rejects a merge target outside the company group unless lookup_name surfaced it", () => {
    const projects = [project({ entityId: "p1", name: "Alpha" })];
    const raw = { verdicts: [{ entityId: "p1", action: "merge_into", targetEntityId: "other", reason: "same work" }] };

    const refused = validateGroupVerdicts(group(projects), raw, ctx());
    expect(refused[0]).toMatchObject({
      action: "needs_human_fix",
      validationReason: "target_not_in_prompt_or_lookup",
    });

    const surfacedButForeign = validateGroupVerdicts(group(projects), raw, ctx({ surfacedIds: new Set(["other"]) }));
    expect(surfacedButForeign[0]).toMatchObject({
      action: "needs_human_fix",
      validationReason: "target_company_group_mismatch",
    });

    const surfacedCompatible = validateGroupVerdicts(
      group(projects),
      raw,
      ctx({
        surfacedIds: new Set(["other"]),
        liveTargets: new Map([["other", { name: "Foreign Project", groupKey: "retireco" }]]),
      }),
    );
    expect(surfacedCompatible[0]).toMatchObject({ action: "merge_into", targetEntityId: "other", validation: "ok" });
  });
});
