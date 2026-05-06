/**
 * Tests for the handleManageScheduledTasks tool handler.
 *
 * Uses a minimal mock TaskScheduler to isolate tool logic from DB/croner dependencies.
 * Covers context scoping (DM vs channel), default session mode selection, chat mode
 * rejection for top-level channels, required field validation, and CRUD delegation.
 */
import { describe, expect, it, vi } from "vitest";
import { handleManageScheduledTasks } from "../agent/sketch-tools";
import type { TaskScheduler } from "./service";
import type { ScheduledTask } from "./types";
import type { TaskContext } from "./types";

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    platform: "slack",
    contextType: "dm",
    deliveryTarget: "C123",
    threadTs: null,
    prompt: "Do a thing",
    scheduleType: "cron",
    scheduleValue: "0 9 * * 1-5",
    timezone: "UTC",
    sessionMode: "chat",
    nextRunAt: null,
    lastRunAt: null,
    status: "active",
    createdBy: "U123",
    createdAt: "2025-01-01T00:00:00.000Z",
    title: null,
    description: null,
    steps: null,
    edges: null,
    outputTarget: null,
    outputPlatform: null,
    ...overrides,
  };
}

function makeMockScheduler(overrides: Partial<TaskScheduler> = {}): TaskScheduler {
  return {
    listTasks: vi.fn().mockResolvedValue([]),
    // Default ownership check returns a task owned by the standard test creator "U123".
    // Tests that exercise the not-yours branch override this with their own mock.
    getTaskById: vi.fn().mockResolvedValue(makeTask()),
    addTask: vi.fn().mockResolvedValue(makeTask()),
    updateTask: vi.fn().mockResolvedValue(makeTask()),
    removeTask: vi.fn().mockResolvedValue(true),
    pauseTask: vi.fn().mockResolvedValue(undefined),
    resumeTask: vi.fn().mockResolvedValue(undefined),
    executeTaskById: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn(),
    scheduleTask: vi.fn(),
    unscheduleTask: vi.fn(),
    executeTask: vi.fn(),
    ...overrides,
  } as unknown as TaskScheduler;
}

function makeMockStepContentRepo() {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    getByTask: vi.fn().mockResolvedValue([]),
    getByStep: vi.fn().mockResolvedValue(undefined),
    deleteByTaskId: vi.fn().mockResolvedValue(undefined),
    deleteOrphanedSteps: vi.fn().mockResolvedValue(undefined),
  } as unknown as NonNullable<Parameters<typeof handleManageScheduledTasks>[1]["stepContentRepo"]>;
}

const dmContext: TaskContext = {
  platform: "slack",
  contextType: "dm",
  deliveryTarget: "D123",
  createdBy: "U123",
};

const channelContext: TaskContext = {
  platform: "slack",
  contextType: "channel",
  deliveryTarget: "C456",
  createdBy: "U123",
};

const channelThreadContext: TaskContext = {
  platform: "slack",
  contextType: "channel",
  deliveryTarget: "C456",
  createdBy: "U123",
  threadTs: "1234567890.123456",
};

const whatsappGroupContext: TaskContext = {
  platform: "whatsapp",
  contextType: "group",
  deliveryTarget: "120363000000@g.us",
  createdBy: "U123",
};

const stepContentRepo = makeMockStepContentRepo();

describe("handleManageScheduledTasks — list", () => {
  it("scopes by createdBy for DM context", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks({ action: "list" }, { scheduler, stepContentRepo, taskContext: dmContext });
    expect(scheduler.listTasks).toHaveBeenCalledWith({ createdBy: "U123" });
  });

  it("scopes by deliveryTarget for channel context", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks({ action: "list" }, { scheduler, stepContentRepo, taskContext: channelContext });
    expect(scheduler.listTasks).toHaveBeenCalledWith({ deliveryTarget: "C456" });
  });

  it("scopes by deliveryTarget for group context", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "list" },
      { scheduler, stepContentRepo, taskContext: whatsappGroupContext },
    );
    expect(scheduler.listTasks).toHaveBeenCalledWith({ deliveryTarget: "120363000000@g.us" });
  });

  it("returns JSON of tasks", async () => {
    const task = makeTask();
    const scheduler = makeMockScheduler({ listTasks: vi.fn().mockResolvedValue([task]) });
    const result = await handleManageScheduledTasks(
      { action: "list" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("task-1");
  });
});

