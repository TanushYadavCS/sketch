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
import { TaskScheduler } from "./service";

interface MockCronInstance {
  stopped: boolean;
  pattern: string | Date;
  nextRun: () => Date | null;
  stop: () => void;
}

const mockCronInstances: MockCronInstance[] = [];
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
    isConnected: true,
  };
}

function buildMockWhatsApp(connected = true) {
  return {
    sendText: vi.fn().mockResolvedValue(undefined),
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
    findIntegrationProvider: vi.fn().mockResolvedValue(null),
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
    });

    expect(task.id).toBeDefined();
    expect(task.prompt).toBe("Send weekly update");
    expect(task.status).toBe("active");
    expect(cronCallCount).toBe(1);

    const dbRow = await repo.getById(task.id);
    expect(dbRow).toBeDefined();
    expect(dbRow?.prompt).toBe("Send weekly update");
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

describe("executeTask() workspace resolution", () => {
  it("uses ensureWorkspace for Slack DM", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({ ...baseTaskFields, platform: "slack", context_type: "dm", created_by: "U_DM_USER" });

    const workspaceMod = await import("../agent/workspace");
    const ensureSpy = vi.spyOn(workspaceMod, "ensureWorkspace").mockResolvedValue("/tmp/ws/U_DM_USER");

    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(ensureSpy).toHaveBeenCalledWith(deps.config, "U_DM_USER");
    ensureSpy.mockRestore();
  });

  it("uses ensureChannelWorkspace for Slack channel", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "channel",
      delivery_target: "C_CHANNEL1",
    });

    const workspaceMod = await import("../agent/workspace");
    const ensureSpy = vi.spyOn(workspaceMod, "ensureChannelWorkspace").mockResolvedValue("/tmp/ws/channel-C_CHANNEL1");

    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(ensureSpy).toHaveBeenCalledWith(deps.config, "C_CHANNEL1");
    ensureSpy.mockRestore();
  });

  it("uses ensureGroupWorkspace for WhatsApp group", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "whatsapp",
      context_type: "group",
      delivery_target: "1234567890@g.us",
    });

    const workspaceMod = await import("../agent/workspace");
    const ensureSpy = vi.spyOn(workspaceMod, "ensureGroupWorkspace").mockResolvedValue("/tmp/ws/wa-group-1234567890");

    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(ensureSpy).toHaveBeenCalledWith(deps.config, "1234567890@g.us");
    ensureSpy.mockRestore();
  });
});

describe("executeTask() bot availability checks", () => {
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

describe("executeTask() session modes", () => {
  beforeEach(async () => {
    const workspaceMod = await import("../agent/workspace");
    vi.spyOn(workspaceMod, "ensureWorkspace").mockResolvedValue("/tmp/ws/user");
    vi.spyOn(workspaceMod, "ensureChannelWorkspace").mockResolvedValue("/tmp/ws/channel");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes sessionMode=fresh and no threadTs for fresh mode", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({ ...baseTaskFields, session_mode: "fresh", context_type: "dm" });

    await scheduler.executeTask(row as ScheduledTaskRow);

    await new Promise<void>((r) => setTimeout(r, 10));

    expect(deps._mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionMode: "fresh", threadTs: undefined }),
    );
  });

  it("passes sessionMode=persistent and threadTs=task-{id} for persistent mode", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({ ...baseTaskFields, session_mode: "persistent", context_type: "dm" });

    await scheduler.executeTask(row as ScheduledTaskRow);

    await new Promise<void>((r) => setTimeout(r, 10));

    expect(deps._mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionMode: "persistent", threadTs: `task-${row.id}` }),
    );
  });

  it("passes sessionMode=chat and original threadTs for chat mode in Slack channel", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      session_mode: "chat",
      context_type: "channel",
      delivery_target: "C_CHAN1",
      thread_ts: "1234567890.000100",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);

    await new Promise<void>((r) => setTimeout(r, 10));

    expect(deps._mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionMode: "chat", threadTs: "1234567890.000100" }),
    );
  });

  it("passes sessionMode=chat and undefined threadTs for chat mode in DM", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({ ...baseTaskFields, session_mode: "chat", context_type: "dm" });

    await scheduler.executeTask(row as ScheduledTaskRow);

    await new Promise<void>((r) => setTimeout(r, 10));

    expect(deps._mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionMode: "chat", threadTs: undefined }),
    );
  });
});

