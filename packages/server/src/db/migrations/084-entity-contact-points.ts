import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("entity_contact_points")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("cascade"))
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("display_value", "text")
    .addColumn("label", "text")
    .addColumn("is_primary", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("connector_config_id", "text", (col) => col.references("connector_configs.id").onDelete("set null"))
    .addColumn("created_by_user_id", "text", (col) => col.references("users.id").onDelete("set null"))
    .addColumn("verified_at", "text")
    .addColumn("last_contacted_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("entity_contact_points_unique", ["entity_id", "kind", "value"])
    .execute();

  await db.schema
    .createIndex("idx_entity_contact_points_entity")
    .on("entity_contact_points")
    .column("entity_id")
    .execute();
  await db.schema
    .createIndex("idx_entity_contact_points_kind_value")
    .on("entity_contact_points")
    .columns(["kind", "value"])
    .execute();
  await db.schema
    .createIndex("idx_entity_contact_points_connector")
    .on("entity_contact_points")
    .column("connector_config_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("entity_contact_points").execute();
}
