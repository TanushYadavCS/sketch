import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { withActiveRun } from "../agent/active-runs";
import { runAgentRuntimeCore } from "../agent/runtime/core";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "../agent/runtime/pricing";
import { MAX_AUTOMATION_OUTPUT_BYTES } from "../automation/capabilities";
import type { ScheduledTaskRow } from "../db/repositories/scheduled-tasks";
import {
  executeAutomation,
  resolveAutomationWorkspaceDir,
  testAutomationStep,
  validateRuntimeAutomationExecutionMode,
} from "./runtime";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      throw new Error("child_process.spawn should not be called by workflow action steps");
    }),
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn().mockImplementation(() => {
    return (async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "light result" }] },
      };
      yield { type: "result", session_id: "sess-light", total_cost_usd: 0 };
    })();
  }),
}));

vi.mock("../agent/runtime/core", () => ({
  runAgentRuntimeCore: vi.fn().mockResolvedValue({
    sessionId: "aisdk-session",
    finalText: "aisdk result",
    stopReason: "end_turn",
    num_turns: 1,
    durations: { totalMs: 10, providerMs: 5 },
    usage: {
      byModel: {
        "claude-sonnet-4-6": {
          inputTokens: 10,
          outputTokens: 3,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
      },
      totalInputTokens: 10,
      totalOutputTokens: 3,
      totalCacheReadTokens: 2,
      totalCacheWriteTokens: 1,
    },
    cost: { totalUsd: 0.001, byModel: {}, pricing: {} },
  }),
}));

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    platform: "slack",
    context_type: "dm",
    delivery_target: "D123",
    thread_ts: null,
    prompt: "Daily workflow planning summary",
    schedule_type: "cron",
    schedule_value: "0 9 * * *",
    timezone: "Asia/Kolkata",
    session_mode: "fresh",
    status: "active",
    created_by: "user-1",
    created_at: "2026-04-27T09:00:00.000Z",
    next_run_at: null,
    last_run_at: null,
    title: "Daily workflow planning summary",
    description: null,
    steps: JSON.stringify([
      { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
      {
        id: "step1",
        type: "agent",
        label: "Summarize Linear issues",
        icon: "sketch-ai",
        position: { x: 0, y: 100 },
        agentMode: "sketch",
        agentModel: "claude-test-model",
      },
    ]),
    edges: null,
    output_target: null,
    output_platform: null,
    output_mode: "deliver",
    ...overrides,
  };
}

function makeParams(overrides: Record<string, unknown> = {}) {
  const runsRepo = {
    create: vi.fn().mockResolvedValue("run-1"),
    update: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };
  const stepContentRepo = {
    getByTask: vi.fn().mockResolvedValue([
      {
        task_id: "task-1",
        step_id: "step1",
        content_type: "prompt",
        content: "Summarize the open workflow-related Linear issues and recommend next actions.",
        apps: null,
        updated_at: "2026-04-27T09:00:00.000Z",
      },
    ]),
  };
  const userRepo = {
    list: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue({
      id: "user-1",
      name: "Roopak",
      email: "roopak@canvasx.ai",
      slack_user_id: "U123",
      whatsapp_number: null,
      type: "human",
      role: null,
      description: null,
    }),
    getAllEmailsForUser: vi.fn().mockResolvedValue(["roopak@canvasx.ai"]),
  };

  return {
    task: makeTask(),
    triggerData: { scheduledAt: "2026-04-27T09:30:00.000Z", taskId: "task-1" },
    db: {} as never,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    config: {
      DATA_DIR: "/tmp/sketch-runtime-test",
      CLAUDE_CONFIG_DIR: "/tmp/sketch-runtime-test/.claude",
      BASE_URL: "https://sketch.test",
      PORT: 3000,
      AGENT_RUNTIME: "sdk",
    },
    runsRepo,
    stepContentRepo,
    loadIntegrationProvider: vi.fn().mockResolvedValue(null),
    userRepo,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
    _runsRepo: runsRepo,
    _stepContentRepo: stepContentRepo,
    _userRepo: userRepo,
  };
}

function makeBrokerProvider(overrides: Record<string, unknown> = {}) {
  return {
    type: "canvas",
    listApps: async () => ({ apps: [], pageInfo: { endCursor: null, hasMore: false } }),
    initiateConnection: async () => ({ redirectUrl: "" }),
    listConnections: async () => [],
    removeConnection: async () => {},
    isBrokerCapable: () => true,
    getBrokerSpec: () => ({
      cliPath: "/tmp/fake-canvas-cli.js",
      credentialEnv: {
        CANVAS_API_KEY_MCP: "secret-key",
        CANVAS_USER_EMAIL: "roopak@canvasx.ai",
      },
      launcherEnvName: "CANVAS_CLI",
    }),
    ...overrides,
  };
}

