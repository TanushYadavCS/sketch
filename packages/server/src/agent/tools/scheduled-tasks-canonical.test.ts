import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomationDefinition, getAutomationDefinition } from "../../automation/persistence";
import { createAutomationRunsRepository } from "../../db/repositories/automation-runs";
import { createAutomationStepContentRepository } from "../../db/repositories/automation-step-content";
import { createScheduledTaskConversationRepository } from "../../db/repositories/scheduled-task-conversations";
import { createScheduledTaskRepository } from "../../db/repositories/scheduled-tasks";
import type { TaskScheduler } from "../../scheduler/service";
import { createTestDb } from "../../test-utils";
import { handleManageScheduledTasks, requiresAutomationBuilder } from "./scheduled-tasks";
import { AutomationArtifactCollector } from "./types";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function definition(overrides: Partial<AutomationBuilderSaveRequest> = {}): AutomationBuilderSaveRequest {
  return {
    title: "Daily account brief",
    description: "Summarize account activity.",
    prompt: "Summarize account activity.",
    executionMode: "hybrid",
    scheduleType: "interval",
    scheduleValue: "120",
    timezone: "UTC",
    status: "active",
    delivery: {
      platform: "slack",
      targetType: "thread",
      targetId: "C123",
      threadTs: "123.456",
      mode: "deliver",
    },
    steps: [
      {
        id: "trigger",
        type: "trigger",
        label: "Every two minutes",
        icon: "clock",
        position: { x: 0, y: 0 },
        triggerConfig: {
          type: "schedule",
          scheduleType: "interval",
          scheduleValue: "120",
          timezone: "UTC",
        },
      },
      {
        id: "agent",
        type: "agent",
        label: "Summarize activity",
        icon: "sketch-ai",
        position: { x: 260, y: 0 },
        agentMode: "sketch",
        agentSkills: ["reports"],
        agentModel: "model-a",
        agentMcpServers: ["slack"],
        timeout: 600,
      },
    ],
    edges: [{ id: "trigger-agent", from: "trigger", to: "agent" }],
    stepContent: {
      agent: {
        taskId: "client-task-id",
        stepId: "agent",
        contentType: "prompt",
        content: "Check activity and summarize changes.",
        apps: ["clickup", "slack"],
      },
    },
    ...overrides,
  };
}

function actionDefinition(overrides: Partial<AutomationBuilderSaveRequest> = {}): AutomationBuilderSaveRequest {
  return {
    ...definition(),
    title: "Broker action",
    prompt: "Run a broker action.",
    steps: [
      definition().steps[0],
      {
        id: "action",
        type: "action",
        label: "Run broker action",
        icon: "zap",
        position: { x: 260, y: 0 },
      },
    ],
    edges: [{ id: "trigger-action", from: "trigger", to: "action" }],
    stepContent: {
      action: {
        taskId: "client-task-id",
        stepId: "action",
        contentType: "script",
        content: "return input;",
        apps: ["clickup"],
      },
    },
    ...overrides,
  };
}

function actionStepInputs() {
  return [
    definition().steps[0],
    {
      id: "action",
      type: "action" as const,
      label: "Run broker action",
      icon: "zap",
      position: { x: 260, y: 0 },
      script: "return input;",
      apps: ["clickup"],
    },
  ];
}

const brokerUnavailableLoaders = [
  { label: "unavailable", loadIntegrationProvider: async () => null },
  {
    label: "not broker-capable",
    loadIntegrationProvider: async () => ({ isBrokerCapable: () => false }) as never,
  },
] as const;

function context(id: string, createdBy = "owner-1") {
  return {
    id,
    platform: "slack" as const,
    contextType: "dm" as const,
    deliveryTarget: "D123",
    threadTs: null,
    createdBy,
    originPlatform: "web" as const,
    originConversationId: "conversation-1",
    originProviderThreadId: null,
    originMessageId: 12,
  };
}

function taskContextFor(
  id: string,
  createdBy = "owner-1",
  currentAutomation?: ReturnType<typeof currentAutomationFor>,
) {
  return {
    ...context(id, createdBy),
    threadTs: undefined,
    ...(currentAutomation ? { currentAutomation } : {}),
  };
}

function normalWebChatContext(conversationId: string, createdBy = "owner-1") {
  return {
    ...taskContextFor("web-chat-task", createdBy),
    conversationKind: "web_chat" as const,
    origin: {
      platform: "web" as const,
      conversationId,
      providerThreadId: null,
      currentMessageId: null,
    },
  };
}

function legacyWebChatContext(conversationId: string, createdBy = "owner-1") {
  return {
    ...taskContextFor("web-chat-task", createdBy),
    origin: {
      platform: "web" as const,
      conversationId,
      providerThreadId: null,
      currentMessageId: null,
    },
  };
}

function currentAutomationFor(taskId: string, revision: number) {
  const current = definition();
  return {
    taskId,
    revision,
    builderConversationId: "builder-1",
    builderState: {
      title: current.title,
      description: current.description,
      prompt: current.prompt,
      scheduleType: current.scheduleType,
      scheduleValue: current.scheduleValue,
      timezone: current.timezone,
      status: current.status,
      delivery: current.delivery,
      steps: current.steps,
      edges: current.edges,
      stepContent: Object.fromEntries(
        Object.entries(current.stepContent).map(([stepId, content]) => [
          stepId,
          {
            contentType: content.contentType,
            content: content.content,
            apps: content.apps,
          },
        ]),
      ),
    },
  };
}

function taskFor(id: string, createdBy = "owner-1") {
  return {
    id,
    platform: "slack",
    contextType: "dm",
    deliveryTarget: "D123",
    threadTs: null,
    prompt: "Summarize account activity.",
    scheduleType: "interval",
    scheduleValue: "120",
    timezone: "UTC",
    sessionMode: "fresh",
    nextRunAt: null,
    lastRunAt: null,
    status: "active",
    createdBy,
    createdAt: "2026-01-01T00:00:00.000Z",
    revision: 0,
    title: "Daily account brief",
    description: "Summarize account activity.",
    originChat: null,
    steps: null,
    edges: null,
    outputTarget: "C123",
    outputPlatform: "slack",
    outputThreadTs: "123.456",
    outputMode: "deliver",
    delivery: {
      platform: "slack",
      targetType: "thread",
      targetId: "C123",
      threadTs: "123.456",
      mode: "deliver",
    },
  };
}

function schedulerFor(taskId: string, createdBy = "owner-1") {
  const task = taskFor(taskId, createdBy);
  return {
    getTaskById: vi.fn().mockResolvedValue(task),
    refreshTaskSchedule: vi.fn().mockImplementation(async (id: string) => ({ ...task, id })),
    executeTaskById: vi.fn().mockResolvedValue({
      runId: `automatic-${taskId}`,
      status: "completed",
      finalOutput: "Verified",
      stepOutputs: {},
    }),
    removeTask: vi.fn(),
    removeTaskRuntime: vi.fn().mockResolvedValue(true),
    addTask: vi.fn(),
    updateTask: vi.fn(),
  } as never;
}