describe("handleManageScheduledTasks — add", () => {
  it("returns error when prompt is missing", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Error:");
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });

  it("returns error when schedule_type is missing", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Error:");
  });

  it("returns error when schedule_value is missing", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Error:");
  });

  it("defaults session_mode to 'chat' for DM context", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ sessionMode: "chat" }));
  });

  it("defaults session_mode to 'fresh' for top-level channel context (no threadTs)", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: channelContext },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ sessionMode: "fresh" }));
  });

  it("defaults session_mode to 'chat' for channel thread context", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: channelThreadContext },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ sessionMode: "chat" }));
  });

  it("defaults session_mode to 'fresh' for WhatsApp group", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "interval", schedule_value: "3600" },
      { scheduler, stepContentRepo, taskContext: whatsappGroupContext },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ sessionMode: "fresh" }));
  });

  it("rejects 'chat' session_mode for top-level channel (no threadTs)", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1", session_mode: "chat" },
      { scheduler, stepContentRepo, taskContext: channelContext },
    );
    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("chat");
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });

  it("allows 'chat' session_mode for channel thread", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1", session_mode: "chat" },
      { scheduler, stepContentRepo, taskContext: channelThreadContext },
    );
    expect(result.content[0].text).not.toContain("Error:");
    expect(scheduler.addTask).toHaveBeenCalled();
  });

  it("fills platform/contextType/deliveryTarget/createdBy from taskContext", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "slack",
        contextType: "dm",
        deliveryTarget: "D123",
        createdBy: "U123",
      }),
    );
  });

  it("passes threadTs from taskContext when in a thread", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: channelThreadContext },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ threadTs: "1234567890.123456" }));
  });

  it("returns created task in response", async () => {
    const task = makeTask({ id: "new-task" });
    const scheduler = makeMockScheduler({ addTask: vi.fn().mockResolvedValue(task) });
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("new-task");
    expect(result.content[0].text).toContain("Automation created:");
  });

  it("persists agent step prompts via stepContentRepo for multi-step workflows", async () => {
    const localRepo = makeMockStepContentRepo();
    const scheduler = makeMockScheduler({ addTask: vi.fn().mockResolvedValue(makeTask({ id: "wf-1" })) });
    const result = await handleManageScheduledTasks(
      {
        action: "add",
        title: "Hourly summary",
        schedule_type: "cron",
        schedule_value: "0 * * * *",
        steps: [
          {
            id: "trigger",
            type: "trigger",
            label: "Hourly",
            icon: "clock",
            position: { x: 0, y: 0 },
            triggerConfig: { type: "schedule" },
          },
          {
            id: "agent1",
            type: "agent",
            label: "Summarize",
            icon: "sketch-ai",
            position: { x: 0, y: 100 },
            agentPrompt: "Summarize the previous step output into a digest.",
          },
        ],
      },
      { scheduler, stepContentRepo: localRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Automation created:");
    expect(localRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "wf-1",
        stepId: "agent1",
        contentType: "prompt",
        content: "Summarize the previous step output into a digest.",
      }),
    );
    // Steps JSON passed to scheduler.addTask must not contain agentPrompt (stripped)
    const addTaskCall = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const stepsJson = JSON.parse(addTaskCall.steps);
    const agentStep = stepsJson.find((s: { id: string }) => s.id === "agent1");
    expect(agentStep.agentPrompt).toBeUndefined();
  });

  it("fails loudly when multi-step workflow is created without stepContentRepo", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      {
        action: "add",
        title: "No repo",
        schedule_type: "cron",
        schedule_value: "0 * * * *",
        steps: [
          {
            id: "trigger",
            type: "trigger",
            label: "Hourly",
            icon: "clock",
            position: { x: 0, y: 0 },
            triggerConfig: { type: "schedule" },
          },
          {
            id: "agent1",
            type: "agent",
            label: "Summarize",
            icon: "sketch-ai",
            position: { x: 0, y: 100 },
            agentPrompt: "Summarize.",
          },
        ],
      },
      { scheduler, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Error: step content storage is not available");
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });
});