function makeActionTask(steps: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return makeTask({
    ...overrides,
    steps: JSON.stringify([
      { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
      ...steps,
    ]),
  });
}

describe("automation execution mode runtime guard", () => {
  it("blocks agent steps in fixed recipe mode", () => {
    expect(() =>
      validateRuntimeAutomationExecutionMode("deterministic", [
        { id: "agent", type: "agent", label: "Summarize", icon: "robot", position: { x: 0, y: 0 } },
      ]),
    ).toThrow('cannot run agent step "Summarize"');
  });

  it("blocks action steps in agent-led mode", () => {
    expect(() =>
      validateRuntimeAutomationExecutionMode("agent-led", [
        { id: "action", type: "action", label: "Send update", icon: "code", position: { x: 0, y: 0 } },
      ]),
    ).toThrow('cannot run code or action step "Send update"');
  });

  it("allows a mixed recipe in hybrid mode", () => {
    expect(() =>
      validateRuntimeAutomationExecutionMode("hybrid", [
        { id: "action", type: "action", label: "Normalize", icon: "code", position: { x: 0, y: 0 } },
        { id: "agent", type: "agent", label: "Summarize", icon: "robot", position: { x: 0, y: 100 } },
      ]),
    ).not.toThrow();
  });
});

function makeStepContent(rows: Array<{ stepId: string; content: string; contentType?: "prompt" | "script" }>) {
  return {
    getByTask: vi.fn().mockResolvedValue(
      rows.map((row) => ({
        task_id: "task-1",
        step_id: row.stepId,
        content_type: row.contentType ?? "script",
        content: row.content,
        apps: null,
        updated_at: "2026-04-27T09:00:00.000Z",
      })),
    ),
  };
}

describe("executeAutomation stopped Sketch agent steps", () => {
  it.each([
    {
      outcome: "returned an aborted result",
      runAgent: vi.fn().mockResolvedValue({
        pendingUploads: [],
        trace: { finalText: "partial output" },
        rawUsage: { stopReason: "aborted", toolCalls: [] },
      }),
    },
    {
      outcome: "threw after its abort controller fired",
      runAgent: vi.fn().mockImplementation(async (agentParams) => {
        agentParams.abortController?.abort();
        throw new Error("Claude SDK aborted");
      }),
    },
  ])("stops later steps when the Sketch agent $outcome on both runtimes", async ({ runAgent }) => {
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const params = makeParams({
      logger,
      runAgent,
      propagateParentAbort: true,
      parentAbortSignal: new AbortController().signal,
      task: makeActionTask([
        {
          id: "agent1",
          type: "agent",
          label: "Research",
          icon: "sketch-ai",
          position: { x: 0, y: 100 },
          agentMode: "sketch",
        },
        { id: "later", type: "action", label: "Send ticket", icon: "code", position: { x: 0, y: 200 } },
      ]),
      stepContentRepo: makeStepContent([
        { stepId: "agent1", content: "Research the issue.", contentType: "prompt" },
        { stepId: "later", content: 'return "sent";' },
      ]),
    });

    for (const runtime of ["sdk", "aisdk"] as const) {
      params.config.AGENT_RUNTIME = runtime;
      const result = await executeAutomation(params as never);

      expect(result.status).toBe("failed");
      expect(result.stepOutputs.agent1?.status).toBe("failed");
      expect(result.stepOutputs.later?.status).toBe("skipped");
      expect(params.sendMessage).not.toHaveBeenCalled();
      expect(params._runsRepo.update).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          status: "failed",
          errorMessage: expect.stringContaining("aborted"),
          completedAt: expect.any(String),
        }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ stepId: "agent1" }),
        "Automation: execution stopped by user",
      );
      expect(logger.error).not.toHaveBeenCalled();
    }
  });
});

