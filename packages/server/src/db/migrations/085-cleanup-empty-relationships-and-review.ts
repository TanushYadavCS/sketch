/**
 * Repairs parent rows stranded by past connector deletions after file-keyed
 * evidence rows cascaded away. The scoped connector-delete path handles this
 * going forward; this migration is the one-time global invariant repair.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM entity_relationships
    WHERE NOT EXISTS (
      SELECT 1
      FROM entity_relationship_evidence ev
      WHERE ev.relationship_id = entity_relationships.id
    )
  `.execute(db);

  await sql`
    DELETE FROM entity_review_queue
    WHERE status = 'pending'
      AND NOT EXISTS (
        SELECT 1
        FROM entity_review_evidence ev
        WHERE ev.review_id = entity_review_queue.id
      )
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