describe("handleManageScheduledTasks — broker-capability gate", () => {
  const httpOnlyProvider = {
    type: "fake",
    listApps: async () => ({ apps: [], pageInfo: { endCursor: null, hasMore: false } }),
    initiateConnection: async () => ({ redirectUrl: "" }),
    listConnections: async () => [],
    removeConnection: async () => {},
    isBrokerCapable: () => false,
    getBrokerSpec: () => null,
  };

  const actionStepWorkflow = {
    title: "Action wf",
    schedule_type: "cron" as const,
    schedule_value: "0 * * * *",
    steps: [
      {
        id: "trigger",
        type: "trigger" as const,
        label: "Hourly",
        icon: "clock",
        position: { x: 0, y: 0 },
        triggerConfig: { type: "schedule" as const },
      },
      {
        id: "act1",
        type: "action" as const,
        label: "Run script",
        icon: "code",
        position: { x: 0, y: 100 },
        script: "console.log('hi');",
      },
    ],
  };

  it("rejects 'add' with action steps when provider is HTTP-only", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", ...actionStepWorkflow },
      {
        scheduler,
        stepContentRepo,
        taskContext: dmContext,
        loadIntegrationProvider: async () => httpOnlyProvider,
      },
    );
    expect(result.content[0].text).toContain("broker-capable integration provider");
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });

  it("rejects 'add' with action steps when no provider is configured", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", ...actionStepWorkflow },
      {
        scheduler,
        stepContentRepo,
        taskContext: dmContext,
        loadIntegrationProvider: async () => null,
      },
    );
    expect(result.content[0].text).toContain("broker-capable integration provider");
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });

  it("rejects 'update' with action steps when provider is HTTP-only and does not mutate the task", async () => {
    const localRepo = makeMockStepContentRepo();
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "task-1", steps: actionStepWorkflow.steps },
      {
        scheduler,
        stepContentRepo: localRepo,
        taskContext: dmContext,
        loadIntegrationProvider: async () => httpOnlyProvider,
      },
    );
    expect(result.content[0].text).toContain("broker-capable integration provider");
    expect(scheduler.updateTask).not.toHaveBeenCalled();
    expect(localRepo.upsert).not.toHaveBeenCalled();
    expect(localRepo.deleteOrphanedSteps).not.toHaveBeenCalled();
  });
});

describe("handleManageScheduledTasks — update", () => {
  it("returns error when task_id is missing", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "update", prompt: "New prompt" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Error:");
    expect(scheduler.updateTask).not.toHaveBeenCalled();
  });

  it("returns error when task not found", async () => {
    const scheduler = makeMockScheduler({ updateTask: vi.fn().mockResolvedValue(null) });
    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "nonexistent", prompt: "New prompt" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("nonexistent");
  });

  it("calls scheduler.updateTask with provided fields", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "update", task_id: "task-1", prompt: "Updated", schedule_value: "0 10 * * 1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(scheduler.updateTask).toHaveBeenCalledWith("task-1", {
      prompt: "Updated",
      scheduleType: undefined,
      scheduleValue: "0 10 * * 1",
      timezone: undefined,
      sessionMode: undefined,
    });
  });

  it("returns updated task in response", async () => {
    const task = makeTask({ prompt: "Updated" });
    const scheduler = makeMockScheduler({ updateTask: vi.fn().mockResolvedValue(task) });
    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "task-1", prompt: "Updated" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Automation updated:");
  });
});

