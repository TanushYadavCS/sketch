/**
 * Per-user Fireflies support:
 *  - credential_hint: last few chars of the API key, stored unencrypted for list views.
 *    Generalizes to any API-key/OAuth-token connector.
 *  - Partial unique index: at most one Fireflies config per (created_by) user.
 *  - Backfill the existing 'admin'-owned Fireflies row to the earliest admin user.
 *    Filters by auth_role = 'admin' so a non-admin user (e.g. a teammate created
 *    before the admin) doesn't inherit ownership and the rotate/delete authority
 *    that comes with it. If no admin exists yet, the row stays with the literal
 *    'admin' string (which matches no user id) — safe; admin can re-claim by
 *    re-connecting from Settings.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("connector_configs").addColumn("credential_hint", "text").execute();

  await sql`
    CREATE UNIQUE INDEX idx_connector_configs_fireflies_owner_unique
    ON connector_configs (created_by)
    WHERE connector_type = 'fireflies'
  `.execute(db);

  await sql`
    UPDATE connector_configs
    SET created_by = (SELECT id FROM users WHERE auth_role = 'admin' ORDER BY created_at ASC LIMIT 1)
    WHERE connector_type = 'fireflies'
      AND created_by = 'admin'
      AND EXISTS (SELECT 1 FROM users WHERE auth_role = 'admin')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_connector_configs_fireflies_owner_unique").execute();
  await db.schema.alterTable("connector_configs").dropColumn("credential_hint").execute();
}
