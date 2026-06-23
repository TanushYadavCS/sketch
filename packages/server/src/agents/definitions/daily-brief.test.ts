import { describe, expect, it } from "vitest";
import { dailyBriefDefinition } from "./daily-brief";

describe("dailyBriefDefinition.buildInstructions", () => {
  it("is static and defers per-user values to the runtime context (prompt-cache safe)", () => {
    const instructions = dailyBriefDefinition.buildInstructions();

    expect(instructions).toContain("runtime context `sections`");
    expect(instructions).toContain("runtime context `maxItemsPerSection`");
    expect(instructions).toContain("`focus` field");

    expect(instructions).toContain("todos:");
    expect(instructions).toContain("customer_updates:");
    expect(instructions).toContain("active_projects:");

    expect(instructions).not.toMatch(/at most \d+ items/);
  });
});
