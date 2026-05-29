import { describe, expect, it } from "vitest";
import {
  isHighConfidenceEndpoint,
  isHighConfidenceRelation,
  normalizeMentionType,
  normalizeRelationType,
  readRelationEndpoint,
  relationDirectionAllowed,
} from "./graph";

describe("entity graph helpers", () => {
  it("normalizes relation types", () => {
    expect(normalizeRelationType("WORKS_AT")).toBe("works_at");
    expect(normalizeRelationType(" engaged_with ")).toBe("engaged_with");
    expect(normalizeRelationType("leads")).toBe("leads");
    expect(normalizeRelationType("contributes_to")).toBe("contributes_to");
    expect(normalizeRelationType("builds")).toBe("builds");
    expect(normalizeRelationType("part_of")).toBe("part_of");
    expect(normalizeRelationType("partner_of")).toBe("partner_of");
    expect(normalizeRelationType("owns")).toBeNull();
    expect(normalizeRelationType(null)).toBeNull();
  });

  it("normalizes mention types without accepting removed types", () => {
    expect(normalizeMentionType("PERSON")).toBe("person");
    expect(normalizeMentionType(" company ")).toBe("company");
    expect(normalizeMentionType("project")).toBe("project");
    expect(normalizeMentionType("product")).toBe("product");
    expect(normalizeMentionType("team")).toBe("team");
    expect(normalizeMentionType("feature")).toBeNull();
    expect(normalizeMentionType("topic")).toBeNull();
    expect(normalizeMentionType(undefined)).toBeNull();
  });

  it("parses relation endpoints", () => {
    expect(
      readRelationEndpoint(
        {
          source: {
            name: "Sarah Chen",
            type: "person",
            variations: ["Sarah", 42, "S. Chen"],
          },
        },
        "source",
      ),
    ).toEqual({ name: "Sarah Chen", type: "person", variations: ["Sarah", "S. Chen"] });

    expect(readRelationEndpoint({}, "source")).toBeNull();
    expect(readRelationEndpoint({ source: [] }, "source")).toBeNull();
    expect(readRelationEndpoint({ source: { type: "person" } }, "source")).toBeNull();
    expect(readRelationEndpoint({ source: { name: "Atlas", type: "feature" } }, "source")).toBeNull();
  });

  it("checks relation direction rules", () => {
    expect(relationDirectionAllowed("works_at", "person", "company")).toBe(true);
    expect(relationDirectionAllowed("works_at", "company", "person")).toBe(false);

    expect(relationDirectionAllowed("engaged_with", "person", "company")).toBe(true);
    expect(relationDirectionAllowed("engaged_with", "team", "company")).toBe(true);
    expect(relationDirectionAllowed("engaged_with", "company", "person")).toBe(false);

    expect(relationDirectionAllowed("leads", "person", "project")).toBe(true);
    expect(relationDirectionAllowed("leads", "person", "product")).toBe(true);
    expect(relationDirectionAllowed("leads", "person", "team")).toBe(true);
    expect(relationDirectionAllowed("leads", "team", "project")).toBe(false);

    expect(relationDirectionAllowed("contributes_to", "person", "project")).toBe(true);
    expect(relationDirectionAllowed("contributes_to", "team", "product")).toBe(true);
    expect(relationDirectionAllowed("contributes_to", "company", "project")).toBe(false);

    expect(relationDirectionAllowed("builds", "company", "product")).toBe(true);
    expect(relationDirectionAllowed("builds", "person", "product")).toBe(false);

    expect(relationDirectionAllowed("part_of", "project", "project")).toBe(true);
    expect(relationDirectionAllowed("part_of", "product", "product")).toBe(true);
    expect(relationDirectionAllowed("part_of", "team", "company")).toBe(true);
    expect(relationDirectionAllowed("part_of", "company", "team")).toBe(false);

    expect(relationDirectionAllowed("partner_of", "company", "company")).toBe(true);
    expect(relationDirectionAllowed("partner_of", "person", "company")).toBe(false);
  });

  it("checks LLM relation confidence floors", () => {
    expect(isHighConfidenceRelation(0.85)).toBe(true);
    expect(isHighConfidenceRelation(0.849)).toBe(false);
    expect(isHighConfidenceRelation("0.9")).toBe(false);
    expect(isHighConfidenceEndpoint(0.8)).toBe(true);
    expect(isHighConfidenceEndpoint(0.799)).toBe(false);
    expect(isHighConfidenceEndpoint(null)).toBe(false);
  });
});
