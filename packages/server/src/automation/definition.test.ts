import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import { describe, expect, it } from "vitest";
import { AutomationValidationError, validateAutomationBuilderSaveRequest } from "./definition";

function requestForAction(
  actionCapabilities?: AutomationBuilderSaveRequest["steps"][number]["actionCapabilities"],
): AutomationBuilderSaveRequest {
  return {
    title: "Search workflow",
    description: null,
    prompt: "Search the knowledge graph",
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
      {
        id: "trigger",
        type: "trigger",
        label: "Schedule",
        icon: "clock",
        position: { x: 0, y: 0 },
        triggerConfig: {
          type: "schedule",
          scheduleType: "cron",
          scheduleValue: "0 9 * * 1-5",
          timezone: "UTC",
        },
      },
      {
        id: "action",
        type: "action",
        label: "Search",
        icon: "code",
        position: { x: 260, y: 0 },
        ...(actionCapabilities ? { actionCapabilities } : {}),
      },
    ],
    edges: [{ id: "trigger-action", from: "trigger", to: "action" }],
    stepContent: {
      action: {
        taskId: "task-1",
        stepId: "action",
        contentType: "script",
        content: "return await ctx.tools.searchEntities({ queries: ['Acme'] });",
        apps: null,
      },
    },
  };
}

describe("automation action capability validation", () => {
  it("allows a read-only Sketch action without a broker", () => {
    expect(() =>
      validateAutomationBuilderSaveRequest({
        request: requestForAction({ sketchTools: ["searchEntities"], usesIntegrationActions: false }),
        brokerCapable: false,
      }),
    ).not.toThrow();
  });

  it("keeps legacy actions broker-required", () => {
    expect(() =>
      validateAutomationBuilderSaveRequest({ request: requestForAction(), brokerCapable: false }),
    ).toThrowError(AutomationValidationError);
    expect(() =>
      validateAutomationBuilderSaveRequest({ request: requestForAction(), brokerCapable: false }),
    ).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "BROKER_REQUIRED" })]),
      }),
    );
  });

  it("requires a capability when an action explicitly disables integrations", () => {
    expect(() =>
      validateAutomationBuilderSaveRequest({
        request: requestForAction({ sketchTools: [], usesIntegrationActions: false }),
        brokerCapable: false,
      }),
    ).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "ACTION_CAPABILITIES_REQUIRED" })]),
      }),
    );
  });

  it("rejects the legacy Sketch tool namespace", () => {
    const request = requestForAction({ sketchTools: ["searchEntities"], usesIntegrationActions: false });
    request.stepContent.action.content = "return await ctx.sketch.searchEntities({ queries: ['Acme'] });";

    expect(() => validateAutomationBuilderSaveRequest({ request, brokerCapable: false })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "SKETCH_TOOL_NAMESPACE_INVALID" })]),
      }),
    );
  });

  it("requires scripts to declare each referenced Sketch capability", () => {
    const request = requestForAction({ sketchTools: [], usesIntegrationActions: false });

    expect(() => validateAutomationBuilderSaveRequest({ request, brokerCapable: false })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "SKETCH_TOOL_NOT_DECLARED" })]),
      }),
    );
  });
});
