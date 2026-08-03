import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createTestDb } from "../test-utils";
import { createAutomationDefinition, replaceAutomationDefinition } from "./persistence";

function makeDefinition(overrides: Partial<AutomationBuilderSaveRequest> = {}): AutomationBuilderSaveRequest {
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
      },
    ],
    edges: [{ id: "trigger-agent", from: "trigger", to: "agent" }],
    stepContent: {
      agent: {
        taskId: "ignored-client-task-id",
        stepId: "ignored-client-step-id",
        contentType: "prompt",
        content: "Check activity and summarize changes.",
        apps: ["clickup"],
      },
    },
    ...overrides,
  };
}

function createContext(id: string) {
  return {
    id,
    platform: "slack" as const,
    contextType: "dm" as const,
    deliveryTarget: "D123",
    threadTs: null,
    createdBy: "user-1",
    originPlatform: "web" as const,
    originConversationId: "conversation-1",
    originProviderThreadId: null,
    originMessageId: 42,
  };
}

describe("automation persistence", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates the task and step content atomically with server-owned identifiers", async () => {
    const result = await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-1"),
      brokerCapable: true,
    });

    expect(result).toMatchObject({
      kind: "saved",
      row: {
        id: "automation-1",
        platform: "slack",
        context_type: "dm",
        delivery_target: "D123",
        created_by: "user-1",
        origin_platform: "web",
        origin_conversation_id: "conversation-1",
        origin_message_id: 42,
        title: "Daily account brief",
        revision: 0,
      },
    });
    await expect(createAutomationStepContentRepository(db).getByTask("automation-1")).resolves.toEqual([
      expect.objectContaining({
        task_id: "automation-1",
        step_id: "agent",
        content: "Check activity and summarize changes.",
        apps: JSON.stringify(["clickup"]),
      }),
    ]);
  });

  it("rolls back task creation when step content cannot be persisted", async () => {
    await sql`
      CREATE TRIGGER reject_automation_content
      BEFORE INSERT ON automation_step_content
      BEGIN
        SELECT RAISE(FAIL, 'content rejected');
      END
    `.execute(db);

    await expect(
      createAutomationDefinition({
        db,
        request: makeDefinition(),
        context: createContext("automation-rollback"),
        brokerCapable: true,
      }),
    ).rejects.toThrow("content rejected");
    await expect(createScheduledTaskRepository(db).getById("automation-rollback")).resolves.toBeUndefined();
  });

  it("validates the complete definition before creating a task row", async () => {
    await expect(
      createAutomationDefinition({
        db,
        request: makeDefinition({ scheduleValue: "1" }),
        context: createContext("automation-invalid"),
        brokerCapable: true,
      }),
    ).rejects.toMatchObject({ name: "AutomationValidationError" });
    await expect(createScheduledTaskRepository(db).getById("automation-invalid")).resolves.toBeUndefined();
  });

  it("replaces an owned definition with revision CAS and removes orphaned content", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition({
        steps: [
          ...makeDefinition().steps,
          {
            id: "old-agent",
            type: "agent",
            label: "Old step",
            icon: "sketch-ai",
            position: { x: 520, y: 0 },
          },
        ],
        edges: [
          { id: "trigger-agent", from: "trigger", to: "agent" },
          { id: "agent-old", from: "agent", to: "old-agent" },
        ],
        stepContent: {
          ...makeDefinition().stepContent,
          "old-agent": {
            taskId: "ignored",
            stepId: "old-agent",
            contentType: "prompt",
            content: "Old content",
            apps: null,
          },
        },
      }),
      context: createContext("automation-edit"),
      brokerCapable: true,
    });

    const result = await replaceAutomationDefinition({
      db,
      taskId: "automation-edit",
      request: makeDefinition({ expectedRevision: 0, title: "Replacement" }),
      actor: { userId: "user-1", canManageAnyTask: false },
      brokerCapable: true,
    });

    expect(result).toMatchObject({ kind: "saved", row: { title: "Replacement", revision: 1 } });
    await expect(createAutomationStepContentRepository(db).getByTask("automation-edit")).resolves.toEqual([
      expect.objectContaining({ step_id: "agent", content: "Check activity and summarize changes." }),
    ]);
  });

  it("hides another owner's task without mutation", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-owned"),
      brokerCapable: true,
    });

    const result = await replaceAutomationDefinition({
      db,
      taskId: "automation-owned",
      request: makeDefinition({ expectedRevision: 0, title: "Unauthorized" }),
      actor: { userId: "user-2", canManageAnyTask: false },
      brokerCapable: true,
    });

    expect(result).toEqual({ kind: "not_found" });
    await expect(createScheduledTaskRepository(db).getById("automation-owned")).resolves.toMatchObject({
      title: "Daily account brief",
      revision: 0,
    });
  });

  it("allows an admin actor to replace another owner's definition", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-admin"),
      brokerCapable: true,
    });

    const result = await replaceAutomationDefinition({
      db,
      taskId: "automation-admin",
      request: makeDefinition({ expectedRevision: 0, title: "Admin replacement" }),
      actor: { userId: "admin-1", canManageAnyTask: true },
      brokerCapable: true,
    });

    expect(result).toMatchObject({
      kind: "saved",
      row: { title: "Admin replacement", revision: 1, last_edited_by: "admin-1" },
    });
  });

  it("fails closed when an admin actor has no tenant user identity", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-no-admin-identity"),
      brokerCapable: true,
    });

    const result = await replaceAutomationDefinition({
      db,
      taskId: "automation-no-admin-identity",
      request: makeDefinition({ expectedRevision: 0, title: "Unauthorized admin replacement" }),
      actor: { userId: null, canManageAnyTask: true },
      brokerCapable: true,
    });

    expect(result).toEqual({ kind: "not_found" });
    await expect(createScheduledTaskRepository(db).getById("automation-no-admin-identity")).resolves.toMatchObject({
      title: "Daily account brief",
      revision: 0,
    });
  });

  it("returns the current revision and preserves data after a stale replacement", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-conflict"),
      brokerCapable: true,
    });
    await db.updateTable("scheduled_tasks").set({ revision: 3 }).where("id", "=", "automation-conflict").execute();

    const result = await replaceAutomationDefinition({
      db,
      taskId: "automation-conflict",
      request: makeDefinition({ expectedRevision: 0, title: "Stale" }),
      actor: { userId: "user-1", canManageAnyTask: false },
      brokerCapable: true,
    });

    expect(result).toEqual({ kind: "revision_conflict", currentRevision: 3 });
    await expect(createScheduledTaskRepository(db).getById("automation-conflict")).resolves.toMatchObject({
      title: "Daily account brief",
      revision: 3,
    });
  });

  it("rolls back definition and orphan changes when replacement content fails", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-edit-rollback"),
      brokerCapable: true,
    });
    await sql`
      CREATE TRIGGER reject_replacement_content
      BEFORE UPDATE ON automation_step_content
      BEGIN
        SELECT RAISE(FAIL, 'replacement rejected');
      END
    `.execute(db);

    await expect(
      replaceAutomationDefinition({
        db,
        taskId: "automation-edit-rollback",
        request: makeDefinition({
          expectedRevision: 0,
          title: "Must roll back",
          stepContent: {
            agent: {
              taskId: "ignored",
              stepId: "agent",
              contentType: "prompt",
              content: "Replacement content",
              apps: null,
            },
          },
        }),
        actor: { userId: "user-1", canManageAnyTask: false },
        brokerCapable: true,
      }),
    ).rejects.toThrow("replacement rejected");
    await expect(createScheduledTaskRepository(db).getById("automation-edit-rollback")).resolves.toMatchObject({
      title: "Daily account brief",
      revision: 0,
    });
    await expect(createAutomationStepContentRepository(db).getByTask("automation-edit-rollback")).resolves.toEqual([
      expect.objectContaining({ content: "Check activity and summarize changes." }),
    ]);
  });
});
