import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("entity_project_bindings")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("cascade"))
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("container_id", "text", (col) => col.notNull())
    .addColumn("container_kind", "text", (col) => col.notNull())
    .addColumn("label", "text")
    .addColumn("connector_config_id", "text", (col) => col.references("connector_configs.id").onDelete("set null"))
    .addColumn("created_by", "text", (col) => col.notNull().references("users.id").onDelete("restrict"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex("idx_entity_project_bindings_entity")
    .on("entity_project_bindings")
    .column("entity_id")
    .execute();
  await db.schema
    .createIndex("idx_entity_project_bindings_unique")
    .on("entity_project_bindings")
    .columns(["entity_id", "source", "container_id"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("entity_project_bindings").execute();
}
