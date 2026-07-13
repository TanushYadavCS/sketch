/**
 * Fact materialization quarantine + sentinel-owner repair.
 *
 * 1. `materialization_attempts` on indexed_file_facts counts failed
 *    materialization passes. Facts that keep throwing (e.g. a foreign-key
 *    violation from a dangling owner) previously stayed unmaterialized and were
 *    retried by every post-sync sweep forever: tens of thousands of failing
 *    inserts per day on affected deployments. Sweeps now skip facts once they
 *    exceed the attempt cap; content changes reset the counter.
 *
 * 2. Legacy auth wrote the literal strings 'admin' / 'sketch-api-key' as
 *    resource owners before user rows existed. Those values match no users.id,
 *    so anything materialized from such facts fails the owner foreign key.
 *    Following the migration 041 precedent, reassign them to the earliest
 *    admin user when one exists. Fireflies configs carry a partial unique
 *    index on created_by (migration 041), so at most one sentinel-owned
 *    Fireflies row is reassigned, and only when the admin owns none;
 *    bootstrap.ts already warns about any remaining sentinel-owned rows.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("indexed_file_facts")
    .addColumn("materialization_attempts", "integer", (col) => col.notNull().defaultTo(0))
    .execute();

  await sql`
    UPDATE connector_configs
    SET created_by = (SELECT id FROM users WHERE auth_role = 'admin' ORDER BY created_at ASC LIMIT 1)
    WHERE created_by IN ('admin', 'sketch-api-key')
      AND connector_type != 'fireflies'
      AND EXISTS (SELECT 1 FROM users WHERE auth_role = 'admin')
  `.execute(db);

  await sql`
    UPDATE connector_configs
    SET created_by = (SELECT id FROM users WHERE auth_role = 'admin' ORDER BY created_at ASC LIMIT 1)
    WHERE connector_type = 'fireflies'
      AND created_by IN ('admin', 'sketch-api-key')
      AND EXISTS (SELECT 1 FROM users WHERE auth_role = 'admin')
      AND NOT EXISTS (
        SELECT 1 FROM connector_configs owned
        WHERE owned.connector_type = 'fireflies'
          AND owned.created_by = (SELECT id FROM users WHERE auth_role = 'admin' ORDER BY created_at ASC LIMIT 1)
      )
      AND id = (
        SELECT candidate.id FROM connector_configs candidate
        WHERE candidate.connector_type = 'fireflies'
          AND candidate.created_by IN ('admin', 'sketch-api-key')
        ORDER BY candidate.created_at ASC, candidate.id ASC
        LIMIT 1
      )
  `.execute(db);

  await sql`
    UPDATE indexed_file_facts
    SET created_by_user_id = (SELECT id FROM users WHERE auth_role = 'admin' ORDER BY created_at ASC LIMIT 1)
    WHERE created_by_user_id IN ('admin', 'sketch-api-key')
      AND EXISTS (SELECT 1 FROM users WHERE auth_role = 'admin')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("indexed_file_facts").dropColumn("materialization_attempts").execute();
}
