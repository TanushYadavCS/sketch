/**
 * Composite index on entity_mentions(entity_id, indexed_file_id).
 *
 * Speeds up multi-entity lookups: the OR/single-id `entity_id IN (...)` path
 * and the AND-mode `GROUP BY indexed_file_id HAVING COUNT(DISTINCT entity_id)`
 * path used by `resolveEntityFileIds` in connectors/search.ts. Existing
 * single-column indexes (idx_entity_mentions_entity, idx_entity_mentions_file
 * from migration 027) cover their respective single-axis queries but force a
 * row lookup to fetch the other column.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("idx_entity_mentions_entity_file")
    .on("entity_mentions")
    .columns(["entity_id", "indexed_file_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_entity_mentions_entity_file").execute();
}
