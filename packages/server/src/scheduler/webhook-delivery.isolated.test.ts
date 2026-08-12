import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createWebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries";
import { createWebhookEndpointsRepository } from "../db/repositories/webhook-endpoints";
import type { DB } from "../db/schema";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import * as workflowRuntime from "../workflows/runtime";
import { TaskScheduler } from "./service";

vi.mock("../workflows/runtime", async () => {
  const actual = await vi.importActual<typeof import("../workflows/runtime")>("../workflows/runtime");
  return {
    ...actual,
    executeAutomation: vi.fn().mockResolvedValue({
      runId: "runtime-run",
      status: "completed",
      finalOutput: null,
      stepOutputs: {},
    }),
  };
});

function webhookSteps() {
  return JSON.stringify([
    {
      id: "trigger",
      type: "trigger",
      label: "Webhook",
      icon: "webhook",
      position: { x: 0, y: 0 },
      triggerConfig: { type: "webhook" },
    },
    {
      id: "agent",
      type: "agent",
      label: "Process",
      icon: "sketch-ai",
      position: { x: 260, y: 0 },
      agentMode: "sketch",
    },
  ]);
}

function buildScheduler(
  db: Kysely<DB>,
  options: { queueAccepted?: boolean; runImmediately?: boolean } = {},
): {
  scheduler: TaskScheduler;
  callbacks: Array<() => Promise<void>>;
} {
  const callbacks: Array<() => Promise<void>> = [];
  const queueAccepted = options.queueAccepted ?? true;
  const queueManager = {
    getQueue: vi.fn(() => ({
      enqueue: (callback: () => Promise<void>) => {
        if (!queueAccepted) return false;
        if (options.runImmediately) {
          void callback();
        } else {
          callbacks.push(callback);
        }
        return true;
      },
    })),
  };
  const automationRunsRepo = {
    create: vi.fn().mockResolvedValue("run-1"),
    update: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue(undefined),
  };
  const deps = {
    db,
    config: createTestConfig({ DATA_DIR: "/tmp/sketch-webhook-test" }),
    logger: createTestLogger(),
    queueManager,
    getSlack: () => null,
    whatsapp: { isConnected: false } as never,
    settingsRepo: { get: vi.fn().mockResolvedValue(null) },
    runAgent: vi.fn(),
    runScheduledAgent: vi.fn(),
    buildMcpServers: vi.fn().mockResolvedValue({}),
    loadIntegrationProvider: vi.fn().mockResolvedValue(null),
    automationRunsRepo,
    stepContentRepo: {
      getByTask: vi.fn().mockResolvedValue([]),
    },
    userRepo: {
      findById: vi.fn().mockResolvedValue(null),
    },
    limitAgentExecution: <T>(work: () => Promise<T>) => work(),
    limitScheduledAgentExecution: <T>(work: () => Promise<T>) => work(),
  };
  return { scheduler: new TaskScheduler(deps as never), callbacks };
}

