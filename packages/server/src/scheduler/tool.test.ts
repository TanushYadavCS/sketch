/**
 * Tests for the handleManageScheduledTasks tool handler.
 *
 * Uses a minimal mock TaskScheduler to isolate tool logic from DB/croner dependencies.
 * Covers context scoping (DM vs channel), fresh-only session mode validation,
 * required field validation, and CRUD delegation.
 */
import { describe, expect, it, vi } from "vitest";
import { handleManageScheduledTasks } from "../agent/sketch-tools";
import { createManageScheduledTasksTool } from "../agent/tools/scheduled-tasks";
import {
  AutomationAuthoringGeneratedOutputError,
  AutomationAuthoringValidationError,
} from "../automation/authoring/service";
import type { TaskScheduler } from "./service";
import type { CurrentAutomation, ScheduledTask, TaskContext } from "./types";

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
    revision: 0,
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

function makeCurrentAutomation(
  overrides: Partial<Pick<CurrentAutomation, "taskId" | "revision">> = {},
): CurrentAutomation {
  return {
    taskId: overrides.taskId ?? "task-1",
    revision: overrides.revision ?? 4,
    builderConversationId: "builder-1",
    builderState: {
      title: "Do a thing",
      description: null,
      prompt: "Do a thing",
      scheduleType: "cron",
      scheduleValue: "0 9 * * 1-5",
      timezone: "UTC",
      status: "active",
      delivery: makeTask().delivery,
      steps: [],
      edges: [],
      stepContent: {},
    },
  };
}

