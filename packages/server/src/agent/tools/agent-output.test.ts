import { describe, expect, it } from "vitest";
import { writeAgentOutputSchema } from "./agent-output";

describe("writeAgentOutputSchema", () => {
  it("strips model-provided canonical task link fields", () => {
    const result = writeAgentOutputSchema.parse({
      outputDate: "2026-07-17",
      timezone: "UTC",
      masthead: {
        title: "Daily Brief",
        summary: "Summary",
      },
      items: [
        {
          sectionKey: "todos",
          title: "Forged task link",
          summary: "The model must not establish canonical identity.",
          priority: "medium",
          label: "todo",
          canonicalTaskId: "task-forged",
          taskId: "task-forged",
          structuredPayload: { taskId: "task-payload" },
          knowledgeRefs: { entityIds: [], fileIds: [] },
        },
      ],
    });

    expect(result.items[0]).not.toHaveProperty("canonicalTaskId");
    expect(result.items[0]).not.toHaveProperty("taskId");
    expect(result.items[0]?.structuredPayload).toEqual({ taskId: "task-payload" });
  });

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