describe("executeTask() delivery routing", () => {
  beforeEach(async () => {
    const workspaceMod = await import("../agent/workspace");
    vi.spyOn(workspaceMod, "ensureWorkspace").mockResolvedValue("/tmp/ws/user");
    vi.spyOn(workspaceMod, "ensureChannelWorkspace").mockResolvedValue("/tmp/ws/channel");
    vi.spyOn(workspaceMod, "ensureGroupWorkspace").mockResolvedValue("/tmp/ws/group");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Slack DM: calls postMessage on the DM channel", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "dm",
      delivery_target: "D_DM_CHANNEL",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await new Promise<void>((r) => setTimeout(r, 10));

    const onFinalMessage = (deps._mockRunAgent as ReturnType<typeof vi.fn>).mock.calls[0][0].onFinalMessage;
    await onFinalMessage("Hello from task");

    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postMessage).toHaveBeenCalledWith(
      "D_DM_CHANNEL",
      "Hello from task",
    );
  });

  it("Slack channel + fresh: calls postMessage (not thread reply)", async () => {
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
    await new Promise<void>((r) => setTimeout(r, 10));

    const onFinalMessage = (deps._mockRunAgent as ReturnType<typeof vi.fn>).mock.calls[0][0].onFinalMessage;
    await onFinalMessage("Channel update");

    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postMessage).toHaveBeenCalledWith(
      "C_CHANNEL1",
      "Channel update",
    );
    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postThreadReply).not.toHaveBeenCalled();
  });

  it("Slack channel + chat + threadTs: calls postThreadReply", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "channel",
      delivery_target: "C_CHANNEL1",
      session_mode: "chat",
      thread_ts: "1234567890.000100",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await new Promise<void>((r) => setTimeout(r, 10));

    const onFinalMessage = (deps._mockRunAgent as ReturnType<typeof vi.fn>).mock.calls[0][0].onFinalMessage;
    await onFinalMessage("Thread reply");

    expect((deps._slack as ReturnType<typeof buildMockSlack>)?.postThreadReply).toHaveBeenCalledWith(
      "C_CHANNEL1",
      "1234567890.000100",
      "Thread reply",
    );
  });

  it("WhatsApp: calls sendText", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "whatsapp",
      context_type: "dm",
      delivery_target: "5511999999999@s.whatsapp.net",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await new Promise<void>((r) => setTimeout(r, 10));

    const onFinalMessage = (deps._mockRunAgent as ReturnType<typeof vi.fn>).mock.calls[0][0].onFinalMessage;
    await onFinalMessage("WhatsApp message");

    expect((deps._whatsapp as ReturnType<typeof buildMockWhatsApp>).sendText).toHaveBeenCalledWith(
      "5511999999999@s.whatsapp.net",
      "WhatsApp message",
    );
  });
});

describe("executeTask() prompt building", () => {
  beforeEach(async () => {
    const workspaceMod = await import("../agent/workspace");
    vi.spyOn(workspaceMod, "ensureWorkspace").mockResolvedValue("/tmp/ws/user");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds scheduled task runs through buildSketchContext with <task>, <time>, and <workspace>", async () => {
    const deps = buildDeps(db);
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({
      ...baseTaskFields,
      platform: "slack",
      context_type: "dm",
      delivery_target: "D_DM_CHANNEL",
      prompt: "Send the daily summary",
    });

    await scheduler.executeTask(row as ScheduledTaskRow);
    await new Promise<void>((r) => setTimeout(r, 10));

    const agentCall = (deps._mockRunAgent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(agentCall.userMessage).toContain("<context>");
    expect(agentCall.userMessage).toContain("<time>");
    expect(agentCall.userMessage).toContain("<workspace>");
    expect(agentCall.userMessage).toContain("<task>Send the daily summary</task>");
    expect(agentCall.userMessage).not.toContain("[Scheduled Task]");
    expect(agentCall.userMessage).not.toContain("<inbox>");
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

  it("uses created_by as queue key for DM", async () => {
    const queueManager = new QueueManager();
    const getQueueSpy = vi.spyOn(queueManager, "getQueue");
    const deps = buildDeps(db, { queueManager });
    const scheduler = new TaskScheduler(deps as never);

    const row = await repo.add({ ...baseTaskFields, platform: "slack", context_type: "dm", created_by: "U_CREATOR" });
    await scheduler.executeTask(row as ScheduledTaskRow);

    expect(getQueueSpy).toHaveBeenCalledWith("U_CREATOR");
  });

  it("uses delivery_target as queue key for Slack channel + fresh", async () => {
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

    expect(getQueueSpy).toHaveBeenCalledWith("C_CHAN");
  });

  it("uses delivery_target:thread_ts as queue key for Slack channel + persistent with threadTs", async () => {
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

    expect(getQueueSpy).toHaveBeenCalledWith("C_CHAN:111.222");
  });

  it("uses wa-group-{jid} as queue key for WhatsApp group", async () => {
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

    expect(getQueueSpy).toHaveBeenCalledWith("wa-group-987654321");
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

    const updated = await repo.getById(row.id);
    expect(updated?.last_run_at).toBeDefined();
    expect(typeof updated?.last_run_at).toBe("string");

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
});
