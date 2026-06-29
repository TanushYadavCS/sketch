/**
 * Tests for TaskScheduler.
 *
 * Uses an in-memory SQLite DB (via createTestDb) for the repository layer and
 * mocks all external dependencies (croner, runAgent, SlackBot, WhatsAppBot,
 * QueueManager). Croner is vi.mock'd with a plain class so `new Cron()` returns
 * controllable instances tracked in a module-level array. Assertions about
 * scheduling use the instances array and the Cron class constructor call count.
 *
 * executeTask is called directly (not via cron callback) for deterministic tests.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import type { ScheduledTaskRow } from "../db/repositories/scheduled-tasks";
import type { DB } from "../db/schema";
import { QueueManager } from "../queue";
import { createTestConfig, createTestDb, createTestLogger } from "../test-utils";
import type { ExecuteAutomationParams } from "../workflows/runtime";
import { TaskScheduler } from "./service";

interface MockCronInstance {
  stopped: boolean;
  pattern: string | Date;
  nextRun: () => Date | null;
  stop: () => void;
}

const mockCronInstances: MockCronInstance[] = [];
let lastExecuteAutomationParams: ExecuteAutomationParams | null = null;

vi.mock("../workflows/runtime", () => ({
  executeAutomation: vi.fn().mockImplementation(async (params: ExecuteAutomationParams) => {
    lastExecuteAutomationParams = params;
    return { runId: "mock-run-1", status: "completed", finalOutput: null, stepOutputs: {} };
  }),
}));

async function resetExecuteAutomationMock(): Promise<void> {
  const { executeAutomation } = await import("../workflows/runtime");
  vi.mocked(executeAutomation).mockImplementation(async (params: ExecuteAutomationParams) => {
    lastExecuteAutomationParams = params;
    return { runId: "mock-run-1", status: "completed", finalOutput: null, stepOutputs: {} };
  });
}

let cronCallCount = 0;

vi.mock("croner", () => {
  class MockCron {
    stopped = false;
    pattern: string | Date;
    _nextRun = new Date(Date.now() + 60_000);

    constructor(pattern: string | Date, _opts: unknown, _callback?: () => void) {
      this.pattern = pattern;
      cronCallCount++;
      mockCronInstances.push(this);
    }

    nextRun() {
      return this.stopped ? null : this._nextRun;
    }

    stop() {
      this.stopped = true;
    }
  }

  return { Cron: MockCron };
});

function buildMockSlack() {
  return {
    postMessage: vi.fn().mockResolvedValue("ts-123"),
    postThreadReply: vi.fn().mockResolvedValue("ts-reply"),
    openDmChannel: vi.fn().mockResolvedValue("D_OPENED"),
    isConnected: true,
  };
}

function buildMockWhatsApp(connected = true) {
  return {
    sendText: vi.fn().mockResolvedValue({ key: { id: "wa-message-1" }, messageTimestamp: 1717480800 }),
    get isConnected() {
      return connected;
    },
  };
}

function buildDeps(
  db: Kysely<DB>,
  overrides: {
    slack?: ReturnType<typeof buildMockSlack> | null;
    whatsapp?: ReturnType<typeof buildMockWhatsApp>;
    runAgent?: ReturnType<typeof vi.fn>;
    queueManager?: QueueManager;
    limitAgentExecution?: <T>(work: () => Promise<T>) => Promise<T>;
  } = {},
) {
  const mockRunAgent =
    overrides.runAgent ??
    vi.fn().mockResolvedValue({ messageSent: true, sessionId: "s1", costUsd: 0, pendingUploads: [] });
  const slack = overrides.slack !== undefined ? overrides.slack : buildMockSlack();
  const whatsapp = overrides.whatsapp ?? buildMockWhatsApp();
  const queueManager = overrides.queueManager ?? new QueueManager();
  const logger = createTestLogger();
  const config = createTestConfig({ DATA_DIR: "/tmp/sketch-test" });

  return {
    db,
    config,
    logger,
    queueManager,
    getSlack: () => slack as ReturnType<typeof buildMockSlack> | null,
    whatsapp: whatsapp as ReturnType<typeof buildMockWhatsApp>,
    settingsRepo: {
      get: vi.fn().mockResolvedValue({ org_name: "TestOrg", bot_name: "Sketch" }),
    },
    runAgent: mockRunAgent,
    buildMcpServers: vi.fn().mockResolvedValue({}),
    loadIntegrationProvider: vi.fn().mockResolvedValue(null),
    limitAgentExecution: overrides.limitAgentExecution ?? ((work) => work()),
    automationRunsRepo: {
      create: vi.fn().mockResolvedValue("run-1"),
      update: vi.fn().mockResolvedValue(undefined),
      getById: vi.fn().mockResolvedValue(undefined),
      getLatest: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      deleteByTaskId: vi.fn().mockResolvedValue(undefined),
    },
    stepContentRepo: {
      upsert: vi.fn().mockResolvedValue(undefined),
      getByTask: vi.fn().mockResolvedValue([]),
      getByStep: vi.fn().mockResolvedValue(undefined),
      deleteByTaskId: vi.fn().mockResolvedValue(undefined),
      deleteOrphanedSteps: vi.fn().mockResolvedValue(undefined),
    },
    userRepo: {
      list: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue({ email: "test@example.com" }),
      findBySlackId: vi.fn().mockResolvedValue(undefined),
      findByWhatsApp: vi.fn().mockResolvedValue(undefined),
      findByEmail: vi.fn().mockResolvedValue(undefined),
      getAllEmailsForUser: vi.fn().mockResolvedValue(["test@example.com"]),
      create: vi.fn(),
      update: vi.fn(),
    },
    inboxMessagesRepo: {
      create: vi.fn().mockResolvedValue({ id: "inbox-1" }),
    },
    sendDm: vi.fn().mockResolvedValue({ channelId: "D123", messageRef: "1111.0001" }),
    _mockRunAgent: mockRunAgent,
    _slack: slack,
    _whatsapp: whatsapp,
    _queueManager: queueManager,
  };
}

const baseTaskFields = {
  platform: "slack" as const,
  context_type: "dm" as const,
  delivery_target: "U_USER1",
  thread_ts: null,
  prompt: "Check the stats",
  schedule_type: "cron" as const,
  schedule_value: "0 9 * * 1",
  timezone: "UTC",
  session_mode: "fresh" as const,
  created_by: "U_USER1",
  status: "active" as const,
  next_run_at: null,
};

let db: Kysely<DB>;
let repo: ReturnType<typeof createScheduledTaskRepository>;

beforeEach(async () => {
  db = await createTestDb();
  repo = createScheduledTaskRepository(db);
  vi.clearAllMocks();
  await resetExecuteAutomationMock();
  mockCronInstances.length = 0;
  cronCallCount = 0;
});

afterEach(async () => {
  await db.destroy();
});

describe("start()", () => {
  it("schedules all active tasks and creates cron instances", async () => {
    await repo.add({ ...baseTaskFields, prompt: "Task A" });
    await repo.add({ ...baseTaskFields, prompt: "Task B" });
    await repo.add({ ...baseTaskFields, status: "paused", prompt: "Task Paused" });

    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    await scheduler.start();

    expect(cronCallCount).toBe(2);
  });

  it("creates no cron instances when there are no active tasks", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    await scheduler.start();
    expect(cronCallCount).toBe(0);
  });
});

describe("stop()", () => {
  it("stops all cron instances and clears the map", async () => {
    await repo.add({ ...baseTaskFields, prompt: "Task 1" });
    await repo.add({ ...baseTaskFields, prompt: "Task 2" });

    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    await scheduler.start();

    expect(cronCallCount).toBe(2);

    scheduler.stop();

    expect(mockCronInstances.every((i) => i.stopped)).toBe(true);
  });
});

describe("addTask()", () => {
  it("inserts a DB row and schedules the task", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const task = await scheduler.addTask({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "U_USER1",
      prompt: "Send weekly update",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1",
      timezone: "UTC",
      sessionMode: "fresh",
      createdBy: "U_USER1",
      originPlatform: "slack",
      originConversationId: "42",
      originProviderThreadId: "111.222",
      originMessageId: 12,
    });

    expect(task.id).toBeDefined();
    expect(task.prompt).toBe("Send weekly update");
    expect(task.status).toBe("active");
    expect(task.originChat).toEqual({
      platform: "slack",
      conversationId: "42",
      providerThreadId: "111.222",
      currentMessageId: 12,
    });
    expect(cronCallCount).toBe(1);

    const dbRow = await repo.getById(task.id);
    expect(dbRow).toBeDefined();
    expect(dbRow?.prompt).toBe("Send weekly update");
    expect(dbRow).toMatchObject({
      origin_platform: "slack",
      origin_conversation_id: "42",
      origin_provider_thread_id: "111.222",
      origin_message_id: 12,
    });
  });

  it("creates an interval-type cron with the correct schedule value", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    await scheduler.addTask({
      platform: "whatsapp",
      contextType: "dm",
      deliveryTarget: "5511999999999@s.whatsapp.net",
      prompt: "Hourly ping",
      scheduleType: "interval",
      scheduleValue: "3600",
      createdBy: "U_USER1",
    });

    expect(cronCallCount).toBe(1);
    expect(mockCronInstances).toHaveLength(1);
  });

  it("converts large interval (>= 60 min) to a valid hourly cron expression", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    await scheduler.addTask({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "U_USER1",
      prompt: "Every 6 hours",
      scheduleType: "interval",
      scheduleValue: "21600",
      createdBy: "U_USER1",
    });

    const instance = mockCronInstances[mockCronInstances.length - 1];
    expect(instance.pattern).toBe("0 */6 * * *");
  });

  it("stores external trigger tasks without creating a cron instance", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const task = await scheduler.addTask({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "U_USER1",
      prompt: "Run when Canvas fires",
      scheduleType: "external",
      scheduleValue: "canvas",
      createdBy: "U_USER1",
    });

    expect(task.status).toBe("active");
    expect(task.nextRunAt).toBeNull();
    expect(cronCallCount).toBe(0);

    const dbRow = await repo.getById(task.id);
    expect(dbRow?.schedule_type).toBe("external");
    expect(dbRow?.schedule_value).toBe("canvas");
  });
});

