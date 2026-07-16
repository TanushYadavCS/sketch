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
  it("appends a missing automation link to final text", () => {
    expect(appendAutomationBuilderLinks("Done.", [artifact])).toBe(
      "Done.\n\nOpen your automation:\n- Daily account brief: https://sketch.test/scheduled-tasks/task-123/edit",
    );
  });

  it("appends multiple missing automation links to final text", () => {
    const secondArtifact: AutomationArtifact = {
      ...artifact,
      taskId: "task-456",
      title: "Weekly pipeline review",
      builderUrl: "https://sketch.test/scheduled-tasks/task-456/edit",
    };

    expect(appendAutomationBuilderLinks("Done.", [artifact, secondArtifact])).toBe(
      "Done.\n\nOpen your automations:\n- Daily account brief: https://sketch.test/scheduled-tasks/task-123/edit\n- Weekly pipeline review: https://sketch.test/scheduled-tasks/task-456/edit",
    );
  });

  it("uses a plural heading when one automation link is present and another is appended", () => {
    const secondArtifact: AutomationArtifact = {
      ...artifact,
      taskId: "task-456",
      title: "Weekly pipeline review",
      builderUrl: "https://sketch.test/scheduled-tasks/task-456/edit",
    };
    const text = `First automation: ${artifact.builderUrl}`;

    expect(appendAutomationBuilderLinks(text, [artifact, secondArtifact])).toBe(
      `${text}\n\nOpen your automations:\n- Weekly pipeline review: https://sketch.test/scheduled-tasks/task-456/edit`,
    );
  });

  it("creates fallback text for artifact-only responses", () => {
    expect(appendAutomationBuilderLinks(null, [artifact])).toBe(
      "Your automation is ready.\n\nOpen your automation:\n- Daily account brief: https://sketch.test/scheduled-tasks/task-123/edit",
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
