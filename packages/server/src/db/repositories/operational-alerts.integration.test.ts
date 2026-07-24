import { type Kysely, sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPgDb } from "../../test-utils";
import type { DB } from "../schema";
import { createOperationalAlertsRepository } from "./operational-alerts";

describe("operational alerts repository on Postgres", () => {
  let db!: Kysely<DB>;

  beforeAll(async () => {
    db = await getSharedPgDb();
  }, 30_000);

  beforeEach(async () => {
    await sql`BEGIN`.execute(db);
  });

  afterEach(async () => {
    await sql`ROLLBACK`.execute(db);
  });

  it("enforces one active alert and one delivery per destination", async () => {
    await db
      .insertInto("users")
      .values({ id: "admin-1", name: "Admin", email: "admin@example.com", auth_role: "admin" })
      .execute();
    const alerts = createOperationalAlertsRepository(db);
    const observedAt = "2026-07-17T10:00:00.000Z";
    const first = await alerts.observe({
      type: "whatsapp.baileys.disconnected",
      resourceKey: "whatsapp:baileys:gateway",
      severity: "warning",
      payload: '{"attempt":1}',
      observedAt,
      notifyAfter: observedAt,
    });
    const second = await alerts.observe({
      type: "whatsapp.baileys.disconnected",
      resourceKey: "whatsapp:baileys:gateway",
      severity: "critical",
      payload: '{"attempt":2}',
      observedAt,
      notifyAfter: observedAt,
    });
    expect(second.id).toBe(first.id);
    await alerts.promote(first.id, observedAt);
    await alerts.ensureDelivery({
      alertId: first.id,
      recipientUserId: "admin-1",
      channel: "whatsapp",
      destinationFingerprint: "same-destination",
      now: observedAt,
    });
    await alerts.ensureDelivery({
      alertId: first.id,
      recipientUserId: "admin-1",
      channel: "whatsapp",
      destinationFingerprint: "same-destination",
      now: observedAt,
    });
    await expect(alerts.listDeliveries(first.id)).resolves.toHaveLength(1);
  }, 30_000);
});
