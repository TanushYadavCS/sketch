import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { automationWebhookRoutes } from "./webhooks";

function webhookSteps() {
  return JSON.stringify([
    {
      id: "trigger-1",
      type: "trigger",
      triggerConfig: { type: "webhook" },
    },
    {
      id: "agent-1",
      type: "agent",
      agentMode: "sketch",
    },
  ]);
}

describe("automation webhook route", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("accepts JSON payloads and queues the matching active automation", async () => {
    const tasks = createScheduledTaskRepository(db);
    await tasks.add({
      id: "task-webhook",
      platform: "web",
      context_type: "dm",
      delivery_target: "conversation-1",
      thread_ts: null,
      prompt: "Process the webhook",
      schedule_type: "external",
      schedule_value: "webhook",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: null,
      status: "active",
      next_run_at: null,
      steps: webhookSteps(),
    });

    const enqueueTaskById = vi.fn().mockResolvedValue(undefined);
    const app = new Hono();
    app.route("/api/webhooks", automationWebhookRoutes({ db, scheduler: { enqueueTaskById } }));

    const response = await app.request("/api/webhooks/wf/task-webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "created", id: "evt-1" }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      taskId: "task-webhook",
      trigger: { type: "webhook", method: "POST", contentType: "application/json" },
    });
    expect(enqueueTaskById).toHaveBeenCalledWith(
      "task-webhook",
      expect.objectContaining({
        source: "webhook",
        data: { event: "created", id: "evt-1" },
      }),
      { propagateParentAbort: false },
    );
  });

  it("does not expose inactive or non-webhook automations as endpoints", async () => {
    const tasks = createScheduledTaskRepository(db);
    await tasks.add({
      id: "task-paused",
      platform: "web",
      context_type: "dm",
      delivery_target: "conversation-1",
      thread_ts: null,
      prompt: "Process the webhook",
      schedule_type: "external",
      schedule_value: "webhook",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: null,
      status: "paused",
      next_run_at: null,
      steps: webhookSteps(),
    });
    await tasks.add({
      id: "task-schedule",
      platform: "web",
      context_type: "dm",
      delivery_target: "conversation-1",
      thread_ts: null,
      prompt: "Run on a schedule",
      schedule_type: "cron",
      schedule_value: "0 * * * *",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: null,
      status: "active",
      next_run_at: null,
      steps: JSON.stringify([{ id: "trigger-1", type: "trigger", triggerConfig: { type: "schedule" } }]),
    });

    const app = new Hono();
    app.route("/api/webhooks", automationWebhookRoutes({ db, scheduler: { enqueueTaskById: vi.fn() } }));

    expect((await app.request("/api/webhooks/wf/task-paused", { method: "POST" })).status).toBe(409);
    expect((await app.request("/api/webhooks/wf/task-schedule", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/webhooks/wf/missing", { method: "POST" })).status).toBe(404);
  });
});
