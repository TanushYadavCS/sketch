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
    structuredPayload: null,
    sortOrder: 0,
    ...overrides,
  };
}

describe("renderAgentOutputForDelivery", () => {
  it("renders readable Slack formatting with linked source titles and mentions", () => {
    const text = renderAgentOutputForDelivery({
      title: "Daily Brief",
      sections,
      platform: "slack",
      mentions: [{ platform: "slack", targetId: "U123", label: "Ada" }],
      output: {
        outputDate: "2026-06-26",
        masthead: { title: "Daily Brief", summary: "Start with the launch follow-up." },
        sections: { todos: [item()], customer_updates: [] },
      },
    });

    expect(text).toContain("*Daily Brief | Jun 26*");
    expect(text).toContain("Cc: <@U123>");
    expect(text).toContain("Start with the launch follow-up.");
    expect(text).toContain("*To-dos*");
    expect(text).toContain(
      "- *<https://linear.app/sketch-ai/issue/SKE-235/example|Follow up with Acme>* - Acme asked for the launch timeline.",
    );
    expect(text).toContain("_High priority / SKE-235_");
  });

  it("renders readable WhatsApp formatting with plain source URLs and text mentions", () => {
    const text = renderAgentOutputForDelivery({
      title: "Daily Brief",
      sections,
      platform: "whatsapp",
      mentions: [{ platform: "whatsapp", targetId: "+15551234567", label: "Ada Lovelace" }],
      output: {
        outputDate: "2026-06-26",
        masthead: { title: "Daily Brief", summary: "Start with the launch follow-up." },
        sections: { todos: [item()], customer_updates: [] },
      },
    });

    expect(text).toContain("*Daily Brief | Jun 26*");
    expect(text).toContain("Cc: @AdaLovelace");
    expect(text).toContain("*To-dos*");
    expect(text).toContain("- *Follow up with Acme* - Acme asked for the launch timeline.");
    expect(text).toContain("  _High priority | SKE-235_");
    expect(text).toContain("  Source: https://linear.app/sketch-ai/issue/SKE-235/example");
  });

  it("clips the masthead but delivers every item without pointing users to the web", () => {
    const text = renderAgentOutputForDelivery({
      title: "Daily Brief",
      sections,
      platform: "slack",
      output: {
        outputDate: "2026-06-26",
        masthead: { title: "Daily Brief", summary: "Long ".repeat(150) },
        sections: {
          todos: [
            item({ id: "1", title: "Item one" }),
            item({ id: "2", title: "Item two" }),
            item({ id: "3", title: "Item three" }),
            item({ id: "4", title: "Item four" }),
            item({ id: "5", title: "Item five" }),
          ],
          customer_updates: [],
        },
      },
    });

    expect(text).toContain("Long");
    expect(text).toContain("...");
    expect(text).toContain("Item one");
    expect(text).toContain("Item five");
    expect(text).not.toContain("more in Sketch");
  });

  it("drops the per-item source when it repeats the run's single source, but keeps a differing one", () => {
    const text = renderAgentOutputForDelivery({
      title: "Summarizer",
      sections,
      platform: "whatsapp",
      output: {
        outputDate: "2026-06-26",
        sourceLabel: "Habuild ORG AI",
        masthead: { title: "Habuild ORG AI", summary: "Weekly recap." },
        sections: {
          todos: [
            item({ id: "same", priority: "medium", displayRef: "Habuild ORG AI", sourceUrl: null }),
            item({ id: "other", priority: "medium", displayRef: "Ops Room", sourceUrl: null }),
          ],
          customer_updates: [],
        },
      },
    });

    expect(text).not.toContain("Habuild ORG AI");
    expect(text).toContain("  _Ops Room_");
  });

  it("escapes Slack control characters outside configured mentions", () => {
    const text = renderAgentOutputForDelivery({
      title: "Daily Brief",
      sections,
      platform: "slack",
      mentions: [
        { platform: "slack", targetId: "UCONFIGURED", label: "Configured" },
        { platform: "slack", targetId: "<!channel>", label: "Invalid" },
      ],
      output: {
        outputDate: "2026-06-26",
        masthead: { title: "Daily Brief", summary: "Do not ping <@U_OTHER> or <#C_OTHER|ops>." },
        sections: {
          todos: [
            item({
              title: "Check <@U_OTHER>",
              summary: "Avoid <@U_OTHER> and *format* injection.",
              displayRef: "<#C_OTHER|ops>",
              sourceUrl: null,
            }),
          ],
          customer_updates: [],
        },
      },
    });

    expect(text).toContain("Cc: <@UCONFIGURED>");
    expect(text).not.toContain("<@<!channel>>");
    expect(text).not.toContain("<@U_OTHER>");
    expect(text).not.toContain("<#C_OTHER|ops>");
    expect(text).toContain("(@UOTHER)");
    expect(text).toContain("(#COTHER/ops)");
  });
});
