import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("entity_review_queue").addColumn("seed_source", "text").execute();
  await db.schema.alterTable("entity_review_queue").addColumn("seed_source_id", "text").execute();

  await db.schema
    .createIndex("idx_entity_review_queue_seed_handle")
    .on("entity_review_queue")
    .columns(["seed_source", "seed_source_id"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_entity_review_queue_seed_handle").execute();
  await db.schema.alterTable("entity_review_queue").dropColumn("seed_source_id").execute();
  await db.schema.alterTable("entity_review_queue").dropColumn("seed_source").execute();
}
