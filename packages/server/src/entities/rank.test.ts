import { describe, expect, it } from "vitest";
import type { Entity } from "./propose";
import { rankPersonLlmMention } from "./rank";

function person(id: string, name: string): Entity {
  return {
    id,
    name,
    source_type: "person",
    subtype: "external",
    aliases: null,
    metadata: null,
    source_ref_id: null,
    status: "confirmed",
    provenance_tier: "inferred",
    hotness: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ai_brief: null,
    share_with_everyone: 0,
    deleted_at: null,
    merged_into_entity_id: null,
  };
}

describe("rankPersonLlmMention", () => {
  it("picks the candidate with an extracted mention on the same file", () => {
    const andreaA = person("a", "Andrea Ramos");
    const andreaB = person("b", "Andrea Roy");
    const decision = rankPersonLlmMention(
      { name: "Andrea", entityType: "person" },
      [andreaB, andreaA],
      {
        fileId: "file-1",
        extractedPersons: [{ entityId: "a" }],
        extractedCompanies: [],
        contextCompanies: [],
      },
      () => [],
    );

    expect(decision.kind).toBe("confident_match");
    if (decision.kind === "confident_match") expect(decision.entity.id).toBe("a");
  });

  it("uses works_at colocation as a confident signal", () => {
    const sarahA = person("a", "Sarah Chen");
    const sarahB = person("b", "Sarah Cheng");
    const decision = rankPersonLlmMention(
      { name: "Sarah", entityType: "person" },
      [sarahA, sarahB],
      {
        fileId: "file-1",
        extractedPersons: [],
        extractedCompanies: [{ entityId: "company-1" }],
        contextCompanies: [],
      },
      (entityId) => (entityId === "b" ? ["company-1"] : []),
    );

    expect(decision.kind).toBe("confident_match");
    if (decision.kind === "confident_match") expect(decision.entity.id).toBe("b");
  });

  it("holds close low-signal candidates as ambiguous existing", () => {
    const decision = rankPersonLlmMention(
      { name: "Sam", entityType: "person" },
      [person("a", "Sam Patel"), person("b", "Sam Prakash")],
      { fileId: "file-1", extractedPersons: [], extractedCompanies: [], contextCompanies: [] },
      () => [],
    );

    expect(decision.kind).toBe("ambiguous_existing");
  });

  it("flags overlapping candidates as ambiguous new entity when no candidate has signal", () => {
    const decision = rankPersonLlmMention(
      { name: "Sarah Cheng", entityType: "person" },
      [person("a", "Sarah C")],
      { fileId: "file-1", extractedPersons: [], extractedCompanies: [], contextCompanies: [] },
      () => [],
    );

    expect(decision.kind).toBe("ambiguous_new_entity");
  });

  it("allows clean creation when there is no token overlap", () => {
    const decision = rankPersonLlmMention(
      { name: "Priya Shah", entityType: "person" },
      [person("a", "Sarah Chen")],
      { fileId: "file-1", extractedPersons: [], extractedCompanies: [], contextCompanies: [] },
      () => [],
    );

    expect(decision.kind).toBe("confident_no_match");
  });
});
