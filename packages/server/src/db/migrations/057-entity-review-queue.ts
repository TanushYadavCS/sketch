/**
 * Entity creation review queue.
 *
 * - `entity_review_queue`: one row per (normalized_name, entity_type) proposal
 *   that fuzzy-collided with an existing entity and couldn't be auto-linked.
 * - `entity_review_evidence`: file-level evidence backing each queue row;
 *   carries the (file, source) pairs the caller would have written mentions
 *   for. Materialized into mentions/ACL when the row is confirmed/rejected
 *   (resolve path lands in ECR-02).
 * - `entity_alias_rejections`: sticky "do not re-suggest this alias against
 *   this entity" record, written when a reviewer rejects a candidate.
 *
 * `proposed_email`, `backfill_cursor`, and the `'confirming'` status value
 * are added now even though ECR-01 doesn't write them — keeps the schema
 * stable across the ECR-02 / ECR-04 / ECR-05 follow-ups so we don't need a
 * second migration for columns that already have known names.
 */
import { type Kysely, sql } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema
    .createTable("entity_review_queue")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("proposed_name", "text", (col) => col.notNull())
    .addColumn("normalized_name", "text", (col) => col.notNull())
    .addColumn("entity_type", "text", (col) => col.notNull())
    .addColumn("proposed_email", "text")
    .addColumn("candidate_entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .addColumn("candidate_score", "real")
    .addColumn("candidate_reason", "text")
    .addColumn("candidate_generated_at", "text")
    .addColumn("first_seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("last_seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addColumn("occurrence_count", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("triggered_by_user_id", "text", (col) => col.notNull())
    .addColumn("review_started_at", "text")
    .addColumn("review_started_by", "text")
    .addColumn("backfill_cursor", "text")
    .addColumn("resolved_by", "text")
    .addColumn("resolved_at", "text")
    .addColumn("resolved_entity_id", "text", (col) => col.references("entities.id").onDelete("set null"))
    .addUniqueConstraint("entity_review_queue_normalized_unique", ["normalized_name", "entity_type"])
    .execute();

  await sql`
    CREATE INDEX idx_entity_review_queue_status_last_seen
    ON entity_review_queue(status, last_seen_at DESC)
  `.execute(db);

  await db.schema
    .createTable("entity_review_evidence")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("review_id", "text", (col) => col.notNull().references("entity_review_queue.id").onDelete("cascade"))
    .addColumn("indexed_file_id", "text", (col) => col.notNull().references("indexed_files.id").onDelete("cascade"))
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("note", "text")
    .addColumn("seen_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("entity_review_evidence_unique", ["review_id", "indexed_file_id", "source"])
    .execute();

  await db.schema
    .createIndex("idx_entity_review_evidence_review")
    .on("entity_review_evidence")
    .column("review_id")
    .execute();

  await db.schema
    .createIndex("idx_entity_review_evidence_seen_at")
    .on("entity_review_evidence")
    .column("seen_at")
    .execute();

  await db.schema
    .createTable("entity_alias_rejections")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("entity_id", "text", (col) => col.notNull().references("entities.id").onDelete("cascade"))
    .addColumn("rejected_name", "text", (col) => col.notNull())
    .addColumn("normalized_rejected_name", "text", (col) => col.notNull())
    .addColumn("rejected_by", "text", (col) => col.notNull())
    .addColumn("rejected_at", "text", (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .addUniqueConstraint("entity_alias_rejections_unique", ["entity_id", "normalized_rejected_name"])
    .execute();
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.dropTable("entity_alias_rejections").execute();
  await db.schema.dropTable("entity_review_evidence").execute();
  await db.schema.dropTable("entity_review_queue").execute();
}
