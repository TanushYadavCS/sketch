import { createHash, randomUUID } from "node:crypto";
import { type Kysely, type Selectable, sql } from "kysely";
import type { DB, OperationalAlertDeliveriesTable, OperationalAlertsTable } from "../schema";

export const OPERATIONAL_ALERT_MAX_ATTEMPTS = 5;
export const OPERATIONAL_ALERT_BATCH_SIZE = 25;
export const OPERATIONAL_ALERT_STALE_CLAIM_MS = 2 * 60 * 1000;

export type OperationalAlertRow = Selectable<OperationalAlertsTable>;
export type OperationalAlertDeliveryRow = Selectable<OperationalAlertDeliveriesTable>;

export function operationalAlertDestinationFingerprint(channel: string, destination: string): string {
  return createHash("sha256").update(`${channel}\x1f${destination}`).digest("hex");
}

function truncate(value: string | null | undefined, max: number): string | null {
  return value ? value.slice(0, max) : null;
}

export function createOperationalAlertsRepository(db: Kysely<DB>) {
  async function findActive(type: string, resourceKey: string): Promise<OperationalAlertRow | undefined> {
    return db
      .selectFrom("operational_alerts")
      .selectAll()
      .where("type", "=", type)
      .where("resource_key", "=", resourceKey)
      .where("state", "in", ["observing", "open"])
      .executeTakeFirst();
  }

  async function updateObservedAlert(
    existing: OperationalAlertRow,
    params: {
      severity: "warning" | "critical";
      payload: string;
      observedAt: string;
      notifyAfter: string;
    },
  ): Promise<OperationalAlertRow> {
    await db
      .updateTable("operational_alerts")
      .set({
        severity: params.severity,
        payload: params.payload,
        last_observed_at: params.observedAt,
        notify_after:
          existing.state === "observing" && params.notifyAfter < existing.notify_after
            ? params.notifyAfter
            : existing.notify_after,
        updated_at: params.observedAt,
      })
      .where("id", "=", existing.id)
      .where("last_observed_at", "<=", params.observedAt)
      .execute();
    return db.selectFrom("operational_alerts").selectAll().where("id", "=", existing.id).executeTakeFirstOrThrow();
  }

  return {
    findActive,

    async observe(params: {
      type: string;
      resourceKey: string;
      severity: "warning" | "critical";
      payload: string;
      observedAt: string;
      notifyAfter: string;
    }): Promise<OperationalAlertRow> {
      const existing = await findActive(params.type, params.resourceKey);
      if (existing) {
        return updateObservedAlert(existing, params);
      }

      const id = randomUUID();
      try {
        await db
          .insertInto("operational_alerts")
          .values({
            id,
            type: params.type,
            resource_key: params.resourceKey,
            severity: params.severity,
            state: "observing",
            payload: params.payload,
            first_observed_at: params.observedAt,
            last_observed_at: params.observedAt,
            notify_after: params.notifyAfter,
            opened_at: null,
            resolved_at: null,
            updated_at: params.observedAt,
          })
          .execute();
        return await db.selectFrom("operational_alerts").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      } catch (error) {
        const raced = await findActive(params.type, params.resourceKey);
        if (!raced) throw error;
        return updateObservedAlert(raced, params);
      }
    },

    async resolve(type: string, resourceKey: string, resolvedAt: string): Promise<void> {
      const active = await findActive(type, resourceKey);
      if (!active) return;
      await db.transaction().execute(async (trx) => {
        const result = await trx
          .updateTable("operational_alerts")
          .set({ state: "resolved", resolved_at: resolvedAt, updated_at: resolvedAt })
          .where("id", "=", active.id)
          .where("state", "in", ["observing", "open"])
          .where("last_observed_at", "<=", resolvedAt)
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) !== 1) return;
        await trx
          .updateTable("operational_alert_deliveries")
          .set({ state: "skipped", last_error_code: "alert_resolved", updated_at: resolvedAt })
          .where("alert_id", "=", active.id)
          .where("state", "in", ["pending", "retry"])
          .execute();
      });
    },

    async listEligibleObserving(now: string): Promise<OperationalAlertRow[]> {
      return db
        .selectFrom("operational_alerts")
        .selectAll()
        .where("state", "=", "observing")
        .where("notify_after", "<=", now)
        .orderBy("notify_after", "asc")
        .limit(OPERATIONAL_ALERT_BATCH_SIZE)
        .execute();
    },

    async promote(id: string, openedAt: string): Promise<boolean> {
      const result = await db
        .updateTable("operational_alerts")
        .set({ state: "open", opened_at: openedAt, updated_at: openedAt })
        .where("id", "=", id)
        .where("state", "=", "observing")
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async listOpen(): Promise<OperationalAlertRow[]> {
      return db
        .selectFrom("operational_alerts")
        .selectAll()
        .where("state", "=", "open")
        .orderBy("opened_at", "asc")
        .limit(OPERATIONAL_ALERT_BATCH_SIZE)
        .execute();
    },

    async ensureDelivery(params: {
      alertId: string;
      recipientUserId: string;
      channel: "whatsapp" | "slack";
      destinationFingerprint: string;
      now: string;
    }): Promise<void> {
      await db
        .insertInto("operational_alert_deliveries")
        .values({
          id: randomUUID(),
          alert_id: params.alertId,
          recipient_user_id: params.recipientUserId,
          channel: params.channel,
          destination_fingerprint: params.destinationFingerprint,
          state: "pending",
          next_attempt_at: params.now,
          claim_token: null,
          claimed_at: null,
          provider_message_id: null,
          last_error_code: null,
          last_error: null,
          sent_at: null,
          updated_at: params.now,
        })
        .onConflict((conflict) => conflict.columns(["alert_id", "channel", "destination_fingerprint"]).doNothing())
        .execute();
    },

    async recoverStaleClaims(now: Date): Promise<void> {
      const staleBefore = new Date(now.getTime() - OPERATIONAL_ALERT_STALE_CLAIM_MS).toISOString();
      await db
        .updateTable("operational_alert_deliveries")
        .set({
          state: "retry",
          claim_token: null,
          claimed_at: null,
          next_attempt_at: now.toISOString(),
          last_error_code: "stale_claim",
          updated_at: now.toISOString(),
        })
        .where("state", "=", "processing")
        .where("claimed_at", "<", staleBefore)
        .execute();
    },

    async claimNext(now: string): Promise<OperationalAlertDeliveryRow | undefined> {
      const candidate = await db
        .selectFrom("operational_alert_deliveries")
        .select("id")
        .where("state", "in", ["pending", "retry"])
        .where("next_attempt_at", "<=", now)
        .orderBy("next_attempt_at", "asc")
        .orderBy("created_at", "asc")
        .executeTakeFirst();
      if (!candidate) return undefined;
      const claimToken = randomUUID();
      const result = await db
        .updateTable("operational_alert_deliveries")
        .set({ state: "processing", claim_token: claimToken, claimed_at: now, updated_at: now })
        .where("id", "=", candidate.id)
        .where("state", "in", ["pending", "retry"])
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return undefined;
      return db
        .selectFrom("operational_alert_deliveries")
        .selectAll()
        .where("id", "=", candidate.id)
        .where("claim_token", "=", claimToken)
        .executeTakeFirst();
    },

    async getAlert(id: string): Promise<OperationalAlertRow | undefined> {
      return db.selectFrom("operational_alerts").selectAll().where("id", "=", id).executeTakeFirst();
    },

    async markSent(id: string, providerMessageId: string | null, sentAt: string): Promise<void> {
      await db
        .updateTable("operational_alert_deliveries")
        .set({
          state: "sent",
          provider_message_id: providerMessageId,
          sent_at: sentAt,
          claim_token: null,
          claimed_at: null,
          updated_at: sentAt,
        })
        .where("id", "=", id)
        .where("state", "=", "processing")
        .execute();
    },

    async markSkipped(id: string, code: string, message: string, now: string): Promise<void> {
      await db
        .updateTable("operational_alert_deliveries")
        .set({
          state: "skipped",
          last_error_code: truncate(code, 128),
          last_error: truncate(message, 1024),
          claim_token: null,
          claimed_at: null,
          updated_at: now,
        })
        .where("id", "=", id)
        .execute();
    },

    async markFailed(params: {
      id: string;
      attempts: number;
      code: string;
      message: string;
      nextAttemptAt: string;
      now: string;
    }): Promise<void> {
      const state = params.attempts >= OPERATIONAL_ALERT_MAX_ATTEMPTS ? "dead" : "retry";
      await db
        .updateTable("operational_alert_deliveries")
        .set({
          state,
          attempts: params.attempts,
          next_attempt_at: params.nextAttemptAt,
          last_error_code: truncate(params.code, 128),
          last_error: truncate(params.message, 1024),
          claim_token: null,
          claimed_at: null,
          updated_at: params.now,
        })
        .where("id", "=", params.id)
        .execute();
    },

    async listDeliveries(alertId: string): Promise<OperationalAlertDeliveryRow[]> {
      return db
        .selectFrom("operational_alert_deliveries")
        .selectAll()
        .where("alert_id", "=", alertId)
        .orderBy("created_at", "asc")
        .execute();
    },

    async counts(): Promise<{ pending: number; dead: number }> {
      const rows = await db
        .selectFrom("operational_alert_deliveries")
        .select(["state", sql<number>`count(*)`.as("count")])
        .where("state", "in", ["pending", "retry", "processing", "dead"])
        .groupBy("state")
        .execute();
      let pending = 0;
      let dead = 0;
      for (const row of rows) {
        if (row.state === "dead") dead += Number(row.count);
        else pending += Number(row.count);
      }
      return { pending, dead };
    },
  };
}
