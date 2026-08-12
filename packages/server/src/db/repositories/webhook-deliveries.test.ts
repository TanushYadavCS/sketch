import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createScheduledTaskRepository } from "./scheduled-tasks";
import { createWebhookDeliveriesRepository } from "./webhook-deliveries";
import { createWebhookEndpointsRepository } from "./webhook-endpoints";

const NOW = "2026-08-12T00:00:00.000Z";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("webhook delivery repository", () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await createTestDb();
    await createScheduledTaskRepository(db).add({
      id: "task-1",
      platform: "slack",
      context_type: "dm",
      delivery_target: "D123",
      thread_ts: null,
      prompt: "Process webhook data",
      schedule_type: "external",
      schedule_value: "webhook",
      timezone: "UTC",
      session_mode: "fresh",
      created_by: null,
      status: "active",
      next_run_at: null,
    });
    await createWebhookEndpointsRepository(db, ENCRYPTION_KEY, { idGenerator: () => "endpoint-1" }).ensureForTask(
      "task-1",
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("deduplicates deliveries by endpoint and event id", async () => {
    const repo = createWebhookDeliveriesRepository(db, { now: () => NOW, idGenerator: () => "delivery-1" });
    const first = await repo.insertOrGet({
      endpointId: "endpoint-1",
      taskId: "task-1",
      eventId: "event-1",
      payloadHash: "hash-1",
      triggerData: { source: "webhook", data: { value: 1 } },
      taskRevision: 0,
      endpointGeneration: 1,
    });
    const duplicate = await repo.insertOrGet({
      endpointId: "endpoint-1",
      taskId: "task-1",
      eventId: "event-1",
      payloadHash: "hash-2",
      triggerData: { value: 2 },
      taskRevision: 0,
      endpointGeneration: 1,
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.delivery).toMatchObject({ id: "delivery-1", payload_hash: "hash-1", status: "pending" });
  });

  it("supports queueing, claiming, completion, and failure recovery", async () => {
    const repo = createWebhookDeliveriesRepository(db, { now: () => NOW, idGenerator: () => "delivery-1" });
    await repo.insertOrGet({
      endpointId: "endpoint-1",
      taskId: "task-1",
      eventId: "event-1",
      payloadHash: "hash-1",
      triggerData: "{}",
      taskRevision: 0,
      endpointGeneration: 1,
    });

    expect((await repo.markQueued("delivery-1"))?.status).toBe("queued");
    expect((await repo.claim("delivery-1", { runId: "run-1" }))?.status).toBe("processing");
    expect((await repo.get("delivery-1"))?.attempt_count).toBe(1);
    expect(await repo.heartbeat("delivery-1", "run-1", "2026-08-12T00:01:00.000Z")).toBe(true);
    expect((await repo.get("delivery-1"))?.claimed_at).toBe("2026-08-12T00:01:00.000Z");
    expect(await repo.heartbeat("delivery-1", "stale-run", "2026-08-12T00:02:00.000Z")).toBe(false);
    expect((await repo.complete("delivery-1", "run-1"))?.status).toBe("completed");

    const failed = await repo.insertOrGet({
      id: "delivery-2",
      endpointId: "endpoint-1",
      taskId: "task-1",
      eventId: "event-2",
      payloadHash: "hash-2",
      triggerData: "{}",
      taskRevision: 0,
      endpointGeneration: 1,
    });
    expect((await repo.fail(failed.delivery.id, "upstream failed"))?.status).toBe("failed");

    const cancelled = await repo.insertOrGet({
      id: "delivery-3",
      endpointId: "endpoint-1",
      taskId: "task-1",
      eventId: "event-3",
      payloadHash: "hash-3",
      triggerData: "{}",
      taskRevision: 0,
      endpointGeneration: 1,
    });
    expect((await repo.cancel(cancelled.delivery.id, "cancelled by task"))?.status).toBe("cancelled");
  });
});