describe("removeTask()", () => {
  it("unschedules and deletes the task from DB", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    const task = await scheduler.addTask({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "U_USER1",
      prompt: "To be removed",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1",
      createdBy: "U_USER1",
    });

    const removed = await scheduler.removeTask(task.id);
    expect(removed).toBe(true);

    const dbRow = await repo.getById(task.id);
    expect(dbRow).toBeUndefined();
  });
});

describe("pauseTask()", () => {
  it("unschedules and sets status to paused", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    const task = await scheduler.addTask({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "U_USER1",
      prompt: "Pauseable task",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1",
      createdBy: "U_USER1",
    });

    await scheduler.pauseTask(task.id);

    const dbRow = await repo.getById(task.id);
    expect(dbRow?.status).toBe("paused");
    expect(mockCronInstances[0].stopped).toBe(true);
  });
});

describe("resumeTask()", () => {
  it("sets status to active and reschedules", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    const task = await scheduler.addTask({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "U_USER1",
      prompt: "Resumable task",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1",
      createdBy: "U_USER1",
    });

    const countAfterAdd = cronCallCount;
    await scheduler.pauseTask(task.id);

    await scheduler.resumeTask(task.id);

    const dbRow = await repo.getById(task.id);
    expect(dbRow?.status).toBe("active");
    expect(cronCallCount).toBeGreaterThan(countAfterAdd);
  });
});

