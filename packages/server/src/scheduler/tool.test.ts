/**
 * Tests for the handleManageScheduledTasks tool handler.
 *
 * Uses a minimal mock TaskScheduler to isolate tool logic from DB/croner dependencies.
 * Covers context scoping (DM vs channel), fresh-only session mode validation,
 * required field validation, and CRUD delegation.
 */
import { describe, expect, it, vi } from "vitest";
import { handleManageScheduledTasks } from "../agent/sketch-tools";
import {
  AutomationAuthoringGeneratedOutputError,
  AutomationAuthoringValidationError,
} from "../automation/authoring/service";
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
    sessionMode: "fresh",
    nextRunAt: null,
    lastRunAt: null,
    status: "active",
    createdBy: "U123",
    createdAt: "2025-01-01T00:00:00.000Z",
    title: null,
    description: null,
    originChat: null,
    steps: null,
    edges: null,
    outputTarget: null,
    outputPlatform: null,
    outputThreadTs: null,
    outputMode: "deliver",
    delivery: {
      platform: "slack",
      targetType: "channel",
      targetId: "C123",
      threadTs: null,
      mode: "deliver",
    },
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
    enqueueTaskById: vi.fn().mockResolvedValue(undefined),
    touchTaskRevision: vi.fn().mockResolvedValue(undefined),
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

