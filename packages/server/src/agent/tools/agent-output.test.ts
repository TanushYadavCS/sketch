import { describe, expect, it } from "vitest";
import { writeAgentOutputSchema } from "./agent-output";

describe("writeAgentOutputSchema", () => {
  it("rejects serialized payloads larger than 256 KiB", () => {
    const result = writeAgentOutputSchema.safeParse({
      outputDate: "2026-07-16",
      timezone: "UTC",
      masthead: {
        title: "Daily Brief",
        summary: "x".repeat(256 * 1024),
      },
      items: [],
    });

    expect(result.success).toBe(false);
  });
});
