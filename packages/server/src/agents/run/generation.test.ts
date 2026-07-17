import { describe, expect, it } from "vitest";
import type { AgentOutputItemInput, PersistedAgentOutputItemRef } from "../../db/repositories/agent-outputs";
import { pairPersistedVisibleItems, validateAgentOutputLimits } from "./generation";

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

describe("pairPersistedVisibleItems", () => {
  it("pairs persisted ids with visible items by array position, not title", () => {
    const items = [item("todos", 0), item("todos", 1)];
    items[0].title = "Same title";
    items[1].title = "Same title";
    const refs: PersistedAgentOutputItemRef[] = [
      { id: "item-a", sectionKey: "todos", sortOrder: 0 },
      { id: "item-b", sectionKey: "todos", sortOrder: 1 },
    ];

    expect(pairPersistedVisibleItems(items, refs)).toEqual([
      { id: "item-a", item: items[0] },
      { id: "item-b", item: items[1] },
    ]);
  });

  it("rejects a persisted-item mismatch instead of guessing", () => {
    expect(() =>
      pairPersistedVisibleItems([item("todos", 0)], [{ id: "wrong", sectionKey: "active_projects", sortOrder: 0 }]),
    ).toThrow("persisted item mismatch");
  });
});
