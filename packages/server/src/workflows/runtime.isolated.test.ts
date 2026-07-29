import { mkdir, writeFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { runAgentRuntimeCore } from "../agent/runtime/core";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "../agent/runtime/pricing";
import { executeAutomation, testAutomationStep } from "./runtime";

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

function makeActionTask(steps: Array<Record<string, unknown>>) {
  return makeTask({
    steps: JSON.stringify([
      { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
      ...steps,
    ]),
  });
}

function makeStepContent(rows: Array<{ stepId: string; content: string }>) {
  return {
    getByTask: vi.fn().mockResolvedValue(
      rows.map((row) => ({
        task_id: "task-1",
        step_id: row.stepId,
        content_type: "script",
        content: row.content,
        apps: null,
        updated_at: "2026-04-27T09:00:00.000Z",
      })),
    ),
  };
}

describe("executeAutomation agent steps", () => {
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
            return { done: true, previousEnv: input.envValue, workspaceDir: input.workspaceDir };
            }
          `,
        },
      ]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider()),
      listAgentEnvForRuntime,
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toEqual({
      done: true,
      previousEnv: "safe-value",
      workspaceDir: "/tmp/sketch-runtime-test/workspaces/user-1",
    });
    expect(result.stepOutputs.act1.output).toEqual({
      prepared: 42,
      envValue: "safe-value",
      workspaceDir: "/tmp/sketch-runtime-test/workspaces/user-1",
    });
    expect(logger.child).toHaveBeenCalledWith({ taskId: "task-1", runId: "run-1", stepId: "act1" });
    expect(childLogger.info).toHaveBeenCalledWith({ ok: true }, "action script log");
    expect(params.sendMessage).toHaveBeenCalledWith(
      JSON.stringify(
        { done: true, previousEnv: "safe-value", workspaceDir: "/tmp/sketch-runtime-test/workspaces/user-1" },
        null,
        2,
      ),
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
    const workspaceDir = "/tmp/sketch-runtime-test/workspaces/user-1";
    const filePath = `${workspaceDir}/automation-trigger-files/bug.jpeg`;
    await mkdir(`${workspaceDir}/automation-trigger-files`, { recursive: true });
    await writeFile(filePath, "jpeg-bytes");
    const executeAction = vi.fn().mockResolvedValue({ id: "clickup-task-1" });
    const params = makeParams({
      task: makeActionTask([
        { id: "act1", type: "action", label: "Create ClickUp task", icon: "code", position: { x: 0, y: 100 } },
      ]),
      triggerData: { filePath },
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
    expect(executeAction).toHaveBeenCalledWith({
      userEmail: "roopak@canvasx.ai",
      componentKey: "clickup-create-task-with-attachment",
      configuredProps: {
        name: "Bug report",
        file_content_base64: Buffer.from("jpeg-bytes").toString("base64"),
      },
    });
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
    expect(result.stepOutputs.act1.error?.message).toContain("outside the automation workspace");
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
        { id: "act1", type: "action", label: "Hang", icon: "code", position: { x: 0, y: 100 }, timeout: 0.001 },
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
      stepContentRepo: makeStepContent([{ stepId: "act1", content: "return { value: BigInt(1) };" }]),
      loadIntegrationProvider: vi.fn().mockResolvedValue(makeBrokerProvider()),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    expect(result.stepOutputs.act1.error?.message).toContain("not JSON-serializable");
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "step.completed", stepId: "act1" }));
  });
});
