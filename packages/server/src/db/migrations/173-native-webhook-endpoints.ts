import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("webhook_endpoints")
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("task_id", "text", (column) =>
      column.notNull().unique().references("scheduled_tasks.id").onDelete("cascade"),
    )
    .addColumn("secret", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (column) => column.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("rotated_at", "text")
    .addColumn("revoked_at", "text")
    .execute();
  await db.schema.createIndex("webhook_endpoints_status").on("webhook_endpoints").column("status").execute();

  await db.schema
    .createTable("webhook_deliveries")
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("endpoint_id", "text", (column) =>
      column.notNull().references("webhook_endpoints.id").onDelete("cascade"),
    )
    .addColumn("task_id", "text", (column) => column.notNull().references("scheduled_tasks.id").onDelete("cascade"))
    .addColumn("event_id", "text", (column) => column.notNull())
    .addColumn("payload_hash", "text", (column) => column.notNull())
    .addColumn("trigger_data", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("run_id", "text")
    .addColumn("attempt_count", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("claimed_at", "text")
    .addColumn("created_at", "text", (column) => column.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (column) => column.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("completed_at", "text")
    .addColumn("error_message", "text")
    .addUniqueConstraint("webhook_deliveries_endpoint_event", ["endpoint_id", "event_id"])
    .execute();
  await db.schema
    .createIndex("webhook_deliveries_task_status")
    .on("webhook_deliveries")
    .columns(["task_id", "status"])
    .execute();
  await db.schema
    .createIndex("webhook_deliveries_endpoint_time")
    .on("webhook_deliveries")
    .columns(["endpoint_id", "created_at"])
    .execute();
  await db.schema
    .createIndex("webhook_deliveries_recovery")
    .on("webhook_deliveries")
    .columns(["status", "claimed_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("webhook_deliveries").ifExists().execute();
  await db.schema.dropTable("webhook_endpoints").ifExists().execute();
}
