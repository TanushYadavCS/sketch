import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../test-utils";
import type { DB } from "../schema";
import { createScheduledTaskRepository } from "./scheduled-tasks";
import { createWebhookEndpointsRepository } from "./webhook-endpoints";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

  it("ensures an opaque endpoint, encrypts its secret, and does not expose it in metadata", async () => {
    const repo = createWebhookEndpointsRepository(db, {
      encryptionKey: ENCRYPTION_KEY,
      idGenerator: () => "endpoint-1",
      secretGenerator: () => "secret-1",
      now: () => "2026-08-12T00:00:00.000Z",
    });

    const created = await repo.ensureForTask("task-1");
    expect(created).toMatchObject({ id: "endpoint-1", task_id: "task-1", secret: "secret-1", created: true });
    expect(created.endpoint).not.toHaveProperty("secret");

    const stored = await db.selectFrom("webhook_endpoints").selectAll().executeTakeFirstOrThrow();
    expect(stored.secret.startsWith("enc:")).toBe(true);
    expect(stored.secret).not.toContain("secret-1");

    const existing = await repo.ensureForTask("task-1");
    expect(existing).toMatchObject({ id: "endpoint-1", secret: null, created: false, generation: 1 });
    expect(await repo.getSecretById("endpoint-1")).toMatchObject({ secret: "secret-1" });
  });

  it("rotates and revokes credentials without changing endpoint identity", async () => {
    let secret = "first-secret";
    const repo = createWebhookEndpointsRepository(db, {
      encryptionKey: ENCRYPTION_KEY,
      secretGenerator: () => secret,
      idGenerator: () => "endpoint-1",
      now: () => "2026-08-12T00:00:00.000Z",
    });
    await repo.ensureForTask("task-1");
    secret = "second-secret";

    const rotated = await repo.rotateForTask("task-1");
    expect(rotated).toMatchObject({ id: "endpoint-1", task_id: "task-1", secret: "second-secret", generation: 2 });
    expect((await repo.getSecretByTaskId("task-1"))?.secret).toBe("second-secret");

    const revoked = await repo.revokeForTask("task-1");
    expect(revoked).toMatchObject({ id: "endpoint-1", status: "revoked", generation: 3 });
    expect((await repo.getByTaskId("task-1"))?.revoked_at).toBe("2026-08-12T00:00:00.000Z");
  });

  it("deletes dependent deliveries before deleting an endpoint", async () => {
    const repo = createWebhookEndpointsRepository(db, {
      encryptionKey: ENCRYPTION_KEY,
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
