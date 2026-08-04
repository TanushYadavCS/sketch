import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomationDefinition, getAutomationDefinition } from "../../automation/persistence";
import { createAutomationStepContentRepository } from "../../db/repositories/automation-step-content";
import { createScheduledTaskRepository } from "../../db/repositories/scheduled-tasks";
import { createTestDb } from "../../test-utils";
import { handleManageScheduledTasks } from "./scheduled-tasks";

function definition(overrides: Partial<AutomationBuilderSaveRequest> = {}): AutomationBuilderSaveRequest {
  return {
    title: "Daily account brief",
    description: "Summarize account activity.",
    prompt: "Summarize account activity.",
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
    addTask: vi.fn(),
    updateTask: vi.fn(),
  } as never;
}

describe("ManageScheduledTasks canonical structured mutations", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

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
            label: "Webhook",
            icon: "webhook",
            position: { x: 0, y: 0 },
            triggerConfig: { type: "webhook" },
          },
          definition().steps[1],
        ],
        expected_revision: 0,
      },
      { db, scheduler, taskContext: taskContextFor("trigger-validation-task") },
    );

    expect(result.content[0].text).toContain("TRIGGER_CONFIG_MISMATCH");
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

  it("keeps ownership on the owner while allowing an admin editor and denying a member", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("ownership-task"),
      brokerCapable: true,
    });
    const adminScheduler = schedulerFor("ownership-task", "owner-1");
    const adminResult = await handleManageScheduledTasks(
      { action: "update", task_id: "ownership-task", prompt: "Admin edit", expected_revision: 0 },
      {
        db,
        scheduler: adminScheduler,
        taskContext: { ...taskContextFor("ownership-task", "admin-1"), canManageAnyTask: true },
      },
    );
    expect(adminResult.content[0].text).toContain("Automation updated:");
    await expect(createScheduledTaskRepository(db).getById("ownership-task")).resolves.toMatchObject({
      created_by: "owner-1",
      last_edited_by: "admin-1",
      revision: 1,
    });

    const memberResult = await handleManageScheduledTasks(
      { action: "update", task_id: "ownership-task", prompt: "Member edit", expected_revision: 1 },
      {
        db,
        scheduler: schedulerFor("ownership-task", "owner-1"),
        taskContext: taskContextFor("ownership-task", "member-1"),
      },
    );
    expect(memberResult.content[0].text).toContain("created by");
    await expect(createScheduledTaskRepository(db).getById("ownership-task")).resolves.toMatchObject({
      prompt: "Admin edit",
      revision: 1,
      last_edited_by: "admin-1",
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
});
