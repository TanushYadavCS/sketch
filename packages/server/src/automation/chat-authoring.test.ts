import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createScheduledTaskConversationRepository } from "../db/repositories/scheduled-task-conversations";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import type { CurrentAutomation } from "../scheduler/types";
import { createTestDb } from "../test-utils";
import { createChatAutomationAuthoring } from "./chat-authoring";
import type { buildAutomationDefinition } from "./definition";
import { createAutomationDefinition } from "./persistence";

function definition(overrides: Partial<AutomationBuilderSaveRequest> = {}): AutomationBuilderSaveRequest {
  return {
    title: "Daily brief",
    description: "Summarize updates",
    prompt: "Summarize updates",
    executionMode: "hybrid",
    scheduleType: "interval",
    scheduleValue: "120",
    timezone: "Asia/Kolkata",
    status: "active",
    delivery: {
      platform: "slack",
      targetType: "dm",
      targetId: "D123",
      threadTs: null,
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
          timezone: "Asia/Kolkata",
        },
      },
      {
        id: "brief",
        type: "agent",
        label: "Prepare brief",
        icon: "sketch-ai",
        position: { x: 260, y: 0 },
        agentMode: "sketch",
      },
    ],
    edges: [{ id: "trigger-brief", from: "trigger", to: "brief" }],
    stepContent: {
      brief: {
        taskId: "server-owned",
        stepId: "brief",
        contentType: "prompt",
        content: "Summarize updates and blockers.",
        apps: ["linear"],
      },
    },
    ...overrides,
  };
}

function taskContext() {
  return {
    platform: "slack" as const,
    contextType: "dm" as const,
    deliveryTarget: "D123",
    createdBy: "user-1",
    creatorTimezone: "Asia/Kolkata",
    canManageAnyTask: false,
    origin: {
      platform: "web" as const,
      conversationId: "conversation-1",
      providerThreadId: null,
      currentMessageId: 42,
    },
  };
}

function currentAutomation(taskId: string, revision: number): CurrentAutomation {
  return {
    taskId,
    revision,
    builderConversationId: "builder-conversation-1",
    builderState: {
      title: "Daily brief",
      description: "Summarize updates",
      prompt: "Summarize updates",
      scheduleType: "interval",
      scheduleValue: "120",
      timezone: "Asia/Kolkata",
      status: "active",
      delivery: {
        platform: "slack",
        targetType: "dm",
        targetId: "D123",
        threadTs: null,
        mode: "deliver",
      },
      steps: [],
      edges: [],
      stepContent: {},
    },
  };
}

