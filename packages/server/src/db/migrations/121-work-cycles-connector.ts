import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("work_cycles")
    .addColumn("connector_config_id", "text", (col) => col.references("connector_configs.id").onDelete("cascade"))
    .execute();

  await db.schema.createIndex("idx_work_cycles_connector").on("work_cycles").column("connector_config_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_work_cycles_connector").ifExists().execute();
  await db.schema.alterTable("work_cycles").dropColumn("connector_config_id").execute();
}