describe("handleManageScheduledTasks — remove", () => {
  it("returns error when task_id is missing", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "remove" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Error:");
    expect(scheduler.removeTask).not.toHaveBeenCalled();
  });

  it("returns error when task not found", async () => {
    const scheduler = makeMockScheduler({ removeTask: vi.fn().mockResolvedValue(false) });
    const result = await handleManageScheduledTasks(
      { action: "remove", task_id: "nonexistent" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Error:");
  });

  it("calls scheduler.removeTask and confirms removal", async () => {
    const scheduler = makeMockScheduler({ removeTask: vi.fn().mockResolvedValue(true) });
    const result = await handleManageScheduledTasks(
      { action: "remove", task_id: "task-1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(scheduler.removeTask).toHaveBeenCalledWith("task-1");
    expect(result.content[0].text).toContain("task-1");
    expect(result.content[0].text).toContain("removed");
  });
});

describe("handleManageScheduledTasks — pause", () => {
  it("returns error when task_id is missing", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "pause" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Error:");
    expect(scheduler.pauseTask).not.toHaveBeenCalled();
  });

  it("calls scheduler.pauseTask and confirms", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "pause", task_id: "task-1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(scheduler.pauseTask).toHaveBeenCalledWith("task-1");
    expect(result.content[0].text).toContain("paused");
  });
});

describe("handleManageScheduledTasks — resume", () => {
  it("returns error when task_id is missing", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "resume" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Error:");
    expect(scheduler.resumeTask).not.toHaveBeenCalled();
  });

  it("calls scheduler.resumeTask and confirms", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "resume", task_id: "task-1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(scheduler.resumeTask).toHaveBeenCalledWith("task-1");
    expect(result.content[0].text).toContain("resumed");
  });
});

describe("handleManageScheduledTasks — add with once schedule type", () => {
  it("succeeds with a valid future ISO datetime", async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const task = makeTask({ scheduleType: "once", scheduleValue: futureDate });
    const scheduler = makeMockScheduler({ addTask: vi.fn().mockResolvedValue(task) });
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Do it once", schedule_type: "once", schedule_value: futureDate },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).not.toContain("Error:");
    expect(result.content[0].text).toContain("Automation created:");
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ scheduleType: "once" }));
  });

  it("returns validation error for a past datetime", async () => {
    const pastDate = new Date(Date.now() - 3_600_000).toISOString();
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Too late", schedule_type: "once", schedule_value: pastDate },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("past");
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });

  it("returns validation error for an invalid (non-ISO) string", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Bad date", schedule_type: "once", schedule_value: "not-a-date" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("ISO 8601");
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });
});

describe("handleManageScheduledTasks — ownership", () => {
  const GUARDED_ACTIONS = ["update", "remove", "pause", "resume", "run", "getRun", "updateStepContent"] as const;

  function buildParams(action: (typeof GUARDED_ACTIONS)[number]): Parameters<typeof handleManageScheduledTasks>[0] {
    if (action === "updateStepContent") {
      return { action, task_id: "task-1", step_id: "step1", step_content: "new prompt" };
    }
    return { action, task_id: "task-1" };
  }

  for (const action of GUARDED_ACTIONS) {
    it(`rejects '${action}' when the task was created by a different user`, async () => {
      const otherUsersTask = makeTask({ createdBy: "U_OTHER" });
      const scheduler = makeMockScheduler({
        getTaskById: vi.fn().mockResolvedValue(otherUsersTask),
      });

      const result = await handleManageScheduledTasks(buildParams(action), {
        scheduler,
        stepContentRepo,
        taskContext: dmContext, // createdBy: "U123"
      });

      expect(result.content[0].text).toBe("Error: task not found.");
      // No mutating / side-effecting operation should have fired.
      expect(scheduler.updateTask).not.toHaveBeenCalled();
      expect(scheduler.removeTask).not.toHaveBeenCalled();
      expect(scheduler.pauseTask).not.toHaveBeenCalled();
      expect(scheduler.resumeTask).not.toHaveBeenCalled();
      expect(scheduler.executeTaskById).not.toHaveBeenCalled();
    });

    it(`rejects '${action}' with same phrasing when the task is missing`, async () => {
      const scheduler = makeMockScheduler({
        getTaskById: vi.fn().mockResolvedValue(null),
      });

      const result = await handleManageScheduledTasks(buildParams(action), {
        scheduler,
        stepContentRepo,
        taskContext: dmContext,
      });

      // Same phrasing as the "not yours" branch — avoids existence leak.
      expect(result.content[0].text).toBe("Error: task not found.");
    });
  }

  it("allows a guarded action when the caller owns the task", async () => {
    const ownTask = makeTask({ createdBy: "U123" });
    const scheduler = makeMockScheduler({
      getTaskById: vi.fn().mockResolvedValue(ownTask),
    });

    const result = await handleManageScheduledTasks(
      { action: "pause", task_id: "task-1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );

    expect(result.content[0].text).not.toContain("Error:");
    expect(scheduler.pauseTask).toHaveBeenCalledWith("task-1");
  });
});
