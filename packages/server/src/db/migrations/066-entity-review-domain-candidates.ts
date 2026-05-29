import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("entity_review_domain_candidates")
    .addColumn("review_id", "text", (col) => col.notNull().references("entity_review_queue.id").onDelete("cascade"))
    .addColumn("domain_candidate_id", "text", (col) =>
      col.notNull().references("entity_candidates.id").onDelete("cascade"),
    )
    .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addPrimaryKeyConstraint("entity_review_domain_candidates_pk", ["review_id", "domain_candidate_id"])
    .execute();

  await db.schema
    .createIndex("idx_entity_review_domain_candidates_candidate")
    .on("entity_review_domain_candidates")
    .column("domain_candidate_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("entity_review_domain_candidates").execute();
}
