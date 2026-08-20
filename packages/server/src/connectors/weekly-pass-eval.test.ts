import { describe, expect, it } from "vitest";
import { type RunEvidence, type WeeklyPassGoldens, diffScores, scoreRun } from "./weekly-pass-eval";

function evidence(overrides: Partial<RunEvidence["containers"][number]>[]): RunEvidence {
  return {
    runId: "run-1",
    judgeMode: "single",
    model: "test/model",
    promptVersion: "v2",
    containers: overrides.map((container, index) => ({
      containerKey: `container-${index}`,
      companyName: "Oliver Wyman",
      dispositions: [],
      verdictId: null,
      verdictProjects: [],
      toolCalls: 0,
      rounds: null,
      ...container,
    })),
  };
}

const goldens: WeeklyPassGoldens = {
  company: "Oliver Wyman",
  projects: [
    { name: "GCC Tourism Dashboard", aliases: ["Tourism Dashboard"], parent: null },
    { name: "Injaz", aliases: ["Inaj"], parent: null },
    { name: "CAPEX Data Feed", aliases: [], parent: "DMT CAPEX Command Center" },
  ],
  junk: [{ name: "Weekly Ops Sync" }, { name: "RFP Tracker" }],
  aliases: [{ candidate: "Tourism Recovery Dashboard", of: "GCC Tourism Dashboard" }],
};

describe("weekly-pass eval scoring", () => {
  it("scores recall, junk, nesting, and alias judgment with failing names listed", () => {
    const run = evidence([
      {
        dispositions: [
          { groupKey: "g1", names: ["Tourism Dashboard"], action: "new", projectName: "GCC Tourism Dashboard" },
          { groupKey: "g2", names: ["Weekly Ops Sync"], action: "skip", reason: "recurring stream" },
          { groupKey: "g3", names: ["Tourism Recovery Dashboard"], action: "alias", targetEntityId: "e-1" },
          {
            groupKey: "g4",
            names: ["CAPEX Data Feed"],
            action: "child_of",
            projectName: "CAPEX Data Feed",
            parentName: "DMT CAPEX Command Center",
          },
          { groupKey: "g5", names: ["Inaj"], action: "new", projectName: "Injaz" },
        ],
        verdictProjects: [
          { name: "GCC Tourism Dashboard", parentName: null },
          { name: "CAPEX Data Feed", parentName: "DMT CAPEX Command Center" },
          { name: "Injaz", parentName: null },
        ],
      },
    ]);
    const scores = scoreRun(run, goldens);
    expect(scores.recall).toEqual({ hit: 3, total: 3, failing: [] });
    expect(scores.junk).toEqual({ hit: 2, total: 2, failing: [] });
    expect(scores.nesting).toEqual({ hit: 1, total: 1, failing: [] });
    expect(scores.aliasJudgment).toEqual({ hit: 1, total: 1, failing: [] });
  });

  it("junk that survives into a verdict fails; junk the judge skipped or never saw passes", () => {
    const run = evidence([
      {
        dispositions: [{ groupKey: "g1", names: ["RFP Tracker"], action: "new", projectName: "RFP Tracker" }],
        verdictProjects: [{ name: "RFP Tracker", parentName: null }],
      },
    ]);
    const scores = scoreRun(run, goldens);
    expect(scores.junk).toEqual({ hit: 1, total: 2, failing: ["RFP Tracker"] });
    expect(scores.recall.failing).toEqual(["GCC Tourism Dashboard", "Injaz", "CAPEX Data Feed"]);
    expect(scores.nesting).toEqual({ hit: 0, total: 1, failing: ["CAPEX Data Feed"] });
  });

  it("diffs two runs per metric and counts tool usage", () => {
    const baseline = evidence([
      {
        dispositions: [{ groupKey: "g1", names: ["Inaj"], action: "new", projectName: "Injaz" }],
        verdictProjects: [{ name: "Injaz", parentName: null }],
      },
    ]);
    const current = evidence([
      {
        dispositions: [
          { groupKey: "g1", names: ["Inaj"], action: "new", projectName: "Injaz" },
          {
            groupKey: "g2",
            names: ["Tourism Dashboard"],
            action: "alias",
            targetEntityId: "e-1",
            reason: "via_lookup",
          },
        ],
        verdictProjects: [{ name: "Injaz", parentName: null }],
        toolCalls: 2,
      },
    ]);
    const currentScores = scoreRun(current, goldens);
    expect(currentScores.toolUsage).toEqual({
      containersWithTools: 1,
      totalToolCalls: 2,
      dispositionsCitingLookup: 1,
    });
    const deltas = diffScores(currentScores, scoreRun(baseline, goldens));
    const recallDelta = deltas.find((delta) => delta.metric === "recall");
    expect(recallDelta).toEqual({ metric: "recall", current: "2/3", baseline: "1/3", delta: 1 });
  });
});