describe("TaskScheduler native webhook delivery", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    vi.mocked(workflowRuntime.executeAutomation).mockClear();
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function createDelivery(status: "active" | "paused" = "active") {
    const task = await createScheduledTaskRepository(db).add({
      id: "webhook-task",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D123",
      thread_ts: null,
      prompt: "Process webhook data",
      schedule_type: "external",
      schedule_value: "webhook",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: null,
      status,
      next_run_at: null,
      steps: webhookSteps(),
      output_mode: "silent",
    });
    const endpoint = await createWebhookEndpointsRepository(db, {
      idGenerator: () => "webhook-endpoint",
    }).ensureForTask(task.id);
    const delivery = await createWebhookDeliveriesRepository(db).insertOrGet({
      endpointId: endpoint.endpoint.id,
      taskId: task.id,
      eventId: "event-1",
      payloadHash: "hash-1",
      triggerData: { source: "webhook", data: { value: 1 } },
      taskRevision: task.revision,
      endpointGeneration: endpoint.endpoint.generation,
    });
    return delivery.delivery;
  }

  it("recovers a pending delivery without racing its startup queue handoff", async () => {
    const delivery = await createDelivery();
    const { scheduler } = buildScheduler(db, { runImmediately: true });

    try {
      await scheduler.start();
      await vi.waitFor(async () => {
        await expect(createWebhookDeliveriesRepository(db).getById(delivery.id)).resolves.toMatchObject({
          status: "completed",
        });
      });
    } finally {
      scheduler.stop();
    }
  });

  it("queues and processes one durable delivery without changing schedule state", async () => {
    const delivery = await createDelivery();
    const { scheduler, callbacks } = buildScheduler(db);

    await expect(scheduler.enqueueWebhookDelivery(delivery.id)).resolves.toBe(true);
    await expect(createWebhookDeliveriesRepository(db).getById(delivery.id)).resolves.toMatchObject({
      status: "queued",
    });
    expect(callbacks).toHaveLength(1);

    await callbacks[0]?.();

    await expect(createWebhookDeliveriesRepository(db).getById(delivery.id)).resolves.toMatchObject({
      status: "completed",
      run_id: expect.any(String),
    });
    const run = await db
      .selectFrom("automation_runs")
      .selectAll()
      .where("task_id", "=", "webhook-task")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(run.trigger_data ?? "{}")).toMatchObject({ source: "webhook", data: { value: 1 } });
    expect(workflowRuntime.executeAutomation).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        triggerData: { source: "webhook", data: { value: 1 } },
      }),
    );
    await expect(createScheduledTaskRepository(db).getById("webhook-task")).resolves.toMatchObject({
      last_run_at: null,
      status: "active",
    });
  });

  it("leaves a durable receipt pending when the bounded queue sheds it", async () => {
    const delivery = await createDelivery();
    const { scheduler, callbacks } = buildScheduler(db, { queueAccepted: false });

    await expect(scheduler.enqueueWebhookDelivery(delivery.id)).resolves.toBe(false);
    expect(callbacks).toHaveLength(0);
    await expect(createWebhookDeliveriesRepository(db).getById(delivery.id)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("cancels an admitted delivery when its automation is paused", async () => {
    const delivery = await createDelivery("paused");
    const { scheduler } = buildScheduler(db);

    await expect(scheduler.enqueueWebhookDelivery(delivery.id)).resolves.toBe(false);
    await expect(createWebhookDeliveriesRepository(db).getById(delivery.id)).resolves.toMatchObject({
      status: "cancelled",
      error_message: "Automation is no longer active",
    });
  });

  it("cancels a queued delivery when its endpoint is revoked", async () => {
    const delivery = await createDelivery();
    await createWebhookEndpointsRepository(db).deactivateForTask("webhook-task");
    const { scheduler } = buildScheduler(db);

    await expect(scheduler.enqueueWebhookDelivery(delivery.id)).resolves.toBe(false);
    await expect(createWebhookDeliveriesRepository(db).getById(delivery.id)).resolves.toMatchObject({
      status: "cancelled",
      error_message: "Webhook endpoint is no longer active",
    });
  });

  it("fences a queued delivery when the automation revision changes", async () => {
    const delivery = await createDelivery();
    const { scheduler, callbacks } = buildScheduler(db);

    await expect(scheduler.enqueueWebhookDelivery(delivery.id)).resolves.toBe(true);
    await createScheduledTaskRepository(db).update("webhook-task", { prompt: "Changed" }, { incrementRevision: true });
    await callbacks[0]?.();

    await expect(createWebhookDeliveriesRepository(db).getById(delivery.id)).resolves.toMatchObject({
      status: "cancelled",
      error_message: "Automation or webhook endpoint changed before delivery execution",
    });
    expect(workflowRuntime.executeAutomation).not.toHaveBeenCalled();
  });
});