describe("executeAutomation agent steps", () => {
  it("links an interactive workflow child to its Slack parent without sharing its controller", async () => {
    const parentController = new AbortController();
    let childController: AbortController | undefined;
    const runAgent = vi.fn().mockImplementation(async (params) => {
      childController = params.abortController;
      return {
        pendingUploads: [],
        trace: { finalText: "sketch result" },
        rawUsage: { toolCalls: [] },
      };
    });
    const params = makeParams({
      runAgent,
      propagateParentAbort: true,
      parentAbortSignal: parentController.signal,
    });

    await withActiveRun("workflow-parent", parentController, () => executeAutomation(params as never), {
      platform: "slack",
      channelId: "D123",
      threadTs: null,
    });

    expect(childController).toBeInstanceOf(AbortController);
    expect(childController).not.toBe(parentController);
    parentController.abort();
    expect(childController?.signal.aborted).toBe(true);
  });

  /**
   * "Run my automation now" from a thread is reentrant under that run, but the automation's own
   * delivery target is configured at creation time and often points elsewhere. Linking must follow
   * causation, or a user could start work from a thread and then be unable to stop it.
   */
  it("links a child whose automation delivers somewhere other than the triggering thread", async () => {
    const parentController = new AbortController();
    let childController: AbortController | undefined;
    const runAgent = vi.fn().mockImplementation(async (params) => {
      childController = params.abortController;
      return {
        pendingUploads: [],
        trace: { finalText: "sketch result" },
        rawUsage: { toolCalls: [] },
      };
    });
    const params = makeParams({
      runAgent,
      propagateParentAbort: true,
      parentAbortSignal: parentController.signal,
    });

    await withActiveRun("workflow-parent", parentController, () => executeAutomation(params as never), {
      platform: "slack",
      channelId: "C_SOMEWHERE_ELSE",
      threadTs: "9999.0000",
    });

    expect(childController).toBeInstanceOf(AbortController);
    parentController.abort();
    expect(childController?.signal.aborted).toBe(true);
  });

  it("does not link scheduled workflow execution to an interactive parent", async () => {
    const parentController = new AbortController();
    const runAgent = vi.fn().mockResolvedValue({
      pendingUploads: [],
      trace: { finalText: "sketch result" },
      rawUsage: { toolCalls: [] },
    });
    const params = makeParams({ runAgent, propagateParentAbort: false });

    await withActiveRun("scheduled-parent", parentController, () => executeAutomation(params as never), {
      platform: "slack",
      channelId: "D123",
      threadTs: null,
    });

    expect(runAgent.mock.calls[0]?.[0].abortController).toBeUndefined();
  });

  it("defaults scheduled agent steps without an explicit mode to the Sketch runtime", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      pendingUploads: [],
      trace: { finalText: "sketch result" },
      rawUsage: { toolCalls: [] },
    });
    const params = makeParams({
      runAgent,
      task: makeTask({
        steps: JSON.stringify([
          { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
          {
            id: "step1",
            type: "agent",
            label: "Summarize Linear issues",
            icon: "sketch-ai",
            position: { x: 0, y: 100 },
          },
        ]),
      }),
    });

    await executeAutomation(params as never);

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        contextType: "scheduled_task",
        currentUserId: "user-1",
        sessionMode: "fresh",
      }),
    );
    expect(params.sendMessage).toHaveBeenCalledWith("sketch result");
  });

  it("does not deliver successful final output for silent workflows", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      pendingUploads: [],
      trace: { finalText: "sketch result" },
      rawUsage: { toolCalls: [] },
    });
    const params = makeParams({
      runAgent,
      task: makeTask({ output_mode: "silent" }),
    });

    await executeAutomation(params as never);

    expect(params.sendMessage).not.toHaveBeenCalled();
  });

  it("routes sketch-mode agent steps through runAgent with workflow context", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      pendingUploads: [],
      trace: { finalText: "sketch result" },
      rawUsage: { toolCalls: [] },
    });
    const buildMcpServers = vi.fn().mockResolvedValue({ canvas: { type: "http", url: "https://mcp.test" } });
    const sendDm = vi.fn();
    const inboxMessagesRepo = {};
    const params = makeParams({ runAgent, buildMcpServers, sendDm, inboxMessagesRepo });

    await executeAutomation(params as never);

    expect(runAgent).toHaveBeenCalledTimes(1);
    const call = runAgent.mock.calls[0][0];
    expect(call.workspaceKey).toBe("user-1");
    expect(call.workspaceDir).toBe("/tmp/sketch-runtime-test/workspaces/user-1");
    expect(call.sessionMode).toBe("fresh");
    expect(call.contextType).toBe("scheduled_task");
    expect(call.currentUserId).toBe("user-1");
    expect(call.model).toBe("claude-test-model");
    expect(call.maxTurns).toBe(50);
    expect(call.integrationMcpServers).toEqual({ canvas: { type: "http", url: "https://mcp.test" } });
    expect(call.userRepo).toBe(params._userRepo);
    expect(call.inboxMessagesRepo).toBe(inboxMessagesRepo);
    expect(call.sendDm).toBe(sendDm);
    expect(call.scheduler).toBeUndefined();
    expect(call.taskContext).toEqual({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "D123",
      createdBy: "user-1",
    });
    expect(call.userMessage).toContain("<task>Daily workflow planning summary</task>");
    expect(call.userMessage).toContain("You are executing one step of a scheduled workflow.");
    expect(call.userMessage).toContain("Step: Summarize Linear issues");
    expect(call.userMessage).toContain("Step prompt:");
    expect(call.userMessage).toContain("Input from previous step:");
    expect(params.sendMessage).toHaveBeenCalledWith("sketch result");
  });

  it("passes the resolved CLI environment to sketch-mode agent steps", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      pendingUploads: [],
      trace: { finalText: "sketch result" },
      rawUsage: { toolCalls: [] },
    });
    const listAgentEnvForRuntime = vi.fn().mockResolvedValue({ GH_TOKEN: "managed-token" });
    const params = makeParams({ runAgent, listAgentEnvForRuntime });

    await executeAutomation(params as never);

    expect(runAgent.mock.calls[0]?.[0].agentEnv).toEqual({ GH_TOKEN: "managed-token" });
    expect(listAgentEnvForRuntime).toHaveBeenCalledWith({
      currentUserId: "user-1",
      contextType: "scheduled_task",
      allowOrgSharedEnv: true,
      taskContext: { platform: "slack", contextType: "dm", deliveryTarget: "D123", createdBy: "user-1" },
    });
  });

  it("keeps channel task context for creator-less sketch-mode agent steps", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      pendingUploads: [],
      trace: { finalText: "sketch result" },
      rawUsage: { toolCalls: [] },
    });
    const params = makeParams({
      runAgent,
      task: makeTask({
        platform: "slack",
        context_type: "channel",
        delivery_target: "C123",
        created_by: null,
      }),
    });

    await executeAutomation(params as never);

    const call = runAgent.mock.calls[0][0];
    expect(call.currentUserId).toBeNull();
    expect(call.taskContext).toEqual({
      platform: "slack",
      contextType: "channel",
      deliveryTarget: "C123",
      createdBy: null,
    });
  });

  it("keeps light-mode agent steps on the lightweight SDK path", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockClear();
    const runAgent = vi.fn();
    const limitAgentExecution = vi.fn((work: () => Promise<unknown>) => work());
    const params = makeParams({
      runAgent,
      limitAgentExecution,
      task: makeTask({
        steps: JSON.stringify([
          { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
          {
            id: "step1",
            type: "agent",
            label: "Summarize Linear issues",
            icon: "sketch-ai",
            position: { x: 0, y: 100 },
            agentMode: "light",
          },
        ]),
      }),
    });

    await executeAutomation(params as never);

    expect(runAgent).not.toHaveBeenCalled();
    expect(limitAgentExecution).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const queryCall = queryMock.mock.calls[0]?.[0];
    if (!queryCall?.options) throw new Error("Expected query call options");
    expect(queryCall.prompt).toContain("Summarize the open workflow-related Linear issues");
    const { options } = queryCall;
    expect(options).toMatchObject({
      maxTurns: 10,
      cwd: "/tmp/sketch-runtime-test/workspaces/user-1",
      permissionMode: "bypassPermissions",
      settingSources: [],
      stderr: expect.any(Function),
    });
    expect(options.systemPrompt).toContain("You are a workflow step in an automation.");
    expect(options).not.toHaveProperty("mcpServers");
    expect(options).not.toHaveProperty("tools");
    expect(options).not.toHaveProperty("canUseTool");
    expect(params.sendMessage).toHaveBeenCalledWith("light result");
  });

  it("routes light-mode agent steps through the AI SDK runtime when flagged", async () => {
    const queryMock = vi.mocked(query);
    queryMock.mockClear();
    const runtimeMock = vi.mocked(runAgentRuntimeCore);
    runtimeMock.mockClear();
    const runAgent = vi.fn();
    const recordWorkflowStep = vi.fn();
    const params = makeParams({
      runAgent,
      recordWorkflowStep,
      loadAgentRuntimeProviderConfig: vi.fn().mockResolvedValue({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        apiKey: "sk-ant-test",
        costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
      }),
      config: {
        DATA_DIR: "/tmp/sketch-runtime-test",
        CLAUDE_CONFIG_DIR: "/tmp",
        BASE_URL: "https://sketch.test",
        PORT: 3000,
        AGENT_RUNTIME: "aisdk",
      },
      task: makeTask({
        steps: JSON.stringify([
          { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
          {
            id: "step1",
            type: "agent",
            label: "Summarize Linear issues",
            icon: "sketch-ai",
            position: { x: 0, y: 100 },
            agentMode: "light",
          },
        ]),
      }),
    });

    await executeAutomation(params as never);

    expect(runAgent).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(runtimeMock).toHaveBeenCalledTimes(1);
    expect(runtimeMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining("Summarize the open workflow-related Linear issues"),
        systemPrompt: expect.stringContaining("You are a workflow step in an automation."),
        maxTurns: 10,
        persistSession: false,
      }),
    );
    expect(Object.keys(runtimeMock.mock.calls[0]?.[0].tools ?? {}).sort()).toEqual([
      "Bash",
      "Edit",
      "Glob",
      "Grep",
      "Read",
      "Write",
    ]);
    expect(recordWorkflowStep).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "slack", contextType: "scheduled_task", workspaceKey: "user-1" }),
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        inputTokens: 10,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheCreationTokens: 1,
        sdkCostUsd: 0.001,
      }),
    );
    expect(params.sendMessage).toHaveBeenCalledWith("aisdk result");
  });

  it("keeps running when execution event delivery fails", async () => {
    const onEvent = vi.fn().mockRejectedValue(new Error("stream closed"));
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const params = makeParams({
      logger,
      onEvent,
      task: makeTask({
        steps: JSON.stringify([
          { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
          {
            id: "step1",
            type: "agent",
            label: "Summarize Linear issues",
            icon: "sketch-ai",
            position: { x: 0, y: 100 },
            agentMode: "light",
          },
        ]),
      }),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toBe("light result");
    expect(params._runsRepo.update).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "completed", stepOutputs: expect.any(Object) }),
    );
    expect(params.sendMessage).toHaveBeenCalledWith("light result");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "run.started" }),
      "Automation: execution event delivery failed",
    );
  });
});

