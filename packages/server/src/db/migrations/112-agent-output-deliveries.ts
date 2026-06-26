import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("agent_output_deliveries")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("agent_output_id", "text", (col) => col.notNull().references("agent_outputs.id").onDelete("cascade"))
    .addColumn("platform", "text", (col) => col.notNull())
    .addColumn("target_type", "text", (col) => col.notNull())
    .addColumn("target_id", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("message_refs_json", "text")
    .addColumn("error_message", "text")
    .addColumn("sent_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_agent_output_deliveries_output")
    .on("agent_output_deliveries")
    .columns(["agent_output_id", "created_at"])
    .execute();

  await db.schema
    .createIndex("idx_agent_output_deliveries_status")
    .on("agent_output_deliveries")
    .columns(["status", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("agent_output_deliveries").execute();
}
