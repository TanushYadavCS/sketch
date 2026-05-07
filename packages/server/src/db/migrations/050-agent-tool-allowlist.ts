/**
 * Adds users.allowed_tools — JSON array of canonical tool names an agent is
 * permitted to invoke. Enforced at runtime in canUseTool when a run is
 * associated with an agent. NULL means no allowlist (legacy/unrestricted),
 * empty array means deny every tool, non-empty array is the canonical set.
 *
 * Existing rows are intentionally left at NULL: backfilling a built-in-only
 * subset would silently strip MCP access from any pre-existing agent. Admins
 * can opt into enforcement by editing the agent.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").addColumn("allowed_tools", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("users").dropColumn("allowed_tools").execute();
}