describe("listTasks()", () => {
  it("returns tasks filtered by deliveryTarget", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    await scheduler.addTask({
      platform: "slack",
      contextType: "channel",
      deliveryTarget: "C_ALPHA",
      prompt: "A",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1",
      createdBy: "U1",
    });
    await scheduler.addTask({
      platform: "slack",
      contextType: "channel",
      deliveryTarget: "C_BETA",
      prompt: "B",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1",
      createdBy: "U1",
    });
    await scheduler.addTask({
      platform: "slack",
      contextType: "channel",
      deliveryTarget: "C_ALPHA",
      prompt: "C",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1",
      createdBy: "U1",
    });

    const tasks = await scheduler.listTasks({ deliveryTarget: "C_ALPHA" });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.deliveryTarget === "C_ALPHA")).toBe(true);
  });

  it("returns tasks filtered by createdBy", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    await scheduler.addTask({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "U_OWNER",
      prompt: "Mine",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1",
      createdBy: "U_OWNER",
    });
    await scheduler.addTask({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "U_OTHER",
      prompt: "Not mine",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1",
      createdBy: "U_OTHER",
    });

    const tasks = await scheduler.listTasks({ createdBy: "U_OWNER" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].createdBy).toBe("U_OWNER");
  });
});

describe("executeTask() invokes automation runtime", () => {
  afterEach(() => {
    lastExecuteAutomationParams = null;
  });

  it("calls executeAutomation for DM task", async () => {
    const { executeAutomation } = await import("../workflows/runtime");
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({ ...baseTaskFields, platform: "slack", context_type: "dm", created_by: "U_DM_USER" });
    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    expect(executeAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ id: row.id }) }),
    );
  });

  it("forwards sketch-mode agent dependencies to executeAutomation", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({ ...baseTaskFields, platform: "slack", context_type: "dm", created_by: "U_DM_USER" });
    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    expect(lastExecuteAutomationParams).toEqual(
      expect.objectContaining({
        runAgent: deps.runAgent,
        buildMcpServers: deps.buildMcpServers,
        inboxMessagesRepo: deps.inboxMessagesRepo,
        sendDm: deps.sendDm,
        userRepo: deps.userRepo,
        limitAgentExecution: deps.limitAgentExecution,
      }),
    );
  });

  it("calls executeAutomation for Slack channel task", async () => {
    const { executeAutomation } = await import("../workflows/runtime");
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "channel",
      delivery_target: "C_CHANNEL1",
    });
    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    expect(executeAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ id: row.id }) }),
    );
  });

  it("calls executeAutomation for WhatsApp group task", async () => {
    const { executeAutomation } = await import("../workflows/runtime");
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "whatsapp",
      context_type: "group",
      delivery_target: "1234567890@g.us",
    });
    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    expect(executeAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ id: row.id }) }),
    );
  });
});

