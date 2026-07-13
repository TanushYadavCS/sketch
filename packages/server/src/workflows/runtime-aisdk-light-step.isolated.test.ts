/**
 * Surface wiring test for the workflow light-step agent call on the AI SDK runtime.
 *
 * Proves that the public workflow-step surface (testAutomationStep -> executeAgentStep ->
 * executeAiSdkLightAgentStep) drives a REAL agent run on the aisdk path end-to-end: the
 * real runAgentRuntimeCore loop executes, real workspace tools run, the model output is
 * returned as the step output, recorded on the run, and delivered to the channel.
 *
 * Only the provider FACTORY is mocked so we inject a fake LanguageModel (the same
 * MockLanguageModelV4 seam used by runner-aisdk.test.ts) instead of hitting a real
 * Bedrock/OpenRouter/Anthropic endpoint. The runtime core, tools, and delivery are all real.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LanguageModel, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "../agent/runtime/pricing";
import type { AgentRuntimeProvider } from "../agent/runtime/provider";

const capturedProviderConfigs: Array<Record<string, unknown>> = [];
let currentModel: MockLanguageModelV4;

function mockProvider(model: LanguageModel): AgentRuntimeProvider {
  return {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    model,
    costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
    preparePrompt: (input) => ({
      instructions: input.systemPrompt,
      messages: input.messages ?? [{ role: "user", content: input.prompt }],
    }),
  };
}

/**
 * Mock only the provider factory. The surface builds the provider internally from
 * loadAgentRuntimeProviderConfig; there is no injection seam for the model, so we
 * substitute a fake-model-backed provider here while leaving runAgentRuntimeCore real.
 */
vi.mock("../agent/runtime/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/runtime/provider")>();
  return {
    ...actual,
    createAgentRuntimeProvider: vi.fn((config: Record<string, unknown>) => {
      capturedProviderConfigs.push(config);
      return mockProvider(currentModel);
    }),
  };
});

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function textModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-anthropic",
    modelId: "claude-sonnet-4-6",
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: text },
          { type: "text-end", id: "text-1" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(10, 2) },
        ],
      }),
    },
  });
}

function readThenTextModel(filePath: string, text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-anthropic",
    modelId: "claude-sonnet-4-6",
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "tool-read",
              toolName: "Read",
              input: JSON.stringify({ file_path: filePath }),
            },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(20, 1) },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: text },
            { type: "text-end", id: "text-1" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(30, 3) },
          ],
        }),
      },
    ],
  });
}

function errorModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock-anthropic",
    modelId: "claude-sonnet-4-6",
    doStream: {
      stream: simulateReadableStream({
        chunks: [{ type: "error", error: new Error("provider melted down mid-stream") }],
      }),
    },
  });
}

const LIGHT_AGENT_STEPS = JSON.stringify([
  { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
  {
    id: "step1",
    type: "agent",
    label: "Summarize notes",
    icon: "sketch-ai",
    position: { x: 0, y: 100 },
    agentMode: "light",
  },
]);

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    platform: "slack",
    context_type: "dm",
    delivery_target: "D123",
    thread_ts: null,
    prompt: "Summarize notes",
    schedule_type: "cron",
    schedule_value: "0 9 * * *",
    timezone: "Asia/Kolkata",
    session_mode: "fresh",
    status: "active",
    created_by: "user-1",
    created_at: "2026-04-27T09:00:00.000Z",
    next_run_at: null,
    last_run_at: null,
    title: "Summarize notes",
    description: null,
    steps: LIGHT_AGENT_STEPS,
    edges: null,
    output_target: null,
    output_platform: null,
    output_mode: "deliver",
    ...overrides,
  };
}

