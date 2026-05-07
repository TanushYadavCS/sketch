/**
 * Adds channels.agent_user_id — nullable FK to users.id with ON DELETE SET NULL.
 * When set, the bound agent's instructions and tool allowlist apply to every
 * @mention in that Slack channel and the workspace is re-rooted under the
 * agent's directory. NULL means the channel runs with default behaviour.
 *
 * SQLite does not enforce FK constraints on ALTER TABLE ADD COLUMN and
 * requires PRAGMA foreign_keys = ON for ON DELETE behaviour. The constraint
 * is preserved for Postgres compatibility and as schema documentation.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("channels")
    .addColumn("agent_user_id", "text", (col) => col.references("users.id").onDelete("set null"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("channels").dropColumn("agent_user_id").execute();
}
