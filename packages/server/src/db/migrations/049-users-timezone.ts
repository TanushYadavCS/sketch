/**
 * Adds a nullable `timezone` column to the `users` table.
 *
 * Stores an IANA timezone string (e.g. `Asia/Kolkata`, `America/New_York`)
 * for each user. NULL means "not yet hydrated" — distinct from a user who
 * has explicitly chosen UTC. Hydration happens lazily from the Slack/WhatsApp
 * adapters on the user's next message; existing rows are left as NULL and
 * fall through to UTC at read time until hydrated.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").addColumn("timezone", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").dropColumn("timezone").execute();
}
