import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledTaskRepository } from "../db/repositories/scheduled-tasks";
import { createWebhookDeliveryRepository } from "../db/repositories/webhook-deliveries";
import { createWebhookEndpointRepository } from "../db/repositories/webhook-endpoints";
import type { DB } from "../db/schema";
import { createTestDb } from "../test-utils";
import { automationWebhookRoutes } from "./webhooks";

function webhookSteps() {
  return JSON.stringify([
    { id: "trigger-1", type: "trigger", triggerConfig: { type: "webhook" } },
    { id: "agent-1", type: "agent", agentMode: "sketch" },
  ]);
}

describe("automation webhook routes", () => {
  let db: Kysely<DB>;
  let enqueueWebhookDelivery: (deliveryId: string) => Promise<boolean>;

  beforeEach(async () => {
    db = await createTestDb();
    enqueueWebhookDelivery = vi.fn<(deliveryId: string) => Promise<boolean>>().mockResolvedValue(true);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function addTask(status: "active" | "paused" = "active") {
    const tasks = createScheduledTaskRepository(db);
    return tasks.add({
      id: `task-${Math.random().toString(16).slice(2)}`,
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
      status,
      next_run_at: null,
      steps: webhookSteps(),
    });
  }

  async function endpointForTask(taskId: string) {
    const endpoint = await createWebhookEndpointRepository(db).ensureForTask(taskId);
    return endpoint.endpoint;
  }

  function app() {
    const app = new Hono();
    app.route(
      "/api/webhooks",
      automationWebhookRoutes({
        db,
        scheduler: { enqueueWebhookDelivery },
      }),
    );
    return app;
  }

  it("admits an unauthenticated native JSON webhook durably without running an agent inline", async () => {
    const task = await addTask();
    const endpoint = await endpointForTask(task.id);
    const body = '{"event":"created"}';

    const response = await app().request(`/api/webhooks/v1/${endpoint.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Sketch-Webhook-Signature": "not-used",
      },
      body,
    });

    expect(response.status).toBe(202);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ accepted: true, duplicate: false, eventId: expect.any(String) });
    expect(enqueueWebhookDelivery).toHaveBeenCalledWith(receipt.deliveryId);
    const delivery = await createWebhookDeliveryRepository(db).getById(receipt.deliveryId);
    expect(delivery).toMatchObject({ endpoint_id: endpoint.id, task_id: task.id, payload_hash: expect.any(String) });
    expect(JSON.parse(delivery?.trigger_data ?? "{}")).toMatchObject({ source: "webhook", data: { event: "created" } });
  });

  it("accepts an optional Idempotency-Key and deduplicates matching retries", async () => {
    const task = await addTask();
    const endpoint = await endpointForTask(task.id);
    const headers = {
      "content-type": "application/json",
      "Idempotency-Key": "event-1",
    };
    const first = await app().request(`/api/webhooks/v1/${endpoint.id}`, {
      method: "POST",
      headers,
      body: '{"value":1}',
    });
    const firstReceipt = await first.json();
    const duplicate = await app().request(`/api/webhooks/v1/${endpoint.id}`, {
      method: "POST",
      headers,
      body: '{"value":1}',
    });
    const duplicateReceipt = await duplicate.json();
    expect(duplicate.status).toBe(202);
    expect(duplicateReceipt.deliveryId).toBe(firstReceipt.deliveryId);
    expect(duplicateReceipt.duplicate).toBe(true);

    const mismatch = await app().request(`/api/webhooks/v1/${endpoint.id}`, {
      method: "POST",
      headers,
      body: '{"value":2}',
    });
    expect(mismatch.status).toBe(409);
  });

  it("rejects malformed requests and inactive or deactivated endpoints", async () => {
    const activeTask = await addTask();
    const activeEndpoint = await endpointForTask(activeTask.id);
    const baseHeaders = {
      "content-type": "application/json",
      "Idempotency-Key": "validation-event",
    };

    expect(
      (
        await app().request(`/api/webhooks/v1/${activeEndpoint.id}`, {
          method: "POST",
          headers: baseHeaders,
          body: "not-json",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app().request(`/api/webhooks/v1/${activeEndpoint.id}`, {
          method: "POST",
          headers: { "Idempotency-Key": "missing-content-type" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await app().request(`/api/webhooks/v1/${activeEndpoint.id}`, {
          method: "POST",
          headers: { ...baseHeaders, "Idempotency-Key": "x".repeat(201) },
          body: "{}",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app().request(`/api/webhooks/v1/${activeEndpoint.id}`, {
          method: "POST",
          headers: baseHeaders,
          body: "x".repeat(1_000_001),
        })
      ).status,
    ).toBe(413);

    const pausedTask = await addTask("paused");
    const pausedEndpoint = await endpointForTask(pausedTask.id);
    expect(
      (
        await app().request(`/api/webhooks/v1/${pausedEndpoint.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(409);

    await createWebhookEndpointRepository(db).deactivateForTask(activeTask.id);
    expect(
      (
        await app().request(`/api/webhooks/v1/${activeEndpoint.id}`, {
          method: "POST",
          headers: baseHeaders,
          body: "{}",
        })
      ).status,
    ).toBe(404);
    expect((await app().request("/api/webhooks/v1/missing", { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("keeps the task-id compatibility route unauthenticated", async () => {
    const task = await addTask();
    await endpointForTask(task.id);
    const response = await app().request(`/api/webhooks/wf/${task.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(202);
  });
});
