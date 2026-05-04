/**
 * Adds whatsapp_groups.agent_user_id — nullable FK to users.id with ON DELETE
 * SET NULL. When set, the bound agent's instructions and tool allowlist apply
 * to every message in that WhatsApp group and the workspace is re-rooted
 * under the agent's directory. NULL means the group runs with default
 * behaviour.
 *
 * Mirror of migration 045 for Slack channel binding. SQLite needs
 * PRAGMA foreign_keys = ON for the SET NULL trigger to fire; the constraint
 * is preserved for Postgres and as schema documentation.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("whatsapp_groups")
    .addColumn("agent_user_id", "text", (col) => col.references("users.id").onDelete("set null"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("whatsapp_groups").dropColumn("agent_user_id").execute();
}
