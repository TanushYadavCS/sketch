import { describe, expect, it } from "vitest";
import { isGenericEngagementName } from "./engagement-name-filter";

describe("isGenericEngagementName", () => {
  it("drops generic engagement names and process phrases while preserving named engagements", () => {
    expect(isGenericEngagementName("Cloud")).toBe(true);
    expect(isGenericEngagementName("Priority RFPs follow-ups")).toBe(true);
    expect(isGenericEngagementName("Maaden Dashboard")).toBe(false);
    expect(isGenericEngagementName("AI Engineer Support")).toBe(false);
  });
});
