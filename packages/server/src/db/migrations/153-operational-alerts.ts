import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("operational_alerts")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("resource_key", "text", (col) => col.notNull())
    .addColumn("severity", "text", (col) => col.notNull())
    .addColumn("state", "text", (col) => col.notNull())
    .addColumn("payload", "text", (col) => col.notNull())
    .addColumn("first_observed_at", "text", (col) => col.notNull())
    .addColumn("last_observed_at", "text", (col) => col.notNull())
    .addColumn("notify_after", "text", (col) => col.notNull())
    .addColumn("opened_at", "text")
    .addColumn("resolved_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addCheckConstraint("operational_alerts_severity_check", sql`severity IN ('warning', 'critical')`)
    .addCheckConstraint("operational_alerts_state_check", sql`state IN ('observing', 'open', 'resolved')`)
    .execute();

  await sql`CREATE UNIQUE INDEX operational_alerts_active_resource_uidx
    ON operational_alerts(type, resource_key)
    WHERE state IN ('observing', 'open')`.execute(db);
  await sql`CREATE INDEX operational_alerts_due_idx
    ON operational_alerts(state, notify_after)`.execute(db);

  await db.schema
    .createTable("operational_alert_deliveries")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("alert_id", "text", (col) => col.notNull().references("operational_alerts.id").onDelete("cascade"))
    .addColumn("recipient_user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("channel", "text", (col) => col.notNull())
    .addColumn("destination_fingerprint", "text", (col) => col.notNull())
    .addColumn("state", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("next_attempt_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("claim_token", "text")
    .addColumn("claimed_at", "text")
    .addColumn("provider_message_id", "text")
    .addColumn("last_error_code", "text")
    .addColumn("last_error", "text")
    .addColumn("sent_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addCheckConstraint("operational_alert_deliveries_channel_check", sql`channel IN ('whatsapp', 'slack')`)
    .addCheckConstraint(
      "operational_alert_deliveries_state_check",
      sql`state IN ('pending', 'processing', 'retry', 'sent', 'skipped', 'dead')`,
    )
    .execute();

  await sql`CREATE UNIQUE INDEX operational_alert_deliveries_destination_uidx
    ON operational_alert_deliveries(alert_id, channel, destination_fingerprint)`.execute(db);
  await sql`CREATE INDEX operational_alert_deliveries_due_idx
    ON operational_alert_deliveries(state, next_attempt_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("operational_alert_deliveries").execute();
  await db.schema.dropTable("operational_alerts").execute();
}
