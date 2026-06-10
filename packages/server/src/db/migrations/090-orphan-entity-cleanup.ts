/**
 * Removes connector-derived entities left behind after their only file support
 * was already deleted. This is intentionally an absence-based one-time cleanup;
 * live connector deletion uses the scoped repository query while file support
 * still exists. Directory seeds are protected, and entities without source refs
 * are left untouched because their origin is ambiguous.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM entities
    WHERE EXISTS (
      SELECT 1
      FROM entity_source_refs esr
      WHERE esr.entity_id = entities.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM entity_source_refs esr
      WHERE esr.entity_id = entities.id
        AND esr.source IN ('team', 'team_directory')
    )
    AND entities.source_type NOT IN ('team', 'team_directory')
    AND NOT EXISTS (
      SELECT 1
      FROM entity_mentions em
      WHERE em.entity_id = entities.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM entity_relationship_evidence ev
      INNER JOIN entity_relationships r ON r.id = ev.relationship_id
      WHERE r.source_entity_id = entities.id
         OR r.target_entity_id = entities.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM indexed_files f
      WHERE f.id = entities.source_ref_id
    )
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
