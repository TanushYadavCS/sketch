import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import { describe, expect, it } from "vitest";
import { AutomationValidationError, validateAutomationBuilderSaveRequest } from "./definition";

describe("automation definition hardening", () => {
  it("does not repeat the same issue for duplicate persisted step ids", () => {
    const request = {
      title: "Duplicate step workflow",
      description: null,
      prompt: "Validate duplicate ids",
      executionMode: "deterministic",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1-5",
      timezone: "UTC",
      status: "paused",
      delivery: {
        platform: "slack",
        targetType: "dm",
        targetId: "U123",
        threadTs: null,
        mode: "silent",
      },
      steps: [
        { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
        {
          id: "action",
          type: "action",
          label: "Search",
          icon: "code",
          position: { x: 260, y: 0 },
          actionCapabilities: { sketchTools: [], usesIntegrationActions: false },
        },
        {
          id: "action",
          type: "action",
          label: "Search",
          icon: "code",
          position: { x: 260, y: 0 },
          actionCapabilities: { sketchTools: [], usesIntegrationActions: false },
        },
      ],
      edges: [],
      stepContent: {
        action: {
          taskId: "task-1",
          stepId: "action",
          contentType: "script",
          content: "return null;",
          apps: null,
        },
      },
    } as unknown as AutomationBuilderSaveRequest;

    let error: unknown;
    try {
      validateAutomationBuilderSaveRequest({ request, brokerCapable: false });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AutomationValidationError);
    expect(
      (error as AutomationValidationError).issues.filter((issue) => issue.code === "ACTION_CAPABILITIES_REQUIRED"),
    ).toHaveLength(1);
  });
});
