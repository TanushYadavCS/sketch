import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import type { DB } from "../db/schema";
import { QueueManager } from "../queue";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import type { ExecuteAutomationParams } from "../workflows/runtime";
import { TaskScheduler } from "./service";

let executionParams: ExecuteAutomationParams[] = [];

vi.mock("../workflows/runtime", () => ({
  executeAutomation: vi.fn().mockImplementation(async (params: ExecuteAutomationParams) => {
    executionParams.push(params);
    return { runId: "run-1", status: "completed", finalOutput: null, stepOutputs: {} };
  }),
  testAutomationStep: vi.fn(),
}));

function makeDeps(db: Kysely<DB>) {
  return {
    db,
    config: createTestConfig({ DATA_DIR: "/tmp/slack-trigger-test" }),
    logger: createTestLogger(),
    queueManager: new QueueManager(),
    getSlack: () => ({ postMessage: vi.fn(), postThreadReply: vi.fn(), isConnected: true }),
    whatsapp: { isConnected: false },
    settingsRepo: { get: vi.fn().mockResolvedValue({}) },
    runAgent: vi.fn(),
    buildMcpServers: vi.fn().mockResolvedValue({}),
    loadIntegrationProvider: vi.fn().mockResolvedValue(null),
    automationRunsRepo: {
      create: vi.fn().mockResolvedValue("run-1"),
      update: vi.fn().mockResolvedValue(undefined),
    },
    stepContentRepo: { getByTask: vi.fn().mockResolvedValue([]) },
    userRepo: { findById: vi.fn().mockResolvedValue({ id: "user-1", email: "user@example.com" }) },
  };
}

const baseTask = {
  platform: "slack" as const,
  context_type: "channel" as const,
  delivery_target: "C_OUT",
  thread_ts: null,
  prompt: "Handle Slack event",
  schedule_type: "external",
  schedule_value: "slack_channel_message",
  timezone: "UTC",
  session_mode: "fresh",
  created_by: "user-1",
  status: "active" as const,
  next_run_at: null,
  output_mode: "silent" as const,
};

function slackTrigger(channelId: string) {
  return JSON.stringify([
    {
      id: "trigger",
      type: "trigger",
      label: "Slack channel message",
      icon: "slack",
      position: { x: 0, y: 0 },
      triggerConfig: { type: "slack_channel_message", channelId },
    },
  ]);
}

describe("TaskScheduler.dispatchSlackChannelMessage", () => {
  let db: Kysely<DB>;
  let repo: ReturnType<typeof createScheduledTaskRepository>;

  beforeEach(async () => {
    db = await createTestDb();
    repo = createScheduledTaskRepository(db);
    executionParams = [];
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("dispatches an active exact-channel trigger once and preserves its object payload", async () => {
    await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const scheduler = new TaskScheduler(makeDeps(db) as never);
    const triggerData = { messageTs: "1.2", nested: { exact: true } };

    await scheduler.dispatchSlackChannelMessage("C_MATCH", triggerData);

    await vi.waitFor(() => expect(executionParams).toHaveLength(1));
    expect(executionParams[0]?.triggerData).toBe(triggerData);
  });

  it("does not dispatch wrong-channel, paused, malformed, or non-Slack external workflows", async () => {
    await repo.add({ ...baseTask, steps: slackTrigger("C_OTHER") });
    await repo.add({ ...baseTask, status: "paused", steps: slackTrigger("C_MATCH") });
    await repo.add({ ...baseTask, steps: "not-json" });
    await repo.add({
      ...baseTask,
      steps: JSON.stringify([
        {
          id: "trigger",
          type: "trigger",
          label: "Slack channel message",
          icon: "slack",
          position: { x: 0, y: 0 },
          triggerConfig: { type: "slack_channel_message" },
        },
      ]),
    });
    await repo.add({
      ...baseTask,
      schedule_value: "canvas",
      steps: JSON.stringify([
        {
          id: "trigger",
          type: "trigger",
          label: "Canvas",
          icon: "canvas",
          position: { x: 0, y: 0 },
          triggerConfig: { type: "canvas" },
        },
      ]),
    });
    const scheduler = new TaskScheduler(makeDeps(db) as never);

    await scheduler.dispatchSlackChannelMessage("C_MATCH", { messageTs: "1.2" });

    expect(executionParams).toHaveLength(0);
  });

  it("preserves an explicitly supplied null trigger payload", async () => {
    const task = await repo.add({ ...baseTask, steps: slackTrigger("C_MATCH") });
    const scheduler = new TaskScheduler(makeDeps(db) as never);

    await scheduler.enqueueTaskById(task.id, null);

    await vi.waitFor(() => expect(executionParams).toHaveLength(1));
    expect(executionParams[0]?.triggerData).toBeNull();
  });
});
