import { describe, expect, it } from "vitest";
import { renderAgentOutputForDelivery } from "./output-renderer";
import type { AgentApiItem, AgentSectionDef } from "./types";

const sections: AgentSectionDef[] = [
  { key: "todos", title: "To-dos", enabledByDefault: true, labels: [] },
  { key: "customer_updates", title: "Customer updates", enabledByDefault: true, labels: [] },
];

function item(overrides: Partial<AgentApiItem> = {}): AgentApiItem {
  return {
    id: "item-1",
    sectionKey: "todos",
    title: "Follow up with Acme",
    summary: "Acme asked for the launch timeline.",
    priority: "high",
    label: "todo",
    displayRef: "SKE-235",
    actionType: "generic",
    actionLabel: "Plan with Sketch",
    actionPrompt: "Plan the follow-up.",
    sourceUrl: "https://linear.app/sketch-ai/issue/SKE-235/example",
    knowledgeRefs: { entityIds: ["entity-1"], fileIds: [] },
    sortOrder: 0,
    ...overrides,
  };
}

describe("renderAgentOutputForDelivery", () => {
  it("renders Slack formatting with linked source titles", () => {
    const text = renderAgentOutputForDelivery({
      title: "Daily Brief",
      sections,
      platform: "slack",
      output: {
        outputDate: "2026-06-26",
        masthead: { title: "Daily Brief", summary: "Start with the launch follow-up." },
        sections: { todos: [item()], customer_updates: [] },
      },
    });

    expect(text).toContain("*Daily Brief - Jun 26*");
    expect(text).toContain("Start with the launch follow-up.");
    expect(text).toContain("*To-dos*");
    expect(text).toContain(
      "- High: <https://linear.app/sketch-ai/issue/SKE-235/example|Follow up with Acme> (SKE-235) - Acme asked for the launch timeline.",
    );
  });

  it("renders WhatsApp formatting with plain source URLs", () => {
    const text = renderAgentOutputForDelivery({
      title: "Daily Brief",
      sections,
      platform: "whatsapp",
      output: {
        outputDate: "2026-06-26",
        masthead: { title: "Daily Brief", summary: "Start with the launch follow-up." },
        sections: { todos: [item()], customer_updates: [] },
      },
    });

    expect(text).toContain("Daily Brief - Jun 26");
    expect(text).toContain("To-dos");
    expect(text).toContain("- High: Follow up with Acme (SKE-235) - Acme asked for the launch timeline.");
    expect(text).toContain("  https://linear.app/sketch-ai/issue/SKE-235/example");
  });
});
