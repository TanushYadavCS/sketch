import { describe, expect, it } from "vitest";
import { BRIEF_SECTIONS } from "./sections";

describe("BRIEF_SECTIONS", () => {
  it("surfaces durable follow-up review sections", () => {
    expect(BRIEF_SECTIONS.map((section) => section.key)).toEqual([
      "meetings",
      "todos",
      "untracked_followups",
      "looks_resolved",
      "customer_updates",
      "active_projects",
    ]);
  });
});
