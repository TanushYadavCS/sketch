/**
 * Scheduler surface -> AI SDK runtime end-to-end wiring.
 *
 * Proves that triggering a scheduled task through the public scheduler surface
 * (TaskScheduler.executeTaskById) drives a REAL agent run on the aisdk path and
 * produces the model's output plus platform delivery.
 *
 * Unlike service.isolated.test.ts, this file does NOT mock executeAutomation.
 * It runs the genuine automation runtime -> executeSketchAgentStep -> the injected
 * runAgent, which is the real runAgent forced onto agentRuntime:"aisdk" with an
 * in-memory mock LanguageModelV4 provider (the same fake-provider seam exercised
 * in runner-aisdk.test.ts). No real Bedrock/OpenRouter/network calls are made.
 *
 * The DB is in-memory SQLite (createTestDb) and delivery targets are local fakes;
 * no real Slack/WhatsApp/external service is touched. Plain unit tier: only local
 * vi.fn spies are used (no vi.mock, fake timers, or global stubs).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LanguageModel, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunAgentParams, runAgent } from "../agent/runner";
import { DEFAULT_AGENT_RUNTIME_COST_TABLE } from "../agent/runtime/pricing";
import type { AgentRuntimeProvider } from "../agent/runtime/provider";
import { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createConversationRepository } from "../db/repositories/conversations";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createSettingsRepository } from "../db/repositories/settings";
import { createUserRepository } from "../db/repositories/users";
import type { DB } from "../db/schema";
import { QueueManager } from "../queue";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import { TaskScheduler } from "./service";

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
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: usage(10, 2),
          },
        ],
      }),
    },
  });
}

function readThenTextModel(relPath: string, text: string): MockLanguageModelV4 {
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
              input: JSON.stringify({ file_path: relPath }),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage: usage(20, 1),
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: text },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: usage(10, 2),
            },
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
        chunks: [{ type: "error", error: new Error("scheduled provider blew up") }],
      }),
    },
  });
}

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
 * Wraps the real runAgent so every call the scheduler's automation runtime makes
 * is forced onto the aisdk runtime with our in-memory mock provider. This is the
 * production seam: bootstrap injects agentRuntime + the provider config; here we
 * inject the equivalent fake. captured records the runtime actually used so the
 * test can assert the aisdk path was taken (not the SDK subprocess path).
 */
function aiSdkRunAgent(model: LanguageModel, captured: { runtime?: string }): typeof runAgent {
  return (params: RunAgentParams) => {
    captured.runtime = "aisdk";
    return runAgent({
      ...params,
      agentRuntime: "aisdk",
      agentRuntimeProvider: mockProvider(model),
    });
  };
}

const baseTaskFields = {
  platform: "slack" as const,
  context_type: "dm" as const,
  delivery_target: "D_DM_CHANNEL",
  thread_ts: null,
  prompt: "Summarise today's numbers",
  schedule_type: "cron" as const,
  schedule_value: "0 9 * * 1",
  timezone: "UTC",
  session_mode: "fresh" as const,
  status: "active" as const,
  next_run_at: null,
};

function buildSlackFake() {
  return {
    postMessage: vi.fn().mockResolvedValue("ts-delivered"),
    postThreadReply: vi.fn().mockResolvedValue("ts-reply"),
    openDmChannel: vi.fn().mockResolvedValue("D_OPENED"),
    isConnected: true,
  };
}

function buildWhatsAppFake() {
  return {
    getCapabilities: vi.fn().mockReturnValue({ templates: true }),
    sendText: vi.fn(),
    sendTemplate: vi.fn(),
    get isConnected() {
      return false;
    },
  };
}

function buildDeps(
  db: Kysely<DB>,
  config: ReturnType<typeof createTestConfig>,
  runAgentImpl: typeof runAgent,
  slack: ReturnType<typeof buildSlackFake> | null,
) {
  const settingsRepo = createSettingsRepository(db);
  return {
    db,
    config,
    logger: createTestLogger(),
    queueManager: new QueueManager(),
    getSlack: () => slack as ReturnType<typeof buildSlackFake> | null,
    whatsapp: buildWhatsAppFake(),
    settingsRepo,
    runAgent: runAgentImpl,
    buildMcpServers: vi.fn().mockResolvedValue({}),
    loadIntegrationProvider: vi.fn().mockResolvedValue(null),
    listAgentEnvForRuntime: vi.fn().mockResolvedValue({}),
    automationRunsRepo: createAutomationRunsRepository(db),
    stepContentRepo: createAutomationStepContentRepository(db),
    userRepo: createUserRepository(db),
    inboxMessagesRepo: undefined,
    sendDm: undefined,
    limitAgentExecution: <T>(work: () => Promise<T>) => work(),
  };
}