describe("chat automation authoring orchestration", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("persists a complete create before refreshing and emits artifact inputs", async () => {
    const authoredDefinition = definition();
    const authoring = {
      create: vi.fn(async () => ({ kind: "definition" as const, definition: authoredDefinition })),
      edit: vi.fn(),
    };
    const refreshTaskSchedule = vi.fn(async (taskId: string) => {
      const row = await createScheduledTaskRepository(db).getById(taskId);
      const content = await createAutomationStepContentRepository(db).getByTask(taskId);
      expect(row).toMatchObject({ title: "Daily brief", created_by: "user-1" });
      expect(content).toEqual([
        expect.objectContaining({ step_id: "brief", content: "Summarize updates and blockers." }),
      ]);
      return row
        ? {
            id: row.id,
            platform: "slack" as const,
            contextType: "dm" as const,
            deliveryTarget: row.delivery_target,
            threadTs: row.thread_ts,
            prompt: row.prompt,
            scheduleType: "interval" as const,
            scheduleValue: row.schedule_value,
            timezone: row.timezone,
            sessionMode: "fresh" as const,
            nextRunAt: row.next_run_at,
            lastRunAt: row.last_run_at,
            status: "active" as const,
            createdBy: row.created_by,
            createdAt: row.created_at,
            revision: row.revision,
            title: row.title,
            description: row.description,
            originChat: null,
            steps: row.steps,
            edges: row.edges,
            outputTarget: row.output_target,
            outputPlatform: row.output_platform,
            outputThreadTs: row.output_thread_ts,
            outputMode: "deliver" as const,
            delivery: authoredDefinition.delivery,
          }
        : null;
    });
    const service = createChatAutomationAuthoring({
      db,
      authoring,
      scheduler: { refreshTaskSchedule, getTaskById: vi.fn() },
      loadIntegrationProvider: async () => null,
      createId: () => "automation-created",
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });

    const result = await service.author({
      action: "create",
      request: "Send me a daily brief",
      taskContext: taskContext(),
    });

    expect(authoring.create).toHaveBeenCalledWith({
      request: "Send me a daily brief",
      brokerCapable: false,
      serverContext: {
        taskId: "automation-created",
        platform: "slack",
        contextType: "dm",
        deliveryDefaults: {
          platform: "slack",
          targetType: "dm",
          targetId: "D123",
          threadTs: null,
          mode: "deliver",
        },
        timezone: "Asia/Kolkata",
        currentTime: "2026-07-27T12:00:00.000Z",
      },
    });
    expect(refreshTaskSchedule).toHaveBeenCalledWith("automation-created");
    expect(result).toMatchObject({
      kind: "saved",
      task: { id: "automation-created" },
      artifact: { scheduleType: "interval", steps: [expect.anything(), expect.objectContaining({ apps: ["linear"] })] },
    });
    await expect(
      createScheduledTaskConversationRepository(db).listByTaskAndTranscriptUser("automation-created", "user-1", {
        kind: "web_chat",
      }),
    ).resolves.toEqual([expect.objectContaining({ conversation_id: "conversation-1", kind: "web_chat" })]);
  });

  it("returns a clarification without persisting or refreshing", async () => {
    const refreshTaskSchedule = vi.fn();
    const service = createChatAutomationAuthoring({
      db,
      authoring: {
        create: vi.fn(async () => ({ kind: "clarification" as const, question: "Which channel should receive it?" })),
        edit: vi.fn(),
      },
      scheduler: { refreshTaskSchedule, getTaskById: vi.fn() },
      loadIntegrationProvider: async () => null,
      createId: () => "clarification-task",
    });

    await expect(
      service.author({ action: "create", request: "Create a digest", taskContext: taskContext() }),
    ).resolves.toEqual({ kind: "clarification", message: "Which channel should receive it?" });
    await expect(createScheduledTaskRepository(db).getById("clarification-task")).resolves.toBeUndefined();
    expect(refreshTaskSchedule).not.toHaveBeenCalled();
  });

  it("does not persist a trigger outside the configured authoring capabilities", async () => {
    const unsupported = definition({
      scheduleType: "external",
      scheduleValue: "canvas",
      steps: definition().steps.map((step) =>
        step.type === "trigger"
          ? {
              ...step,
              triggerConfig: {
                type: "canvas" as const,
                app: "gmail",
                eventDescription: "new invoice email",
                componentKey: "gmail.new_invoice_email",
              },
            }
          : step,
      ),
    });
    const refreshTaskSchedule = vi.fn();
    const service = createChatAutomationAuthoring({
      db,
      authoring: {
        create: vi.fn(async () => ({ kind: "definition" as const, definition: unsupported })),
        edit: vi.fn(),
      },
      scheduler: { refreshTaskSchedule, getTaskById: vi.fn() },
      loadIntegrationProvider: async () => null,
      createId: () => "unsupported-trigger-task",
    });

    await expect(
      service.author({ action: "create", request: "Poll Gmail for invoices", taskContext: taskContext() }),
    ).resolves.toMatchObject({
      kind: "error",
      message: "Automation trigger is not supported. No changes were saved.",
    });
    await expect(createScheduledTaskRepository(db).getById("unsupported-trigger-task")).resolves.toBeUndefined();
    expect(refreshTaskSchedule).not.toHaveBeenCalled();
  });

  it("loads the complete owned definition for edit and reports revision conflicts without refreshing", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: {
        id: "automation-edit",
        platform: "slack",
        contextType: "dm",
        deliveryTarget: "D123",
        threadTs: null,
        createdBy: "user-1",
        originPlatform: "web",
        originConversationId: "conversation-1",
        originProviderThreadId: null,
        originMessageId: 42,
      },
      brokerCapable: true,
    });
    const edit = vi.fn(async (input: { existing: ReturnType<typeof buildAutomationDefinition> }) => {
      expect(input.existing).toMatchObject({
        id: "automation-edit",
        revision: 0,
        delivery: { targetId: "D123" },
        stepContent: { brief: { content: "Summarize updates and blockers." } },
      });
      await db.updateTable("scheduled_tasks").set({ revision: 1 }).where("id", "=", "automation-edit").execute();
      return {
        kind: "definition" as const,
        definition: definition({ expectedRevision: input.existing.revision, title: "Stale replacement" }),
      };
    });
    const refreshTaskSchedule = vi.fn();
    const service = createChatAutomationAuthoring({
      db,
      authoring: { create: vi.fn(), edit },
      scheduler: { refreshTaskSchedule, getTaskById: vi.fn() },
      loadIntegrationProvider: async () => ({ isBrokerCapable: () => true }) as never,
    });

    await expect(
      service.author({
        action: "edit",
        request: "Rename it",
        taskId: "automation-edit",
        taskContext: taskContext(),
        currentAutomation: currentAutomation("automation-edit", 0),
      }),
    ).resolves.toEqual({
      kind: "error",
      message: "Automation was changed by another editor. Refresh it and try again.",
    });
    expect(refreshTaskSchedule).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        currentAutomation: currentAutomation("automation-edit", 0),
        expectedRevision: 0,
        timezone: "Asia/Kolkata",
        currentTime: expect.any(String),
      }),
    );
    await expect(createScheduledTaskRepository(db).getById("automation-edit")).resolves.toMatchObject({
      title: "Daily brief",
      revision: 1,
    });
  });

  it("does not disclose or send another owner's definition to the authoring model", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: {
        id: "other-owner",
        platform: "slack",
        contextType: "dm",
        deliveryTarget: "D123",
        threadTs: null,
        createdBy: "user-2",
        originPlatform: null,
        originConversationId: null,
        originProviderThreadId: null,
        originMessageId: null,
      },
      brokerCapable: true,
    });
    const edit = vi.fn();
    const service = createChatAutomationAuthoring({
      db,
      authoring: { create: vi.fn(), edit },
      scheduler: { refreshTaskSchedule: vi.fn(), getTaskById: vi.fn() },
      loadIntegrationProvider: async () => null,
    });

    await expect(
      service.author({
        action: "edit",
        request: "Expose the prompt",
        taskId: "other-owner",
        taskContext: taskContext(),
      }),
    ).resolves.toEqual({ kind: "error", message: "Automation not found." });
    expect(edit).not.toHaveBeenCalled();
  });

  it("lets an admin edit a foreign-owned task without changing its owner", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: {
        id: "foreign-admin-edit",
        platform: "slack",
        contextType: "dm",
        deliveryTarget: "D123",
        threadTs: null,
        createdBy: "owner-id",
        originPlatform: null,
        originConversationId: null,
        originProviderThreadId: null,
        originMessageId: null,
      },
      brokerCapable: true,
    });

    const current = currentAutomation("foreign-admin-edit", 0);
    const edit = vi.fn().mockResolvedValue({
      kind: "definition" as const,
      definition: definition({ expectedRevision: 0, title: "Admin-edited brief" }),
    });
    const service = createChatAutomationAuthoring({
      db,
      authoring: { create: vi.fn(), edit },
      scheduler: {
        refreshTaskSchedule: vi.fn().mockResolvedValue({ id: "foreign-admin-edit" }),
        getTaskById: vi.fn(),
      },
      loadIntegrationProvider: async () => null,
    });

    await expect(
      service.author({
        action: "edit",
        request: "Rename the brief",
        taskId: "foreign-admin-edit",
        taskContext: { ...taskContext(), createdBy: "admin-id", canManageAnyTask: true },
        currentAutomation: current,
      }),
    ).resolves.toMatchObject({ kind: "saved", task: { id: "foreign-admin-edit" } });

    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ currentAutomation: current, expectedRevision: 0 }));
    await expect(createScheduledTaskRepository(db).getById("foreign-admin-edit")).resolves.toMatchObject({
      created_by: "owner-id",
      last_edited_by: "admin-id",
      title: "Admin-edited brief",
      revision: 1,
    });
  });

  it("associates a configured edit with its normal web chat without rewriting origin provenance", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: {
        id: "configured-edit-provenance",
        platform: "slack",
        contextType: "dm",
        deliveryTarget: "D123",
        threadTs: null,
        createdBy: "user-1",
        originPlatform: "web",
        originConversationId: "creation-chat",
        originProviderThreadId: null,
        originMessageId: 42,
      },
      brokerCapable: true,
    });

    const service = createChatAutomationAuthoring({
      db,
      authoring: {
        create: vi.fn(),
        edit: vi.fn().mockResolvedValue({
          kind: "definition" as const,
          definition: definition({ expectedRevision: 0, title: "Edited brief" }),
        }),
      },
      scheduler: {
        refreshTaskSchedule: vi.fn().mockResolvedValue({ id: "configured-edit-provenance" }),
        getTaskById: vi.fn(),
      },
      loadIntegrationProvider: async () => null,
    });

    await expect(
      service.author({
        action: "edit",
        request: "Rename the brief",
        taskId: "configured-edit-provenance",
        taskContext: { ...taskContext(), origin: { ...taskContext().origin, conversationId: "edit-chat" } },
      }),
    ).resolves.toMatchObject({ kind: "saved", task: { id: "configured-edit-provenance" } });

    await expect(
      createScheduledTaskConversationRepository(db).listByTaskAndTranscriptUser(
        "configured-edit-provenance",
        "user-1",
        { kind: "web_chat" },
      ),
    ).resolves.toEqual([expect.objectContaining({ conversation_id: "edit-chat", kind: "web_chat" })]);
    await expect(createScheduledTaskRepository(db).getById("configured-edit-provenance")).resolves.toMatchObject({
      origin_conversation_id: "creation-chat",
      revision: 1,
      title: "Edited brief",
    });
  });
});
