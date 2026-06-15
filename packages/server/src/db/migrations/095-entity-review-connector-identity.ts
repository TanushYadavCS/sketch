import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("entity_review_queue").addColumn("source", "text").execute();
  await db.schema.alterTable("entity_review_queue").addColumn("source_id", "text").execute();

  await sql`
    CREATE UNIQUE INDEX uq_entity_review_queue_source_ref
    ON entity_review_queue(source, source_id)
    WHERE source IS NOT NULL AND source_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_entity_review_queue_source_ref`.execute(db);
  await db.schema.alterTable("entity_review_queue").dropColumn("source_id").execute();
  await db.schema.alterTable("entity_review_queue").dropColumn("source").execute();
}