function makeMockUserRepo(
  overrides: Partial<NonNullable<Parameters<typeof handleManageScheduledTasks>[1]["userRepo"]>> = {},
) {
  return {
    findById: vi.fn().mockResolvedValue({ id: "U_OTHER", name: "roopak", email: "roopak@canvasx.ai" }),
    list: vi.fn().mockResolvedValue([]),
    getAllEmailsForUser: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as NonNullable<Parameters<typeof handleManageScheduledTasks>[1]["userRepo"]>;
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

describe("handleManageScheduledTasks — configured chat authoring", () => {
  it("routes natural-language creation through the authorer and collects the saved artifact", async () => {
    const scheduler = makeMockScheduler();
    const savedTask = makeTask({ id: "authored-task", title: "Daily brief", prompt: "Daily brief" });
    const chatAuthoring = {
      author: vi.fn().mockResolvedValue({
        kind: "saved",
        task: savedTask,
        artifact: {
          steps: [
            {
              id: "trigger",
              type: "trigger",
              label: "Schedule",
              icon: "clock",
              position: { x: 0, y: 0 },
              triggerConfig: { type: "schedule" },
            },
            {
              id: "brief",
              type: "agent",
              label: "Write brief",
              icon: "sketch-ai",
              position: { x: 260, y: 0 },
              agentMode: "sketch",
            },
          ],
          scheduleType: "cron",
          scheduleValue: "0 9 * * 1-5",
          timezone: "Asia/Kolkata",
        },
      }),
    };
    const automationArtifactCollector = {
      collect: vi.fn(),
      drain: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof handleManageScheduledTasks>[1]["automationArtifactCollector"]>;

    const result = await handleManageScheduledTasks(
      { action: "add", request: "Every weekday at 9, send me a concise daily brief" },
      {
        scheduler,
        stepContentRepo,
        taskContext: { ...dmContext, creatorTimezone: "Asia/Kolkata" },
        chatAuthoring,
        automationArtifactCollector,
      },
    );

    expect(chatAuthoring.author).toHaveBeenCalledWith({
      action: "create",
      request: "Every weekday at 9, send me a concise daily brief",
      taskContext: { ...dmContext, creatorTimezone: "Asia/Kolkata" },
    });
    expect(scheduler.addTask).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Automation created:");
    expect(automationArtifactCollector.collect).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "authored-task", title: "Daily brief" }),
    );
  });

  it("routes natural-language editing through the authorer for database-backed ownership validation", async () => {
    const scheduler = makeMockScheduler();
    const chatAuthoring = {
      author: vi.fn().mockResolvedValue({
        kind: "saved",
        task: makeTask({ title: "Shorter brief" }),
        artifact: {
          steps: [],
          scheduleType: "cron",
          scheduleValue: "0 9 * * 1-5",
          timezone: "UTC",
        },
      }),
    };

    await handleManageScheduledTasks(
      { action: "update", task_id: "task-1", request: "Make the summary shorter" },
      { scheduler, stepContentRepo, taskContext: dmContext, chatAuthoring },
    );

    expect(scheduler.getTaskById).not.toHaveBeenCalled();
    expect(chatAuthoring.author).toHaveBeenCalledWith({
      action: "edit",
      request: "Make the summary shorter",
      taskId: "task-1",
      taskContext: dmContext,
    });
    expect(scheduler.updateTask).not.toHaveBeenCalled();
  });

  it("reports invalid generated output separately from provider unavailability", async () => {
    const scheduler = makeMockScheduler();
    const chatAuthoring = {
      author: vi
        .fn()
        .mockRejectedValue(new AutomationAuthoringValidationError(new AutomationAuthoringGeneratedOutputError())),
    };

    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "task-1", request: "Rewrite the action script" },
      { scheduler, stepContentRepo, taskContext: dmContext, chatAuthoring },
    );

    expect(result.content[0].text).toBe(
      "Error: automation authoring could not produce a valid definition. No changes were saved.",
    );
  });

  it("masks another owner's configured edit and does not emit a new-automation artifact", async () => {
    const scheduler = makeMockScheduler();
    const chatAuthoring = {
      author: vi.fn().mockResolvedValue({ kind: "error", message: "Automation not found." }),
    };
    const automationArtifactCollector = {
      collect: vi.fn(),
      drain: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof handleManageScheduledTasks>[1]["automationArtifactCollector"]>;

    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "task-1", request: "Rename it" },
      {
        scheduler,
        stepContentRepo,
        taskContext: { ...dmContext, createdBy: "other-user" },
        chatAuthoring,
        automationArtifactCollector,
      },
    );

    expect(result.content[0].text).toBe("Error: Automation not found.");
    expect(result.content[0].text).not.toContain("Roopak");
    expect(chatAuthoring.author).toHaveBeenCalledOnce();
    expect(automationArtifactCollector.collect).not.toHaveBeenCalled();
  });

  it("rejects legacy structured add and update fields instead of persisting a main-model bypass", async () => {
    const scheduler = makeMockScheduler();
    const chatAuthoring = { author: vi.fn() };

    const addResult = await handleManageScheduledTasks(
      {
        action: "add",
        request: "Create a brief",
        prompt: "Main-model prompt",
        schedule_type: "cron",
        schedule_value: "0 9 * * *",
      },
      { scheduler, stepContentRepo, taskContext: dmContext, chatAuthoring },
    );
    const updateResult = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "task-1",
        request: "Change it",
        title: "Main-model title",
      },
      { scheduler, stepContentRepo, taskContext: dmContext, chatAuthoring },
    );

    expect(addResult.content[0].text).toContain("structured automation fields");
    expect(updateResult.content[0].text).toContain("structured automation fields");
    expect(chatAuthoring.author).not.toHaveBeenCalled();
    expect(scheduler.addTask).not.toHaveBeenCalled();
    expect(scheduler.updateTask).not.toHaveBeenCalled();
  });

  it("rejects direct step-content updates and requires a full authored edit", async () => {
    const scheduler = makeMockScheduler();
    const chatAuthoring = { author: vi.fn() };

    const result = await handleManageScheduledTasks(
      { action: "updateStepContent", task_id: "task-1", step_id: "brief", step_content: "Rewrite this" },
      { scheduler, stepContentRepo, taskContext: dmContext, chatAuthoring },
    );

    expect(result.content[0].text).toContain("full automation edit");
    expect(chatAuthoring.author).not.toHaveBeenCalled();
    expect(stepContentRepo.upsert).not.toHaveBeenCalled();
  });

  it.each(["list", "remove", "pause", "resume", "run", "getRun", "share"] as const)(
    "keeps %s deterministic without invoking the authorer",
    async (action) => {
      const scheduler = makeMockScheduler();
      const chatAuthoring = { author: vi.fn() };
      const automationRunsRepo = {
        getLatest: vi.fn().mockResolvedValue({ id: "run-1" }),
        deleteByTaskId: vi.fn().mockResolvedValue(undefined),
      } as unknown as NonNullable<Parameters<typeof handleManageScheduledTasks>[1]["automationRunsRepo"]>;

      await handleManageScheduledTasks(action === "list" ? { action } : { action, task_id: "task-1" }, {
        scheduler,
        stepContentRepo,
        automationRunsRepo,
        taskContext: dmContext,
        chatAuthoring,
      });

      expect(chatAuthoring.author).not.toHaveBeenCalled();
    },
  );

  it.each([
    { result: { kind: "clarification", message: "Which timezone should I use?" }, expected: "Which timezone" },
    { result: { kind: "error", message: "Automation authoring is temporarily unavailable." }, expected: "Error:" },
  ])("does not collect an artifact for $result.kind", async ({ result: authoringResult, expected }) => {
    const scheduler = makeMockScheduler();
    const chatAuthoring = { author: vi.fn().mockResolvedValue(authoringResult) };
    const automationArtifactCollector = {
      collect: vi.fn(),
      drain: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof handleManageScheduledTasks>[1]["automationArtifactCollector"]>;

    const result = await handleManageScheduledTasks(
      { action: "add", request: "Create something" },
      { scheduler, stepContentRepo, taskContext: dmContext, chatAuthoring, automationArtifactCollector },
    );

    expect(result.content[0].text).toContain(expected);
    expect(automationArtifactCollector.collect).not.toHaveBeenCalled();
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });

  it("preserves legacy add behavior when no authorer is configured", async () => {
    const scheduler = makeMockScheduler();

    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );

    expect(scheduler.addTask).toHaveBeenCalledOnce();
  });
});

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

  it.each([
    ["channel", channelContext],
    ["group", whatsappGroupContext],
  ] as const)("scopes admin %s listings by deliveryTarget", async (_contextName, taskContext) => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "list" },
      { scheduler, stepContentRepo, taskContext: { ...taskContext, canManageAnyTask: true } },
    );
    expect(scheduler.listTasks).toHaveBeenCalledWith({ deliveryTarget: taskContext.deliveryTarget });
  });

  it("lists every automation for an admin context", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "list" },
      { scheduler, stepContentRepo, taskContext: { ...dmContext, canManageAnyTask: true } },
    );
    expect(scheduler.listTasks).toHaveBeenCalledWith({ includeInactive: true });
  });

  it("fails closed when listing without an authenticated creator", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "list" },
      { scheduler, stepContentRepo, taskContext: { ...channelContext, createdBy: null, canManageAnyTask: true } },
    );
    expect(result.content[0].text).toBe("Error: scheduled task creator is not available in this context.");
    expect(scheduler.listTasks).not.toHaveBeenCalled();
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

  it("defaults session_mode to 'fresh' for DM context", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ sessionMode: "fresh" }));
  });

  it("defaults session_mode to 'fresh' for top-level channel context (no threadTs)", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: channelContext },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ sessionMode: "fresh" }));
  });

  it("defaults session_mode to 'fresh' for channel thread context", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: channelThreadContext },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ sessionMode: "fresh" }));
  });

  it("defaults session_mode to 'fresh' for WhatsApp group", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "interval", schedule_value: "3600" },
      { scheduler, stepContentRepo, taskContext: whatsappGroupContext },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ sessionMode: "fresh" }));
  });

  it("uses creator's timezone when params.timezone is omitted", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      {
        scheduler,
        stepContentRepo,
        taskContext: { ...dmContext, creatorTimezone: "Asia/Kolkata" },
      },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Asia/Kolkata" }));
  });

  it("falls back to creator's timezone when params.timezone is an empty string", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1", timezone: "" },
      {
        scheduler,
        stepContentRepo,
        taskContext: { ...dmContext, creatorTimezone: "Asia/Kolkata" },
      },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ timezone: "Asia/Kolkata" }));
  });

  it("falls back to UTC when both params.timezone and creatorTimezone are blank", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1", timezone: "   " },
      {
        scheduler,
        stepContentRepo,
        taskContext: { ...dmContext, creatorTimezone: "" },
      },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ timezone: "UTC" }));
  });

  it("explicit params.timezone wins over creatorTimezone", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      {
        action: "add",
        prompt: "Do it",
        schedule_type: "cron",
        schedule_value: "0 9 * * 1",
        timezone: "America/Los_Angeles",
      },
      {
        scheduler,
        stepContentRepo,
        taskContext: { ...dmContext, creatorTimezone: "Asia/Kolkata" },
      },
    );
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ timezone: "America/Los_Angeles" }));
  });

  it("rejects non-fresh session modes", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1", session_mode: "chat" },
      { scheduler, stepContentRepo, taskContext: channelContext },
    );
    expect(result.content[0].text).toContain("Error:");
    expect(result.content[0].text).toContain("only 'fresh'");
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });

  it("allows explicit 'fresh' session_mode for channel thread", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1", session_mode: "fresh" },
      { scheduler, stepContentRepo, taskContext: channelThreadContext },
    );
    expect(result.content[0].text).not.toContain("Error:");
    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ sessionMode: "fresh" }));
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

  it("does not default workflow delivery to the current Slack thread", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: channelThreadContext },
    );

    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ outputThreadTs: undefined }));
  });

  it("supports explicit delivery to the current Slack thread", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      {
        action: "add",
        prompt: "Do it",
        schedule_type: "cron",
        schedule_value: "0 9 * * 1",
        delivery: { targetType: "thread" },
      },
      { scheduler, stepContentRepo, taskContext: channelThreadContext },
    );

    expect(scheduler.addTask).toHaveBeenCalledWith(expect.objectContaining({ outputThreadTs: "1234567890.123456" }));
  });

  it("creates simple prompt automations as Sketch-mode agent steps", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );

    const addTaskCall = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const stepsJson = JSON.parse(addTaskCall.steps);
    expect(stepsJson.find((step: { id: string }) => step.id === "step1")).toEqual(
      expect.objectContaining({ type: "agent", agentMode: "sketch" }),
    );
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

  it("collects structured automation artifacts for successful adds", async () => {
    const task = makeTask({ id: "new-task", title: "Daily account brief", prompt: "Daily account brief" });
    const scheduler = makeMockScheduler({ addTask: vi.fn().mockResolvedValue(task) });
    const automationArtifactCollector = {
      collect: vi.fn(),
      drain: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof handleManageScheduledTasks>[1]["automationArtifactCollector"]>;
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Daily account brief", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      {
        scheduler,
        stepContentRepo,
        taskContext: dmContext,
        automationArtifactCollector,
      },
    );

    expect(result.content[0].text).not.toContain("builderUrl");
    expect(automationArtifactCollector.collect).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "new-task",
        title: "Daily account brief",
        builderUrl: "http://localhost:3000/scheduled-tasks/new-task/edit",
        status: "active",
      }),
    );
  });

  it("passes origin chat metadata when creating automations", async () => {
    const scheduler = makeMockScheduler({ addTask: vi.fn().mockResolvedValue(makeTask({ id: "origin-task" })) });
    await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      {
        scheduler,
        stepContentRepo,
        taskContext: {
          ...dmContext,
          origin: { platform: "web", conversationId: "chat-alpha", providerThreadId: null, currentMessageId: null },
        },
      },
    );

    expect(scheduler.addTask).toHaveBeenCalledWith(
      expect.objectContaining({
        originPlatform: "web",
        originConversationId: "chat-alpha",
        originProviderThreadId: null,
      }),
    );
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

  it("creates Canvas-managed trigger workflows without requiring a local schedule", async () => {
    const localRepo = makeMockStepContentRepo();
    const scheduler = makeMockScheduler({ addTask: vi.fn().mockResolvedValue(makeTask({ id: "wf-canvas" })) });
    const result = await handleManageScheduledTasks(
      {
        action: "add",
        title: "New ClickUp issues",
        steps: [
          {
            id: "trigger",
            type: "trigger",
            label: "ClickUp issue created",
            icon: "clickup",
            position: { x: 0, y: 0 },
            triggerConfig: {
              type: "canvas",
              app: "clickup",
              eventDescription: "new issue created",
              componentKey: "clickup.issue.created",
            },
          },
          {
            id: "agent1",
            type: "agent",
            label: "Handle issue",
            icon: "sketch-ai",
            position: { x: 0, y: 100 },
            agentPrompt: "Handle the incoming issue.",
          },
        ],
      },
      { scheduler, stepContentRepo: localRepo, taskContext: dmContext },
    );

    expect(result.content[0].text).toContain("Automation created:");
    expect(scheduler.addTask).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleType: "external",
        scheduleValue: "canvas",
      }),
    );
    const addTaskCall = (scheduler.addTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const stepsJson = JSON.parse(addTaskCall.steps);
    expect(stepsJson[0].triggerConfig).toEqual(
      expect.objectContaining({
        type: "canvas",
        status: "pending_canvas_setup",
      }),
    );
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

  it("rejects workflow graphs with fan-out before creating a task", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      {
        action: "add",
        title: "Fan out",
        schedule_type: "cron",
        schedule_value: "0 9 * * 1",
        steps: [
          {
            id: "trigger",
            type: "trigger",
            label: "Schedule",
            icon: "clock",
            position: { x: 0, y: 0 },
            triggerConfig: { type: "schedule" },
          },
          {
            id: "agent1",
            type: "agent",
            label: "First",
            icon: "sketch-ai",
            position: { x: 0, y: 100 },
            agentPrompt: "First prompt.",
          },
          {
            id: "agent2",
            type: "agent",
            label: "Second",
            icon: "sketch-ai",
            position: { x: 0, y: 200 },
            agentPrompt: "Second prompt.",
          },
        ],
        edges: [
          { id: "trigger-agent1", from: "trigger", to: "agent1" },
          { id: "trigger-agent2", from: "trigger", to: "agent2" },
        ],
      },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );

    expect(result.content[0].text).toContain("FAN_OUT_UNSUPPORTED");
    expect(scheduler.addTask).not.toHaveBeenCalled();
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

  it("syncs stored schedule trigger metadata when only schedule fields are updated", async () => {
    const scheduler = makeMockScheduler({
      getTaskById: vi.fn().mockResolvedValue(
        makeTask({
          scheduleType: "cron",
          scheduleValue: "*/5 * * * *",
          timezone: "UTC",
          steps: JSON.stringify([
            {
              id: "trigger",
              type: "trigger",
              label: "Every 5 minutes",
              icon: "clock",
              position: { x: 0, y: 0 },
              triggerConfig: {
                type: "schedule",
                scheduleType: "cron",
                scheduleValue: "*/5 * * * *",
                timezone: "UTC",
              },
            },
            {
              id: "agent1",
              type: "agent",
              label: "Check inbox",
              icon: "sketch-ai",
              position: { x: 0, y: 100 },
            },
          ]),
        }),
      ),
    });

    await handleManageScheduledTasks(
      { action: "update", task_id: "task-1", schedule_value: "*/10 * * * *" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );

    const updateFields = (scheduler.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1] as { steps: string };
    const stepsJson = JSON.parse(updateFields.steps);
    expect(stepsJson[0].label).toBe("Every 10 minutes");
    expect(stepsJson[0].triggerConfig).toEqual(
      expect.objectContaining({
        type: "schedule",
        scheduleType: "cron",
        scheduleValue: "*/10 * * * *",
        timezone: "UTC",
      }),
    );
  });

  it("can clear Slack thread delivery without changing the channel target", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "task-1",
        delivery: { platform: "slack", targetType: "channel", targetId: "C456", threadTs: null },
      },
      { scheduler, stepContentRepo, taskContext: channelThreadContext },
    );

    expect(scheduler.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        outputPlatform: "slack",
        outputTarget: "C456",
        outputThreadTs: null,
      }),
    );
  });

  it("clears Slack thread delivery when retargeting to a channel", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "task-1",
        delivery: { platform: "slack", targetType: "channel", targetId: "COPS" },
      },
      { scheduler, stepContentRepo, taskContext: channelThreadContext },
    );

    expect(scheduler.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        outputPlatform: "slack",
        outputTarget: "COPS",
        outputThreadTs: null,
      }),
    );
  });

  it("does not clear Slack thread delivery for mode-only delivery updates", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "task-1",
        delivery: { mode: "silent" },
      },
      { scheduler, stepContentRepo, taskContext: channelThreadContext },
    );

    expect(scheduler.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        outputMode: "silent",
      }),
    );
    expect((scheduler.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toHaveProperty("outputThreadTs");
  });

  it("sets the current channel target when updating delivery to the current thread", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "task-1",
        delivery: { targetType: "thread" },
      },
      { scheduler, stepContentRepo, taskContext: channelThreadContext },
    );

    expect(scheduler.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        outputPlatform: "slack",
        outputTarget: "C456",
        outputThreadTs: "1234567890.123456",
      }),
    );
  });

  it("normalizes schedule fields when updating steps to a Canvas-managed trigger", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "task-1",
        steps: [
          {
            id: "trigger",
            type: "trigger",
            label: "Linear issue created",
            icon: "linear",
            position: { x: 0, y: 0 },
            triggerConfig: {
              type: "canvas",
              app: "linear",
              eventDescription: "new issue created",
              componentKey: "linear.issue.created",
            },
          },
          {
            id: "agent1",
            type: "agent",
            label: "Handle issue",
            icon: "sketch-ai",
            position: { x: 0, y: 100 },
            agentPrompt: "Handle the issue.",
          },
        ],
      },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );

    expect(scheduler.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        scheduleType: "external",
        scheduleValue: "canvas",
      }),
    );
    const updateFields = (scheduler.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1] as { steps: string };
    const stepsJson = JSON.parse(updateFields.steps);
    expect(stepsJson[0].triggerConfig).toEqual(
      expect.objectContaining({
        type: "canvas",
        status: "pending_canvas_setup",
      }),
    );
  });

  it("preserves existing edges and step content when updating step metadata only", async () => {
    const existingSteps = [
      {
        id: "trigger",
        type: "trigger" as const,
        label: "Every weekday",
        icon: "clock",
        position: { x: 0, y: 0 },
        triggerConfig: {
          type: "schedule" as const,
          scheduleType: "cron" as const,
          scheduleValue: "0 9 * * 1-5",
          timezone: "UTC",
        },
      },
      {
        id: "agent1",
        type: "agent" as const,
        label: "Check inbox",
        icon: "sketch-ai",
        position: { x: 260, y: 0 },
      },
    ];
    const existingEdges = [{ id: "trigger-agent1", from: "trigger", to: "agent1" }];
    const scheduler = makeMockScheduler({
      getTaskById: vi.fn().mockResolvedValue(
        makeTask({
          steps: JSON.stringify(existingSteps),
          edges: JSON.stringify(existingEdges),
          outputPlatform: "slack",
          outputTarget: "D123",
        }),
      ),
    });
    const localRepo = makeMockStepContentRepo();
    vi.mocked(localRepo.getByTask).mockResolvedValue([
      {
        task_id: "task-1",
        step_id: "agent1",
        content_type: "prompt",
        content: "Summarize the inbox",
        apps: null,
        updated_at: "2026-06-01T00:00:00.000Z",
      },
    ]);

    await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "task-1",
        steps: [
          existingSteps[0],
          {
            ...existingSteps[1],
            label: "Check priority inbox",
            position: { x: 300, y: 20 },
          },
        ],
      },
      { scheduler, stepContentRepo: localRepo, taskContext: dmContext },
    );

    expect(localRepo.deleteOrphanedSteps).toHaveBeenCalledWith("task-1", ["trigger", "agent1"]);
    expect(localRepo.upsert).not.toHaveBeenCalled();
    expect(scheduler.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.not.objectContaining({
        edges: expect.any(String),
      }),
    );
    const updateFields = (scheduler.updateTask as ReturnType<typeof vi.fn>).mock.calls[0][1] as { steps: string };
    expect(JSON.parse(updateFields.steps)[1]).toMatchObject({
      id: "agent1",
      label: "Check priority inbox",
      position: { x: 300, y: 20 },
    });
  });

  it("rejects step updates whose trigger metadata does not match the schedule", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "task-1",
        steps: [
          {
            id: "trigger",
            type: "trigger",
            label: "Webhook",
            icon: "webhook",
            position: { x: 0, y: 0 },
            triggerConfig: { type: "webhook" },
          },
          {
            id: "agent1",
            type: "agent",
            label: "Check inbox",
            icon: "sketch-ai",
            position: { x: 0, y: 100 },
            agentPrompt: "Check inbox.",
          },
        ],
      },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );

    expect(result.content[0].text).toContain("TRIGGER_CONFIG_MISMATCH");
    expect(scheduler.updateTask).not.toHaveBeenCalled();
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