describe("scheduler surface drives an agent run on the AI SDK runtime", () => {
  let db: Kysely<DB>;
  let config: ReturnType<typeof createTestConfig>;
  let dataDir: string;
  let creatorId: string;

  beforeEach(async () => {
    db = await createTestDb();
    dataDir = await mkdtemp(join(tmpdir(), "sketch-sched-aisdk-data-"));
    const claudeConfigDir = await mkdtemp(join(tmpdir(), "sketch-sched-aisdk-cfg-"));
    config = createTestConfig({
      DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      AGENT_RUNTIME: "aisdk",
    });
    const settings = createSettingsRepository(db);
    await settings.create();
    const creator = await createUserRepository(db).create({
      name: "Scheduler Creator",
      email: "creator@example.com",
    });
    creatorId = creator.id;
  });

  afterEach(async () => {
    await db.destroy();
    await rm(dataDir, { recursive: true, force: true });
    await rm(config.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
  });

  it("runs the agent on aisdk, returns its output, and delivers it to Slack", async () => {
    const captured: { runtime?: string } = {};
    const slack = buildSlackFake();
    const scheduler = new TaskScheduler(
      buildDeps(db, config, aiSdkRunAgent(textModel("weekly summary: all green"), captured), slack) as never,
    );

    const repo = createScheduledTaskRepository(db);
    const row = await repo.add({ ...baseTaskFields, created_by: creatorId });

    const result = await scheduler.executeTaskById(row.id);

    expect(captured.runtime).toBe("aisdk");
    expect(result?.status).toBe("completed");
    expect(result?.finalOutput).toBe("weekly summary: all green");

    expect(slack.postMessage).toHaveBeenCalledWith("D_DM_CHANNEL", "weekly summary: all green");

    const runs = await createAutomationRunsRepository(db).list(row.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");

    const updatedTask = await repo.getById(row.id);
    expect(updatedTask?.last_run_at).toBeTruthy();

    const captureRow = await db
      .selectFrom("conversation_messages")
      .innerJoin("conversations", "conversations.id", "conversation_messages.conversation_id")
      .select([
        "conversations.provider_conversation_id",
        "conversation_messages.provider_message_id",
        "conversation_messages.is_bot",
        "conversation_messages.text",
      ])
      .executeTakeFirstOrThrow();
    expect(captureRow).toMatchObject({
      provider_conversation_id: "D_DM_CHANNEL",
      provider_message_id: "ts-delivered",
      is_bot: 1,
      text: "weekly summary: all green",
    });
  });

  it("executes a workspace tool-call loop on aisdk before delivering the final text", async () => {
    const captured: { runtime?: string } = {};
    const slack = buildSlackFake();
    const scheduler = new TaskScheduler(
      buildDeps(
        db,
        config,
        aiSdkRunAgent(readThenTextModel("today.txt", "read the file: alpha"), captured),
        slack,
      ) as never,
    );

    const repo = createScheduledTaskRepository(db);
    const row = await repo.add({ ...baseTaskFields, created_by: creatorId });

    // The automation runtime resolves a DM task's workspace to
    // DATA_DIR/workspaces/{created_by} and mkdirs it at run time; seed a file the
    // model's Read tool-call resolves against relative to that workspace.
    const workspaceDir = join(dataDir, "workspaces", creatorId);
    await writeFileEnsured(join(workspaceDir, "today.txt"), "alpha");

    const result = await scheduler.executeTaskById(row.id);

    expect(captured.runtime).toBe("aisdk");
    expect(result?.status).toBe("completed");
    expect(result?.finalOutput).toBe("read the file: alpha");
    expect(slack.postMessage).toHaveBeenCalledWith("D_DM_CHANNEL", "read the file: alpha");
  });

  it("marks the run failed and delivers a failure message when the aisdk run errors", async () => {
    const captured: { runtime?: string } = {};
    const slack = buildSlackFake();
    const scheduler = new TaskScheduler(buildDeps(db, config, aiSdkRunAgent(errorModel(), captured), slack) as never);

    const repo = createScheduledTaskRepository(db);
    const row = await repo.add({ ...baseTaskFields, created_by: creatorId, title: "Numbers report" });

    const result = await scheduler.executeTaskById(row.id);

    expect(captured.runtime).toBe("aisdk");
    expect(result?.status).toBe("failed");

    const runs = await createAutomationRunsRepository(db).list(row.id, 10);
    expect(runs[0].status).toBe("failed");

    expect(slack.postMessage).toHaveBeenCalledTimes(1);
    const [, deliveredText] = slack.postMessage.mock.calls[0];
    expect(deliveredText).toContain("failed");
    expect(deliveredText).toContain("Numbers report");
  });

  it("throws when triggering a non-active task", async () => {
    const captured: { runtime?: string } = {};
    const scheduler = new TaskScheduler(
      buildDeps(db, config, aiSdkRunAgent(textModel("unused"), captured), buildSlackFake()) as never,
    );

    const repo = createScheduledTaskRepository(db);
    const row = await repo.add({ ...baseTaskFields, created_by: creatorId, status: "paused" });

    await expect(scheduler.executeTaskById(row.id)).rejects.toThrow(/not active/);
    expect(captured.runtime).toBeUndefined();
  });
});

async function writeFileEnsured(path: string, contents: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}