function schedulerWithoutRefresh(taskId: string, createdBy = "owner-1") {
  const task = taskFor(taskId, createdBy);
  return {
    getTaskById: vi.fn().mockResolvedValue(task),
    addTask: vi.fn(),
    updateTask: vi.fn(),
  } as never;
}

describe("automation artifact presentation policy", () => {
  it("requires setup for an unbounded scheduled agent instruction", () => {
    expect(
      requiresAutomationBuilder({
        scheduleType: "interval",
        steps: [
          {
            id: "trigger",
            type: "trigger",
            label: "Every two minutes",
            icon: "clock",
            position: { x: 0, y: 0 },
            triggerConfig: { type: "schedule", scheduleType: "interval", scheduleValue: "120", timezone: "UTC" },
          },
          {
            id: "reminder",
            type: "agent",
            label: "Send reminder",
            icon: "sketch-ai",
            position: { x: 260, y: 0 },
            agentMode: "sketch",
          },
        ],
      }),
    ).toBe(true);
  });

  it("keeps a single literal reminder action in chat", () => {
    expect(
      requiresAutomationBuilder({
        scheduleType: "once",
        steps: [
          {
            id: "trigger",
            type: "trigger",
            label: "At reminder time",
            icon: "clock",
            position: { x: 0, y: 0 },
            triggerConfig: {
              type: "schedule",
              scheduleType: "once",
              scheduleValue: "2026-08-11T09:00:00Z",
              timezone: "UTC",
            },
          },
          {
            id: "reminder",
            type: "action",
            label: "Send reminder",
            icon: "code",
            position: { x: 260, y: 0 },
            script: 'return "Reminder: message Vedant on Slack.";',
          },
        ],
      }),
    ).toBe(false);
  });

  it("requires the builder for a dynamic action even when it has one scheduled step", () => {
    const trigger = {
      id: "trigger",
      type: "trigger" as const,
      label: "At reminder time",
      icon: "clock",
      position: { x: 0, y: 0 },
      triggerConfig: {
        type: "schedule" as const,
        scheduleType: "once" as const,
        scheduleValue: "2026-08-11T09:00:00Z",
        timezone: "UTC",
      },
    };
    const dynamicScripts = ["return `Reminder: ${input.name}`;", 'return "Reminder: " + input.name;'];

    for (const script of dynamicScripts) {
      expect(
        requiresAutomationBuilder({
          scheduleType: "once",
          steps: [
            trigger,
            {
              id: "reminder",
              type: "action",
              label: "Send reminder",
              icon: "code",
              position: { x: 260, y: 0 },
              script,
            },
          ],
        }),
      ).toBe(true);
    }
  });

  it("requires the builder for integration-backed or multi-step automations", () => {
    expect(
      requiresAutomationBuilder({
        scheduleType: "cron",
        steps: [
          {
            id: "trigger",
            type: "trigger",
            label: "Daily",
            icon: "clock",
            position: { x: 0, y: 0 },
            triggerConfig: { type: "schedule", scheduleType: "cron", scheduleValue: "0 9 * * *", timezone: "UTC" },
          },
          {
            id: "first",
            type: "agent",
            label: "Fetch updates",
            icon: "sketch-ai",
            position: { x: 260, y: 0 },
            apps: ["slack"],
          },
          {
            id: "second",
            type: "agent",
            label: "Summarize updates",
            icon: "sketch-ai",
            position: { x: 520, y: 0 },
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("ManageScheduledTasks canonical structured mutations", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("opens an existing automation in its builder without authoring or mutating it", async () => {
    const scheduler = schedulerFor("existing-task");
    const automationArtifactCollector = new AutomationArtifactCollector();
    const collectArtifact = vi.spyOn(automationArtifactCollector, "collect");

    const result = await handleManageScheduledTasks(
      { action: "open", task_id: "existing-task" },
      {
        db,
        scheduler,
        config: { PORT: 5174 },
        automationArtifactCollector,
        taskContext: normalWebChatContext("web-chat-update"),
      },
    );

    expect(result.content[0].text).toContain("ready to edit in the builder");
    expect(collectArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "existing-task",
        kind: "Updated automation",
        builderUrl: "http://localhost:5174/scheduled-tasks/existing-task/edit",
      }),
    );
    expect((scheduler as { refreshTaskSchedule: ReturnType<typeof vi.fn> }).refreshTaskSchedule).not.toHaveBeenCalled();
    expect((scheduler as { updateTask: ReturnType<typeof vi.fn> }).updateTask).not.toHaveBeenCalled();
    await expect(createScheduledTaskRepository(db).listAll()).resolves.toEqual([]);
  });

  it.each(["add", "update", "updateStepContent"] as const)(
    "blocks %s authoring in web chat before any automation mutation",
    async (action) => {
      const scheduler = schedulerFor("existing-task");
      const result = await handleManageScheduledTasks(
        { action, ...(action === "update" || action === "updateStepContent" ? { task_id: "existing-task" } : {}) },
        { db, scheduler, taskContext: normalWebChatContext("web-chat-update") },
      );

      expect(result.content[0].text).toContain("builder");
      expect((scheduler as { getTaskById: ReturnType<typeof vi.fn> }).getTaskById).not.toHaveBeenCalled();
      await expect(createScheduledTaskRepository(db).listAll()).resolves.toEqual([]);
    },
  );

  it("creates the complete definition atomically and refreshes scheduler state after commit", async () => {
    const scheduler = schedulerFor("new-task");
    const result = await handleManageScheduledTasks(
      {
        action: "add",
        title: "Daily account brief",
        prompt: "Summarize account activity.",
        schedule_type: "interval",
        schedule_value: "120",
        timezone: "UTC",
        delivery: { targetType: "thread", targetId: "C123", threadTs: "123.456" },
        steps: [
          definition().steps[0],
          {
            ...definition().steps[1],
            agentPrompt: "Check activity and summarize changes.",
            apps: ["clickup", "slack"],
          },
        ],
        edges: [{ id: "trigger-agent", from: "trigger", to: "agent" }],
      },
      {
        db,
        scheduler,
        taskContext: {
          ...taskContextFor("new-task"),
          origin: {
            platform: "web",
            conversationId: "conversation-1",
            providerThreadId: null,
            currentMessageId: 12,
          },
        },
      },
    );

    expect(result.content[0].text).toContain("Automation created:");
    expect((scheduler as { refreshTaskSchedule: ReturnType<typeof vi.fn> }).refreshTaskSchedule).toHaveBeenCalledOnce();

    const rows = await createScheduledTaskRepository(db).listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      platform: "slack",
      context_type: "dm",
      delivery_target: "D123",
      schedule_type: "interval",
      schedule_value: "120",
      prompt: "Summarize account activity.",
      output_target: "C123",
      output_thread_ts: "123.456",
      created_by: "owner-1",
      origin_platform: "web",
      origin_conversation_id: "conversation-1",
      origin_message_id: 12,
    });
    expect(JSON.parse(rows[0].steps ?? "[]")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "agent", agentModel: "model-a" })]),
    );
    await expect(createAutomationStepContentRepository(db).getByTask(rows[0].id)).resolves.toEqual([
      expect.objectContaining({
        step_id: "agent",
        content: "Check activity and summarize changes.",
        apps: JSON.stringify(["clickup", "slack"]),
      }),
    ]);
  });

  it("creates native webhook definitions with external webhook schedule fields", async () => {
    const scheduler = schedulerFor("native-webhook-task");
    const result = await handleManageScheduledTasks(
      {
        action: "add",
        title: "Deployment webhook",
        prompt: "Format deployment events.",
        steps: [
          {
            ...definition().steps[0],
            label: "Incoming deployment webhook",
            icon: "webhook",
            triggerConfig: { type: "webhook" },
          },
          {
            ...definition().steps[1],
            agentPrompt: "Format the deployment event.",
            apps: [],
          },
        ],
        edges: [{ id: "trigger-agent", from: "trigger", to: "agent" }],
      },
      {
        db,
        scheduler,
        config: { PORT: 3000 },
        encryptionKey: ENCRYPTION_KEY,
        taskContext: taskContextFor("native-webhook-task"),
      },
    );

    expect(result.content[0].text).toContain("Automation created:");
    const row = await createScheduledTaskRepository(db).listAll();
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ schedule_type: "external", schedule_value: "webhook" });
    expect(JSON.parse(row[0].steps ?? "[]")[0]).toMatchObject({
      triggerConfig: { type: "webhook" },
    });
    await expect(
      db
        .selectFrom("webhook_endpoints")
        .select(["status", "task_id"])
        .where("task_id", "=", row[0].id)
        .executeTakeFirst(),
    ).resolves.toMatchObject({ status: "active", task_id: row[0].id });
  });

  it("expands prompt shorthand into a native webhook definition", async () => {
    const result = await handleManageScheduledTasks(
      {
        action: "add",
        title: "Deployment webhook shorthand",
        prompt: "Format deployment events.",
        schedule_type: "external",
        schedule_value: "webhook",
        timezone: "UTC",
      },
      {
        db,
        scheduler: schedulerFor("native-webhook-prompt-task"),
        config: { PORT: 3000 },
        encryptionKey: ENCRYPTION_KEY,
        taskContext: taskContextFor("native-webhook-prompt-task"),
      },
    );

    expect(result.content[0].text).toContain("Automation created:");
    const row = await createScheduledTaskRepository(db).listAll();
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ schedule_type: "external", schedule_value: "webhook" });
    expect(JSON.parse(row[0].steps ?? "[]")[0]).toMatchObject({
      label: "Webhook",
      icon: "webhook",
      triggerConfig: { type: "webhook" },
    });
  });

  it("rejects Canvas-managed webhook definitions before persistence", async () => {
    const result = await handleManageScheduledTasks(
      {
        action: "add",
        title: "Unsupported Canvas webhook",
        steps: [
          {
            ...definition().steps[0],
            label: "Incoming webhook",
            icon: "webhook",
            triggerConfig: { type: "canvas", componentKey: "webhook-trigger" },
          },
          {
            ...definition().steps[1],
            agentPrompt: "Process the event.",
            apps: [],
          },
        ],
        edges: [{ id: "trigger-agent", from: "trigger", to: "agent" }],
      },
      { db, scheduler: schedulerFor("blocked-canvas-webhook"), taskContext: taskContextFor("blocked-canvas-webhook") },
    );

    expect(result.content[0].text).toContain("Canvas-managed webhook triggers are not supported");
    await expect(createScheduledTaskRepository(db).listAll()).resolves.toEqual([]);
  });

  it("reports a thrown scheduler refresh after add instead of reading the saved row", async () => {
    const scheduler = schedulerFor("thrown-refresh-add");
    const refreshTaskSchedule = (scheduler as { refreshTaskSchedule: ReturnType<typeof vi.fn> }).refreshTaskSchedule;
    refreshTaskSchedule.mockRejectedValue(new Error("refresh failed"));

    const result = await handleManageScheduledTasks(
      {
        action: "add",
        title: "Daily account brief",
        prompt: "Summarize account activity.",
        schedule_type: "interval",
        schedule_value: "120",
        steps: [
          definition().steps[0],
          {
            ...definition().steps[1],
            agentPrompt: "Check activity and summarize changes.",
            apps: ["clickup", "slack"],
          },
        ],
        edges: definition().edges,
      },
      { db, scheduler, taskContext: taskContextFor("thrown-refresh-add") },
    );

    expect(result.content[0].text).toContain("saved, but its scheduler state could not be refreshed");
    expect((scheduler as { getTaskById: ReturnType<typeof vi.fn> }).getTaskById).not.toHaveBeenCalled();
    await expect(createScheduledTaskRepository(db).listAll()).resolves.toEqual([
      expect.objectContaining({ revision: 0 }),
    ]);
  });

  it("reports a thrown scheduler refresh after update instead of reading the saved row", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("thrown-refresh-update"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("thrown-refresh-update");
    const refreshTaskSchedule = (scheduler as { refreshTaskSchedule: ReturnType<typeof vi.fn> }).refreshTaskSchedule;
    refreshTaskSchedule.mockRejectedValue(new Error("refresh failed"));

    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "thrown-refresh-update", title: "Renamed brief", expected_revision: 0 },
      { db, scheduler, taskContext: taskContextFor("thrown-refresh-update") },
    );

    expect(result.content[0].text).toContain("saved, but its scheduler state could not be refreshed");
    expect((scheduler as { getTaskById: ReturnType<typeof vi.fn> }).getTaskById).toHaveBeenCalledOnce();
    await expect(createScheduledTaskRepository(db).getById("thrown-refresh-update")).resolves.toMatchObject({
      title: "Renamed brief",
      revision: 1,
    });
  });

  it("reports a thrown scheduler refresh after step-content update instead of reading the saved row", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("thrown-refresh-content"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("thrown-refresh-content");
    const refreshTaskSchedule = (scheduler as { refreshTaskSchedule: ReturnType<typeof vi.fn> }).refreshTaskSchedule;
    refreshTaskSchedule.mockRejectedValue(new Error("refresh failed"));

    const result = await handleManageScheduledTasks(
      {
        action: "updateStepContent",
        task_id: "thrown-refresh-content",
        step_id: "agent",
        step_content: "Use the activity report and call out blockers.",
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("thrown-refresh-content") },
    );

    expect(result.content[0].text).toContain("saved, but its scheduler state could not be refreshed");
    expect((scheduler as { getTaskById: ReturnType<typeof vi.fn> }).getTaskById).toHaveBeenCalledOnce();
    await expect(createAutomationStepContentRepository(db).getByTask("thrown-refresh-content")).resolves.toEqual([
      expect.objectContaining({ content: "Use the activity report and call out blockers." }),
    ]);
  });

  it("falls back to a row read when the scheduler refresh method is unavailable", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("missing-refresh-method"),
      brokerCapable: true,
    });
    const scheduler = schedulerWithoutRefresh("missing-refresh-method");

    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "missing-refresh-method", title: "Renamed brief", expected_revision: 0 },
      { db, scheduler, taskContext: taskContextFor("missing-refresh-method") },
    );

    expect(result.content[0].text).toContain("Automation updated:");
    expect((scheduler as { getTaskById: ReturnType<typeof vi.fn> }).getTaskById).toHaveBeenCalledTimes(2);
  });

  it("reports a synchronous scheduler refresh throw instead of reading the saved row", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("sync-refresh-throw"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("sync-refresh-throw");
    const refreshTaskSchedule = (scheduler as { refreshTaskSchedule: ReturnType<typeof vi.fn> }).refreshTaskSchedule;
    refreshTaskSchedule.mockImplementation(() => {
      throw new Error("synchronous refresh failed");
    });

    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "sync-refresh-throw", title: "Renamed brief", expected_revision: 0 },
      { db, scheduler, taskContext: taskContextFor("sync-refresh-throw") },
    );

    expect(result.content[0].text).toContain("saved, but its scheduler state could not be refreshed");
    expect((scheduler as { getTaskById: ReturnType<typeof vi.fn> }).getTaskById).toHaveBeenCalledOnce();
  });

  it("does not fall back to a row read when a present scheduler refresh returns null", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("null-refresh-result"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("null-refresh-result");
    const refreshTaskSchedule = (scheduler as { refreshTaskSchedule: ReturnType<typeof vi.fn> }).refreshTaskSchedule;
    refreshTaskSchedule.mockResolvedValue(null);

    const result = await handleManageScheduledTasks(
      {
        action: "updateStepContent",
        task_id: "null-refresh-result",
        step_id: "agent",
        step_content: "Use the activity report and call out blockers.",
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("null-refresh-result") },
    );

    expect(result.content[0].text).toContain("saved, but its scheduler state could not be refreshed");
    expect((scheduler as { getTaskById: ReturnType<typeof vi.fn> }).getTaskById).toHaveBeenCalledOnce();
  });

  it("rejects unsupported fan-out graphs through canonical validation before persistence", async () => {
    const scheduler = schedulerFor("fanout-task");
    const result = await handleManageScheduledTasks(
      {
        action: "add",
        title: "Fan out",
        schedule_type: "cron",
        schedule_value: "0 9 * * 1",
        steps: [
          definition().steps[0],
          { ...definition().steps[1], id: "agent1", agentPrompt: "First prompt." },
          { ...definition().steps[1], id: "agent2", agentPrompt: "Second prompt." },
        ],
        edges: [
          { id: "trigger-agent1", from: "trigger", to: "agent1" },
          { id: "trigger-agent2", from: "trigger", to: "agent2" },
        ],
      },
      { db, scheduler, taskContext: taskContextFor("fanout-task") },
    );

    expect(result.content[0].text).toContain("FAN_OUT_UNSUPPORTED");
    expect((scheduler as { refreshTaskSchedule: ReturnType<typeof vi.fn> }).refreshTaskSchedule).not.toHaveBeenCalled();
    await expect(createScheduledTaskRepository(db).listAll()).resolves.toEqual([]);
  });

  it("retains creator timezone fallback through canonical creation", async () => {
    const scheduler = schedulerFor("timezone-task");
    await handleManageScheduledTasks(
      {
        action: "add",
        prompt: "Use the creator timezone",
        schedule_type: "cron",
        schedule_value: "0 9 * * 1",
      },
      {
        db,
        scheduler,
        taskContext: { ...taskContextFor("timezone-task"), creatorTimezone: "Asia/Kolkata" },
      },
    );

    await expect(createScheduledTaskRepository(db).listAll()).resolves.toEqual([
      expect.objectContaining({ timezone: "Asia/Kolkata", schedule_type: "cron" }),
    ]);
  });

  it("persists a valid future once schedule through the canonical create path", async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    const scheduler = schedulerFor("once-task");
    const result = await handleManageScheduledTasks(
      { action: "add", prompt: "Run it once", schedule_type: "once", schedule_value: futureDate },
      { db, scheduler, taskContext: taskContextFor("once-task") },
    );

    expect(result.content[0].text).toContain("Automation created:");
    const rows = await createScheduledTaskRepository(db).listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      schedule_type: "once",
      schedule_value: futureDate,
      session_mode: "fresh",
    });
  });

  it.each(brokerUnavailableLoaders)(
    "rejects broker-requiring direct creates when the provider is $label",
    async ({ loadIntegrationProvider }) => {
      const scheduler = schedulerFor("broker-create-task");
      const result = await handleManageScheduledTasks(
        {
          action: "add",
          title: "Broker action",
          schedule_type: "interval",
          schedule_value: "120",
          steps: actionStepInputs(),
          edges: [{ id: "trigger-action", from: "trigger", to: "action" }],
        },
        {
          db,
          scheduler,
          loadIntegrationProvider,
          taskContext: taskContextFor("broker-create-task"),
        },
      );

      expect(result.content[0].text).toContain("broker-capable integration provider");
      await expect(createScheduledTaskRepository(db).listAll()).resolves.toEqual([]);
    },
  );

  it.each(brokerUnavailableLoaders)(
    "rejects broker-requiring direct updates when the provider is $label",
    async ({ loadIntegrationProvider }) => {
      await createAutomationDefinition({
        db,
        request: actionDefinition(),
        context: context("broker-update-task"),
        brokerCapable: true,
      });
      const scheduler = schedulerFor("broker-update-task");

      const update = await handleManageScheduledTasks(
        { action: "update", task_id: "broker-update-task", prompt: "Update the action" },
        { db, scheduler, loadIntegrationProvider, taskContext: taskContextFor("broker-update-task") },
      );
      expect(update.content[0].text).toContain("BROKER_REQUIRED");

      const stepContentUpdate = await handleManageScheduledTasks(
        {
          action: "updateStepContent",
          task_id: "broker-update-task",
          step_id: "action",
          step_content: "return updatedInput;",
        },
        { db, scheduler, loadIntegrationProvider, taskContext: taskContextFor("broker-update-task") },
      );
      expect(stepContentUpdate.content[0].text).toContain("BROKER_REQUIRED");

      await expect(createScheduledTaskRepository(db).getById("broker-update-task")).resolves.toMatchObject({
        revision: 0,
      });
    },
  );

  it("preserves unspecified fields during a partial update and records the acting editor", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("partial-task"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("partial-task");

    const result = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "partial-task",
        prompt: "A more focused summary.",
        title: "Focused brief",
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("partial-task") },
    );

    expect(result.content[0].text).toContain("Automation updated:");
    const updated = await getAutomationDefinition({ db, taskId: "partial-task" });
    expect(updated).toMatchObject({
      prompt: "A more focused summary.",
      title: "Focused brief",
      description: "Summarize account activity.",
      scheduleType: "interval",
      scheduleValue: "120",
      timezone: "UTC",
      status: "active",
      delivery: definition().delivery,
      edges: definition().edges,
      revision: 1,
    });
    const storedRow = await createScheduledTaskRepository(db).getById("partial-task");
    expect(JSON.parse(storedRow?.steps ?? "[]")).toEqual(definition().steps);
    expect(updated?.stepContent.agent).toMatchObject({
      content: "Check activity and summarize changes.",
      apps: ["clickup", "slack"],
    });
    await expect(createScheduledTaskRepository(db).getById("partial-task")).resolves.toMatchObject({
      created_by: "owner-1",
      last_edited_by: "owner-1",
      revision: 1,
    });
  });

  it("automatically verifies the full automation after a structured update", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("automatic-structured-update"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("automatic-structured-update");

    const result = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "automatic-structured-update",
        prompt: "A verified account brief.",
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("automatic-structured-update") },
    );

    expect((scheduler as { executeTaskById: ReturnType<typeof vi.fn> }).executeTaskById).toHaveBeenCalledWith(
      "automatic-structured-update",
      { preserveTaskState: true, runMode: "test" },
    );
    expect(result.content[0].text).toContain("Automatic test run completed for automation automatic-structured-update");
    expect(result.content[0].text).toContain('"runId": "automatic-automatic-structured-update"');
  });

  it("reconciles inherited schedule metadata on a title-only edit while preserving a custom trigger label", async () => {
    const initial = definition({
      steps: [{ ...definition().steps[0], label: "Custom trigger label" }, definition().steps[1]],
    });
    await createAutomationDefinition({
      db,
      request: initial,
      context: context("drifted-schedule-task"),
      brokerCapable: true,
    });

    await createScheduledTaskRepository(db).update("drifted-schedule-task", {
      steps: JSON.stringify([
        {
          ...initial.steps[0],
          triggerConfig: {
            type: "schedule",
            scheduleType: "cron",
            scheduleValue: "0 9 * * 1",
            timezone: "Asia/Kolkata",
          },
        },
        initial.steps[1],
      ]),
    });

    const result = await handleManageScheduledTasks(
      { action: "update", task_id: "drifted-schedule-task", title: "Renamed brief", expected_revision: 0 },
      { db, scheduler: schedulerFor("drifted-schedule-task"), taskContext: taskContextFor("drifted-schedule-task") },
    );

    expect(result.content[0].text).toContain("Automation updated:");
    const row = await createScheduledTaskRepository(db).getById("drifted-schedule-task");
    const steps = JSON.parse(row?.steps ?? "[]");
    expect(row).toMatchObject({ title: "Renamed brief", revision: 1 });
    expect(steps[0]).toMatchObject({
      label: "Custom trigger label",
      triggerConfig: {
        type: "schedule",
        scheduleType: "interval",
        scheduleValue: "120",
        timezone: "UTC",
      },
    });
  });

  it("rejects a schedule change that conflicts with an explicitly supplied trigger config", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("explicit-trigger-conflict"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("explicit-trigger-conflict");

    const result = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "explicit-trigger-conflict",
        schedule_value: "300",
        steps: [
          {
            ...definition().steps[0],
            triggerConfig: {
              type: "schedule",
              scheduleType: "interval",
              scheduleValue: "120",
              timezone: "UTC",
            },
          },
          definition().steps[1],
        ],
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("explicit-trigger-conflict") },
    );

    expect(result.content[0].text).toContain("SCHEDULE_TRIGGER_MISMATCH");
    await expect(createScheduledTaskRepository(db).getById("explicit-trigger-conflict")).resolves.toMatchObject({
      schedule_value: "120",
      revision: 0,
    });
  });

  it("rejects a partial explicitly supplied schedule config instead of repairing it", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("partial-explicit-trigger"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("partial-explicit-trigger");

    const result = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "partial-explicit-trigger",
        schedule_value: "300",
        steps: [
          {
            ...definition().steps[0],
            triggerConfig: { type: "schedule", scheduleType: "interval" },
          },
          definition().steps[1],
        ],
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("partial-explicit-trigger") },
    );

    expect(result.content[0].text).toContain("SCHEDULE_TRIGGER_MISMATCH");
    await expect(createScheduledTaskRepository(db).getById("partial-explicit-trigger")).resolves.toMatchObject({
      schedule_value: "120",
      revision: 0,
    });
  });

  it("updates step content through the full-definition CAS path", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("content-task"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("content-task");

    const result = await handleManageScheduledTasks(
      {
        action: "updateStepContent",
        task_id: "content-task",
        step_id: "agent",
        step_content: "Use the activity report and call out blockers.",
        step_apps: ["linear"],
        expectedRevision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("content-task") },
    );

    expect(result.content[0].text).toContain("content updated at revision 1");
    expect((scheduler as { refreshTaskSchedule: ReturnType<typeof vi.fn> }).refreshTaskSchedule).toHaveBeenCalledWith(
      "content-task",
    );
    const updated = await getAutomationDefinition({ db, taskId: "content-task" });
    expect(updated?.revision).toBe(1);
    expect(updated?.stepContent.agent).toMatchObject({
      content: "Use the activity report and call out blockers.",
      apps: ["linear"],
    });
    expect(updated?.scheduleValue).toBe("120");
    expect(updated?.edges).toEqual(definition().edges);
  });

  it("retains delivery update semantics and synchronizes schedule trigger metadata", async () => {
    const initial = definition({
      scheduleType: "cron",
      scheduleValue: "*/5 * * * *",
      delivery: { platform: "slack", targetType: "channel", targetId: "C123", threadTs: null, mode: "deliver" },
      steps: [
        {
          ...definition().steps[0],
          label: "Every five minutes",
          triggerConfig: {
            type: "schedule",
            scheduleType: "cron",
            scheduleValue: "*/5 * * * *",
            timezone: "UTC",
          },
        },
        definition().steps[1],
      ],
    });
    await createAutomationDefinition({ db, request: initial, context: context("metadata-task"), brokerCapable: true });
    const scheduler = schedulerFor("metadata-task");

    const result = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "metadata-task",
        schedule_type: "cron",
        schedule_value: "*/10 * * * *",
        delivery: { platform: "slack", targetType: "channel", targetId: "C456" },
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("metadata-task") },
    );

    expect(result.content[0].text).toContain("Automation updated:");
    const updated = await getAutomationDefinition({ db, taskId: "metadata-task" });
    expect(updated).toMatchObject({ scheduleType: "cron", scheduleValue: "*/10 * * * *" });
    expect(updated?.delivery).toMatchObject({ targetType: "channel", targetId: "C456", threadTs: null });
    expect(updated?.steps[0]).toMatchObject({
      label: "Every 10 minutes",
      triggerConfig: { type: "schedule", scheduleType: "cron", scheduleValue: "*/10 * * * *", timezone: "UTC" },
    });
  });

  it("preserves graph edges and step content when only step metadata changes", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("step-metadata-task"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("step-metadata-task");
    const currentSteps = definition().steps;

    const result = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "step-metadata-task",
        steps: [currentSteps[0], { ...currentSteps[1], label: "Check priority activity", position: { x: 320, y: 20 } }],
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("step-metadata-task") },
    );

    expect(result.content[0].text).toContain("Automation updated:");
    const updated = await getAutomationDefinition({ db, taskId: "step-metadata-task" });
    expect(updated?.edges).toEqual(definition().edges);
    expect(updated?.steps[1]).toMatchObject({
      label: "Check priority activity",
      position: { x: 320, y: 20 },
      agentModel: "model-a",
      agentSkills: ["reports"],
    });
    expect(updated?.stepContent.agent).toMatchObject({
      content: "Check activity and summarize changes.",
      apps: ["clickup", "slack"],
    });
  });

  it("normalizes Canvas-managed trigger updates through the canonical definition", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("canvas-task"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("canvas-task");

    const result = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "canvas-task",
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
            ...definition().steps[1],
            agentPrompt: "Handle the issue.",
          },
        ],
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("canvas-task") },
    );

    expect(result.content[0].text).toContain("Automation updated:");
    const updated = await getAutomationDefinition({ db, taskId: "canvas-task" });
    expect(updated).toMatchObject({ scheduleType: "external", scheduleValue: "canvas" });
    expect(updated?.steps[0].triggerConfig).toMatchObject({ type: "canvas", status: "pending_canvas_setup" });
  });

  it("rejects an incompatible trigger update without changing the persisted definition", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("trigger-validation-task"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("trigger-validation-task");

    const result = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "trigger-validation-task",
        steps: [
          {
            id: "trigger",
            type: "trigger",
            label: "Cron",
            icon: "clock",
            position: { x: 0, y: 0 },
            triggerConfig: { type: "schedule", scheduleType: "cron", scheduleValue: "0 9 * * *", timezone: "UTC" },
          },
          definition().steps[1],
        ],
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("trigger-validation-task") },
    );

    expect(result.content[0].text).toContain("SCHEDULE_TRIGGER_MISMATCH");
    await expect(createScheduledTaskRepository(db).getById("trigger-validation-task")).resolves.toMatchObject({
      revision: 0,
      schedule_value: "120",
    });
  });

  it("provides deterministic full-definition inspection without changing list semantics", async () => {
    await createAutomationDefinition({ db, request: definition(), context: context("get-task"), brokerCapable: true });
    const scheduler = schedulerFor("get-task");

    const result = await handleManageScheduledTasks(
      { action: "get", task_id: "get-task" },
      { db, scheduler, taskContext: taskContextFor("get-task") },
    );

    const inspected = JSON.parse(result.content[0].text);
    expect(inspected).toMatchObject({ id: "get-task", prompt: definition().prompt, revision: 0 });
    expect(inspected.stepContent.agent).toMatchObject({ content: definition().stepContent.agent.content });
    expect((scheduler as { getTaskById: ReturnType<typeof vi.fn> }).getTaskById).toHaveBeenCalledWith("get-task");
  });

  it("allows exactly one save for concurrent editors at the same revision", async () => {
    await createAutomationDefinition({ db, request: definition(), context: context("race-task"), brokerCapable: true });
    const scheduler = schedulerFor("race-task");

    const results = await Promise.all([
      handleManageScheduledTasks(
        { action: "update", task_id: "race-task", prompt: "First editor", expected_revision: 0 },
        { db, scheduler, taskContext: taskContextFor("race-task") },
      ),
      handleManageScheduledTasks(
        { action: "update", task_id: "race-task", prompt: "Second editor", expected_revision: 0 },
        { db, scheduler, taskContext: taskContextFor("race-task") },
      ),
    ]);

    const messages = results.map((result) => result.content[0].text);
    expect(messages.filter((message) => message.includes("Automation updated:"))).toHaveLength(1);
    expect(messages.filter((message) => message.includes("revision conflict"))).toHaveLength(1);
    await expect(createScheduledTaskRepository(db).getById("race-task")).resolves.toMatchObject({ revision: 1 });
    await expect(createAutomationStepContentRepository(db).getByTask("race-task")).resolves.toEqual([
      expect.objectContaining({ content: definition().stepContent.agent.content }),
    ]);
  });

  it("leaves both tables unchanged when the merged definition fails validation", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("invalid-task"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("invalid-task");

    const result = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "invalid-task",
        schedule_type: "interval",
        schedule_value: "30",
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("invalid-task") },
    );

    expect(result.content[0].text).toContain("automation definition is invalid");
    await expect(createScheduledTaskRepository(db).getById("invalid-task")).resolves.toMatchObject({
      schedule_value: "120",
      revision: 0,
    });
    await expect(createAutomationStepContentRepository(db).getByTask("invalid-task")).resolves.toEqual([
      expect.objectContaining({ content: definition().stepContent.agent.content }),
    ]);
  });

  it("keeps ownership on the owner while denying an admin editor without a grant and a member", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("ownership-task"),
      brokerCapable: true,
    });
    const adminResult = await handleManageScheduledTasks(
      { action: "update", task_id: "ownership-task", prompt: "Admin edit", expected_revision: 0 },
      {
        db,
        scheduler: schedulerFor("ownership-task", "owner-1"),
        taskContext: { ...taskContextFor("ownership-task", "admin-1"), canManageAnyTask: true },
      },
    );
    expect(adminResult.content[0].text).toContain("Error: you do not have permission to update task ownership-task.");
    await expect(createScheduledTaskRepository(db).getById("ownership-task")).resolves.toMatchObject({
      created_by: "owner-1",
      revision: 0,
    });

    const memberResult = await handleManageScheduledTasks(
      { action: "update", task_id: "ownership-task", prompt: "Member edit", expected_revision: 0 },
      {
        db,
        scheduler: schedulerFor("ownership-task", "owner-1"),
        taskContext: taskContextFor("ownership-task", "member-1"),
      },
    );
    expect(memberResult.content[0].text).toContain("created by");
    await expect(createScheduledTaskRepository(db).getById("ownership-task")).resolves.toMatchObject({
      created_by: "owner-1",
      revision: 0,
      last_edited_by: "owner-1",
    });
  });

  it("uses the ambient builder revision for an implicit update", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("ambient-task"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("ambient-task");
    const taskContext = taskContextFor("ambient-task", "owner-1", currentAutomationFor("ambient-task", 0));

    const first = await handleManageScheduledTasks(
      { action: "update", prompt: "Ambient edit" },
      { db, scheduler, taskContext },
    );
    expect(first.content[0].text).toContain("Automation updated:");

    const stale = await handleManageScheduledTasks(
      { action: "update", prompt: "Stale ambient edit" },
      { db, scheduler, taskContext },
    );
    expect(stale.content[0].text).toContain("revision conflict");
  });

  it("records normal web-chat create provenance and keeps the artifact URL free of the source conversation", async () => {
    const automationArtifactCollector = new AutomationArtifactCollector();
    const collectArtifact = vi.spyOn(automationArtifactCollector, "collect");
    const result = await handleManageScheduledTasks(
      {
        action: "add",
        prompt: "Send a daily account brief",
        schedule_type: "interval",
        schedule_value: "120",
      },
      {
        db,
        scheduler: schedulerFor("created-task"),
        taskContext: legacyWebChatContext("normal-chat-1"),
        config: { BASE_URL: "https://sketch.example", PORT: 3000 },
        automationArtifactCollector,
      },
    );

    expect(result.content[0].text).toContain("Automation created:");
    const task = (await createScheduledTaskRepository(db).listAll())[0];
    expect(task).toBeDefined();
    await expect(
      createScheduledTaskConversationRepository(db).listByTaskAndTranscriptUser(task.id, "owner-1", {
        kind: "web_chat",
      }),
    ).resolves.toEqual([expect.objectContaining({ conversation_id: "normal-chat-1", kind: "web_chat" })]);
    expect(collectArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        requiresBuilder: true,
        builderUrl: `https://sketch.example/scheduled-tasks/${task.id}/edit`,
      }),
    );
  });

  it("retains many-to-many task/chat provenance across direct updates and step-content updates", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: { ...context("many-task-a"), originConversationId: "creation-chat" },
      brokerCapable: true,
    });
    await createAutomationDefinition({
      db,
      request: definition(),
      context: { ...context("many-task-b"), originConversationId: "creation-chat" },
      brokerCapable: true,
    });

    await handleManageScheduledTasks(
      { action: "update", task_id: "many-task-a", prompt: "First chat edit", expected_revision: 0 },
      { db, scheduler: schedulerFor("many-task-a"), taskContext: legacyWebChatContext("chat-one") },
    );
    await handleManageScheduledTasks(
      { action: "update", task_id: "many-task-b", prompt: "First chat edit", expected_revision: 0 },
      { db, scheduler: schedulerFor("many-task-b"), taskContext: legacyWebChatContext("chat-one") },
    );
    await handleManageScheduledTasks(
      { action: "update", task_id: "many-task-a", prompt: "Second chat edit", expected_revision: 1 },
      { db, scheduler: schedulerFor("many-task-a"), taskContext: legacyWebChatContext("chat-two") },
    );
    await handleManageScheduledTasks(
      { action: "update", task_id: "many-task-a", prompt: "Repeat first chat edit", expected_revision: 2 },
      { db, scheduler: schedulerFor("many-task-a"), taskContext: legacyWebChatContext("chat-one") },
    );
    await handleManageScheduledTasks(
      {
        action: "updateStepContent",
        task_id: "many-task-a",
        step_id: "agent",
        step_content: "Apply the third chat's wording.",
        expected_revision: 3,
      },
      { db, scheduler: schedulerFor("many-task-a"), taskContext: legacyWebChatContext("chat-three") },
    );

    const conversations = createScheduledTaskConversationRepository(db);
    await expect(
      conversations.listByTaskAndTranscriptUser("many-task-a", "owner-1", { kind: "web_chat" }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversation_id: "chat-one" }),
        expect.objectContaining({ conversation_id: "chat-two" }),
        expect.objectContaining({ conversation_id: "chat-three" }),
      ]),
    );
    await expect(
      conversations.listByTaskAndTranscriptUser("many-task-a", "owner-1", { kind: "web_chat" }),
    ).resolves.toHaveLength(3);
    await expect(
      conversations.listByTaskAndTranscriptUser("many-task-b", "owner-1", { kind: "web_chat" }),
    ).resolves.toEqual([expect.objectContaining({ conversation_id: "chat-one" })]);
    await expect(createScheduledTaskRepository(db).getById("many-task-a")).resolves.toMatchObject({
      origin_conversation_id: "creation-chat",
      revision: 4,
    });
  });

  it("does not associate validation, access, or revision failures", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("failure-task"),
      brokerCapable: true,
    });

    const invalid = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "failure-task",
        schedule_type: "interval",
        schedule_value: "30",
        expected_revision: 0,
      },
      { db, scheduler: schedulerFor("failure-task"), taskContext: legacyWebChatContext("invalid-chat") },
    );
    expect(invalid.content[0].text).toContain("automation definition is invalid");

    const denied = await handleManageScheduledTasks(
      { action: "update", task_id: "failure-task", prompt: "Denied", expected_revision: 0 },
      {
        db,
        scheduler: schedulerFor("failure-task"),
        taskContext: legacyWebChatContext("denied-chat", "member-1"),
      },
    );
    expect(denied.content[0].text).toContain("created by");

    const saved = await handleManageScheduledTasks(
      { action: "update", task_id: "failure-task", prompt: "First edit", expected_revision: 0 },
      { db, scheduler: schedulerFor("failure-task"), taskContext: legacyWebChatContext("successful-chat") },
    );
    expect(saved.content[0].text).toContain("Automation updated:");
    const conflict = await handleManageScheduledTasks(
      { action: "update", task_id: "failure-task", prompt: "Stale edit", expected_revision: 0 },
      { db, scheduler: schedulerFor("failure-task"), taskContext: legacyWebChatContext("stale-chat") },
    );
    expect(conflict.content[0].text).toContain("revision conflict");

    await expect(
      createScheduledTaskConversationRepository(db).listByTaskAndTranscriptUser("failure-task", "owner-1", {
        kind: "web_chat",
      }),
    ).resolves.toEqual([expect.objectContaining({ conversation_id: "successful-chat" })]);
  });

  it("rolls back the canonical mutation and emits no artifact when provenance persistence fails", async () => {
    await sql`
      CREATE TRIGGER reject_web_chat_provenance
      BEFORE INSERT ON scheduled_task_conversations
      WHEN NEW.conversation_id = 'failing-chat'
      BEGIN
        SELECT RAISE(FAIL, 'provenance rejected');
      END
    `.execute(db);

    const automationArtifactCollector = new AutomationArtifactCollector();
    const collectArtifact = vi.spyOn(automationArtifactCollector, "collect");
    await expect(
      handleManageScheduledTasks(
        { action: "add", prompt: "This must not partially save", schedule_type: "interval", schedule_value: "120" },
        {
          db,
          scheduler: schedulerFor("failed-provenance-task"),
          taskContext: legacyWebChatContext("failing-chat"),
          automationArtifactCollector,
        },
      ),
    ).rejects.toThrow("provenance rejected");

    await expect(createScheduledTaskRepository(db).listAll()).resolves.toEqual([]);
    expect(collectArtifact).not.toHaveBeenCalled();
  });

  it("uses the ambient revision for an explicit same-task update and rejects a stale race", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("explicit-same-task"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("explicit-same-task");
    const taskContext = taskContextFor("explicit-same-task", "owner-1", currentAutomationFor("explicit-same-task", 0));

    const results = await Promise.all([
      handleManageScheduledTasks(
        { action: "update", task_id: "explicit-same-task", prompt: "First explicit edit" },
        { db, scheduler, taskContext },
      ),
      handleManageScheduledTasks(
        { action: "update", task_id: "explicit-same-task", prompt: "Second explicit edit" },
        { db, scheduler, taskContext },
      ),
    ]);

    const messages = results.map((result) => result.content[0].text);
    expect(messages.filter((message) => message.includes("Automation updated:"))).toHaveLength(1);
    expect(messages.filter((message) => message.includes("revision conflict"))).toHaveLength(1);
    await expect(createScheduledTaskRepository(db).getById("explicit-same-task")).resolves.toMatchObject({
      revision: 1,
    });
  });

  it("uses the ambient revision for an explicit same-task step-content race", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("explicit-same-content-task"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("explicit-same-content-task");
    const taskContext = taskContextFor(
      "explicit-same-content-task",
      "owner-1",
      currentAutomationFor("explicit-same-content-task", 0),
    );

    const results = await Promise.all([
      handleManageScheduledTasks(
        {
          action: "updateStepContent",
          task_id: "explicit-same-content-task",
          step_id: "agent",
          step_content: "First explicit content edit",
        },
        { db, scheduler, taskContext },
      ),
      handleManageScheduledTasks(
        {
          action: "updateStepContent",
          task_id: "explicit-same-content-task",
          step_id: "agent",
          step_content: "Second explicit content edit",
        },
        { db, scheduler, taskContext },
      ),
    ]);

    const messages = results.map((result) => result.content[0].text);
    expect(messages.filter((message) => message.includes("content updated at revision 1"))).toHaveLength(1);
    expect(messages.filter((message) => message.includes("revision conflict"))).toHaveLength(1);
    await expect(createScheduledTaskRepository(db).getById("explicit-same-content-task")).resolves.toMatchObject({
      revision: 1,
    });
  });

  it("honors a supplied revision for an explicit same-task update", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("explicit-supplied-revision"),
      brokerCapable: true,
    });
    const scheduler = schedulerFor("explicit-supplied-revision");
    const taskContext = taskContextFor(
      "explicit-supplied-revision",
      "owner-1",
      currentAutomationFor("explicit-supplied-revision", 0),
    );

    const first = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "explicit-supplied-revision",
        prompt: "First edit",
        expected_revision: 0,
      },
      { db, scheduler, taskContext },
    );
    expect(first.content[0].text).toContain("Automation updated:");

    const second = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "explicit-supplied-revision",
        prompt: "Second edit",
        expected_revision: 1,
      },
      { db, scheduler, taskContext },
    );
    expect(second.content[0].text).toContain("Automation updated:");
    await expect(createScheduledTaskRepository(db).getById("explicit-supplied-revision")).resolves.toMatchObject({
      prompt: "Second edit",
      revision: 2,
    });
  });

  it("does not inherit the ambient revision for an explicit different accessible task", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("ambient-task-for-explicit-target"),
      brokerCapable: true,
    });
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("explicit-different-task"),
      brokerCapable: true,
    });

    const taskForId = (id: string) => taskFor(id);
    const scheduler = {
      getTaskById: vi.fn().mockImplementation(async (id: string) => taskForId(id)),
      refreshTaskSchedule: vi.fn().mockImplementation(async (id: string) => ({ ...taskForId(id), id })),
      addTask: vi.fn(),
      updateTask: vi.fn(),
    } as never;
    const initial = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "explicit-different-task",
        prompt: "Initial explicit edit",
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("explicit-different-task") },
    );
    expect(initial.content[0].text).toContain("Automation updated:");

    const result = await handleManageScheduledTasks(
      {
        action: "update",
        task_id: "explicit-different-task",
        prompt: "Second explicit edit",
      },
      {
        db,
        scheduler,
        taskContext: taskContextFor(
          "ambient-task-for-explicit-target",
          "owner-1",
          currentAutomationFor("ambient-task-for-explicit-target", 99),
        ),
      },
    );

    expect(result.content[0].text).toContain("Automation updated:");
    await expect(createScheduledTaskRepository(db).getById("explicit-different-task")).resolves.toMatchObject({
      prompt: "Second explicit edit",
      revision: 2,
    });
  });

  it("deletes task data through the canonical service and only removes runtime state after commit", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("remove-task"),
      brokerCapable: true,
    });
    const runId = await createAutomationRunsRepository(db).create({ taskId: "remove-task" });
    await createScheduledTaskConversationRepository(db).upsert({
      taskId: "remove-task",
      conversationId: "builder-remove",
      transcriptUserId: "owner-1",
      kind: "builder",
    });
    const scheduler = schedulerFor("remove-task");

    const result = await handleManageScheduledTasks(
      { action: "remove", task_id: "remove-task" },
      { db, scheduler, taskContext: taskContextFor("remove-task") },
    );

    expect(result.content[0].text).toBe("Automation remove-task removed.");
    await expect(createScheduledTaskRepository(db).getById("remove-task")).resolves.toBeUndefined();
    await expect(createAutomationStepContentRepository(db).getByTask("remove-task")).resolves.toEqual([]);
    await expect(createAutomationRunsRepository(db).getById(runId)).resolves.toBeUndefined();
    await expect(
      createScheduledTaskConversationRepository(db).listByTaskConversation("remove-task", "builder-remove"),
    ).resolves.toEqual([]);
    expect((scheduler as { removeTask: ReturnType<typeof vi.fn> }).removeTask).not.toHaveBeenCalled();
    expect((scheduler as { removeTaskRuntime: ReturnType<typeof vi.fn> }).removeTaskRuntime).toHaveBeenCalledWith(
      "remove-task",
    );
  });

  it("reports runtime cleanup failure after structured deletion commits", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("remove-runtime-failure"),
      brokerCapable: true,
    });
    const removeTaskRuntime = vi.fn().mockResolvedValue(false);
    const scheduler = schedulerFor("remove-runtime-failure") as unknown as TaskScheduler;
    (scheduler as unknown as { removeTaskRuntime: ReturnType<typeof vi.fn> }).removeTaskRuntime = removeTaskRuntime;

    const result = await handleManageScheduledTasks(
      { action: "remove", task_id: "remove-runtime-failure" },
      { db, scheduler, taskContext: taskContextFor("remove-runtime-failure") },
    );

    expect(result.content[0].text).toContain("Runtime state is inconsistent");
    await expect(createScheduledTaskRepository(db).getById("remove-runtime-failure")).resolves.toBeUndefined();
    expect(removeTaskRuntime).toHaveBeenCalledWith("remove-runtime-failure");
  });
});
