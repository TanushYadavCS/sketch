import { describe, expect, it } from "vitest";
import {
  type ClusterVerdict,
  channelMatchesCompany,
  chooseMajorityVerdict,
  clusterIsTriggered,
  computeTitleFamilies,
  normalizeTitleFamily,
  productNameTripwireFlags,
  readClusterVerdict,
} from "./project-minting";

type LegacyTestState = "lead" | "trial" | "customer" | "vendor" | "investor" | "none";

describe("normalizeTitleFamily", () => {
  it("collapses reply, invite, and Meet prefixes and date or counter suffixes into one family", () => {
    expect(normalizeTitleFamily("Meet – OW <> Canvas Standup").display).toBe("OW <> Canvas Standup");
    expect(normalizeTitleFamily("Re: Fwd: Contracting and proposed terms").display).toBe(
      "Contracting and proposed terms",
    );
    expect(normalizeTitleFamily("Daily Demo Insights – 2026-07-19").key).toBe(
      normalizeTitleFamily("Daily Demo Insights – 2026-08-01").key,
    );
    expect(normalizeTitleFamily("Fwd: Summary of your Gather meeting - May 1, 2026").display).toBe(
      "Summary of your Gather meeting",
    );
    expect(normalizeTitleFamily("Meet – Canvasx - OSAI - Bi-weekly Check-in - 1").key).toBe(
      normalizeTitleFamily("Canvasx - OSAI - Bi-weekly Check-in - 2").key,
    );
    expect(normalizeTitleFamily("Meet").display).toBe("Meet");
    expect(normalizeTitleFamily("Slack: #ow - 2026-06-12T17:17:00.798Z to 2026-06-12T17:28:00.331Z").key).toBe(
      normalizeTitleFamily("Slack: #ow - 2026-07-21T15:23:01.446Z").key,
    );
  });
});

describe("clusterIsTriggered", () => {
  it("fires on a title family recurring across calendar days, not on a same-day reply chain", () => {
    const sameDay = computeTitleFamilies([
      { fileName: "Re: Payroll query", source: "gmail", date: "2026-08-01T09:00:00Z" },
      { fileName: "Re: Payroll query", source: "gmail", date: "2026-08-01T11:00:00Z" },
    ]);
    const differentDays = computeTitleFamilies([
      { fileName: "Praevorium proposal discussion", source: "gmail", date: "2026-08-01T09:00:00Z" },
      { fileName: "Re: Praevorium proposal discussion", source: "gmail", date: "2026-08-03T09:00:00Z" },
    ]);

    expect(clusterIsTriggered(sameDay)).toBe(false);
    expect(clusterIsTriggered(differentDays)).toBe(true);
  });
});

describe("channelMatchesCompany", () => {
  it("requires the complete company name or alias as a contiguous token run in the channel name", () => {
    expect(channelMatchesCompany("ow", ["Oliverwyman", "OW"])).toBe(true);
    expect(channelMatchesCompany("habuild-sketch-support", ["Habuild"])).toBe(true);
    expect(channelMatchesCompany("Liquirit <> Sketch", ["Liquirit"])).toBe(true);
    expect(channelMatchesCompany("product-engineering", ["Zomato"])).toBe(false);
    expect(channelMatchesCompany("beetu-standup", ["Beet"])).toBe(false);
    expect(channelMatchesCompany("a-team", ["A"])).toBe(false);
  });
});

function axesForState(state: LegacyTestState): Pick<ClusterVerdict, "counterpartyKind" | "clientStage"> {
  if (state === "lead") return { counterpartyKind: "client", clientStage: "prospect" };
  if (state === "trial") return { counterpartyKind: "client", clientStage: "pilot" };
  if (state === "customer") return { counterpartyKind: "client", clientStage: "active" };
  if (state === "vendor") return { counterpartyKind: "vendor", clientStage: null };
  if (state === "investor") return { counterpartyKind: "investor", clientStage: null };
  return { counterpartyKind: "other", clientStage: null };
}

function verdict(state: LegacyTestState, projectNames: string[]): ClusterVerdict {
  return readClusterVerdict({
    ...axesForState(state),
    engagement: null,
    projects: projectNames.map((name) => ({
      name,
      status: "proposed" as const,
      confidence: "medium" as const,
      evidenceTitleFamilies: [],
      evidenceRepos: [],
      evidencePeople: [],
    })),
    existingEntities: [],
    trackerFit: "no_containers",
    notes: [],
  });
}

describe("productNameTripwireFlags", () => {
  it("hard-flags a product-named project under prospect and nothing under pilot", () => {
    const ownNames = ["Canvasx", "Sketch"];
    const prospect = productNameTripwireFlags(
      "prospect",
      verdict("lead", ["Sketch Platform", "Acme proposal"]).projects,
      ownNames,
    );
    expect(prospect).toEqual(["product_named_project_under_prospect:Sketch Platform"]);

    const pilot = productNameTripwireFlags(
      "pilot",
      verdict("trial", ["Sketch deployment for Acme"]).projects,
      ownNames,
    );
    expect(pilot).toEqual([]);

    const fragment = productNameTripwireFlags("prospect", verdict("lead", ["Sketchbook redesign"]).projects, ownNames);
    expect(fragment).toEqual([]);
  });
});

describe("chooseMajorityVerdict", () => {
  it("keeps the majority state with agreement metadata, deterministic on ties", () => {
    const { verdict: chosen, voteStats } = chooseMajorityVerdict([
      verdict("trial", ["Acme deployment"]),
      verdict("none", []),
      verdict("trial", ["Acme deployment", "Acme MVP"]),
    ]);
    expect(chosen.counterpartyKind).toBe("client");
    expect(chosen.clientStage).toBe("pilot");
    expect(chosen.projects.map((p) => p.name)).toEqual(["Acme deployment"]);
    expect(voteStats.axisAgreement).toBeCloseTo(2 / 3);
    expect(voteStats.projectSetAgreement).toBeCloseTo(1 / 3);
    expect(voteStats.axisCounts).toEqual({ "client:pilot": 2, "other:": 1 });
    expect(voteStats.projectNameCounts["Acme deployment"]).toBe(2);

    const tie = chooseMajorityVerdict([verdict("lead", []), verdict("customer", [])]);
    expect(tie.verdict.counterpartyKind).toBe("client");
    expect(tie.verdict.clientStage).toBe("prospect");
    expect(tie.voteStats.axisAgreement).toBeCloseTo(0.5);
  });
});
