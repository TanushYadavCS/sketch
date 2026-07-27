import { describe, expect, it } from "vitest";
import {
  automationAuthoringDefinitionSchema,
  automationAuthoringOutputSchema,
  toAutomationBuilderSaveRequest,
} from "./schema";

const completeDraft = {
  title: "Weekday digest",
  description: "Summarize updates every weekday",
  prompt: "Summarize the completed workflow",
  scheduleType: "cron" as const,
  scheduleValue: "0 9 * * 1-5",
  timezone: "Asia/Kolkata",
  delivery: {
    platform: "slack" as const,
    targetType: "dm" as const,
    targetId: "U123",
    threadTs: null,
    mode: "deliver" as const,
  },
  steps: [
    {
      id: "trigger",
      type: "trigger" as const,
      label: "Weekday schedule",
      icon: "clock",
      position: { x: 0, y: 0 },
      triggerConfig: {
        type: "schedule" as const,
        scheduleType: "cron" as const,
        scheduleValue: "0 9 * * 1-5",
        timezone: "Asia/Kolkata",
      },
    },
    {
      id: "digest",
      type: "agent" as const,
      label: "Prepare digest",
      icon: "sketch-ai",
      position: { x: 260, y: 0 },
      agentMode: "sketch" as const,
    },
  ],
  edges: [{ id: "trigger-digest", from: "trigger", to: "digest" }],
  stepContent: {
    digest: {
      stepId: "digest",
      contentType: "prompt" as const,
      content: "Summarize updates and call out blockers.",
      apps: ["linear"],
    },
  },
};

describe("automation authoring schema", () => {
  it("accepts a complete replacement definition and injects server-owned fields", () => {
    const draft = automationAuthoringDefinitionSchema.parse(completeDraft);

    expect(
      toAutomationBuilderSaveRequest(draft, { taskId: "task-123", status: "paused", expectedRevision: 7 }),
    ).toMatchObject({
      expectedRevision: 7,
      status: "paused",
      title: "Weekday digest",
      stepContent: {
        digest: {
          taskId: "task-123",
          stepId: "digest",
          contentType: "prompt",
          apps: ["linear"],
        },
      },
    });
  });

  it("rejects agentModel anywhere in generated steps", () => {
    const withPinnedExecutionModel = structuredClone(completeDraft);
    Object.assign(withPinnedExecutionModel.steps[1], { agentModel: "anthropic/claude-sonnet-4.6" });

    expect(automationAuthoringDefinitionSchema.safeParse(withPinnedExecutionModel).success).toBe(false);
  });

  it("rejects model-authored operational status", () => {
    expect(
      automationAuthoringDefinitionSchema.safeParse({
        ...completeDraft,
        status: "completed",
      }).success,
    ).toBe(false);
  });

  it("rejects mismatched and orphaned generated step content", () => {
    const mismatched = structuredClone(completeDraft);
    mismatched.stepContent.digest.stepId = "other";
    const orphaned = structuredClone(completeDraft);
    Object.assign(orphaned.stepContent, {
      removed: {
        stepId: "removed",
        contentType: "prompt",
        content: "Do something",
        apps: null,
      },
    });

    expect(automationAuthoringDefinitionSchema.safeParse(mismatched).success).toBe(false);
    expect(automationAuthoringDefinitionSchema.safeParse(orphaned).success).toBe(false);
  });

  it("allows one concise clarification instead of a definition", () => {
    expect(
      automationAuthoringOutputSchema.parse({
        kind: "clarification",
        question: "Which Slack channel should receive the digest?",
      }),
    ).toEqual({
      kind: "clarification",
      question: "Which Slack channel should receive the digest?",
    });
    expect(
      automationAuthoringOutputSchema.safeParse({
        kind: "clarification",
        question: "x".repeat(241),
      }).success,
    ).toBe(false);
  });
});
