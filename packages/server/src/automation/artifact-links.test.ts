import type { AutomationArtifact } from "@sketch/shared";
import { describe, expect, it } from "vitest";
import { appendAutomationBuilderLinks } from "./artifact-links";

const artifact: AutomationArtifact = {
  taskId: "task-123",
  kind: "New automation",
  title: "Daily account brief",
  description: "Summarizes customer updates.",
  tags: ["Scheduled", "Slack"],
  scheduleLabel: "Cron: 0 9 * * 1 (UTC)",
  deliveryLabel: "Slack DM",
  builderUrl: "https://sketch.test/scheduled-tasks/task-123/edit",
  status: "active",
};

describe("appendAutomationBuilderLinks", () => {
  it("appends missing builder links to final text", () => {
    expect(appendAutomationBuilderLinks("Done.", [artifact])).toBe(
      "Done.\n\nBuilder link:\n- Daily account brief: https://sketch.test/scheduled-tasks/task-123/edit",
    );
  });

  it("creates fallback text for artifact-only responses", () => {
    expect(appendAutomationBuilderLinks(null, [artifact])).toBe(
      "Automation created.\n\nBuilder link:\n- Daily account brief: https://sketch.test/scheduled-tasks/task-123/edit",
    );
  });

  it("does not duplicate links already present in final text", () => {
    const text = "Open https://sketch.test/scheduled-tasks/task-123/edit";
    expect(appendAutomationBuilderLinks(text, [artifact])).toBe(text);
  });

  it("does not duplicate an absolute link when the text already has the matching path", () => {
    const text = "Open /scheduled-tasks/task-123/edit";
    expect(appendAutomationBuilderLinks(text, [artifact])).toBe(text);
  });
});
