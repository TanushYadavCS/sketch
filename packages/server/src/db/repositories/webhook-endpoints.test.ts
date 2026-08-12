import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createScheduledTaskRepository } from "./scheduled-tasks";
import { createWebhookEndpointsRepository } from "./webhook-endpoints";

describe("webhook endpoint repository", () => {
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
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("ensures an opaque endpoint without generating credentials", async () => {
    const repo = createWebhookEndpointsRepository(db, {
      idGenerator: () => "endpoint-1",
      now: () => "2026-08-12T00:00:00.000Z",
    });

    const created = await repo.ensureForTask("task-1");
    expect(created).toMatchObject({ id: "endpoint-1", task_id: "task-1", created: true, status: "active" });

    const stored = await db.selectFrom("webhook_endpoints").selectAll().executeTakeFirstOrThrow();
    expect(stored).toEqual({
      id: "endpoint-1",
      task_id: "task-1",
      status: "active",
      generation: 1,
      created_at: "2026-08-12T00:00:00.000Z",
      updated_at: "2026-08-12T00:00:00.000Z",
    });

    const existing = await repo.ensureForTask("task-1");
    expect(existing).toMatchObject({ id: "endpoint-1", created: false, generation: 1 });
  });

  it("deactivates and reactivates an endpoint without changing its identity", async () => {
    const repo = createWebhookEndpointsRepository(db, {
      idGenerator: () => "endpoint-1",
      now: () => "2026-08-12T00:00:00.000Z",
    });
    await repo.ensureForTask("task-1");

    const deactivated = await repo.deactivateForTask("task-1");
    expect(deactivated).toMatchObject({ id: "endpoint-1", status: "revoked", generation: 2 });

    const reactivated = await repo.ensureForTask("task-1");
    expect(reactivated).toMatchObject({ id: "endpoint-1", status: "active", generation: 3 });
  });

  it("deletes dependent deliveries before deleting an endpoint", async () => {
    const repo = createWebhookEndpointsRepository(db, {
      idGenerator: () => "endpoint-1",
    });
    await repo.ensureForTask("task-1");
    await db
      .insertInto("webhook_deliveries")
      .values({
        id: "delivery-1",
        endpoint_id: "endpoint-1",
        task_id: "task-1",
        event_id: "event-1",
        payload_hash: "hash",
        trigger_data: "{}",
        status: "pending",
        task_revision: 0,
        endpoint_generation: 1,
      })
      .execute();

    await repo.deleteByTaskId("task-1");
    expect(await db.selectFrom("webhook_endpoints").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("webhook_deliveries").selectAll().execute()).toHaveLength(0);
  });
});
