import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("whatsapp_provider_events")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("dedupe_key", "text", (col) => col.notNull())
    .addColumn("provider_message_id", "text")
    .addColumn("provider_conversation_id", "text")
    .addColumn("event_family", "text", (col) => col.notNull())
    .addColumn("event_type", "text")
    .addColumn("status", "text")
    .addColumn("failure_code", "text")
    .addColumn("failure_detail", "text")
    .addColumn("provider_timestamp", "text")
    .addColumn("raw_payload_json", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("whatsapp_provider_events_dedupe_uidx")
    .on("whatsapp_provider_events")
    .columns(["provider", "dedupe_key"])
    .unique()
    .execute();

  await db.schema
    .createIndex("whatsapp_provider_events_message_idx")
    .on("whatsapp_provider_events")
    .columns(["provider", "provider_message_id"])
    .execute();

  await db.schema
    .createIndex("whatsapp_provider_events_family_idx")
    .on("whatsapp_provider_events")
    .columns(["provider", "event_family", "created_at"])
    .execute();

  await db.schema
    .createTable("whatsapp_template_mappings")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("logical_key", "text", (col) => col.notNull())
    .addColumn("provider_template_name", "text", (col) => col.notNull())
    .addColumn("language", "text", (col) => col.notNull().defaultTo("en_US"))
    .addColumn("status", "text", (col) => col.notNull().defaultTo("approved"))
    .addColumn("category", "text")
    .addColumn("parameter_map_json", "text")
    .addColumn("last_synced_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("whatsapp_template_mappings_logical_uidx")
    .on("whatsapp_template_mappings")
    .columns(["provider", "logical_key", "language"])
    .unique()
    .execute();

  await db.schema
    .createIndex("whatsapp_template_mappings_provider_template_idx")
    .on("whatsapp_template_mappings")
    .columns(["provider", "provider_template_name", "language"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("whatsapp_template_mappings").execute();
  await db.schema.dropTable("whatsapp_provider_events").execute();
}
