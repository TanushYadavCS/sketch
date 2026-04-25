/**
 * Add org_context JSON column to settings.
 * Stores org description, industry, and other context used by the
 * enrichment prompt to understand what the org does.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("settings").addColumn("org_context", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("settings").dropColumn("org_context").execute();
}