describe("testAutomationStep", () => {
  it("builds a representative Slack channel-message payload for trigger step tests", async () => {
    const params = makeParams({
      task: makeTask({
        steps: JSON.stringify([
          {
            id: "trigger",
            type: "trigger",
            label: "Slack message",
            icon: "slack",
            position: { x: 0, y: 0 },
            triggerConfig: { type: "slack_channel_message", channelId: "C123" },
          },
        ]),
      }),
    });

    const result = await testAutomationStep({ ...params, stepId: "trigger" } as never);

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({
      type: "slack_channel_message",
      taskId: "task-1",
      channelId: "C123",
      messageTs: "1710000000.000000",
      text: "Example Slack channel message",
      userId: "U123456",
      botId: null,
      appId: null,
      subtype: null,
      files: [],
      capturedMessageId: null,
      conversationId: "C123",
    });
  });

  it("uses the latest completed upstream output instead of the current step-test run", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      pendingUploads: [],
      trace: { finalText: "step two result" },
      rawUsage: { toolCalls: [] },
    });
    const params = makeParams({
      runAgent,
      task: makeTask({
        steps: JSON.stringify([
          { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
          {
            id: "step1",
            type: "agent",
            label: "Collect accounts",
            icon: "sketch-ai",
            position: { x: 0, y: 100 },
            agentMode: "sketch",
          },
          {
            id: "step2",
            type: "agent",
            label: "Summarize accounts",
            icon: "sketch-ai",
            position: { x: 0, y: 200 },
            agentMode: "sketch",
          },
        ]),
        edges: JSON.stringify([
          { id: "trigger-step1", from: "trigger", to: "step1" },
          { id: "step1-step2", from: "step1", to: "step2" },
        ]),
      }),
      stepContentRepo: {
        getByTask: vi.fn().mockResolvedValue([
          {
            task_id: "task-1",
            step_id: "step2",
            content_type: "prompt",
            content: "Summarize the upstream account list.",
            apps: null,
            updated_at: "2026-04-27T09:00:00.000Z",
          },
        ]),
      },
    });
    params._runsRepo.create.mockResolvedValue("run-current");
    params._runsRepo.list.mockResolvedValue([
      {
        id: "run-current",
        task_id: "task-1",
        status: "running",
        step_outputs: "{}",
        trigger_data: null,
        error_message: null,
        started_at: "2026-06-01T00:00:02.000Z",
        completed_at: null,
      },
      {
        id: "run-previous",
        task_id: "task-1",
        status: "completed",
        step_outputs: JSON.stringify({
          step1: { status: "completed", output: { accounts: ["Acme"] }, duration_ms: 12 },
        }),
        trigger_data: null,
        error_message: null,
        started_at: "2026-06-01T00:00:01.000Z",
        completed_at: "2026-06-01T00:00:01.500Z",
      },
    ]);

    await testAutomationStep({
      ...params,
      stepId: "step2",
      useLatestUpstreamOutput: true,
    } as never);

    expect(runAgent.mock.calls[0][0].userMessage).toContain('"accounts": [');
    expect(runAgent.mock.calls[0][0].userMessage).toContain('"Acme"');
  });
});