describe("executeTask() bot availability checks", () => {
  afterEach(() => {
    lastExecuteAutomationParams = null;
  });

  it("skips execution when Slack bot is unavailable", async () => {
    const deps = buildDeps(db, { slack: null });
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({ ...baseTaskFields, platform: "slack" });

    const workspaceMod = await import("../agent/workspace");
    vi.spyOn(workspaceMod, "ensureWorkspace").mockResolvedValue("/tmp/ws");

    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(deps._mockRunAgent).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("runs silent workflows even when Slack delivery is unavailable", async () => {
    const deps = buildDeps(db, { slack: null });
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({ ...baseTaskFields, platform: "slack", output_mode: "silent" });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    expect(lastExecuteAutomationParams?.sendMessage).toBeUndefined();
  });

  it("skips execution when WhatsApp is not connected", async () => {
    const deps = buildDeps(db, { whatsapp: buildMockWhatsApp(false) });
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "5511999999999@s.whatsapp.net",
    });

    const workspaceMod = await import("../agent/workspace");
    vi.spyOn(workspaceMod, "ensureWorkspace").mockResolvedValue("/tmp/ws");

    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(deps._mockRunAgent).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

// Session mode routing is verified through "invokes automation runtime" + "queue key derivation" tests.
// The runtime handles session/workspace logic internally.

describe("executeTask() delivery routing", () => {
  afterEach(() => {
    lastExecuteAutomationParams = null;
  });

  it("Slack DM: sendMessage calls postMessage on the DM channel", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "dm",
      delivery_target: "D_DM_CHANNEL",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    expect(lastExecuteAutomationParams?.sendMessage).toBeDefined();
    await lastExecuteAutomationParams?.sendMessage?.("Hello from task");

    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postMessage).toHaveBeenCalledWith(
      "D_DM_CHANNEL",
      "Hello from task",
    );
    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.openDmChannel).not.toHaveBeenCalled();

    const captured = await db
      .selectFrom("conversation_messages")
      .innerJoin("conversations", "conversations.id", "conversation_messages.conversation_id")
      .select([
        "conversations.platform",
        "conversations.kind",
        "conversations.provider_conversation_id",
        "conversation_messages.provider_message_id",
        "conversation_messages.is_bot",
        "conversation_messages.text",
      ])
      .executeTakeFirstOrThrow();
    expect(captured).toMatchObject({
      platform: "slack",
      kind: "dm",
      provider_conversation_id: "D_DM_CHANNEL",
      provider_message_id: "ts-123",
      is_bot: 1,
      text: "Hello from task",
    });
  });

  it("Slack DM user id: sendMessage opens the DM channel before posting", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "dm",
      delivery_target: "URECIPIENT",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    await lastExecuteAutomationParams?.sendMessage?.("Hello from task");

    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.openDmChannel).toHaveBeenCalledWith(
      "URECIPIENT",
      undefined,
    );
    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postMessage).toHaveBeenCalledWith(
      "D_OPENED",
      "Hello from task",
    );
  });

  it("Slack DM user id: sendMessage fails when the DM channel cannot be opened", async () => {
    const deps = buildDeps(db);
    (deps._slack as ReturnType<typeof buildMockSlack>).openDmChannel.mockResolvedValue(null);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "dm",
      delivery_target: "URECIPIENT",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    await expect(lastExecuteAutomationParams?.sendMessage?.("Hello from task")).rejects.toThrow(
      "Failed to open Slack DM channel",
    );
    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postMessage).not.toHaveBeenCalled();
  });

  it("Slack channel + fresh: sendMessage calls postMessage", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "channel",
      delivery_target: "C_CHANNEL1",
      session_mode: "fresh",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    await lastExecuteAutomationParams?.sendMessage?.("Channel update");

    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postMessage).toHaveBeenCalledWith(
      "C_CHANNEL1",
      "Channel update",
    );
    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postThreadReply).not.toHaveBeenCalled();

    const captured = await db
      .selectFrom("conversation_messages")
      .innerJoin("conversations", "conversations.id", "conversation_messages.conversation_id")
      .select([
        "conversations.platform",
        "conversations.kind",
        "conversations.provider_conversation_id",
        "conversation_messages.provider_message_id",
        "conversation_messages.sender_jid",
        "conversation_messages.is_bot",
        "conversation_messages.text",
      ])
      .executeTakeFirstOrThrow();
    expect(captured).toMatchObject({
      platform: "slack",
      kind: "channel",
      provider_conversation_id: "C_CHANNEL1",
      provider_message_id: "ts-123",
      sender_jid: "bot",
      is_bot: 1,
      text: "Channel update",
    });
  });

  it("Slack channel + fresh + source threadTs: sendMessage posts top-level by default", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "channel",
      delivery_target: "C_CHANNEL1",
      session_mode: "fresh",
      thread_ts: "1234567890.000100",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    await lastExecuteAutomationParams?.sendMessage?.("Thread reply");

    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postThreadReply).not.toHaveBeenCalled();
    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postMessage).toHaveBeenCalledWith(
      "C_CHANNEL1",
      "Thread reply",
    );
  });

  it("Slack channel + outputThreadTs: sendMessage calls postThreadReply", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "channel",
      delivery_target: "C_CHANNEL1",
      session_mode: "fresh",
      thread_ts: "source-thread",
      output_thread_ts: "1234567890.000100",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    await lastExecuteAutomationParams?.sendMessage?.("Thread reply");

    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postThreadReply).toHaveBeenCalledWith(
      "C_CHANNEL1",
      "1234567890.000100",
      "Thread reply",
    );

    const captured = await db
      .selectFrom("conversation_messages")
      .innerJoin("conversations", "conversations.id", "conversation_messages.conversation_id")
      .select([
        "conversations.kind",
        "conversation_messages.provider_message_id",
        "conversation_messages.provider_thread_id",
        "conversation_messages.provider_parent_message_id",
        "conversation_messages.is_thread_reply",
        "conversation_messages.text",
      ])
      .executeTakeFirstOrThrow();
    expect(captured).toMatchObject({
      kind: "channel",
      provider_message_id: "ts-reply",
      provider_thread_id: "1234567890.000100",
      provider_parent_message_id: "1234567890.000100",
      is_thread_reply: 1,
      text: "Thread reply",
    });
  });

  it("Slack channel + fresh + threadTs + output target: sendMessage posts a top-level message", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "channel",
      delivery_target: "C_CHANNEL1",
      output_target: "C_OUTPUT",
      session_mode: "fresh",
      thread_ts: "1234567890.000100",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    await lastExecuteAutomationParams?.sendMessage?.("Output channel update");

    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postThreadReply).not.toHaveBeenCalled();
    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postMessage).toHaveBeenCalledWith(
      "C_OUTPUT",
      "Output channel update",
    );
  });

  it("WhatsApp: sendMessage calls sendText", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "5511999999999@s.whatsapp.net",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    await lastExecuteAutomationParams?.sendMessage?.("WhatsApp message");

    expect((deps._whatsapp as ReturnType<typeof buildMockWhatsApp>).sendText).toHaveBeenCalledWith(
      "5511999999999@s.whatsapp.net",
      "WhatsApp message",
    );

    const captured = await db
      .selectFrom("conversation_messages")
      .innerJoin("conversations", "conversations.id", "conversation_messages.conversation_id")
      .select([
        "conversations.platform",
        "conversations.kind",
        "conversations.provider_conversation_id",
        "conversation_messages.provider_message_id",
        "conversation_messages.sender_jid",
        "conversation_messages.is_bot",
        "conversation_messages.text",
      ])
      .executeTakeFirstOrThrow();
    expect(captured).toMatchObject({
      platform: "whatsapp",
      kind: "dm",
      provider_conversation_id: "5511999999999@s.whatsapp.net",
      provider_message_id: "wa-message-1",
      sender_jid: "bot",
      is_bot: 1,
      text: "WhatsApp message",
    });
  });

  it("WhatsApp group: sendMessage captures the delivered bot message", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "whatsapp",
      context_type: "group",
      delivery_target: "987654321@g.us",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await vi.waitFor(() => expect(lastExecuteAutomationParams).not.toBeNull());

    await lastExecuteAutomationParams?.sendMessage?.("Group workflow result");

    expect((deps._whatsapp as ReturnType<typeof buildMockWhatsApp>).sendText).toHaveBeenCalledWith(
      "987654321@g.us",
      "Group workflow result",
    );

    const captured = await db
      .selectFrom("conversation_messages")
      .innerJoin("conversations", "conversations.id", "conversation_messages.conversation_id")
      .select([
        "conversations.platform",
        "conversations.kind",
        "conversations.provider_conversation_id",
        "conversation_messages.provider_message_id",
        "conversation_messages.is_bot",
        "conversation_messages.text",
      ])
      .executeTakeFirstOrThrow();
    expect(captured).toMatchObject({
      platform: "whatsapp",
      kind: "group",
      provider_conversation_id: "987654321@g.us",
      provider_message_id: "wa-message-1",
      is_bot: 1,
      text: "Group workflow result",
    });
  });
});

