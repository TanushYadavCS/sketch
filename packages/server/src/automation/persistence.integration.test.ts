import type { AutomationBuilderSaveRequest } from "@sketch/shared";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAutomationStepContentRepository } from "../db/repositories/automation-step-content";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createTestPgDb } from "../test-utils";
import { createAutomationDefinition, replaceAutomationDefinition } from "./persistence";

function definition(overrides: Partial<AutomationBuilderSaveRequest> = {}): AutomationBuilderSaveRequest {
  return {
    title: "Portable automation",
    description: null,
    prompt: "Run the portable automation.",
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
        label: "Schedule",
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
        label: "Work",
        icon: "sketch-ai",
        position: { x: 260, y: 0 },
      },
    ],
    edges: [{ id: "trigger-agent", from: "trigger", to: "agent" }],
    stepContent: {
      agent: {
        taskId: "client-value",
        stepId: "agent",
        contentType: "prompt",
        content: "Do the work.",
        apps: null,
      },
    },
    ...overrides,
  };
}

function context(id: string) {
  return {
    id,
    platform: "slack" as const,
    contextType: "dm" as const,
    deliveryTarget: "D123",
    threadTs: null,
    createdBy: "pg-owner",
    originPlatform: null,
    originConversationId: null,
    originProviderThreadId: null,
    originMessageId: null,
  };
}

describe("automation persistence on Postgres", () => {
  let db: Awaited<ReturnType<typeof createTestPgDb>>;

  beforeAll(async () => {
    db = await createTestPgDb();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("creates and replaces task content with portable transactions and revision CAS", async () => {
    const initial = definition({
      steps: [
        ...definition().steps,
        {
          id: "orphan",
          type: "agent",
          label: "Remove me",
          icon: "sketch-ai",
          position: { x: 520, y: 0 },
        },
      ],
      edges: [
        { id: "trigger-agent", from: "trigger", to: "agent" },
        { id: "agent-orphan", from: "agent", to: "orphan" },
      ],
      stepContent: {
        ...definition().stepContent,
        orphan: {
          taskId: "client-value",
          stepId: "orphan",
          contentType: "prompt",
          content: "Remove this.",
          apps: null,
        },
      },
    });
    await createAutomationDefinition({
      db,
      request: initial,
      context: context("pg-automation"),
      brokerCapable: true,
    });

    await expect(
      replaceAutomationDefinition({
        db,
        taskId: "pg-automation",
        request: definition({ expectedRevision: 0, title: "Unauthorized replacement" }),
        actor: { userId: "another-owner", canManageAnyTask: false },
        brokerCapable: true,
      }),
    ).resolves.toEqual({ kind: "not_found" });

    const replaced = await replaceAutomationDefinition({
      db,
      taskId: "pg-automation",
      request: definition({ expectedRevision: 0, title: "Portable replacement" }),
      actor: { userId: "pg-owner", canManageAnyTask: false },
      brokerCapable: true,
    });

    expect(replaced).toMatchObject({ kind: "saved", row: { revision: 1, title: "Portable replacement" } });
    await expect(createAutomationStepContentRepository(db).getByTask("pg-automation")).resolves.toEqual([
      expect.objectContaining({ task_id: "pg-automation", step_id: "agent", content: "Do the work." }),
    ]);
    await expect(
      replaceAutomationDefinition({
        db,
        taskId: "pg-automation",
        request: definition({ expectedRevision: 0, title: "Stale replacement" }),
        actor: { userId: "pg-owner", canManageAnyTask: false },
        brokerCapable: true,
      }),
    ).resolves.toEqual({ kind: "revision_conflict", currentRevision: 1 });
  });

  it("rolls back the replacement row when Postgres rejects replacement content", async () => {
    await createAutomationDefinition({
      db,
      request: definition(),
      context: context("pg-replace-rollback"),
      brokerCapable: true,
    });
    await sql`
      CREATE FUNCTION reject_replacement_content() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'replacement content rejected';
      END;
      $$ LANGUAGE plpgsql
    `.execute(db);
    await sql`
      CREATE TRIGGER reject_replacement_content
      BEFORE INSERT ON automation_step_content
      FOR EACH ROW EXECUTE FUNCTION reject_replacement_content()
    `.execute(db);

    try {
      await expect(
        replaceAutomationDefinition({
          db,
          taskId: "pg-replace-rollback",
          request: definition({ expectedRevision: 0, title: "Must roll back" }),
          actor: { userId: "pg-owner", canManageAnyTask: false },
          brokerCapable: true,
        }),
      ).rejects.toThrow("replacement content rejected");
      await expect(createScheduledTaskRepository(db).getById("pg-replace-rollback")).resolves.toMatchObject({
        title: "Portable automation",
        revision: 0,
      });
    } finally {
      await sql`DROP TRIGGER reject_replacement_content ON automation_step_content`.execute(db);
      await sql`DROP FUNCTION reject_replacement_content()`.execute(db);
    }
  });

  it("rolls back the task row when Postgres rejects step content", async () => {
    await sql`
      CREATE FUNCTION reject_automation_content() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'content rejected';
      END;
      $$ LANGUAGE plpgsql
    `.execute(db);
    await sql`
      CREATE TRIGGER reject_automation_content
      BEFORE INSERT ON automation_step_content
      FOR EACH ROW EXECUTE FUNCTION reject_automation_content()
    `.execute(db);

    try {
      await expect(
        createAutomationDefinition({
          db,
          request: definition(),
          context: context("pg-rollback"),
          brokerCapable: true,
        }),
      ).rejects.toThrow("content rejected");
      await expect(createScheduledTaskRepository(db).getById("pg-rollback")).resolves.toBeUndefined();
    } finally {
      await sql`DROP TRIGGER reject_automation_content ON automation_step_content`.execute(db);
      await sql`DROP FUNCTION reject_automation_content()`.execute(db);
    }
  });
});