describe("executeAutomation action steps", () => {
  it("uses a reserved run ID and sends one sanitized manual failure notification", async () => {
    const params = makeParams({
      runId: "reserved-run-1",
      runMode: "manual",
      task: makeActionTask([{ id: "act1", type: "action", label: "Fail", icon: "code", position: { x: 0, y: 100 } }]),
      stepContentRepo: makeStepContent([{ stepId: "act1", content: 'throw new Error("secret provider detail");' }]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider()),
    });

    const result = await executeAutomation(params as never);

    expect(result).toMatchObject({ runId: "reserved-run-1", status: "failed" });
    expect(params._runsRepo.create).not.toHaveBeenCalled();
    expect(params._runsRepo.update).toHaveBeenCalledWith(
      "reserved-run-1",
      expect.objectContaining({ errorMessage: expect.stringContaining("secret provider detail") }),
    );
    expect(params.sendMessage).toHaveBeenCalledTimes(1);
    expect(params.sendMessage).toHaveBeenCalledWith(
      "Automation “Daily workflow planning summary” failed. View run: https://sketch.test/scheduled-tasks/task-1/edit?runId=reserved-run-1",
    );
    expect(params.sendMessage).not.toHaveBeenCalledWith(expect.stringContaining("secret provider detail"));
  });

  it("records a failed run without executing a malformed persisted definition", async () => {
    const runAgent = vi.fn();
    const params = makeParams({
      runAgent,
      task: makeTask({ steps: "not-json" }),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    expect(result.finalOutput).toBeNull();
    expect(result.stepOutputs).toEqual({});
    expect(runAgent).not.toHaveBeenCalled();
    expect(params._runsRepo.update).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        status: "failed",
        errorMessage: expect.stringContaining("Automation definition is invalid"),
      }),
    );
  });

  it("runs a read-only Sketch tool action without a Canvas broker", async () => {
    const searchEntities = vi.fn().mockResolvedValue([{ id: "entity-acme", name: "Acme" }]);
    const automationCapabilityRegistry = {
      createTools: vi.fn().mockReturnValue({ searchEntities }),
    };
    const loadIntegrationProvider = vi.fn().mockResolvedValue(null);
    const params = makeParams({
      task: makeActionTask(
        [
          {
            id: "act1",
            type: "action",
            label: "Find Acme",
            icon: "magnifying-glass",
            position: { x: 0, y: 100 },
            actionCapabilities: { sketchTools: ["searchEntities"], usesIntegrationActions: false },
          },
        ],
        { output_mode: "silent" },
      ),
      stepContentRepo: makeStepContent([
        {
          stepId: "act1",
          content: `
            const entities = await ctx.tools.searchEntities({ queries: ["Acme"] });
            return { entities, hasCanvasCli: Boolean(ctx.env.CANVAS_CLI) };
          `,
        },
      ]),
      loadIntegrationProvider,
      automationCapabilityRegistry,
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({
      entities: [{ id: "entity-acme", name: "Acme" }],
      hasCanvasCli: false,
    });
    expect(searchEntities).toHaveBeenCalledWith({ queries: ["Acme"] });
    expect(loadIntegrationProvider).not.toHaveBeenCalled();
    expect(automationCapabilityRegistry.createTools).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTools: ["searchEntities"] }),
    );
  });

  it("runs a managed GitHub CLI action without a Canvas broker", async () => {
    const loadIntegrationProvider = vi.fn().mockResolvedValue(null);
    const listAgentEnvForRuntime = vi.fn().mockResolvedValue({
      GH_TOKEN: "managed-token",
      OTHER_SAFE_VALUE: "safe-value",
    });
    const params = makeParams({
      task: makeActionTask(
        [
          {
            id: "act1",
            type: "action",
            label: "List GitHub pull requests",
            icon: "github",
            position: { x: 0, y: 100 },
            actionCapabilities: { sketchTools: [], usesIntegrationActions: false, cliIntegrations: ["github"] },
          },
        ],
        { output_mode: "silent" },
      ),
      stepContentRepo: makeStepContent([
        {
          stepId: "act1",
          content: "return { token: ctx.env.GH_TOKEN, safeValue: ctx.env.OTHER_SAFE_VALUE };",
        },
      ]),
      loadIntegrationProvider,
      listAgentEnvForRuntime,
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({ token: "managed-token", safeValue: "safe-value" });
    expect(loadIntegrationProvider).not.toHaveBeenCalled();
    expect(listAgentEnvForRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ currentUserId: "user-1", contextType: "scheduled_task" }),
    );
  });

  it("strips managed CLI credentials from actions that do not declare them", async () => {
    const loadIntegrationProvider = vi.fn().mockResolvedValue(makeBrokerProvider());
    const listAgentEnvForRuntime = vi.fn().mockResolvedValue({ GH_TOKEN: "managed-token" });
    const params = makeParams({
      task: makeActionTask(
        [
          {
            id: "act1",
            type: "action",
            label: "Inspect environment",
            icon: "code",
            position: { x: 0, y: 100 },
            actionCapabilities: { sketchTools: [], usesIntegrationActions: true },
          },
        ],
        { output_mode: "silent" },
      ),
      stepContentRepo: makeStepContent([{ stepId: "act1", content: "return Boolean(ctx.env.GH_TOKEN);" }]),
      loadIntegrationProvider,
      listAgentEnvForRuntime,
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toBe(false);
    expect(loadIntegrationProvider).toHaveBeenCalledTimes(1);
  });

  it("fails a CLI action clearly when its managed connection is unavailable", async () => {
    const loadIntegrationProvider = vi.fn().mockResolvedValue(null);
    const listAgentEnvForRuntime = vi.fn().mockResolvedValue({});
    const params = makeParams({
      task: makeActionTask(
        [
          {
            id: "act1",
            type: "action",
            label: "List GitHub pull requests",
            icon: "github",
            position: { x: 0, y: 100 },
            actionCapabilities: { sketchTools: [], usesIntegrationActions: false, cliIntegrations: ["github"] },
          },
        ],
        { output_mode: "silent" },
      ),
      stepContentRepo: makeStepContent([{ stepId: "act1", content: 'return "should not run";' }]),
      loadIntegrationProvider,
      listAgentEnvForRuntime,
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    expect(result.stepOutputs.act1.error?.message).toContain("requires an active managed CLI integration: GitHub");
    expect(loadIntegrationProvider).not.toHaveBeenCalled();
  });

  it("fails action steps that use the legacy Sketch tool namespace", async () => {
    const automationCapabilityRegistry = { createTools: vi.fn() };
    const loadIntegrationProvider = vi.fn().mockResolvedValue(null);
    const params = makeParams({
      task: makeActionTask(
        [
          {
            id: "act1",
            type: "action",
            label: "Find Acme",
            icon: "magnifying-glass",
            position: { x: 0, y: 100 },
            actionCapabilities: { sketchTools: ["search"], usesIntegrationActions: false },
          },
        ],
        { output_mode: "silent" },
      ),
      stepContentRepo: makeStepContent([
        { stepId: "act1", content: "return await ctx.sketch.search({ query: 'Acme' });" },
      ]),
      loadIntegrationProvider,
      automationCapabilityRegistry,
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    expect(result.stepOutputs).toEqual({});
    expect(params._runsRepo.update).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        status: "failed",
        errorMessage: expect.stringContaining("must call Sketch tools through ctx.tools"),
      }),
    );
    expect(automationCapabilityRegistry.createTools).not.toHaveBeenCalled();
    expect(loadIntegrationProvider).not.toHaveBeenCalled();
  });

  it("fails a run when a Sketch capability fails even if the script catches it", async () => {
    const search = vi.fn().mockRejectedValue(new Error("search backend unavailable"));
    const createTools = vi.fn((options: { context: { onFailure?: (capability: string, error: unknown) => void } }) => ({
      search: async (args: unknown) => {
        try {
          return await search(args);
        } catch (error) {
          options.context.onFailure?.("search", error);
          throw error;
        }
      },
    }));
    const params = makeParams({
      task: makeActionTask([
        {
          id: "act1",
          type: "action",
          label: "Find Acme",
          icon: "magnifying-glass",
          position: { x: 0, y: 100 },
          actionCapabilities: { sketchTools: ["search"], usesIntegrationActions: false },
        },
      ]),
      stepContentRepo: makeStepContent([
        {
          stepId: "act1",
          content: `
            try {
              await ctx.tools.search({ query: "Acme" });
            } catch {
              return "No items";
            }
          `,
        },
      ]),
      automationCapabilityRegistry: { createTools },
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    expect(result.stepOutputs.act1.error?.message).toContain(
      'Sketch capability "search" failed: search backend unavailable',
    );
    expect(params.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Sketch capability "search" failed: search backend unavailable'),
    );
  });

  it("delivers legacy structured final output through the message compatibility adapter", async () => {
    const params = makeParams({
      task: makeActionTask([{ id: "act1", type: "action", label: "Report", icon: "code", position: { x: 0, y: 100 } }]),
      stepContentRepo: makeStepContent([
        { stepId: "act1", content: 'const result = { summary: "done" }; return result;' },
      ]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider()),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(result.stepOutputs.act1.output).toBe('{\n  "summary": "done"\n}');
    expect(params.sendMessage).toHaveBeenCalledWith('{\n  "summary": "done"\n}');
  });

  it("completes when a final action has no output instead of failing delivery", async () => {
    const params = makeParams({
      task: makeActionTask([{ id: "act1", type: "action", label: "Report", icon: "code", position: { x: 0, y: 100 } }]),
      stepContentRepo: makeStepContent([{ stepId: "act1", content: "return;" }]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider()),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(result.stepOutputs.act1.output).toBeNull();
    expect(params.sendMessage).not.toHaveBeenCalled();
  });

  it("formats structured final output during a test run without delivering it", async () => {
    const params = makeParams({
      runMode: "test",
      task: makeActionTask([{ id: "act1", type: "action", label: "Report", icon: "code", position: { x: 0, y: 100 } }]),
      stepContentRepo: makeStepContent([
        {
          stepId: "act1",
          content: 'const result = { message: "Reminder: message Vedant on Slack." }; return result;',
        },
      ]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider()),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(result.stepOutputs.act1.output).toBe('{\n  "message": "Reminder: message Vedant on Slack."\n}');
    expect(params.sendMessage).not.toHaveBeenCalled();
  });

  it("suppresses target delivery for an explicit test run while retaining failure output", async () => {
    const params = makeParams({
      runMode: "test",
      task: makeActionTask([{ id: "act1", type: "action", label: "Fail", icon: "code", position: { x: 0, y: 100 } }]),
      stepContentRepo: makeStepContent([{ stepId: "act1", content: 'throw new Error("test failure");' }]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider()),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    expect(result.stepOutputs.act1.error?.message).toContain("test failure");
    expect(params.sendMessage).not.toHaveBeenCalled();
  });

  it("executes action scripts in process with previous input and script context", async () => {
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
    const childLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    logger.child.mockReturnValue(childLogger);
    const onEvent = vi.fn();
    const { spawn } = await import("node:child_process");
    const listAgentEnvForRuntime = vi.fn().mockResolvedValue({
      MY_SAFE_VAR: "safe-value",
      ANTHROPIC_MODEL: "should-not-win",
      PATH: "should-not-win",
      CANVAS_CLI: "should-not-win",
    });
    const params = makeParams({
      logger,
      onEvent,
      task: makeActionTask([
        { id: "act1", type: "action", label: "Prepare", icon: "code", position: { x: 0, y: 100 } },
        { id: "act2", type: "action", label: "Finish", icon: "code", position: { x: 0, y: 200 } },
      ]),
      triggerData: { initial: 41 },
      stepContentRepo: makeStepContent([
        {
          stepId: "act1",
          content: `
            if (input.initial !== 41) throw new Error("bad input");
            if (!ctx.env.CANVAS_CLI) throw new Error("missing canvas cli");
            if (ctx.env.INTEGRATION_CLI !== ctx.env.CANVAS_CLI) throw new Error("missing legacy alias");
            if (ctx.env.CANVAS_API_KEY_MCP || ctx.env.CANVAS_USER_EMAIL) throw new Error("credential leak");
            if (ctx.env.ANTHROPIC_MODEL || ctx.env.PATH !== "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin") {
              throw new Error("reserved env override");
            }
            ctx.log.info({ ok: true }, "action script log");
            return { prepared: input.initial + 1, envValue: ctx.env.MY_SAFE_VAR, workspaceDir: ctx.workspaceDir };
          `,
        },
        {
          stepId: "act2",
          content: `
            export default async function action(input, ctx, signal) {
            if (input.prepared !== 42) throw new Error("previous output missing");
            return "Done: previous environment value was " + input.envValue + "; workspace is " + input.workspaceDir;
            }
          `,
        },
      ]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider()),
      listAgentEnvForRuntime,
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toBe(
      "Done: previous environment value was safe-value; workspace is /tmp/sketch-runtime-test/workspaces/user-1",
    );
    expect(result.stepOutputs.act1.output).toEqual({
      prepared: 42,
      envValue: "safe-value",
      workspaceDir: "/tmp/sketch-runtime-test/workspaces/user-1",
    });
    expect(logger.child).toHaveBeenCalledWith({ taskId: "task-1", runId: "run-1", stepId: "act1" });
    expect(childLogger.info).toHaveBeenCalledWith({ ok: true }, "action script log");
    expect(params.sendMessage).toHaveBeenCalledWith(
      "Done: previous environment value was safe-value; workspace is /tmp/sketch-runtime-test/workspaces/user-1",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(listAgentEnvForRuntime).toHaveBeenCalledWith({
      currentUserId: "user-1",
      contextType: "scheduled_task",
      allowOrgSharedEnv: true,
      taskContext: { platform: "slack", contextType: "dm", deliveryTarget: "D123", createdBy: "user-1" },
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "step.completed", stepId: "act1", outputSummary: expect.any(String) }),
    );
  });

  it("executes server-owned integration actions with bounded workspace files", async () => {
    const trustedLocalFileRoot = "/tmp/sketch-runtime-test/automation-trigger-files/run-1";
    const filePath = `${trustedLocalFileRoot}/bug.jpeg`;
    await mkdir(trustedLocalFileRoot, { recursive: true });
    await writeFile(filePath, "jpeg-bytes");
    const executeAction = vi.fn().mockResolvedValue({ id: "clickup-task-1" });
    const params = makeParams({
      task: makeActionTask(
        [{ id: "act1", type: "action", label: "Create ClickUp task", icon: "code", position: { x: 0, y: 100 } }],
        { output_mode: "silent" },
      ),
      triggerData: { filePath },
      trustedLocalFileRoot,
      stepContentRepo: makeStepContent([
        {
          stepId: "act1",
          content: `
            return ctx.integrations.executeAction({
              componentKey: "clickup-create-task-with-attachment",
              configuredProps: { name: "Bug report" },
              localFiles: [{ path: input.filePath, configuredProp: "file_content_base64" }]
            });
          `,
        },
      ]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider({ executeAction })),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(executeAction).toHaveBeenCalledWith(
      {
        userEmail: "roopak@canvasx.ai",
        componentKey: "clickup-create-task-with-attachment",
        configuredProps: {
          name: "Bug report",
          file_content_base64: Buffer.from("jpeg-bytes").toString("base64"),
        },
      },
      expect.any(AbortSignal),
    );
  });

  it("rejects integration action files outside the automation workspace", async () => {
    const outsidePath = "/tmp/sketch-runtime-outside.jpeg";
    await writeFile(outsidePath, "not-allowed");
    const executeAction = vi.fn();
    const params = makeParams({
      task: makeActionTask([
        { id: "act1", type: "action", label: "Create ClickUp task", icon: "code", position: { x: 0, y: 100 } },
      ]),
      triggerData: { filePath: outsidePath },
      stepContentRepo: makeStepContent([
        {
          stepId: "act1",
          content: `
            return ctx.integrations.executeAction({
              componentKey: "clickup-create-task-with-attachment",
              configuredProps: {},
              localFiles: [{ path: input.filePath, configuredProp: "file_content_base64" }]
            });
          `,
        },
      ]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider({ executeAction })),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    expect(result.stepOutputs.act1.error?.message).toContain("outside the trusted automation file roots");
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("fails the action step with a clear error when the provider is not broker-capable", async () => {
    const httpOnlyProvider = {
      type: "fake",
      listApps: async () => ({ apps: [], pageInfo: { endCursor: null, hasMore: false } }),
      initiateConnection: async () => ({ redirectUrl: "" }),
      listConnections: async () => [],
      removeConnection: async () => {},
      isBrokerCapable: () => false,
      getBrokerSpec: () => null,
    };

    const params = makeParams({
      task: makeTask({
        steps: JSON.stringify([
          { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
          {
            id: "act1",
            type: "action",
            label: "Run script",
            icon: "code",
            position: { x: 0, y: 100 },
          },
        ]),
      }),
      stepContentRepo: {
        getByTask: vi.fn().mockResolvedValue([
          {
            task_id: "task-1",
            step_id: "act1",
            content_type: "script",
            content: "return 1;",
            apps: null,
            updated_at: "2026-04-27T09:00:00.000Z",
          },
        ]),
      },
      loadIntegrationProvider: vi.fn().mockResolvedValue(httpOnlyProvider),
    });

    const result = await executeAutomation(params as never);
    expect(result.status).toBe("failed");
    const failureUpdate = (params._runsRepo.update as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1]?.status === "failed",
    );
    expect(failureUpdate?.[1]?.errorMessage).toContain("broker-capable integration provider");
    expect(params.sendMessage).toHaveBeenCalledWith(expect.stringContaining("broker-capable integration provider"));
  });

  it("fails clearly when a broker-capable provider returns no broker spec", async () => {
    const params = makeParams({
      task: makeActionTask([
        { id: "act1", type: "action", label: "Run script", icon: "code", position: { x: 0, y: 100 } },
      ]),
      stepContentRepo: makeStepContent([{ stepId: "act1", content: "return 1;" }]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider({ getBrokerSpec: () => null })),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    const failureUpdate = (params._runsRepo.update as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1]?.status === "failed",
    );
    expect(failureUpdate?.[1]?.errorMessage).toContain("broker-capable integration provider");
  });

  it("fails the current step and skips downstream steps on sync throw, async rejection, or syntax error", async () => {
    for (const content of [
      "throw new Error('sync boom');",
      "await Promise.reject(new Error('async boom'));",
      "const broken = ;",
    ]) {
      const params = makeParams({
        task: makeActionTask([
          { id: "act1", type: "action", label: "Break", icon: "code", position: { x: 0, y: 100 } },
          { id: "act2", type: "action", label: "Skip", icon: "code", position: { x: 0, y: 200 } },
        ]),
        stepContentRepo: makeStepContent([
          { stepId: "act1", content },
          { stepId: "act2", content: "return 'should not run';" },
        ]),
        loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider()),
      });

      const result = await executeAutomation(params as never);

      expect(result.status).toBe("failed");
      expect(result.stepOutputs.act1.status).toBe("failed");
      expect(result.stepOutputs.act2.status).toBe("skipped");
      const failureUpdate = (params._runsRepo.update as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[1]?.status === "failed",
      );
      expect(failureUpdate?.[1]?.errorMessage).toContain('Step "Break" failed');
    }
  });

  it("fails action steps that time out before completing", async () => {
    const params = makeParams({
      task: makeActionTask([
        { id: "act1", type: "action", label: "Hang", icon: "code", position: { x: 0, y: 100 }, timeout: 1 },
        { id: "act2", type: "action", label: "Skip", icon: "code", position: { x: 0, y: 200 } },
      ]),
      stepContentRepo: makeStepContent([
        { stepId: "act1", content: "await new Promise(() => {});" },
        { stepId: "act2", content: "return 'should not run';" },
      ]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider()),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    expect(result.stepOutputs.act1.error?.message).toContain("timed out");
    expect(result.stepOutputs.act2.status).toBe("skipped");
  });

  it("fails before completing when action output is not JSON serializable", async () => {
    const onEvent = vi.fn();
    const params = makeParams({
      onEvent,
      task: makeActionTask([
        { id: "act1", type: "action", label: "Bad output", icon: "code", position: { x: 0, y: 100 } },
      ]),
      stepContentRepo: makeStepContent([
        { stepId: "act1", content: "const result = { value: BigInt(1) }; return result;" },
      ]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider()),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    expect(result.stepOutputs.act1.error?.message).toContain("not JSON-serializable");
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "step.completed", stepId: "act1" }));
  });

  it("bounds action output before it is persisted or passed downstream", async () => {
    const onEvent = vi.fn();
    const params = makeParams({
      onEvent,
      task: makeActionTask(
        [{ id: "act1", type: "action", label: "Large output", icon: "code", position: { x: 0, y: 100 } }],
        { output_mode: "silent" },
      ),
      stepContentRepo: makeStepContent([
        { stepId: "act1", content: `return "x".repeat(${MAX_AUTOMATION_OUTPUT_BYTES + 1});` },
      ]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider()),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    expect(result.stepOutputs.act1.error?.message).toContain(
      `Workflow step output exceeds ${MAX_AUTOMATION_OUTPUT_BYTES} bytes`,
    );
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "step.completed", stepId: "act1" }));
  });

  it("keeps a successful run successful when context maintenance fails", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sketch-runtime-context-"));
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const params = makeParams({
      logger,
      config: {
        DATA_DIR: dataDir,
        CLAUDE_CONFIG_DIR: join(dataDir, ".claude"),
        BASE_URL: "https://sketch.test",
        PORT: 3000,
        AGENT_RUNTIME: "sdk",
      },
      task: makeTask({ id: "context-task", output_mode: "silent" }),
      runAgent: vi.fn().mockResolvedValue({
        pendingUploads: [],
        trace: { finalText: "successful result" },
        rawUsage: { toolCalls: [] },
      }),
    });
    const contextFilePath = join(dataDir, "workspaces", "user-1", ".workflow-context", "context-task-run-1.md");
    await mkdir(contextFilePath, { recursive: true });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toBe("successful result");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ contextDir: expect.stringContaining(".workflow-context") }),
      "Automation: context maintenance failed",
    );
  });
});

function makePromptStepContent(rows: Array<{ stepId: string; content: string }>) {
  return {
    getByTask: vi.fn().mockResolvedValue(
      rows.map((row) => ({
        task_id: "task-1",
        step_id: row.stepId,
        content_type: "prompt",
        content: row.content,
        apps: null,
        updated_at: "2026-04-27T09:00:00.000Z",
      })),
    ),
  };
}

describe("shared-member-triggered runs execute with the owner's identity", () => {
  it("runs a member-triggered manual automation with the owner's workspace and agent identity", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      pendingUploads: [],
      trace: { finalText: "owner result" },
      rawUsage: { toolCalls: [] },
    });
    const userRepo = {
      list: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockImplementation(async (id: string) =>
        id === "owner-1"
          ? {
              id: "owner-1",
              name: "Owner Name",
              email: "owner@canvasx.ai",
              slack_user_id: "UOWN",
              whatsapp_number: null,
              type: "human",
              role: null,
              description: null,
            }
          : undefined,
      ),
      getAllEmailsForUser: vi.fn().mockResolvedValue(["owner@canvasx.ai"]),
    };
    const params = makeParams({
      runAgent,
      userRepo,
      task: makeTask({ created_by: "owner-1" }),
      triggerData: { type: "manual", triggeredByUserId: "member-1" },
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(userRepo.findById).toHaveBeenCalledWith("owner-1");
    expect(userRepo.findById).not.toHaveBeenCalledWith("member-1");
    expect(params._runsRepo.create).toHaveBeenCalledWith({
      taskId: "task-1",
      triggerData: { type: "manual", triggeredByUserId: "member-1" },
    });

    const call = runAgent.mock.calls[0]?.[0];
    expect(call.workspaceKey).toBe("owner-1");
    expect(call.workspaceDir).toBe("/tmp/sketch-runtime-test/workspaces/owner-1");
    expect(call.currentUserId).toBe("owner-1");
    expect(call.userName).toBe("Owner Name");
    expect(call.userEmail).toBe("owner@canvasx.ai");
    expect(call.taskContext).toEqual({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "D123",
      createdBy: "owner-1",
    });
    expect(call.currentUserId).not.toBe("member-1");
    expect(call.userName).not.toBe("Member Name");
  });

  it("resolves the workspace directory from the task owner, not the triggerer", () => {
    expect(
      resolveAutomationWorkspaceDir("/data", makeTask({ created_by: "owner-1" }) as unknown as ScheduledTaskRow),
    ).toBe("/data/workspaces/owner-1");
    expect(
      resolveAutomationWorkspaceDir(
        "/data",
        makeTask({ created_by: null, delivery_target: "D123" }) as unknown as ScheduledTaskRow,
      ),
    ).toBe("/data/workspaces/D123");
    expect(
      resolveAutomationWorkspaceDir(
        "/data",
        makeTask({ context_type: "channel", delivery_target: "C123" }) as unknown as ScheduledTaskRow,
      ),
    ).toBe("/data/workspaces/channel-C123");
    expect(
      resolveAutomationWorkspaceDir(
        "/data",
        makeTask({ context_type: "group", delivery_target: "120363000000@g.us" }) as unknown as ScheduledTaskRow,
      ),
    ).toBe("/data/workspaces/wa-group-120363000000");
  });
});