describe("executeTask() queue key derivation", () => {
  beforeEach(async () => {
    const workspaceMod = await import("../agent/workspace");
    vi.spyOn(workspaceMod, "ensureWorkspace").mockResolvedValue("/tmp/ws/user");
    vi.spyOn(workspaceMod, "ensureChannelWorkspace").mockResolvedValue("/tmp/ws/channel");
    vi.spyOn(workspaceMod, "ensureGroupWorkspace").mockResolvedValue("/tmp/ws/group");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses task-{id} as queue key for fresh DM (isolated from conversation)", async () => {
    const queueManager = new QueueManager();
    const getQueueSpy = vi.spyOn(queueManager, "getQueue");
    const deps = buildDeps(db, { queueManager });
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({ ...baseTaskFields, platform: "slack", context_type: "dm", created_by: "U_CREATOR" });
    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(getQueueSpy).toHaveBeenCalledWith(`task-${row.id}`);
  });

  it("uses task-{id} as queue key for Slack channel + fresh (isolated)", async () => {
    const queueManager = new QueueManager();
    const getQueueSpy = vi.spyOn(queueManager, "getQueue");
    const deps = buildDeps(db, { queueManager });
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "channel",
      delivery_target: "C_CHAN",
      session_mode: "fresh",
    });
    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(getQueueSpy).toHaveBeenCalledWith(`task-${row.id}`);
  });

  it("uses task-{id} as queue key for legacy persistent mode rows", async () => {
    const queueManager = new QueueManager();
    const getQueueSpy = vi.spyOn(queueManager, "getQueue");
    const deps = buildDeps(db, { queueManager });
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "channel",
      delivery_target: "C_CHAN",
      session_mode: "persistent",
      thread_ts: "111.222",
    });
    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(getQueueSpy).toHaveBeenCalledWith(`task-${row.id}`);
  });

  it("uses task-{id} as queue key for legacy chat mode rows", async () => {
    const queueManager = new QueueManager();
    const getQueueSpy = vi.spyOn(queueManager, "getQueue");
    const deps = buildDeps(db, { queueManager });
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "dm",
      created_by: "U_CREATOR",
      session_mode: "chat",
    });
    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(getQueueSpy).toHaveBeenCalledWith(`task-${row.id}`);
  });

  it("uses task-{id} as queue key for legacy Slack channel-thread chat rows", async () => {
    const queueManager = new QueueManager();
    const getQueueSpy = vi.spyOn(queueManager, "getQueue");
    const deps = buildDeps(db, { queueManager });
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "channel",
      delivery_target: "C_CHAN",
      thread_ts: "111.222",
      session_mode: "chat",
    });
    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(getQueueSpy).toHaveBeenCalledWith(`task-${row.id}`);
    expect(getQueueSpy).not.toHaveBeenCalledWith("C_CHAN:111.222");
  });

  it("uses task-{id} as queue key for WhatsApp group + fresh (isolated)", async () => {
    const queueManager = new QueueManager();
    const getQueueSpy = vi.spyOn(queueManager, "getQueue");
    const deps = buildDeps(db, { queueManager });
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "whatsapp",
      context_type: "group",
      delivery_target: "987654321@g.us",
    });
    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(getQueueSpy).toHaveBeenCalledWith(`task-${row.id}`);
  });

  it("uses task-{id} as queue key for legacy WhatsApp chat mode rows", async () => {
    const queueManager = new QueueManager();
    const getQueueSpy = vi.spyOn(queueManager, "getQueue");
    const deps = buildDeps(db, { queueManager });
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "whatsapp",
      context_type: "group",
      delivery_target: "987654321@g.us",
      session_mode: "chat",
    });
    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(getQueueSpy).toHaveBeenCalledWith(`task-${row.id}`);
  });
});