describe("handleManageScheduledTasks — updateStepContent", () => {
  it("updates step content and bumps the task revision", async () => {
    const scheduler = makeMockScheduler();
    const localRepo = makeMockStepContentRepo();
    vi.mocked(localRepo.getByStep).mockResolvedValue({
      task_id: "task-1",
      step_id: "step1",
      content_type: "prompt",
      content: "old prompt",
      apps: null,
      updated_at: "2026-06-01T00:00:00.000Z",
    });

    const result = await handleManageScheduledTasks(
      { action: "updateStepContent", task_id: "task-1", step_id: "step1", step_content: "new prompt" },
      { scheduler, stepContentRepo: localRepo, taskContext: dmContext },
    );

    expect(localRepo.upsert).toHaveBeenCalledWith({
      taskId: "task-1",
      stepId: "step1",
      contentType: "prompt",
      content: "new prompt",
      apps: null,
    });
    expect(scheduler.touchTaskRevision).toHaveBeenCalledWith("task-1");
    expect(result.content[0].text).toContain("content updated");
  });
});

describe("handleManageScheduledTasks — run", () => {
  it("awaits execution and returns the run result", async () => {
    const runResult = {
      runId: "run-1",
      status: "completed",
      finalOutput: { ok: true },
      stepOutputs: { step1: { output: { ok: true }, status: "completed", duration_ms: 12 } },
    };
    const scheduler = makeMockScheduler({
      getTaskById: vi.fn().mockResolvedValue(makeTask({ sessionMode: "fresh" })),
      executeTaskById: vi.fn().mockResolvedValue(runResult),
    });

    const result = await handleManageScheduledTasks(
      { action: "run", task_id: "task-1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );

    expect(scheduler.executeTaskById).toHaveBeenCalledWith("task-1");
    expect(result.content[0].text).toContain("Automation task-1 completed");
    expect(result.content[0].text).toContain('"runId": "run-1"');
    expect(result.content[0].text).toContain('"ok": true');
  });

  it("awaits same-thread fresh runs because automation queues are isolated from chat queues", async () => {
    const runResult = {
      runId: "run-1",
      status: "completed",
      finalOutput: { ok: true },
      stepOutputs: {},
    };
    const scheduler = makeMockScheduler({
      getTaskById: vi.fn().mockResolvedValue(
        makeTask({
          contextType: "channel",
          deliveryTarget: "C456",
          threadTs: "1234567890.123456",
          sessionMode: "fresh",
          createdBy: "U123",
        }),
      ),
      executeTaskById: vi.fn().mockResolvedValue(runResult),
      enqueueTaskById: vi.fn().mockResolvedValue(undefined),
    });

    const result = await handleManageScheduledTasks(
      { action: "run", task_id: "task-1" },
      {
        scheduler,
        stepContentRepo,
        taskContext: channelThreadContext,
        activeQueueKey: "C456:1234567890.123456",
      },
    );

    expect(scheduler.executeTaskById).toHaveBeenCalledWith("task-1");
    expect(scheduler.enqueueTaskById).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Automation task-1 completed");
  });

  it("returns the latest run when a completed once task is run again", async () => {
    const scheduler = makeMockScheduler({
      getTaskById: vi.fn().mockResolvedValue(makeTask({ scheduleType: "once", status: "completed" })),
      executeTaskById: vi.fn().mockResolvedValue(null),
    });
    const automationRunsRepo = {
      getLatest: vi.fn().mockResolvedValue({
        id: "run-1",
        task_id: "task-1",
        status: "completed",
        step_outputs: "{}",
        trigger_data: null,
        error_message: null,
        started_at: "2026-05-08T00:00:00.000Z",
        completed_at: "2026-05-08T00:00:01.000Z",
      }),
    } as unknown as NonNullable<Parameters<typeof handleManageScheduledTasks>[1]["automationRunsRepo"]>;

    const result = await handleManageScheduledTasks(
      { action: "run", task_id: "task-1" },
      { scheduler, stepContentRepo, automationRunsRepo, taskContext: dmContext },
    );

    expect(automationRunsRepo.getLatest).toHaveBeenCalledWith("task-1");
    expect(result.content[0].text).toContain("already completed");
    expect(result.content[0].text).toContain('"id": "run-1"');
  });
});

describe("handleManageScheduledTasks — run history", () => {
  it("does not return a run belonging to another automation", async () => {
    const scheduler = makeMockScheduler();
    const automationRunsRepo = {
      getById: vi.fn().mockResolvedValue({
        id: "run-other",
        task_id: "task-other",
        status: "completed",
      }),
      getLatest: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof handleManageScheduledTasks>[1]["automationRunsRepo"]>;

    const result = await handleManageScheduledTasks(
      { action: "getRun", task_id: "task-1", run_id: "run-other" },
      { scheduler, stepContentRepo, automationRunsRepo, taskContext: dmContext },
    );

    expect(result.content[0].text).toBe("Error: run run-other not found.");
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
  const GUARDED_ACTIONS = [
    "update",
    "remove",
    "pause",
    "resume",
    "run",
    "getRun",
    "share",
    "updateStepContent",
  ] as const;

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
        userRepo: makeMockUserRepo(),
        taskContext: dmContext,
      });

      expect(result.content[0].text).toBe(
        `Error: You can't ${action === "remove" ? "delete" : action === "getRun" ? "inspect" : action === "updateStepContent" ? "update" : action} "Do a thing" because it was created by Roopak.`,
      );
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

      expect(result.content[0].text).toBe("Error: task not found.");
    });
  }

  it("allows guarded actions when the context can manage any task", async () => {
    const otherUsersTask = makeTask({ createdBy: "U_OTHER" });
    const scheduler = makeMockScheduler({
      getTaskById: vi.fn().mockResolvedValue(otherUsersTask),
    });

    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "task-1", prompt: "Admin update" },
      { scheduler, stepContentRepo, taskContext: { ...dmContext, canManageAnyTask: true } },
    );

    expect(scheduler.updateTask).toHaveBeenCalledWith("task-1", expect.objectContaining({ prompt: "Admin update" }));
    expect(result.content[0].text).toContain("Automation updated:");
  });

  it("returns the canonical URL for an automation the member owns", async () => {
    const scheduler = makeMockScheduler();

    const result = await handleManageScheduledTasks(
      { action: "share", task_id: "task-1" },
      {
        scheduler,
        stepContentRepo,
        taskContext: dmContext,
        config: { BASE_URL: "https://sketch.test/", PORT: 3000 },
      },
    );

    expect(result.content[0].text).toBe("- Open your automation - https://sketch.test/scheduled-tasks/task-1/edit");
    expect(scheduler.getTaskById).toHaveBeenCalledWith("task-1");
    expect(scheduler.updateTask).not.toHaveBeenCalled();
    expect(scheduler.executeTaskById).not.toHaveBeenCalled();
  });

  it("returns the canonical URL for another user's automation to an admin", async () => {
    const scheduler = makeMockScheduler({
      getTaskById: vi.fn().mockResolvedValue(makeTask({ createdBy: "U_OTHER" })),
    });

    const result = await handleManageScheduledTasks(
      { action: "share", task_id: "task-1" },
      {
        scheduler,
        stepContentRepo,
        taskContext: { ...dmContext, canManageAnyTask: true },
        config: { BASE_URL: "https://sketch.test", PORT: 3000 },
      },
    );

    expect(result.content[0].text).toBe("- Open your automation - https://sketch.test/scheduled-tasks/task-1/edit");
  });

  it("falls back when the task owner cannot be resolved", async () => {
    const otherUsersTask = makeTask({ createdBy: "U_OTHER", title: "AWS Daily Cost Chart" });
    const scheduler = makeMockScheduler({
      getTaskById: vi.fn().mockResolvedValue(otherUsersTask),
    });

    const result = await handleManageScheduledTasks(
      { action: "pause", task_id: "task-1" },
      {
        scheduler,
        stepContentRepo,
        userRepo: makeMockUserRepo({ findById: vi.fn().mockResolvedValue(undefined) }),
        taskContext: dmContext,
      },
    );

    expect(result.content[0].text).toBe(
      'Error: You can\'t pause "AWS Daily Cost Chart" because it was created by another user.',
    );
    expect(scheduler.pauseTask).not.toHaveBeenCalled();
  });

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
