import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("container_classifications")
    .addColumn("connector_config_id", "text", (col) =>
      col.notNull().references("connector_configs.id").onDelete("cascade"),
    )
    .addColumn("container_id", "text", (col) => col.notNull())
    .addColumn("container_name", "text", (col) => col.notNull())
    .addColumn("level", "text", (col) => col.notNull())
    .addColumn("proposed_target", "text", (col) => col.notNull())
    .addColumn("confidence", "text", (col) => col.notNull())
    .addColumn("reasoning", "text", (col) => col.notNull())
    .addColumn("digest_hash", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("proposed"))
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("container_classifications_pk", ["connector_config_id", "container_id"])
    .execute();

  await db.schema
    .createIndex("idx_container_classifications_status")
    .on("container_classifications")
    .columns(["connector_config_id", "status"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_container_classifications_status").execute();
  await db.schema.dropTable("container_classifications").execute();
}
