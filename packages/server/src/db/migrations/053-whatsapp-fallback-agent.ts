/**
 * Adds settings.whatsapp_fallback_agent_id — nullable singleton FK to users.id
 * with ON DELETE SET NULL. When set, WhatsApp DMs from numbers not in
 * users.whatsapp_number are routed to this agent in a per-sender external user
 * sandbox instead of being dropped.
 *
 * users.type already accepts arbitrary text, so the new "external" value does
 * not require a schema change. External rows are excluded from auth flows by
 * application logic, not by a CHECK constraint.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("settings")
    .addColumn("whatsapp_fallback_agent_id", "text", (col) => col.references("users.id").onDelete("set null"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("settings").dropColumn("whatsapp_fallback_agent_id").execute();
}
