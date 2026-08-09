import { describe, expect, it } from "vitest";
import {
  type CompanyDedupMember,
  buildCompanyDedupGroups,
  chooseCanonicalCompany,
  ownOrgCompanyIds,
} from "./company-dedup-groups";

function member(overrides: Partial<CompanyDedupMember> & { entityId: string; name: string }): CompanyDedupMember {
  return {
    aliases: [],
    corporateDomains: [],
    mentionFileCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "confirmed",
    ownOrgSeed: false,
    ...overrides,
  };
}

function groupNames(members: CompanyDedupMember[], name: string): string[] {
  const groups = buildCompanyDedupGroups(members);
  const group = groups.find((candidate) => candidate.members.some((m) => m.name === name));
  return (group?.members ?? []).map((m) => m.name).sort();
}

describe("buildCompanyDedupGroups", () => {
  it("joins companies that share a corporate domain", () => {
    const members = [
      member({ entityId: "a", name: "Oliver Wyman", corporateDomains: ["oliverwyman.com"] }),
      member({ entityId: "b", name: "OW", corporateDomains: ["oliverwyman.com"] }),
      member({ entityId: "c", name: "Unrelated", corporateDomains: ["other.com"] }),
    ];
    expect(groupNames(members, "OW")).toEqual(["OW", "Oliver Wyman"]);
    expect(groupNames(members, "Unrelated")).toEqual(["Unrelated"]);
  });

  it("joins companies whose compact names are equal", () => {
    const members = [
      member({ entityId: "a", name: "Onestop" }),
      member({ entityId: "b", name: "One Stop" }),
      member({ entityId: "c", name: "One-Stop" }),
    ];
    expect(groupNames(members, "Onestop")).toEqual(["One Stop", "One-Stop", "Onestop"]);
  });

  it("ignores compact names shorter than the minimum key length", () => {
    const members = [member({ entityId: "a", name: "OW" }), member({ entityId: "b", name: "O.W." })];
    expect(groupNames(members, "OW")).toEqual(["OW"]);
  });

  it("joins a company whose name is another company's committed alias", () => {
    const members = [
      member({ entityId: "a", name: "Oliver Wyman", aliases: ["OW"] }),
      member({ entityId: "b", name: "ow" }),
    ];
    expect(groupNames(members, "ow")).toEqual(["Oliver Wyman", "ow"]);
  });

  it("chains shards transitively across different edge types", () => {
    const members = [
      member({ entityId: "a", name: "Canvasx", corporateDomains: ["canvasx.ai"] }),
      member({ entityId: "b", name: "Canvas X", aliases: ["Canvas Labs"] }),
      member({ entityId: "c", name: "Canvas Labs" }),
    ];
    expect(groupNames(members, "Canvasx")).toEqual(["Canvas Labs", "Canvas X", "Canvasx"]);
  });
});

describe("ownOrgCompanyIds", () => {
  it("excludes every member of a group when one member holds an org domain", () => {
    const members = [
      member({ entityId: "a", name: "Canvasx", corporateDomains: ["canvasx.ai"], ownOrgSeed: true }),
      member({ entityId: "b", name: "Canvas X" }),
      member({ entityId: "c", name: "Oliver Wyman", corporateDomains: ["oliverwyman.com"] }),
    ];
    const excluded = ownOrgCompanyIds(buildCompanyDedupGroups(members));
    expect([...excluded].sort()).toEqual(["a", "b"]);
  });
});

describe("chooseCanonicalCompany", () => {
  it("prefers a domain holder, then file mentions, then the oldest row", () => {
    const withDomain = member({
      entityId: "a",
      name: "Oliver Wyman",
      corporateDomains: ["oliverwyman.com"],
      mentionFileCount: 130,
    });
    const busier = member({ entityId: "b", name: "OW", mentionFileCount: 651 });
    const groups = buildCompanyDedupGroups([{ ...withDomain, aliases: ["OW"] }, busier]);
    expect(chooseCanonicalCompany(groups[0]).entityId).toBe("a");

    const noDomains = buildCompanyDedupGroups([
      member({ entityId: "x", name: "Onestop", mentionFileCount: 3, createdAt: "2026-05-01T00:00:00.000Z" }),
      member({ entityId: "y", name: "One Stop", mentionFileCount: 9, createdAt: "2026-06-01T00:00:00.000Z" }),
      member({ entityId: "z", name: "one-stop", mentionFileCount: 9, createdAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(chooseCanonicalCompany(noDomains[0]).entityId).toBe("z");
  });
});
