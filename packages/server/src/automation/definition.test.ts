import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import { describe, expect, it } from "vitest";
import {
  AutomationValidationError,
  parseAutomationBuilderSaveRequest,
  validateAutomationBuilderSaveRequest,
} from "./definition";

function requestForAction(
  actionCapabilities?: AutomationBuilderSaveRequest["steps"][number]["actionCapabilities"],
): AutomationBuilderSaveRequest {
  return {
    title: "Search workflow",
    description: null,
    prompt: "Search the knowledge graph",
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

describe("automation trigger validation", () => {
  it("rejects Canvas-managed webhook triggers", () => {
    const request = requestForAction({ sketchTools: ["searchEntities"], usesIntegrationActions: false });
    request.status = "active";
    request.scheduleType = "external";
    request.scheduleValue = "canvas";
    request.steps[0] = {
      ...request.steps[0],
      triggerConfig: {
        type: "canvas",
        app: "system",
        componentKey: "webhook-trigger",
        canvasEndpoint: {
          url: "http://localhost:3000/api/workflows/test/nodes/system-1/events",
          method: "POST",
          authentication: "none",
          contentType: "application/json",
          payload: "Any JSON value",
        },
      },
    };

    expect(() => validateAutomationBuilderSaveRequest({ request, brokerCapable: false })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "CANVAS_WEBHOOK_UNSUPPORTED" })]),
      }),
    );
  });

  it("continues to allow provider-specific Canvas triggers", () => {
    const request = requestForAction({ sketchTools: ["searchEntities"], usesIntegrationActions: false });
    request.status = "active";
    request.scheduleType = "external";
    request.scheduleValue = "canvas";
    request.steps[0] = {
      ...request.steps[0],
      triggerConfig: {
        type: "canvas",
        app: "clickup",
        eventDescription: "new issue created",
        componentKey: "clickup.issue.created",
      },
    };

    expect(() => validateAutomationBuilderSaveRequest({ request, brokerCapable: false })).not.toThrow();
  });
});

describe("automation action capability validation", () => {
  it("rejects a final delivery action that returns an object", () => {
    const request = requestForAction({ sketchTools: ["searchEntities"], usesIntegrationActions: false });
    request.status = "active";
    request.delivery.mode = "deliver";
    request.stepContent.action.content = 'return { message: "Reminder: message Vedant on Slack." };';

    expect(() => validateAutomationBuilderSaveRequest({ request, brokerCapable: false })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "DELIVERY_MESSAGE_STRING_REQUIRED" })]),
      }),
    );
  });

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

  it("deduplicates identical validation issues from repeated persisted step ids", () => {
    const request = requestForAction({ sketchTools: [], usesIntegrationActions: false });
    request.steps.push({ ...request.steps[1] });

    let error: unknown;
    try {
      validateAutomationBuilderSaveRequest({ request, brokerCapable: false });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AutomationValidationError);
    const issues = (error as AutomationValidationError).issues.filter(
      (issue) => issue.code === "ACTION_CAPABILITIES_REQUIRED",
    );
    expect(issues).toHaveLength(1);
  });
});

describe("automation execution mode validation", () => {
  it("requires GitHub skill aliases to run in full Sketch mode", () => {
    const request = requestForAction();
    request.steps = [
      request.steps[0],
      {
        id: "agent",
        type: "agent",
        label: "Use GitHub",
        icon: "robot",
        position: { x: 260, y: 0 },
        agentMode: "light",
        agentSkills: ["GitHub CLI"],
      },
    ];
    request.edges = [{ id: "trigger-agent", from: "trigger", to: "agent" }];
    request.stepContent = {
      agent: {
        taskId: "task-1",
        stepId: "agent",
        contentType: "prompt",
        content: "List repositories.",
        apps: null,
      },
    };

    expect(() => validateAutomationBuilderSaveRequest({ request, brokerCapable: true })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "CLI_INTEGRATION_REQUIRES_SKETCH" })]),
      }),
    );
  });

  it("allows a fixed recipe with deterministic action and existing agent steps", () => {
    const request = requestForAction({ sketchTools: ["searchEntities"], usesIntegrationActions: false });
    request.executionMode = "deterministic";
    request.steps.push({
      id: "agent",
      type: "agent",
      label: "Summarize",
      icon: "robot",
      position: { x: 520, y: 0 },
    });
    request.edges.push({ id: "action-agent", from: "action", to: "agent" });
    request.stepContent.agent = {
      taskId: "task-1",
      stepId: "agent",
      contentType: "prompt",
      content: "Summarize the result.",
      apps: null,
    };

    expect(() => validateAutomationBuilderSaveRequest({ request, brokerCapable: true })).not.toThrow();
  });

  it("still rejects a fixed recipe made only of agent steps", () => {
    const request = requestForAction();
    request.executionMode = "deterministic";
    request.steps = [
      request.steps[0],
      {
        id: "agent",
        type: "agent",
        label: "Summarize",
        icon: "robot",
        position: { x: 260, y: 0 },
      },
    ];
    request.edges = [{ id: "trigger-agent", from: "trigger", to: "agent" }];
    request.stepContent = {
      agent: {
        taskId: "task-1",
        stepId: "agent",
        contentType: "prompt",
        content: "Summarize the result.",
        apps: null,
      },
    };
    request.status = "active";

    expect(() => validateAutomationBuilderSaveRequest({ request, brokerCapable: false })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "DETERMINISTIC_MODE_AGENT_STEP", path: "steps.agent" }),
        ]),
      }),
    );
  });

  it("rejects action steps in agent-led mode", () => {
    const request = requestForAction({ sketchTools: ["searchEntities"], usesIntegrationActions: false });
    request.executionMode = "agent-led";
    request.status = "active";

    expect(() => validateAutomationBuilderSaveRequest({ request, brokerCapable: false })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "AGENT_LED_MODE_ACTION_STEP", path: "steps.action" }),
        ]),
      }),
    );
  });

  it("keeps mixed steps valid in hybrid mode", () => {
    const request = requestForAction({ sketchTools: ["searchEntities"], usesIntegrationActions: false });
    request.executionMode = "hybrid";
    request.steps.push({
      id: "agent",
      type: "agent",
      label: "Summarize",
      icon: "robot",
      position: { x: 520, y: 0 },
    });
    request.edges.push({ id: "action-agent", from: "action", to: "agent" });
    request.stepContent.agent = {
      taskId: "task-1",
      stepId: "agent",
      contentType: "prompt",
      content: "Summarize the result.",
      apps: null,
    };

    expect(() => validateAutomationBuilderSaveRequest({ request, brokerCapable: false })).not.toThrow();
  });

  it("backfills the hybrid mode for a legacy save payload", () => {
    const request = requestForAction({ sketchTools: ["search"], usesIntegrationActions: false });
    const { executionMode: _executionMode, ...legacyPayload } = request;

    expect(parseAutomationBuilderSaveRequest(legacyPayload).executionMode).toBe("hybrid");
  });
});
