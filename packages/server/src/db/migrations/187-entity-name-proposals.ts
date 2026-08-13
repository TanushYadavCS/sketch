import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("entities")
    .addColumn("name_status", "text", (col) => col.notNull().defaultTo("confirmed"))
    .execute();
  await db.schema
    .createTable("entity_name_proposals")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("cascade"))
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("normalized_value", "text", (col) => col.notNull())
    .addColumn("observed_count", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("first_seen_at", "text", (col) => col.notNull())
    .addColumn("last_seen_at", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("resolved_by_user_id", "text", (col) => col.references("users.id"))
    .addColumn("resolved_at", "text")
    .addUniqueConstraint("entity_name_proposals_entity_source_value_uidx", ["entity_id", "source", "normalized_value"])
    .execute();
  await sql`
    UPDATE entities
    SET name_status = 'placeholder'
    WHERE source_type = 'person'
      AND EXISTS (
        SELECT 1
        FROM entity_contact_points
        WHERE entity_contact_points.entity_id = entities.id
          AND entity_contact_points.source = 'whatsapp_identity'
          AND entity_contact_points.kind IN ('phone', 'whatsapp_lid')
          AND entity_contact_points.value = entities.name
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("entity_name_proposals").execute();
  await db.schema.alterTable("entities").dropColumn("name_status").execute();
}
