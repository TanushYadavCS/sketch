import { describe, expect, it, vi } from "vitest";
import { executeAutomation } from "./runtime";

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
    const runAgent = vi.fn();
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
            agentMode: "light",
          },
        ]),
      }),
    });

    await executeAutomation(params as never);

    expect(runAgent).not.toHaveBeenCalled();
    expect(params.sendMessage).toHaveBeenCalledWith("light result");
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