function makeMockScheduler(overrides: Partial<TaskScheduler> = {}): TaskScheduler {
  return {
    listTasks: vi.fn().mockResolvedValue([]),
    listTasksForUser: vi.fn().mockResolvedValue([]),
    // Default ownership check returns a task owned by the standard test creator "U123".
    // Tests that exercise the not-yours branch override this with their own mock.
    getTaskById: vi.fn().mockResolvedValue(makeTask()),
    addTask: vi.fn().mockResolvedValue(makeTask()),
    updateTask: vi.fn().mockResolvedValue(makeTask()),
    removeTask: vi.fn().mockResolvedValue(true),
    removeTaskRuntime: vi.fn().mockResolvedValue(true),
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

type StructuredManageScheduledTasksTool = {
  inputSchema: {
    prompt: { description?: string };
    steps: {
      description?: string;
      unwrap: () => {
        element: {
          shape: {
            script: { description?: string };
            agentPrompt: { description?: string };
          };
        };
      };
    };
  };
};

describe("ManageScheduledTasks tool contract", () => {
  it("distinguishes deterministic action steps from legacy agent prompts", () => {
    const definition = createManageScheduledTasksTool({}) as unknown as StructuredManageScheduledTasksTool;
    const stepSchema = definition.inputSchema.steps.unwrap().element;

    expect(definition.inputSchema.prompt.description).toContain("Legacy/simple automation prompt");
    expect(definition.inputSchema.prompt.description).toContain("one Sketch-mode agent step");
    expect(definition.inputSchema.steps.description).toContain("deterministic work");
    expect(definition.inputSchema.steps.description).toContain("action steps with script content");
    expect(stepSchema.shape.script.description).toContain("deterministic action steps");
    expect(stepSchema.shape.agentPrompt.description).toContain("explicit agent steps");
  });
});

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
    expect(scheduler.executeTaskById).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Automation created:");
    expect(automationArtifactCollector.collect).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "authored-task", title: "Daily brief", requiresBuilder: true }),
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

  it("uses the ambient current automation for an implicit natural-language edit", async () => {
    const scheduler = makeMockScheduler();
    const chatAuthoring = {
      author: vi.fn().mockResolvedValue({ kind: "clarification", message: "Which filter?" }),
    };
    const currentAutomation = makeCurrentAutomation();

    await handleManageScheduledTasks(
      { action: "update", request: "Make this stricter" },
      { scheduler, stepContentRepo, taskContext: dmContext, chatAuthoring, currentAutomation },
    );

    expect(scheduler.getTaskById).not.toHaveBeenCalled();
    expect(chatAuthoring.author).toHaveBeenCalledWith({
      action: "edit",
      request: "Make this stricter",
      taskId: "task-1",
      taskContext: dmContext,
      currentAutomation,
    });
  });

  it("lets an explicit accessible task override ambient builder context", async () => {
    const scheduler = makeMockScheduler();
    const chatAuthoring = {
      author: vi.fn().mockResolvedValue({ kind: "clarification", message: "Which filter?" }),
    };
    const currentAutomation = makeCurrentAutomation();

    await handleManageScheduledTasks(
      { action: "update", task_id: "task-2", request: "Make the other one stricter" },
      { scheduler, stepContentRepo, taskContext: dmContext, chatAuthoring, currentAutomation },
    );

    expect(chatAuthoring.author).toHaveBeenCalledWith({
      action: "edit",
      request: "Make the other one stricter",
      taskId: "task-2",
      taskContext: dmContext,
    });
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
      "Error: automation authoring could not produce a valid definition after three attempts. No invalid automation was saved. Please correct your request and try again.",
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

  it.each(["list", "get", "remove", "pause", "resume", "run", "getRun", "share"] as const)(
    "keeps %s deterministic without invoking the authorer",
    async (action) => {
      const scheduler = makeMockScheduler();
      const chatAuthoring = { author: vi.fn() };
      const automationRunsRepo = {
        create: vi.fn().mockResolvedValue("run-1"),
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
});

describe("handleManageScheduledTasks — list", () => {
  it("scopes DM listings through the grant-aware user list", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks({ action: "list" }, { scheduler, stepContentRepo, taskContext: dmContext });
    expect(scheduler.listTasksForUser).toHaveBeenCalledWith("U123");
    expect(scheduler.listTasks).not.toHaveBeenCalled();
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

  it("keeps DM listings grant-aware for an admin without grants", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "list" },
      { scheduler, stepContentRepo, taskContext: { ...dmContext, canManageAnyTask: true } },
    );
    expect(scheduler.listTasksForUser).toHaveBeenCalledWith("U123");
    expect(scheduler.listTasks).not.toHaveBeenCalled();
  });

  it("keeps explicit list behavior when ambient builder context exists", async () => {
    const scheduler = makeMockScheduler();
    await handleManageScheduledTasks(
      { action: "list" },
      {
        scheduler,
        stepContentRepo,
        taskContext: dmContext,
        currentAutomation: makeCurrentAutomation(),
      },
    );
    expect(scheduler.listTasksForUser).toHaveBeenCalledWith("U123");
    expect(scheduler.listTasks).not.toHaveBeenCalled();
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
    const scheduler = makeMockScheduler({ listTasksForUser: vi.fn().mockResolvedValue([task]) });
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
  it("returns an actionable error when prompt is missing", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", schedule_type: "cron", schedule_value: "0 9 * * 1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("prompt or steps are required");
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });

  it("returns an actionable error when a schedule field is missing", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("prompt, schedule_type, and schedule_value are required");
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });

  it("rejects non-fresh session modes before mutation", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Do it", schedule_type: "cron", schedule_value: "0 9 * * 1", session_mode: "chat" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("only 'fresh'");
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
  it("returns an error when task_id is missing", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "update", prompt: "New prompt" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("task_id is required");
    expect(scheduler.updateTask).not.toHaveBeenCalled();
  });

  it("returns a distinct not-found error before canonical mutation", async () => {
    const scheduler = makeMockScheduler({ getTaskById: vi.fn().mockResolvedValue(null) });
    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "nonexistent", prompt: "New prompt" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toBe("Error: task not found.");
    expect(scheduler.updateTask).not.toHaveBeenCalled();
  });

  it("does not automatically execute a natural-language automation edit", async () => {
    const scheduler = makeMockScheduler();
    const chatAuthoring = {
      author: vi.fn().mockResolvedValue({
        kind: "saved",
        task: makeTask({ id: "edited-task", title: "Verified automation" }),
        artifact: {
          steps: [
            { id: "trigger", type: "trigger", label: "Schedule", icon: "clock", position: { x: 0, y: 0 } },
            { id: "action_one", type: "action", label: "First script", icon: "code", position: { x: 0, y: 100 } },
            { id: "action_two", type: "action", label: "Second script", icon: "code", position: { x: 0, y: 200 } },
          ],
          scheduleType: "cron",
          scheduleValue: "0 9 * * 1-5",
          timezone: "UTC",
        },
      }),
    };

    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "edited-task", request: "Finish configuring the automation" },
      { scheduler, taskContext: dmContext, chatAuthoring },
    );

    expect(scheduler.executeTaskById).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Automation updated:");
    expect(result.content[0].text).not.toContain("Automatic test run");
  });
});

