/**
 * Add browse_cache column to connector_configs.
 * Caches the last browse result (scope items like pages, workspaces, drives)
 * so the manage dialog can render instantly without re-fetching from the provider.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("connector_configs").addColumn("browse_cache", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("connector_configs").dropColumn("browse_cache").execute();
}
