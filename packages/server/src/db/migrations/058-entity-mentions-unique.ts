/**
 * UNIQUE constraint on entity_mentions(entity_id, indexed_file_id).
 *
 * ECR-02's Confirm/Reject flows rely on idempotent `INSERT ... ON CONFLICT
 * DO NOTHING` against this tuple to materialize held mentions and merge
 * stale-entity rows. Migration 027 created the table without any unique
 * constraint; 048 added a non-unique composite. Replace the non-unique
 * composite with a unique index so the ON CONFLICT paths are well-defined.
 *
 * Pre-flight: scans for duplicates before applying. If any (entity_id,
 * indexed_file_id) pair has >1 row, the migration aborts with a clear
 * error rather than silently dropping rows. Operator path:
 *
 *   DELETE FROM entity_mentions
 *    WHERE id NOT IN (
 *      SELECT MIN(id) FROM entity_mentions
 *       GROUP BY entity_id, indexed_file_id
 *    );
 *
 * Then re-run migrations.
 *
 * Handoff note for `ENTITY_LINKAGE_PROVENANCE` PR-1: when the `relation`
 * column lands on entity_mentions, that migration must DROP this index
 * (`idx_entity_mentions_entity_file_unique`) first and recreate it as
 * `UNIQUE (entity_id, indexed_file_id, relation)`. The pre-relation shape
 * here is correct for the world without relations; once relations exist a
 * given (entity, file) pair may legitimately appear multiple times under
 * different relation kinds.
 */
import { type Kysely, sql } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  const duplicates = await sql<{ entity_id: string; indexed_file_id: string; cnt: number }>`
    SELECT entity_id, indexed_file_id, COUNT(*) AS cnt
      FROM entity_mentions
     GROUP BY entity_id, indexed_file_id
    HAVING COUNT(*) > 1
     LIMIT 5
  `.execute(db);

  if (duplicates.rows.length > 0) {
    const sample = duplicates.rows
      .map((r) => `(entity_id=${r.entity_id}, indexed_file_id=${r.indexed_file_id}, count=${r.cnt})`)
      .join("; ");
    throw new Error(
      `migration 058-entity-mentions-unique: duplicate (entity_id, indexed_file_id) pairs found in entity_mentions — cannot apply UNIQUE index. Sample: ${sample}. Dedupe with: DELETE FROM entity_mentions WHERE id NOT IN (SELECT MIN(id) FROM entity_mentions GROUP BY entity_id, indexed_file_id);`,
    );
  }

  await db.schema.dropIndex("idx_entity_mentions_entity_file").ifExists().execute();

  await db.schema
    .createIndex("idx_entity_mentions_entity_file_unique")
    .on("entity_mentions")
    .columns(["entity_id", "indexed_file_id"])
    .unique()
    .execute();
}

export async function down<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.dropIndex("idx_entity_mentions_entity_file_unique").ifExists().execute();
  await db.schema
    .createIndex("idx_entity_mentions_entity_file")
    .on("entity_mentions")
    .columns(["entity_id", "indexed_file_id"])
    .execute();
}