describe("executeTaskById() queueing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes manual runs through the scheduler queue", async () => {
    const { executeAutomation } = await import("../workflows/runtime");
    const executeAutomationMock = vi.mocked(executeAutomation);
    let releaseFirst: (() => void) | undefined;
    let activeRuns = 0;
    let maxActiveRuns = 0;
    let callCount = 0;

    executeAutomationMock.mockImplementation(async (params: ExecuteAutomationParams) => {
      lastExecuteAutomationParams = params;
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      callCount += 1;
      const runNumber = callCount;
      if (runNumber === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      activeRuns -= 1;
      return { runId: `run-${runNumber}`, status: "completed", finalOutput: null, stepOutputs: {} };
    });

    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    const row = await repo.add({ ...baseTaskFields, session_mode: "persistent" });

    const firstRun = scheduler.executeTaskById(row.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(callCount).toBe(1);

    const secondRun = scheduler.executeTaskById(row.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(callCount).toBe(1);
    expect(maxActiveRuns).toBe(1);

    releaseFirst?.();
    await firstRun;
    await secondRun;

    expect(callCount).toBe(2);
    expect(maxActiveRuns).toBe(1);
  });

  it("does not rerun a once task that completes while a manual run is queued", async () => {
    const { executeAutomation } = await import("../workflows/runtime");
    const executeAutomationMock = vi.mocked(executeAutomation);
    let releaseScheduledRun: (() => void) | undefined;
    let callCount = 0;

    executeAutomationMock.mockImplementation(async (params: ExecuteAutomationParams) => {
      lastExecuteAutomationParams = params;
      callCount += 1;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          releaseScheduledRun = resolve;
        });
      }
      return { runId: `run-${callCount}`, status: "completed", finalOutput: null, stepOutputs: {} };
    });

    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    const row = await repo.add({
      ...baseTaskFields,
      schedule_type: "once",
      schedule_value: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const manualRun = scheduler.executeTaskById(row.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(callCount).toBe(1);

    releaseScheduledRun?.();
    await expect(manualRun).resolves.toBeNull();
    expect(callCount).toBe(1);
  });

  it("enqueueTaskById validates then returns without waiting for execution", async () => {
    const { executeAutomation } = await import("../workflows/runtime");
    const executeAutomationMock = vi.mocked(executeAutomation);
    let releaseRun: (() => void) | undefined;
    let callCount = 0;

    executeAutomationMock.mockImplementation(async (params: ExecuteAutomationParams) => {
      lastExecuteAutomationParams = params;
      callCount += 1;
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return { runId: "run-1", status: "completed", finalOutput: null, stepOutputs: {} };
    });

    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    const row = await repo.add({ ...baseTaskFields, session_mode: "chat" });

    await scheduler.enqueueTaskById(row.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(callCount).toBe(1);

    releaseRun?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  });

  it("enqueueTaskById returns immediately when a legacy chat-mode Slack thread task queue is already running", async () => {
    const { executeAutomation } = await import("../workflows/runtime");
    const executeAutomationMock = vi.mocked(executeAutomation);
    let releaseFirst: (() => void) | undefined;
    let callCount = 0;

    executeAutomationMock.mockImplementation(async (params: ExecuteAutomationParams) => {
      lastExecuteAutomationParams = params;
      callCount += 1;
      const runNumber = callCount;
      if (runNumber === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { runId: `run-${runNumber}`, status: "completed", finalOutput: null, stepOutputs: {} };
    });

    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    const row = await repo.add({
      ...baseTaskFields,
      context_type: "channel",
      delivery_target: "C0ARCAF5G4F",
      thread_ts: "1778913948.627689",
      session_mode: "chat",
    });

    const activeRun = scheduler.executeTaskById(row.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(callCount).toBe(1);

    await expect(scheduler.enqueueTaskById(row.id)).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(callCount).toBe(1);

    releaseFirst?.();
    await activeRun;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(callCount).toBe(2);
  });
});

describe("executeTask() run timestamps", () => {
  it("updates last_run_at after execution", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const workspaceMod = await import("../agent/workspace");
    vi.spyOn(workspaceMod, "ensureWorkspace").mockResolvedValue("/tmp/ws/user");

    const row = await repo.add({ ...baseTaskFields, platform: "slack", context_type: "dm" });

    await scheduler.scheduleTask(row as ScheduledTaskRow);
    await scheduler.executeTask(row as ScheduledTaskRow);

    const updated = await vi.waitFor(async () => {
      const task = await repo.getById(row.id);
      expect(task?.last_run_at).toBeDefined();
      return task;
    });
    expect(Number.isNaN(new Date(updated?.last_run_at as string).getTime())).toBe(false);

    vi.restoreAllMocks();
  });
});

describe("scheduleTask() with once type", () => {
  it("creates a croner instance using a Date pattern", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const row = await repo.add({
      ...baseTaskFields,
      schedule_type: "once",
      schedule_value: futureDate,
    });

    await scheduler.scheduleTask(row as ScheduledTaskRow);

    expect(cronCallCount).toBe(1);
    expect(mockCronInstances[0].pattern).toBeInstanceOf(Date);
    expect((mockCronInstances[0].pattern as Date).toISOString()).toBe(futureDate);
  });

  it("marks task as completed immediately when the datetime has already passed", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const pastDate = new Date(Date.now() - 3_600_000).toISOString();
    const row = await repo.add({
      ...baseTaskFields,
      schedule_type: "once",
      schedule_value: pastDate,
    });

    await scheduler.scheduleTask(row as ScheduledTaskRow);

    expect(cronCallCount).toBe(0);

    const updated = await repo.getById(row.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.next_run_at).toBeNull();
  });
});

describe("executeTask() with once type", () => {
  beforeEach(async () => {
    const workspaceMod = await import("../agent/workspace");
    vi.spyOn(workspaceMod, "ensureWorkspace").mockResolvedValue("/tmp/ws/user");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets status to completed after execution", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const row = await repo.add({
      ...baseTaskFields,
      schedule_type: "once",
      schedule_value: futureDate,
    });

    await scheduler.scheduleTask(row as ScheduledTaskRow);
    await scheduler.executeTask(row as ScheduledTaskRow);

    await new Promise<void>((r) => setTimeout(r, 10));

    const updated = await repo.getById(row.id);
    expect(updated?.status).toBe("completed");
  });

  it("unschedules the cron instance after execution", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const row = await repo.add({
      ...baseTaskFields,
      schedule_type: "once",
      schedule_value: futureDate,
    });

    await scheduler.scheduleTask(row as ScheduledTaskRow);
    expect(mockCronInstances).toHaveLength(1);

    await scheduler.executeTask(row as ScheduledTaskRow);

    await new Promise<void>((r) => setTimeout(r, 10));

    expect(mockCronInstances[0].stopped).toBe(true);
  });

  it("sets next_run_at to null after execution", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const row = await repo.add({
      ...baseTaskFields,
      schedule_type: "once",
      schedule_value: futureDate,
    });

    await scheduler.scheduleTask(row as ScheduledTaskRow);
    await scheduler.executeTask(row as ScheduledTaskRow);

    await new Promise<void>((r) => setTimeout(r, 10));

    const updated = await repo.getById(row.id);
    expect(updated?.next_run_at).toBeNull();
  });
});

