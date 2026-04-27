import { describe, expect, it, vi } from "vitest";
import { executeAutomation } from "./runtime";

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
    findIntegrationProvider: vi.fn().mockResolvedValue(null),
    userRepo,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
    _runsRepo: runsRepo,
    _stepContentRepo: stepContentRepo,
    _userRepo: userRepo,
  };
}

describe("executeAutomation agent steps", () => {
  it("routes sketch-mode agent steps through runAgent with workflow context", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      pendingUploads: [],
      toolCalls: [],
      trace: { finalText: "sketch result" },
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
    expect(call.taskContext).toBeUndefined();
    expect(call.userMessage).toContain("<task>Daily workflow planning summary</task>");
    expect(call.userMessage).toContain("You are executing one step of a scheduled workflow.");
    expect(call.userMessage).toContain("Step: Summarize Linear issues");
    expect(call.userMessage).toContain("Step prompt:");
    expect(call.userMessage).toContain("Input from previous step:");
    expect(params.sendMessage).toHaveBeenCalledWith("sketch result");
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
});
