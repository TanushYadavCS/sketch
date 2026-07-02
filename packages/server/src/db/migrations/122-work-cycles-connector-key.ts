import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_work_cycles_source_ref").ifExists().execute();
  await db.schema
    .createIndex("idx_work_cycles_connector_source_ref")
    .unique()
    .on("work_cycles")
    .columns(["connector_config_id", "source", "external_ref"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_work_cycles_connector_source_ref").ifExists().execute();
  await db.schema
    .createIndex("idx_work_cycles_source_ref")
    .unique()
    .on("work_cycles")
    .columns(["source", "external_ref"])
    .execute();
}