describe("start() with completed tasks", () => {
  it("skips completed tasks and only loads active ones", async () => {
    await repo.add({ ...baseTaskFields, prompt: "Active task", status: "active" });
    const completedRow = await repo.add({ ...baseTaskFields, prompt: "Completed once task", status: "active" });
    await repo.updateStatus(completedRow.id, "completed");

    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);
    await scheduler.start();

    expect(cronCallCount).toBe(1);
  });
});

describe("addTask() with once schedule type", () => {
  it("persists and schedules a once task correctly", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const futureDate = new Date(Date.now() + 7_200_000).toISOString();
    const task = await scheduler.addTask({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "U_USER1",
      prompt: "One-time reminder",
      scheduleType: "once",
      scheduleValue: futureDate,
      createdBy: "U_USER1",
    });

    expect(task.scheduleType).toBe("once");
    expect(task.scheduleValue).toBe(futureDate);
    expect(task.status).toBe("active");
    expect(cronCallCount).toBe(1);
    expect(mockCronInstances[0].pattern).toBeInstanceOf(Date);

    const dbRow = await repo.getById(task.id);
    expect(dbRow?.schedule_type).toBe("once");
  });

  it("interprets a naive ISO local schedule_value in the task's timezone (Asia/Kolkata)", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    // Naive local time, no Z, no offset. 5 PM IST should resolve to 11:30 UTC.
    await scheduler.addTask({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "U_USER1",
      prompt: "Tomorrow at 5pm IST",
      scheduleType: "once",
      scheduleValue: "2099-05-02T17:00:00",
      timezone: "Asia/Kolkata",
      createdBy: "U_USER1",
    });

    const pattern = mockCronInstances[mockCronInstances.length - 1].pattern;
    expect(pattern).toBeInstanceOf(Date);
    expect((pattern as Date).toISOString()).toBe("2099-05-02T11:30:00.000Z");
  });

  it("preserves the absolute instant when schedule_value carries a Z suffix", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    // Z suffix means absolute UTC — task tz must not shift it.
    await scheduler.addTask({
      platform: "slack",
      contextType: "dm",
      deliveryTarget: "U_USER1",
      prompt: "Absolute UTC instant",
      scheduleType: "once",
      scheduleValue: "2099-05-02T17:00:00Z",
      timezone: "Asia/Kolkata",
      createdBy: "U_USER1",
    });

    const pattern = mockCronInstances[mockCronInstances.length - 1].pattern;
    expect(pattern).toBeInstanceOf(Date);
    expect((pattern as Date).toISOString()).toBe("2099-05-02T17:00:00.000Z");
  });
});
