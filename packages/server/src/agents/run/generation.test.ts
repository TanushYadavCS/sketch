import { describe, expect, it } from "vitest";
import type { AgentOutputItemInput } from "../../db/repositories/agent-outputs";
import { validateAgentOutputLimits } from "./generation";

function item(sectionKey: string, index: number): AgentOutputItemInput {
  return {
    sectionKey,
    title: `${sectionKey} ${index}`,
    summary: "Summary",
    priority: "medium",
    label: "item",
    knowledgeRefs: { entityIds: [], fileIds: [] },
    sortOrder: index,
  };
}

describe("validateAgentOutputLimits", () => {
  it("rejects visible sections over their configured item cap", () => {
    expect(() =>
      validateAgentOutputLimits({
        items: [item("todos", 0), item("todos", 1), item("todos", 2)],
        visibleSectionKeys: new Set(["todos"]),
        internalSectionKeys: new Set(),
        maxItemsPerSection: 2,
      }),
    ).toThrow("todos");
  });

  it("rejects internal task sections over twenty-five items", () => {
    expect(() =>
      validateAgentOutputLimits({
        items: Array.from({ length: 26 }, (_, index) => item("task_candidates", index)),
        visibleSectionKeys: new Set(),
        internalSectionKeys: new Set(["task_candidates"]),
        maxItemsPerSection: 10,
      }),
    ).toThrow("task_candidates");
  });

  it("rejects more than twenty-five internal task items across candidate and change sections", () => {
    expect(() =>
      validateAgentOutputLimits({
        items: [
          ...Array.from({ length: 13 }, (_, index) => item("task_candidates", index)),
          ...Array.from({ length: 13 }, (_, index) => item("task_changes", index)),
        ],
        visibleSectionKeys: new Set(),
        internalSectionKeys: new Set(["task_candidates", "task_changes"]),
        maxItemsPerSection: 10,
      }),
    ).toThrow("25-item");
  });
});
