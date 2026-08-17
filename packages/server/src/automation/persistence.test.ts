import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomationLocksRepository } from "../db/repositories/automation-locks";
import { createAutomationRunsRepository } from "../db/repositories/automation-runs";
import { createAutomationSharesRepository } from "../db/repositories/automation-shares";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createScheduledTaskConversationRepository } from "../db/repositories/scheduled-task-conversations";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createTestDb } from "../test-utils";
import { acquireOrRenewLock, releaseLock } from "./lock-service";
import {
  createAutomationDefinition,
  createAutomationDraft,
  deleteAutomation,
  getAutomationDefinition,
  replaceAutomationDefinition,
  selectAutomationSetupExecutionMode,
  updateAutomationDefinition,
} from "./persistence";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeDefinition(overrides: Partial<AutomationBuilderSaveRequest> = {}): AutomationBuilderSaveRequest {
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

  async function addUser(id: string): Promise<void> {
    await db.insertInto("users").values({ id, name: id }).execute();
  }

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

  it("persists and reloads the selected execution mode", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition({ executionMode: "agent-led" }),
      context: createContext("automation-mode"),
      brokerCapable: true,
    });

    await expect(createScheduledTaskRepository(db).getById("automation-mode")).resolves.toMatchObject({
      execution_mode: "agent-led",
    });
    await expect(getAutomationDefinition({ db, taskId: "automation-mode" })).resolves.toMatchObject({
      executionMode: "agent-led",
      executionModeRecommendation: { mode: "agent-led" },
    });

    const saved = await updateAutomationDefinition({
      db,
      taskId: "automation-mode",
      patch: { expectedRevision: 0, executionMode: "hybrid" },
      actor: { userId: "user-1" },
      brokerCapable: true,
    });

    expect(saved).toMatchObject({ kind: "saved", row: { execution_mode: "hybrid", revision: 1 } });
  });

  it("includes the native webhook endpoint when a caller supplies its public base URL", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition({
        scheduleType: "external",
        scheduleValue: "webhook",
        steps: [
          {
            ...makeDefinition().steps[0],
            triggerConfig: { type: "webhook" },
          },
          ...makeDefinition().steps.slice(1),
        ],
      }),
      context: createContext("automation-webhook"),
      brokerCapable: true,
      encryptionKey: ENCRYPTION_KEY,
    });

    await expect(
      getAutomationDefinition({
        db,
        taskId: "automation-webhook",
        webhookBaseUrl: "https://sketch.example/",
        encryptionKey: ENCRYPTION_KEY,
      }),
    ).resolves.toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({
          triggerConfig: expect.objectContaining({
            type: "webhook",
            webhookUrl: expect.stringMatching(/^https:\/\/sketch\.example\/api\/webhooks\/v1\//),
            webhookEndpointId: expect.any(String),
            webhookMethod: "POST",
            webhookContentType: "application/json",
            webhookAuthentication: "none",
            webhookStatus: "active",
          }),
        }),
      ]),
    });
  });

  it("normalizes a native webhook trigger replacement during an update", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-webhook-update"),
      brokerCapable: true,
    });

    const nextDefinition = makeDefinition();
    nextDefinition.steps[0] = {
      ...nextDefinition.steps[0],
      label: "Webhook",
      icon: "webhook",
      triggerConfig: { type: "webhook" },
    };
    const saved = await updateAutomationDefinition({
      db,
      taskId: "automation-webhook-update",
      patch: { expectedRevision: 0, steps: nextDefinition.steps },
      actor: { userId: "user-1" },
      brokerCapable: true,
      encryptionKey: ENCRYPTION_KEY,
    });

    expect(saved).toMatchObject({
      kind: "saved",
      row: { revision: 1, schedule_type: "external", schedule_value: "webhook" },
    });
    await expect(
      db
        .selectFrom("webhook_endpoints")
        .select(["status", "task_id"])
        .where("task_id", "=", "automation-webhook-update")
        .executeTakeFirst(),
    ).resolves.toMatchObject({ status: "active", task_id: "automation-webhook-update" });

    const scheduled = await updateAutomationDefinition({
      db,
      taskId: "automation-webhook-update",
      patch: {
        expectedRevision: 1,
        scheduleType: "interval",
        scheduleValue: "120",
        steps: makeDefinition().steps,
      },
      actor: { userId: "user-1" },
      brokerCapable: true,
      encryptionKey: ENCRYPTION_KEY,
    });
    expect(scheduled).toMatchObject({ kind: "saved", row: { revision: 2, schedule_type: "interval" } });
    await expect(
      db
        .selectFrom("webhook_endpoints")
        .select("status")
        .where("task_id", "=", "automation-webhook-update")
        .executeTakeFirst(),
    ).resolves.toMatchObject({ status: "revoked" });

    const reenabled = await updateAutomationDefinition({
      db,
      taskId: "automation-webhook-update",
      patch: { expectedRevision: 2, steps: nextDefinition.steps },
      actor: { userId: "user-1" },
      brokerCapable: true,
      encryptionKey: ENCRYPTION_KEY,
    });
    expect(reenabled).toMatchObject({
      kind: "saved",
      row: { revision: 3, schedule_type: "external", schedule_value: "webhook" },
    });
    await expect(
      db
        .selectFrom("webhook_endpoints")
        .select(["status", "generation"])
        .where("task_id", "=", "automation-webhook-update")
        .executeTakeFirst(),
    ).resolves.toMatchObject({ status: "active", generation: 3 });
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
      actor: { userId: "user-1" },
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
      actor: { userId: "user-2" },
      brokerCapable: true,
    });

    expect(result).toEqual({ kind: "not_found" });
    await expect(createScheduledTaskRepository(db).getById("automation-owned")).resolves.toMatchObject({
      title: "Daily account brief",
      revision: 0,
    });
  });

  it("allows an admin to replace a foreign-owned task and denies an un-granted member", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-admin"),
      brokerCapable: true,
    });

    const memberDenied = await replaceAutomationDefinition({
      db,
      taskId: "automation-admin",
      request: makeDefinition({ expectedRevision: 0, title: "Member replacement" }),
      actor: { userId: "member-1" },
      brokerCapable: true,
    });
    expect(memberDenied).toEqual({ kind: "not_found" });

    const adminAllowed = await replaceAutomationDefinition({
      db,
      taskId: "automation-admin",
      request: makeDefinition({ expectedRevision: 0, title: "Admin replacement" }),
      actor: { userId: "admin-1", role: "admin" },
      brokerCapable: true,
    });
    expect(adminAllowed).toMatchObject({
      kind: "saved",
      row: { title: "Admin replacement", revision: 1, last_edited_by: "admin-1" },
    });

    await addUser("grantee-1");
    await createAutomationSharesRepository(db).grant({
      taskId: "automation-admin",
      userId: "grantee-1",
      grantedByUserId: "user-1",
    });
    const allowed = await replaceAutomationDefinition({
      db,
      taskId: "automation-admin",
      request: makeDefinition({ expectedRevision: 1, title: "Granted replacement" }),
      actor: { userId: "grantee-1" },
      brokerCapable: true,
    });

    expect(allowed).toMatchObject({
      kind: "saved",
      row: { title: "Granted replacement", revision: 2, last_edited_by: "grantee-1" },
    });
  });

  it("re-checks the grant inside the mutation transaction after a revoke", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-grant-recheck"),
      brokerCapable: true,
    });
    await addUser("grantee-1");
    const shares = createAutomationSharesRepository(db);
    await shares.grant({ taskId: "automation-grant-recheck", userId: "grantee-1", grantedByUserId: "user-1" });

    await expect(
      updateAutomationDefinition({
        db,
        taskId: "automation-grant-recheck",
        patch: { expectedRevision: 0, title: "Granted edit" },
        actor: { userId: "grantee-1" },
        brokerCapable: true,
      }),
    ).resolves.toMatchObject({ kind: "saved" });

    await shares.revoke({ taskId: "automation-grant-recheck", userId: "grantee-1" });
    await expect(
      updateAutomationDefinition({
        db,
        taskId: "automation-grant-recheck",
        patch: { expectedRevision: 1, title: "Revoked edit" },
        actor: { userId: "grantee-1" },
        brokerCapable: true,
      }),
    ).resolves.toEqual({ kind: "access_denied" });
    await expect(createScheduledTaskRepository(db).getById("automation-grant-recheck")).resolves.toMatchObject({
      title: "Granted edit",
      revision: 1,
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
      actor: { userId: null },
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
      actor: { userId: "user-1" },
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
        actor: { userId: "user-1" },
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

  it("updates the complete definition atomically with revision CAS", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-direct-update"),
      brokerCapable: true,
    });

    const saved = await updateAutomationDefinition({
      db,
      taskId: "automation-direct-update",
      patch: {
        expectedRevision: 0,
        prompt: "Updated prompt",
        stepContent: {
          agent: {
            contentType: "prompt",
            content: "Updated content",
            apps: ["linear"],
          },
        },
      },
      actor: { userId: "user-1" },
      brokerCapable: true,
    });

    expect(saved).toMatchObject({ kind: "saved", row: { revision: 1, prompt: "Updated prompt" } });
    await expect(createAutomationStepContentRepository(db).getByTask("automation-direct-update")).resolves.toEqual([
      expect.objectContaining({ content: "Updated content", apps: JSON.stringify(["linear"]) }),
    ]);

    const conflict = await updateAutomationDefinition({
      db,
      taskId: "automation-direct-update",
      patch: {
        expectedRevision: 0,
        prompt: "Stale prompt",
        stepContent: {
          agent: { contentType: "prompt", content: "Stale content", apps: null },
        },
      },
      actor: { userId: "user-1" },
      brokerCapable: true,
    });

    expect(conflict).toEqual({ kind: "revision_conflict", currentRevision: 1 });
    await expect(createScheduledTaskRepository(db).getById("automation-direct-update")).resolves.toMatchObject({
      prompt: "Updated prompt",
      revision: 1,
    });
    await expect(createAutomationStepContentRepository(db).getByTask("automation-direct-update")).resolves.toEqual([
      expect.objectContaining({ content: "Updated content" }),
    ]);
  });

  it("rolls back direct metadata and content updates together", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-direct-rollback"),
      brokerCapable: true,
    });
    await sql`
      CREATE TRIGGER reject_direct_update_content
      BEFORE UPDATE ON automation_step_content
      BEGIN
        SELECT RAISE(FAIL, 'direct update rejected');
      END
    `.execute(db);

    try {
      await expect(
        updateAutomationDefinition({
          db,
          taskId: "automation-direct-rollback",
          patch: {
            expectedRevision: 0,
            title: "Must roll back",
            stepContent: {
              agent: { contentType: "prompt", content: "Rejected content", apps: null },
            },
          },
          actor: { userId: "user-1" },
          brokerCapable: true,
        }),
      ).rejects.toThrow("direct update rejected");
      await expect(createScheduledTaskRepository(db).getById("automation-direct-rollback")).resolves.toMatchObject({
        title: "Daily account brief",
        revision: 0,
      });
      await expect(createAutomationStepContentRepository(db).getByTask("automation-direct-rollback")).resolves.toEqual([
        expect.objectContaining({ content: "Check activity and summarize changes." }),
      ]);
    } finally {
      await sql`DROP TRIGGER reject_direct_update_content`.execute(db);
    }
  });

  it("deletes all task-owned rows and invokes runtime cleanup after commit", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-delete"),
      brokerCapable: true,
    });
    const runId = await createAutomationRunsRepository(db).create({
      taskId: "automation-delete",
      triggerData: { source: "test" },
    });
    await createScheduledTaskConversationRepository(db).upsert({
      taskId: "automation-delete",
      conversationId: "builder-delete",
      transcriptUserId: "user-1",
      kind: "builder",
    });

    let taskVisibleAtRuntimeCleanup: boolean | undefined;
    const removeTaskRuntime = vi.fn(async (taskId: string) => {
      taskVisibleAtRuntimeCleanup = Boolean(await createScheduledTaskRepository(db).getById(taskId));
      return true;
    });
    const result = await deleteAutomation({
      db,
      taskId: "automation-delete",
      actor: { userId: "user-1" },
      scheduler: { removeTaskRuntime },
    });

    expect(result).toEqual({ kind: "deleted" });
    expect(taskVisibleAtRuntimeCleanup).toBe(false);
    expect(removeTaskRuntime).toHaveBeenCalledWith("automation-delete");
    await expect(createScheduledTaskRepository(db).getById("automation-delete")).resolves.toBeUndefined();
    await expect(createAutomationStepContentRepository(db).getByTask("automation-delete")).resolves.toEqual([]);
    await expect(createAutomationRunsRepository(db).getById(runId)).resolves.toBeUndefined();
    await expect(
      createScheduledTaskConversationRepository(db).listByTaskConversation("automation-delete", "builder-delete"),
    ).resolves.toEqual([]);
  });

  it("rolls back every dependent deletion when the database rejects a child delete", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-delete-rollback"),
      brokerCapable: true,
    });
    await createAutomationRunsRepository(db).create({ taskId: "automation-delete-rollback" });
    await createScheduledTaskConversationRepository(db).upsert({
      taskId: "automation-delete-rollback",
      conversationId: "builder-delete-rollback",
      transcriptUserId: "user-1",
      kind: "builder",
    });
    await sql`
      CREATE TRIGGER reject_automation_run_delete
      BEFORE DELETE ON automation_runs
      BEGIN
        SELECT RAISE(FAIL, 'run deletion rejected');
      END
    `.execute(db);
    const removeTaskRuntime = vi.fn().mockResolvedValue(true);

    try {
      await expect(
        deleteAutomation({
          db,
          taskId: "automation-delete-rollback",
          actor: { userId: "user-1" },
          scheduler: { removeTaskRuntime },
        }),
      ).rejects.toThrow("run deletion rejected");
      await expect(createScheduledTaskRepository(db).getById("automation-delete-rollback")).resolves.toBeDefined();
      await expect(
        createAutomationStepContentRepository(db).getByTask("automation-delete-rollback"),
      ).resolves.toHaveLength(1);
      await expect(createAutomationRunsRepository(db).list("automation-delete-rollback")).resolves.toHaveLength(1);
      await expect(
        createScheduledTaskConversationRepository(db).listByTaskConversation(
          "automation-delete-rollback",
          "builder-delete-rollback",
        ),
      ).resolves.toHaveLength(1);
      expect(removeTaskRuntime).not.toHaveBeenCalled();
    } finally {
      await sql`DROP TRIGGER reject_automation_run_delete`.execute(db);
    }
  });

  it("surfaces false and thrown runtime cleanup without claiming a clean delete", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-delete-false"),
      brokerCapable: true,
    });
    const falseCleanup = vi.fn().mockResolvedValue(false);
    const falseResult = await deleteAutomation({
      db,
      taskId: "automation-delete-false",
      actor: { userId: "user-1" },
      scheduler: { removeTaskRuntime: falseCleanup },
    });
    expect(falseResult.kind).toBe("scheduler_failure");
    await expect(createScheduledTaskRepository(db).getById("automation-delete-false")).resolves.toBeUndefined();

    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-delete-throw"),
      brokerCapable: true,
    });
    const thrownCleanup = vi.fn().mockRejectedValue(new Error("runtime unavailable"));
    const thrownResult = await deleteAutomation({
      db,
      taskId: "automation-delete-throw",
      actor: { userId: "user-1" },
      scheduler: { removeTaskRuntime: thrownCleanup },
    });
    expect(thrownResult).toMatchObject({ kind: "scheduler_failure", error: new Error("runtime unavailable") });
    await expect(createScheduledTaskRepository(db).getById("automation-delete-throw")).resolves.toBeUndefined();
  });

  it("deletes only for the owner or an admin and returns not-found for repeat deletes", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-delete-access"),
      brokerCapable: true,
    });
    await addUser("grantee-1");
    const shares = createAutomationSharesRepository(db);
    await shares.grant({ taskId: "automation-delete-access", userId: "grantee-1", grantedByUserId: "user-1" });
    const removeTaskRuntime = vi.fn().mockResolvedValue(true);
    await expect(
      deleteAutomation({
        db,
        taskId: "automation-delete-access",
        actor: { userId: "user-2" },
        scheduler: { removeTaskRuntime },
      }),
    ).resolves.toEqual({ kind: "access_denied" });
    await expect(
      deleteAutomation({
        db,
        taskId: "automation-delete-access",
        actor: { userId: "grantee-1" },
        scheduler: { removeTaskRuntime },
      }),
    ).resolves.toEqual({ kind: "access_denied" });
    // An admin without the role field still gets no delete rights; with the
    // role field the delete goes through.
    await expect(
      deleteAutomation({
        db,
        taskId: "automation-delete-access",
        actor: { userId: "admin-1" },
        scheduler: { removeTaskRuntime },
      }),
    ).resolves.toEqual({ kind: "access_denied" });
    await expect(
      deleteAutomation({
        db,
        taskId: "automation-delete-access",
        actor: { userId: "admin-1", role: "admin" },
        scheduler: { removeTaskRuntime },
      }),
    ).resolves.toEqual({ kind: "deleted" });
    expect(removeTaskRuntime).toHaveBeenCalledOnce();
    await expect(
      deleteAutomation({
        db,
        taskId: "automation-delete-access",
        actor: { userId: "user-1" },
        scheduler: { removeTaskRuntime },
      }),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("lets an admin edit a foreign-owned task inside the mutation transaction", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-admin-edit"),
      brokerCapable: true,
    });

    const updated = await updateAutomationDefinition({
      db,
      taskId: "automation-admin-edit",
      patch: { expectedRevision: 0, title: "Admin direct edit" },
      actor: { userId: "admin-1", role: "admin" },
      brokerCapable: true,
    });
    expect(updated).toMatchObject({
      kind: "saved",
      row: { title: "Admin direct edit", revision: 1, last_edited_by: "admin-1" },
    });

    const mode = await selectAutomationSetupExecutionMode({
      db,
      taskId: "automation-admin-edit",
      executionMode: "agent-led",
      actor: { userId: "admin-1", role: "admin" },
    });
    expect(mode.kind).toBe("not_placeholder");
  });

  it("cleans up share rows when an admin deletes a foreign-owned task", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-admin-delete-shares"),
      brokerCapable: true,
    });
    await addUser("grantee-1");
    await addUser("grantee-2");
    const shares = createAutomationSharesRepository(db);
    await shares.grant({ taskId: "automation-admin-delete-shares", userId: "grantee-1", grantedByUserId: "user-1" });
    await shares.grant({ taskId: "automation-admin-delete-shares", userId: "grantee-2", grantedByUserId: "user-1" });

    const result = await deleteAutomation({
      db,
      taskId: "automation-admin-delete-shares",
      actor: { userId: "admin-1", role: "admin" },
      scheduler: { removeTaskRuntime: vi.fn().mockResolvedValue(true) },
    });

    expect(result).toEqual({ kind: "deleted" });
    await expect(
      db
        .selectFrom("automation_task_shares")
        .selectAll()
        .where("task_id", "=", "automation-admin-delete-shares")
        .execute(),
    ).resolves.toEqual([]);
    await expect(createScheduledTaskRepository(db).getById("automation-admin-delete-shares")).resolves.toBeUndefined();
  });

  it("removes share rows for the task inside the delete transaction", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-delete-shares"),
      brokerCapable: true,
    });
    await addUser("grantee-1");
    await addUser("grantee-2");
    const shares = createAutomationSharesRepository(db);
    await shares.grant({ taskId: "automation-delete-shares", userId: "grantee-1", grantedByUserId: "user-1" });
    await shares.grant({ taskId: "automation-delete-shares", userId: "grantee-2", grantedByUserId: "user-1" });

    const result = await deleteAutomation({
      db,
      taskId: "automation-delete-shares",
      actor: { userId: "user-1" },
      scheduler: { removeTaskRuntime: vi.fn().mockResolvedValue(true) },
    });

    expect(result).toEqual({ kind: "deleted" });
    await expect(
      db.selectFrom("automation_task_shares").selectAll().where("task_id", "=", "automation-delete-shares").execute(),
    ).resolves.toEqual([]);
  });

  it("returns not-found for a concurrent delete that arrives during runtime cleanup", async () => {
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-delete-race"),
      brokerCapable: true,
    });
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const firstCleanup = vi.fn(async () => {
      markCleanupStarted();
      await cleanupReleased;
      return true;
    });
    const firstDelete = deleteAutomation({
      db,
      taskId: "automation-delete-race",
      actor: { userId: "user-1" },
      scheduler: { removeTaskRuntime: firstCleanup },
    });
    await cleanupStarted;

    const secondCleanup = vi.fn().mockResolvedValue(true);
    await expect(
      deleteAutomation({
        db,
        taskId: "automation-delete-race",
        actor: { userId: "user-1" },
        scheduler: { removeTaskRuntime: secondCleanup },
      }),
    ).resolves.toEqual({ kind: "not_found" });
    releaseCleanup();
    await expect(firstDelete).resolves.toEqual({ kind: "deleted" });
    expect(secondCleanup).not.toHaveBeenCalled();
  });

  it("blocks updates, replacements, and setup-mode selection while another editor holds the lock", async () => {
    await addUser("user-2");
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-locked"),
      brokerCapable: true,
    });
    await createAutomationDraft({
      db,
      context: { ...createContext("automation-locked-draft"), createdBy: "user-1" },
      timezone: "UTC",
    });
    const shares = createAutomationSharesRepository(db);
    await shares.grant({ taskId: "automation-locked", userId: "user-2", grantedByUserId: "user-1" });
    const holder = { userId: "user-2", platform: "web", surface: "builder", conversationId: null } as const;
    await acquireOrRenewLock(db, { taskId: "automation-locked", holder });
    await acquireOrRenewLock(db, { taskId: "automation-locked-draft", holder });

    const updated = await updateAutomationDefinition({
      db,
      taskId: "automation-locked",
      patch: { expectedRevision: 0, title: "Locked out" },
      actor: { userId: "user-1" },
      brokerCapable: true,
    });
    expect(updated.kind).toBe("locked");
    if (updated.kind === "locked") expect(updated.lock.holder_user_id).toBe("user-2");

    const replaced = await replaceAutomationDefinition({
      db,
      taskId: "automation-locked",
      request: makeDefinition({ expectedRevision: 0, title: "Locked out replacement" }),
      actor: { userId: "user-1" },
      brokerCapable: true,
    });
    expect(replaced.kind).toBe("locked");

    const mode = await selectAutomationSetupExecutionMode({
      db,
      taskId: "automation-locked-draft",
      executionMode: "hybrid",
      actor: { userId: "user-1" },
    });
    expect(mode.kind).toBe("locked");

    // The definition and draft are untouched by locked-out writes.
    await expect(createScheduledTaskRepository(db).getById("automation-locked")).resolves.toMatchObject({
      title: "Daily account brief",
      revision: 0,
    });
    await expect(createScheduledTaskRepository(db).getById("automation-locked-draft")).resolves.toMatchObject({
      execution_mode: "hybrid",
      revision: 0,
    });

    // The lock holder (with edit access) can still edit.
    const holderEdit = await updateAutomationDefinition({
      db,
      taskId: "automation-locked",
      patch: { expectedRevision: 0, title: "Holder edit" },
      actor: { userId: "user-2" },
      brokerCapable: true,
    });
    expect(holderEdit).toMatchObject({ kind: "saved", row: { title: "Holder edit", revision: 1 } });
  });

  it("blocks deletion while another session holds the task lock", async () => {
    await addUser("user-2");
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-delete-lock"),
      brokerCapable: true,
    });
    await acquireOrRenewLock(db, {
      taskId: "automation-delete-lock",
      holder: { userId: "user-2", platform: "web", surface: "builder", conversationId: null },
    });

    const result = await deleteAutomation({
      db,
      taskId: "automation-delete-lock",
      actor: { userId: "user-1" },
      scheduler: { removeTaskRuntime: vi.fn().mockResolvedValue(true) },
    });

    expect(result).toMatchObject({ kind: "locked", lock: { holder_user_id: "user-2" } });
    await expect(createScheduledTaskRepository(db).getById("automation-delete-lock")).resolves.toBeDefined();
    await expect(createAutomationLocksRepository(db).getByTaskId("automation-delete-lock")).resolves.toBeDefined();
  });

  it("denies a grantee's next save after a revoke while the grantee still holds the edit lock", async () => {
    await addUser("grantee-1");
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-revoke-locked"),
      brokerCapable: true,
    });
    const shares = createAutomationSharesRepository(db);
    await shares.grant({ taskId: "automation-revoke-locked", userId: "grantee-1", grantedByUserId: "user-1" });

    // Grant writes never touch the task row: the revision stays put.
    await expect(createScheduledTaskRepository(db).getById("automation-revoke-locked")).resolves.toMatchObject({
      revision: 0,
    });

    const holder = { userId: "grantee-1", platform: "web", surface: "builder", conversationId: null } as const;
    await acquireOrRenewLock(db, { taskId: "automation-revoke-locked", holder });
    const edited = await updateAutomationDefinition({
      db,
      taskId: "automation-revoke-locked",
      patch: { expectedRevision: 0, title: "Grantee edit" },
      actor: { userId: "grantee-1" },
      brokerCapable: true,
    });
    expect(edited).toMatchObject({ kind: "saved", row: { revision: 1, title: "Grantee edit" } });

    // The owner revokes mid-edit; the grantee's lock row is not cleared.
    await expect(shares.revoke({ taskId: "automation-revoke-locked", userId: "grantee-1" })).resolves.toBe(true);
    await expect(createScheduledTaskRepository(db).getById("automation-revoke-locked")).resolves.toMatchObject({
      revision: 1,
      title: "Grantee edit",
    });

    // The in-transaction re-check denies the grantee's next save on both paths.
    const deniedUpdate = await updateAutomationDefinition({
      db,
      taskId: "automation-revoke-locked",
      patch: { expectedRevision: 1, title: "Revoked edit" },
      actor: { userId: "grantee-1" },
      brokerCapable: true,
    });
    expect(deniedUpdate).toEqual({ kind: "access_denied" });
    const deniedReplace = await replaceAutomationDefinition({
      db,
      taskId: "automation-revoke-locked",
      request: makeDefinition({ expectedRevision: 1, title: "Revoked replacement" }),
      actor: { userId: "grantee-1" },
      brokerCapable: true,
    });
    expect(deniedReplace).toEqual({ kind: "not_found" });

    // Neither the denial nor the revoke bumped the revision or dropped the lock.
    await expect(createScheduledTaskRepository(db).getById("automation-revoke-locked")).resolves.toMatchObject({
      revision: 1,
      title: "Grantee edit",
    });
    await expect(createAutomationLocksRepository(db).getByTaskId("automation-revoke-locked")).resolves.toMatchObject({
      holder_user_id: "grantee-1",
    });
  });

  it("applies the same lock discipline to admin edits", async () => {
    await addUser("admin-1");
    await addUser("user-2");
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-admin-locked"),
      brokerCapable: true,
    });
    const holder = { userId: "user-2", platform: "web", surface: "builder", conversationId: null } as const;
    await acquireOrRenewLock(db, { taskId: "automation-admin-locked", holder });

    // Even admins must hold the lock to mutate.
    const denied = await updateAutomationDefinition({
      db,
      taskId: "automation-admin-locked",
      patch: { expectedRevision: 0, title: "Admin must wait" },
      actor: { userId: "admin-1", role: "admin" },
      brokerCapable: true,
    });
    expect(denied.kind).toBe("locked");
    if (denied.kind === "locked") expect(denied.lock.holder_user_id).toBe("user-2");
    const deniedReplace = await replaceAutomationDefinition({
      db,
      taskId: "automation-admin-locked",
      request: makeDefinition({ expectedRevision: 0, title: "Admin replacement must wait" }),
      actor: { userId: "admin-1", role: "admin" },
      brokerCapable: true,
    });
    expect(deniedReplace.kind).toBe("locked");

    // The admin's acquire loses to the live holder, then wins after release.
    const adminHolder = { userId: "admin-1", platform: "web", surface: "builder", conversationId: null } as const;
    const blockedAcquire = await acquireOrRenewLock(db, { taskId: "automation-admin-locked", holder: adminHolder });
    expect(blockedAcquire.kind).toBe("locked");
    await releaseLock(db, { taskId: "automation-admin-locked", userId: "user-2" });
    const held = await acquireOrRenewLock(db, { taskId: "automation-admin-locked", holder: adminHolder });
    expect(held.kind).toBe("held");

    const saved = await updateAutomationDefinition({
      db,
      taskId: "automation-admin-locked",
      patch: { expectedRevision: 0, title: "Admin after lock" },
      actor: { userId: "admin-1", role: "admin" },
      brokerCapable: true,
    });
    expect(saved).toMatchObject({
      kind: "saved",
      row: { title: "Admin after lock", revision: 1, last_edited_by: "admin-1" },
    });
  });

  it("blocks an admin delete while another user holds the lock", async () => {
    await addUser("user-2");
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-admin-delete-locked"),
      brokerCapable: true,
    });
    await acquireOrRenewLock(db, {
      taskId: "automation-admin-delete-locked",
      holder: { userId: "user-2", platform: "web", surface: "builder", conversationId: null },
    });
    const shares = createAutomationSharesRepository(db);
    await shares.grant({ taskId: "automation-admin-delete-locked", userId: "user-2", grantedByUserId: "user-1" });

    const result = await deleteAutomation({
      db,
      taskId: "automation-admin-delete-locked",
      actor: { userId: "admin-1", role: "admin" },
      scheduler: { removeTaskRuntime: vi.fn().mockResolvedValue(true) },
    });

    expect(result).toMatchObject({ kind: "locked", lock: { holder_user_id: "user-2" } });
    await expect(createScheduledTaskRepository(db).getById("automation-admin-delete-locked")).resolves.toBeDefined();
    await expect(
      createAutomationLocksRepository(db).getByTaskId("automation-admin-delete-locked"),
    ).resolves.toBeDefined();
    await expect(
      db
        .selectFrom("automation_task_shares")
        .selectAll()
        .where("task_id", "=", "automation-admin-delete-locked")
        .execute(),
    ).resolves.toHaveLength(1);
  });

  it("surfaces LOCKED and REVISION_CONFLICT across builder-save and agent-edit seams without silent clobbering", async () => {
    await addUser("user-1");
    await addUser("user-2");
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-builder-agent"),
      brokerCapable: true,
    });
    const shares = createAutomationSharesRepository(db);
    await shares.grant({ taskId: "automation-builder-agent", userId: "user-2", grantedByUserId: "user-1" });

    // Agent edit path (acquire -> update -> release), exactly as the agent tool runs it.
    const agentHolder = { userId: "user-2", platform: "slack", surface: "dm", conversationId: "C1" } as const;
    await acquireOrRenewLock(db, { taskId: "automation-builder-agent", holder: agentHolder });
    const agentEdit = await updateAutomationDefinition({
      db,
      taskId: "automation-builder-agent",
      patch: { expectedRevision: 0, prompt: "Agent-prompt version" },
      actor: { userId: "user-2" },
      brokerCapable: true,
    });
    expect(agentEdit).toMatchObject({ kind: "saved", row: { revision: 1, prompt: "Agent-prompt version" } });
    await releaseLock(db, { taskId: "automation-builder-agent", userId: "user-2" });

    // The web builder saves against a stale revision: REVISION_CONFLICT, no clobber.
    const builderStale = await replaceAutomationDefinition({
      db,
      taskId: "automation-builder-agent",
      request: makeDefinition({ expectedRevision: 0, prompt: "Builder-prompt version" }),
      actor: { userId: "user-1" },
      brokerCapable: true,
    });
    expect(builderStale).toEqual({ kind: "revision_conflict", currentRevision: 1 });
    await expect(createScheduledTaskRepository(db).getById("automation-builder-agent")).resolves.toMatchObject({
      prompt: "Agent-prompt version",
      revision: 1,
    });

    // The builder takes the lock; the agent's next edit is LOCKED, no clobber.
    const builderHolder = { userId: "user-1", platform: "web", surface: "builder", conversationId: null } as const;
    await acquireOrRenewLock(db, { taskId: "automation-builder-agent", holder: builderHolder });
    const agentLocked = await updateAutomationDefinition({
      db,
      taskId: "automation-builder-agent",
      patch: { expectedRevision: 1, prompt: "Agent second version" },
      actor: { userId: "user-2" },
      brokerCapable: true,
    });
    expect(agentLocked.kind).toBe("locked");
    if (agentLocked.kind === "locked") expect(agentLocked.lock.holder_user_id).toBe("user-1");

    // The builder saves against the current revision: success, revision advances.
    const builderSave = await replaceAutomationDefinition({
      db,
      taskId: "automation-builder-agent",
      request: makeDefinition({ expectedRevision: 1, prompt: "Builder-prompt version" }),
      actor: { userId: "user-1" },
      brokerCapable: true,
    });
    expect(builderSave).toMatchObject({ kind: "saved", row: { revision: 2, prompt: "Builder-prompt version" } });
    await releaseLock(db, { taskId: "automation-builder-agent", userId: "user-1" });

    // The agent's stale edit after the builder's save is REVISION_CONFLICT.
    const agentStale = await updateAutomationDefinition({
      db,
      taskId: "automation-builder-agent",
      patch: { expectedRevision: 1, prompt: "Agent stale version" },
      actor: { userId: "user-2" },
      brokerCapable: true,
    });
    expect(agentStale).toEqual({ kind: "revision_conflict", currentRevision: 2 });
    await expect(createScheduledTaskRepository(db).getById("automation-builder-agent")).resolves.toMatchObject({
      prompt: "Builder-prompt version",
      revision: 2,
    });
  });

  it("requires the exact active session and generation for browser persistence mutations", async () => {
    await addUser("user-1");
    await createAutomationDefinition({
      db,
      request: makeDefinition(),
      context: createContext("automation-browser-lease"),
      brokerCapable: true,
    });

    const noLease = await replaceAutomationDefinition({
      db,
      taskId: "automation-browser-lease",
      request: makeDefinition({ expectedRevision: 0, title: "No lease" }),
      actor: { userId: "user-1", source: "web" },
      brokerCapable: true,
    });
    expect(noLease).toEqual({ kind: "lease_required" });

    await acquireOrRenewLock(db, {
      taskId: "automation-browser-lease",
      holder: { userId: "user-1", sessionId: "tab-a", platform: "web", surface: "builder", conversationId: null },
    });

    const otherSession = await replaceAutomationDefinition({
      db,
      taskId: "automation-browser-lease",
      request: makeDefinition({ expectedRevision: 0, title: "Other session" }),
      actor: { userId: "user-1", source: "web", lease: { sessionId: "tab-b", generation: 1 } },
      brokerCapable: true,
    });
    expect(otherSession.kind).toBe("locked");

    const exactSession = await replaceAutomationDefinition({
      db,
      taskId: "automation-browser-lease",
      request: makeDefinition({ expectedRevision: 0, title: "Exact session" }),
      actor: { userId: "user-1", source: "web", lease: { sessionId: "tab-a", generation: 1 } },
      brokerCapable: true,
    });
    expect(exactSession).toMatchObject({ kind: "saved", row: { title: "Exact session", revision: 1 } });
  });
});