describe("handleManageScheduledTasks — updateStepContent", () => {
  it("requires a task and step content", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "updateStepContent", task_id: "task-1", step_id: "step1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("step_id and step_content are required");
    expect(scheduler.touchTaskRevision).not.toHaveBeenCalled();
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

  it("requires canonical persistence before runtime cleanup", async () => {
    const scheduler = makeMockScheduler({ removeTask: vi.fn().mockResolvedValue(true) });
    const result = await handleManageScheduledTasks(
      { action: "remove", task_id: "task-1" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(scheduler.removeTask).not.toHaveBeenCalled();
    expect(scheduler.removeTaskRuntime).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("canonical automation persistence is not available");
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

describe("handleManageScheduledTasks — run", () => {
  it("reserves a manual run and returns the tracking link without inlining the result", async () => {
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
    const automationRunsRepo = {
      create: vi.fn().mockResolvedValue("reserved-run-1"),
    } as unknown as NonNullable<Parameters<typeof handleManageScheduledTasks>[1]["automationRunsRepo"]>;

    const result = await handleManageScheduledTasks(
      { action: "run", task_id: "task-1" },
      {
        scheduler,
        stepContentRepo,
        automationRunsRepo,
        taskContext: dmContext,
        config: { BASE_URL: "https://sketch.test", PORT: 3000 },
      },
    );

    expect(automationRunsRepo.create).toHaveBeenCalledWith({
      taskId: "task-1",
      triggeredByUserId: "U123",
      triggerData: { type: "manual" },
    });
    expect(scheduler.executeTaskById).toHaveBeenCalledWith("task-1", {
      runMode: "manual",
      runId: "reserved-run-1",
      preserveTaskState: true,
      triggeredByUserId: "U123",
    });
    expect(result.content[0].text).toContain(
      'Automation "Do a thing" run started. Track it here: https://sketch.test/scheduled-tasks/task-1/edit?runId=reserved-run-1',
    );
    expect(result.content[0].text).not.toContain("completed");
    expect(result.content[0].text).not.toContain('"ok": true');
  });

  it("returns the uniform run-started ACK for interactive contexts without the old enqueue branch", async () => {
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
    const automationRunsRepo = {
      create: vi.fn().mockResolvedValue("reserved-run-1"),
    } as unknown as NonNullable<Parameters<typeof handleManageScheduledTasks>[1]["automationRunsRepo"]>;

    const result = await handleManageScheduledTasks(
      { action: "run", task_id: "task-1" },
      {
        scheduler,
        stepContentRepo,
        automationRunsRepo,
        taskContext: channelThreadContext,
        activeQueueKey: "C456:1234567890.123456",
      },
    );

    expect(automationRunsRepo.create).toHaveBeenCalledWith({
      taskId: "task-1",
      triggeredByUserId: "U123",
      triggerData: { type: "manual" },
    });
    expect(scheduler.executeTaskById).toHaveBeenCalledWith("task-1", {
      runMode: "manual",
      runId: "reserved-run-1",
      preserveTaskState: true,
      triggeredByUserId: "U123",
    });
    expect(scheduler.enqueueTaskById).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('Automation "Do a thing" run started. Track it here:');
    expect(result.content[0].text).not.toContain("completed");
    expect(result.content[0].text).not.toContain("queued and will post back");
  });

  it("reserves a run id even for a completed once task and returns the tracking link", async () => {
    const scheduler = makeMockScheduler({
      getTaskById: vi.fn().mockResolvedValue(makeTask({ scheduleType: "once", status: "completed" })),
      executeTaskById: vi.fn().mockRejectedValue(new Error("Task task-1 is not active")),
    });
    const automationRunsRepo = {
      create: vi.fn().mockResolvedValue("reserved-run-1"),
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

    expect(automationRunsRepo.create).toHaveBeenCalledWith({
      taskId: "task-1",
      triggeredByUserId: "U123",
      triggerData: { type: "manual" },
    });
    expect(scheduler.executeTaskById).toHaveBeenCalledWith("task-1", {
      runMode: "manual",
      runId: "reserved-run-1",
      preserveTaskState: true,
      triggeredByUserId: "U123",
    });
    expect(result.content[0].text).toContain('Automation "Do a thing" run started. Track it here:');
    expect(result.content[0].text).not.toContain("already completed");
    expect(result.content[0].text).not.toContain('"id": "run-1"');
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
  it("returns validation error for a past datetime", async () => {
    const pastDate = new Date(Date.now() - 3_600_000).toISOString();
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Too late", schedule_type: "once", schedule_value: pastDate },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("past");
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });

  it("returns validation error for an invalid datetime", async () => {
    const scheduler = makeMockScheduler();
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Bad date", schedule_type: "once", schedule_value: "not-a-date" },
      { scheduler, stepContentRepo, taskContext: dmContext },
    );
    expect(result.content[0].text).toContain("ISO 8601");
    expect(scheduler.addTask).not.toHaveBeenCalled();
  });
});

describe("handleManageScheduledTasks — ownership", () => {
  const GUARDED_ACTIONS = [
    "update",
    "get",
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
        `Error: You can't ${action === "remove" ? "delete" : action === "getRun" || action === "get" ? "inspect" : action === "updateStepContent" ? "update" : action} "Do a thing" because it was created by Roopak.`,
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

  it("denies share of another user's automation even to an admin", async () => {
    const scheduler = makeMockScheduler({
      getTaskById: vi.fn().mockResolvedValue(makeTask({ createdBy: "U_OTHER" })),
    });

    const result = await handleManageScheduledTasks(
      { action: "share", task_id: "task-1" },
      {
        scheduler,
        stepContentRepo,
        userRepo: makeMockUserRepo(),
        taskContext: { ...dmContext, canManageAnyTask: true },
        config: { BASE_URL: "https://sketch.test", PORT: 3000 },
      },
    );

    expect(result.content[0].text).toBe('Error: You can\'t share "Do a thing" because it was created by Roopak.');
    expect(scheduler.getTaskById).toHaveBeenCalledWith("task-1");
    expect(scheduler.updateTask).not.toHaveBeenCalled();
    expect(scheduler.executeTaskById).not.toHaveBeenCalled();
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