describe("workflow light-step agent call on the AI SDK runtime", () => {
  let workspaceRoot: string;
  let dataDir: string;
  let claudeConfigDir: string;

  beforeEach(async () => {
    capturedProviderConfigs.length = 0;
    workspaceRoot = await mkdtemp(join(tmpdir(), "sketch-wf-aisdk-"));
    dataDir = join(workspaceRoot, "data");
    claudeConfigDir = join(workspaceRoot, "claude");
    await mkdir(claudeConfigDir, { recursive: true });
    // Pre-create the step workspace so tool reads resolve inside the scope.
    await mkdir(join(dataDir, "workspaces", "user-1", "notes"), { recursive: true });
    await writeFile(join(dataDir, "workspaces", "user-1", "notes", "today.txt"), "quarterly numbers are up");
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

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
          content: "Summarize the workspace notes into one crisp sentence.",
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
        DATA_DIR: dataDir,
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        BASE_URL: "https://sketch.test",
        PORT: 3000,
        AGENT_RUNTIME: "aisdk" as const,
      },
      runsRepo,
      stepContentRepo,
      loadIntegrationProvider: vi.fn().mockResolvedValue(null),
      loadAgentRuntimeProviderConfig: vi.fn().mockResolvedValue({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        apiKey: "sk-ant-test",
        costTable: DEFAULT_AGENT_RUNTIME_COST_TABLE,
      }),
      userRepo,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      ...overrides,
      _runsRepo: runsRepo,
      _stepContentRepo: stepContentRepo,
      _userRepo: userRepo,
    };
  }

  it("runs the light agent step through the real AI SDK core and records/delivers its output", async () => {
    const { executeAutomation } = await import("./runtime");
    currentModel = textModel("Quarterly numbers are up.");
    const recordWorkflowStep = vi.fn().mockResolvedValue(undefined);
    const limitAgentExecution = vi.fn((work: () => Promise<unknown>) => work());
    const params = makeParams({ recordWorkflowStep, limitAgentExecution });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toBe("Quarterly numbers are up.");
    expect(result.stepOutputs.step1).toMatchObject({
      status: "completed",
      output: "Quarterly numbers are up.",
    });

    // Proves the surface built a provider from the loaded config on the aisdk path.
    expect(params.loadAgentRuntimeProviderConfig).toHaveBeenCalledTimes(1);
    expect(capturedProviderConfigs[0]).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-4-6" });

    // Proves the real core loop actually invoked the model with the workflow-step system prompt.
    const call = currentModel.doStreamCalls[0];
    expect(call).toBeDefined();
    expect(JSON.stringify(call?.prompt)).toContain("Summarize the workspace notes into one crisp sentence.");
    const systemMessage = call?.prompt?.find((m) => m.role === "system");
    expect(JSON.stringify(systemMessage)).toContain("You are a workflow step in an automation.");

    // Delivery + usage recording happened.
    expect(params.sendMessage).toHaveBeenCalledWith("Quarterly numbers are up.");
    expect(recordWorkflowStep).toHaveBeenCalledTimes(1);
    expect(recordWorkflowStep.mock.calls[0][0]).toMatchObject({
      platform: "slack",
      contextType: "scheduled_task",
      workspaceKey: "user-1",
    });
    expect(recordWorkflowStep.mock.calls[0][1]).toMatchObject({
      model: "claude-sonnet-4-6",
      inputTokens: 10,
      outputTokens: 2,
    });

    // Run record persisted the completed step output.
    const completedUpdate = (params._runsRepo.update as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1]?.status === "completed",
    );
    expect(completedUpdate?.[1]?.stepOutputs?.step1?.output).toBe("Quarterly numbers are up.");
  });

  it("executes a real workspace tool loop (Read) inside the step scope and feeds the result back to the model", async () => {
    const { executeAutomation } = await import("./runtime");
    const notesPath = join(dataDir, "workspaces", "user-1", "notes", "today.txt");
    currentModel = readThenTextModel(notesPath, "Notes say quarterly numbers are up.");
    const params = makeParams();

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toBe("Notes say quarterly numbers are up.");

    // Two model turns ran: tool-call turn, then the text turn. The second turn's prompt
    // must contain the real file contents produced by the actual Read tool handler.
    expect(currentModel.doStreamCalls.length).toBe(2);
    expect(JSON.stringify(currentModel.doStreamCalls[1]?.prompt)).toContain("quarterly numbers are up");

    // Read must be registered as a real workspace tool for the light step.
    const toolNames = (currentModel.doStreamCalls[0]?.tools ?? []).map((t) => String(t.name));
    expect(toolNames).toContain("Read");
    expect(params.sendMessage).toHaveBeenCalledWith("Notes say quarterly numbers are up.");
  });

  it("records the step and run as failed when the AI SDK provider errors mid-run", async () => {
    const { executeAutomation } = await import("./runtime");
    currentModel = errorModel();
    const params = makeParams();

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    expect(result.stepOutputs.step1?.status).toBe("failed");
    expect(result.stepOutputs.step1?.error?.message).toContain("Agent runtime provider failed");

    const failureUpdate = (params._runsRepo.update as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1]?.status === "failed",
    );
    expect(failureUpdate?.[1]?.errorMessage).toContain('Step "Summarize notes" failed');
    expect(params.sendMessage).toHaveBeenCalledWith(expect.stringContaining("failed at step 'Summarize notes'"));
  });

  it("fails clearly when the aisdk runtime is enabled but no provider config is available", async () => {
    const { executeAutomation } = await import("./runtime");
    currentModel = textModel("unused");
    const params = makeParams({
      loadAgentRuntimeProviderConfig: vi.fn().mockResolvedValue(null),
    });

    const result = await executeAutomation(params as never);

    expect(result.status).toBe("failed");
    expect(result.stepOutputs.step1?.error?.message).toContain("no LLM provider configuration is available");
    // Provider factory must never be reached without a config.
    expect(capturedProviderConfigs.length).toBe(0);
  });

  it("runs a single light step via testAutomationStep and returns the model output", async () => {
    const { testAutomationStep } = await import("./runtime");
    currentModel = textModel("Single step output.");
    const params = makeParams();

    const result = await testAutomationStep({
      ...params,
      stepId: "step1",
      input: { seed: "value" },
    } as never);

    expect(result.status).toBe("completed");
    expect(result.finalOutput).toBe("Single step output.");
    expect(result.stepOutputs.step1?.output).toBe("Single step output.");
    // The provided input must reach the model prompt (serialized inside the user message).
    const userMessage = currentModel.doStreamCalls[0]?.prompt?.find((m) => m.role === "user");
    expect(JSON.stringify(userMessage)).toContain("Input:");
    expect(JSON.stringify(userMessage)).toContain("value");
    expect(capturedProviderConfigs[0]).toMatchObject({ provider: "anthropic" });
  });
});
